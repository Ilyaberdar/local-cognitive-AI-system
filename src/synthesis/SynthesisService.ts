import fs from "node:fs/promises";
import { previewDocument } from "./preview";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectStore } from "../projects/ProjectStore";
import { LocalModelManagerRegistry } from "../llm/LocalModelManager";
import { LLMService } from "../llm/LLMService";
import { ManagedModel } from "../types";
import { preciseLocalGenerationSettings, resolveLocalGenerationSettings } from "../local/GenerationSettings";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { compileProgram, SourceSpan } from "./language";
import { BudgetExhausted, Interpreter } from "./Interpreter";
import { ActivityEvent, Evidence, RunRecord, RunStatus, SynthesisError, SynthesisModule, SynthesisRun } from "./types";
import { containedPath, filesHash, hash, MAX_ARTIFACT_BYTES, readOptional, readText, relativePath } from "./paths";
import { calculatorTemplate, emptyModuleTemplate, ModuleTemplate } from "./templates";
import { discoverModules, moduleDirectory, moduleFolders, moduleName, moduleSources, sourceId } from "./modules";
import { evaluateCalculator, evaluatorVersion, supportedEvaluators } from "./evaluators";

interface Services {
  projects: ProjectStore;
  models: Pick<LocalModelManagerRegistry, "listAllModels">;
  loadModel: (model: ManagedModel, signal: AbortSignal) => Promise<void>;
  llm: Pick<LLMService, "generateObject" | "generateText">;
}
/** What this runtime (V1, local files) can run, as diagnostics: Run refuses the errors, and a
 * module shows them as soon as it is opened. */
function profileDiagnostics(compiled: ReturnType<typeof compileProgram>, specPath: string, flowPath: string) {
  const found: Array<{severity: "error" | "warning"; code: string; message: string; file: string; line: number; column: number}> = [];
  const add = (severity: "error" | "warning", code: string, message: string, file: string) => found.push({severity, code, message, file, line: 1, column: 1});
  if (!compiled.spec || !compiled.flow) return found;
  if (compiled.flow.limits.iterations < 1 || compiled.flow.limits.iterations > 32 || compiled.flow.limits.timeMs > 7200000) {
    add("error", "FLOW_LIMIT_RANGE", "V1 supports at most 32 iterations and 120 minutes per run.", flowPath);
  }
  if (!compiled.spec.artifacts.length || compiled.spec.artifacts.length > 12) add("error", "SPEC_ARTIFACT_LIMIT", "Declare between 1 and 12 artifact files.", specPath);
  for (const file of compiled.spec.artifacts) {
    try { relativePath(file); }
    catch { add("error", "SPEC_ARTIFACT_PATH", `${file}: use a project-relative path without spaces, hidden folders or "..".`, specPath); continue; }
    if (!/\.(?:js|html|css|txt|md)$/.test(file)) add("error", "SPEC_ARTIFACT_TYPE", `${file}: local-files-v1 supports only js, html, css, txt and md artifacts.`, specPath);
  }
  for (const gate of compiled.spec.gates) {
    if (compiled.spec.evaluator !== "calculator-v1" || !supportedEvaluators.has(gate.evaluatorId)) {
      add("warning", "SPEC_EVALUATOR_UNREGISTERED", `No trusted evaluator is registered for ${gate.evaluatorId}: the gate ${gate.id} will be Unknown and cannot pass.`, specPath);
    }
  }
  return found;
}
const activeStatus = (status: RunStatus) => status === "running" || status === "queued";
const stamp = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const runId = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new SynthesisError("Invalid run identifier."); return id; };
// Synthesis turns produce structured source/JSON and should not inherit a creative chat profile.
const synthesisSampling = resolveLocalGenerationSettings(preciseLocalGenerationSettings()).sampling;
function publicRun(record: RunRecord): SynthesisRun {
  const {files, baseline, specSource, flowSource, rootPath, specHash, spec, flow, version, outputPath, ...run} = record;
  return run;
}

/** Project source is read-only until Apply. Runs contain frozen sources and an isolated artifact tree. */
export class SynthesisService {
  private readonly directory: string;
  private readonly active = new Map<string, {controller: AbortController; done: Promise<void>; interruption: boolean}>();
  private accepting = true;
  private readonly pendingStarts = new Set<Promise<SynthesisRun>>();
  private reservations = 0;
  private disposed = false;
  constructor(appDataDir: string, private readonly services: Services) { this.directory = path.join(appDataDir, "synthesis", "runs"); }

  async init(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    for (const id of await this.ids()) {
      const record = await this.read(id);
      if (activeStatus(record.status)) {
        record.status = "interrupted";
        record.error = "The application stopped. Restart from the frozen snapshot to create a new run; incomplete side effects are not replayed.";
        await this.event(record, "recovery", record.error, "failed");
      }
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const item of this.active.values()) { item.interruption = true; item.controller.abort(new Error("Runtime reloaded or stopped.")); }
    await Promise.allSettled([...this.pendingStarts]);
    await Promise.allSettled([...this.active.values()].map(item => item.done));
  }
  private async project(id: string) {
    const project = await this.services.projects.get(id);
    if (!project || project.archivedAt) throw new SynthesisError("Select an existing, non-archived project.", 404);
    if (await fs.realpath(project.rootPath) !== project.rootPath) throw new SynthesisError("Project folder changed.", 409);
    return project;
  }
  async modules(projectId: string): Promise<SynthesisModule[]> {
    const project = await this.project(projectId);
    const ids = await discoverModules(project.rootPath);
    return Promise.all(ids.map(id => this.module(projectId, id)));
  }
  async folders(projectId: string, directory: unknown = "") {
    const project = await this.project(projectId);
    const relative = moduleDirectory(directory);
    try { return {directory: relative, folders: await moduleFolders(project.rootPath, relative)}; }
    catch (error) { if (isMissingFile(error)) throw new SynthesisError("Folder not found.", 404); throw error; }
  }
  async module(projectId: string, id: string): Promise<SynthesisModule> {
    const project = await this.project(projectId);
    const {name, specPath, flowPath} = moduleSources(id);
    let specSource = "", flowSource = "", reading = specPath;
    try {
      specSource = await readText(await containedPath(project.rootPath, specPath));
      reading = flowPath;
      flowSource = await readText(await containedPath(project.rootPath, flowPath));
    } catch (error) {
      // The project-relative file, never the host's full path (it may reach a paired device).
      const message = isMissingFile(error) ? `Missing ${reading}.` : error instanceof SynthesisError ? error.message : `${reading} could not be read.`;
      return {id, name, specPath, flowPath, specSource, flowSource, valid: false,
        diagnostics: [{severity: "error", code: "SOURCE_READ", message, file: reading, line: 1, column: 1}]};
    }
    const compiled = compileProgram(specSource, flowSource, {specPath, flowPath});
    const diagnostics = [...compiled.diagnostics.map(item => ({severity: item.severity, code: item.code, message: item.message, file: item.path, line: item.span.start.line, column: item.span.start.column})),
      // What Run would refuse is shown before it: the module is not "valid" only to fail at Run.
      ...(compiled.diagnostics.some(item => item.severity === "error") ? [] : profileDiagnostics(compiled, specPath, flowPath))];
    if (compiled.spec?.module !== name) diagnostics.push({severity: "error", code: "MODULE_NAME", message: "Filename and module declaration must match.", file: specPath, line: 1, column: 1});
    return {id, name: compiled.spec?.module ?? name, specPath, flowPath, specSource, flowSource, valid: !diagnostics.some(item => item.severity === "error"), diagnostics};
  }
  async createModule(projectId: string, name = "Calculator", options: {template?: ModuleTemplate; directory?: string} = {}): Promise<SynthesisModule> {
    const project = await this.project(projectId); moduleName(name);
    const directory = moduleDirectory(options.directory);
    const relative = directory ? `${directory}/${name}` : name;
    const sources = moduleSources(sourceId(`${relative}/${name}`));
    const folder = await containedPath(project.rootPath, relative);
    if (options.template !== undefined && options.template !== "calculator" && options.template !== "empty") throw new SynthesisError("Choose an empty module or calculator template.");
    const template = options.template === "empty" ? emptyModuleTemplate(name) : calculatorTemplate(name);
    // Check both final paths before any mutation (including path length limits).
    const specFile = await containedPath(project.rootPath, sources.specPath);
    const flowFile = await containedPath(project.rootPath, sources.flowPath);
    // mkdir is exclusive: never overwrite an authored module, even if its files are incomplete.
    if (directory) await fs.mkdir(await containedPath(project.rootPath, directory), {recursive: true});
    try { await fs.mkdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SynthesisError(`This module already exists at ${relative}. Choose another name or folder; existing files were not changed.`, 409); throw error; }
    await fs.writeFile(specFile, template.spec, {flag: "wx"});
    await fs.writeFile(flowFile, template.flow, {flag: "wx"});
    return this.module(projectId, sourceId(`${relative}/${name}`));
  }
  async editorPath(projectId: string, id?: string, file?: "spec" | "flow"): Promise<string> {
    const project = await this.project(projectId);
    if (!id) return project.rootPath;
    const sources = moduleSources(id);
    const relative = file === "spec" ? sources.specPath : file === "flow" ? sources.flowPath : path.posix.dirname(sources.specPath);
    if (relative === ".") return project.rootPath;
    const target = await containedPath(project.rootPath, relative);
    await fs.access(target); return target;
  }
  /** `runId`: an id reserved by the caller (a paired device's command), so a resend or a restart
   * finds the run it made instead of making another. */
  async start(projectId: string, id: string, options: {runId?: string} = {}): Promise<SynthesisRun> {
    const existing = options.runId ? await this.existing(options.runId) : undefined;
    if (existing) return existing;
    const module = await this.module(projectId, id);
    if (!module.valid) throw new SynthesisError(module.diagnostics.map(item => `${item.line}:${item.column} ${item.message}`).join("\n"));
    return this.launch(projectId, id, module.specSource!, module.flowSource!, undefined, options.runId);
  }
  async restart(id: string, options: {runId?: string} = {}): Promise<SynthesisRun> {
    const existing = options.runId ? await this.existing(options.runId) : undefined;
    if (existing) return existing;
    const record = await this.read(id);
    if (activeStatus(record.status) || record.status === "accepted") throw new SynthesisError("Only unsuccessful or interrupted runs may be restarted.", 409);
    return this.launch(record.projectId, record.moduleId, record.specSource, record.flowSource, record.id, options.runId);
  }
  /** A run, if one with this id exists. */
  async existing(id: string): Promise<SynthesisRun | undefined> {
    try { return await this.get(id); } catch (error) { if (error instanceof SynthesisError && error.statusCode === 404) return undefined; throw error; }
  }
  /** Runs executing now (and starts being prepared): a server drains them before it stops. */
  activeCount(): number { return this.active.size + this.reservations; }
  /** The server is draining: no new run starts; running ones finish. */
  stopAccepting(): void { this.accepting = false; }
  private launch(projectId: string, id: string, specSource: string, flowSource: string, restartedFrom?: string, reservedId?: string): Promise<SynthesisRun> {
    if (this.disposed) throw new SynthesisError("Runtime is stopping.", 409);
    if (!this.accepting) throw new SynthesisError("The server is shutting down. Try again when it is back.", 409);
    if (this.active.size + this.reservations >= 2) throw new SynthesisError("At most two Synthesis runs may execute concurrently.", 409);
    this.reservations++;
    const pending = this.prepareLaunch(projectId, id, specSource, flowSource, restartedFrom, reservedId).finally(() => {
      this.reservations--; this.pendingStarts.delete(pending);
    });
    this.pendingStarts.add(pending);
    return pending;
  }
  private async prepareLaunch(projectId: string, id: string, specSource: string, flowSource: string, restartedFrom?: string, reservedId?: string): Promise<SynthesisRun> {
    const project = await this.project(projectId);
    if (this.disposed) throw new SynthesisError("Runtime is stopping.", 409);
    const compiled = compileProgram(specSource, flowSource);
    if (!compiled.spec || !compiled.flow || compiled.diagnostics.some(item => item.severity === "error")) throw new SynthesisError("Frozen DSL source is invalid. Fix diagnostics before running.");
    const refusal = profileDiagnostics(compiled, "", "").find(item => item.severity === "error");
    if (refusal) throw new SynthesisError(refusal.message);
    if (compiled.flow.limits.iterations > 32 || compiled.flow.limits.timeMs > 7200000) throw new SynthesisError("V1 supports at most 32 iterations and 120 minutes per run.");
    if (!compiled.spec.artifacts.length || compiled.spec.artifacts.length > 12) throw new SynthesisError("Declare between 1 and 12 artifact files.");
    for (const file of compiled.spec.artifacts) {
      relativePath(file);
      if (!/\.(?:js|html|css|txt|md)$/.test(file)) throw new SynthesisError("local-files-v1 supports only js, html, css, txt and md artifacts.");
    }
    const record: RunRecord = {
      version: 1, id: reservedId ? runId(reservedId) : randomUUID(), projectId, moduleId: id, moduleName: compiled.spec.module,
      rootPath: project.rootPath, specSource, flowSource, specHash: hash(specSource), spec: compiled.spec, flow: compiled.flow,
      status: "queued", phase: "queued", iteration: 0, createdAt: stamp(), updatedAt: stamp(), restartedFrom,
      files: {}, baseline: {}, events: [], models: [], usage: {inputTokens: 0, outputTokens: 0, calls: 0}
    };
    await this.save(record);
    if (this.disposed) {
      record.status = "interrupted"; record.error = "Runtime stopped before this run was admitted.";
      await this.save(record); throw new SynthesisError(record.error, 409);
    }
    const item = {controller: new AbortController(), done: Promise.resolve(), interruption: false};
    this.active.set(record.id, item);
    item.done = this.execute(record, item).finally(() => { this.active.delete(record.id); });
    return publicRun(record);
  }
  async get(id: string): Promise<SynthesisRun> { return publicRun(await this.read(id)); }
  async sources(id: string): Promise<{specSource: string; flowSource: string; specHash: string}> {
    const record = await this.read(id);
    return {specSource: record.specSource, flowSource: record.flowSource, specHash: record.specHash};
  }
  async list(projectId: string): Promise<SynthesisRun[]> {
    await this.project(projectId);
    const records = await Promise.all((await this.ids()).map(id => this.read(id)));
    return records.filter(run => run.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(publicRun);
  }
  async cancel(id: string): Promise<SynthesisRun> {
    const item = this.active.get(runId(id));
    if (item) { item.controller.abort(new Error("Cancelled by user.")); await item.done; }
    return this.get(id);
  }
  /** Useful for CLI/tests; HTTP execution remains non-blocking. */
  async wait(id: string): Promise<SynthesisRun> { await this.active.get(runId(id))?.done; return this.get(id); }

  private async execute(record: RunRecord, item: {controller: AbortController; interruption: boolean}): Promise<void> {
    const signal = item.controller.signal;
    const timer = setTimeout(() => item.controller.abort(new BudgetExhausted("Wall-clock time budget exhausted.")), record.flow.limits.timeMs);
    timer.unref();
    const candidate = Object.freeze({kind: "candidate", id: record.id, runId: record.id,
      get path() { return record.outputPath ?? ""; }, get hash() { return filesHash(record.files); }});
    const spec = Object.freeze({kind: "spec", hash: record.specHash});
    const models = new Map<string, ManagedModel>();
    const roles = new Set<object>();
    const evaluationSignatures: string[] = [];
    let lastEvidence: Evidence | undefined;
    let generationErrors: string[] = [];
    let terminal: {status: RunStatus; evidence?: Evidence} | undefined;
    const requireCandidate = (value: unknown) => { if (value !== candidate || !record.outputPath) throw new SynthesisError("Expected the checked-out candidate."); };
    const requireSpec = (value: unknown) => { if (value !== spec) throw new SynthesisError("Expected the frozen module specification."); };
    const evidenceMatches = (value: unknown): value is Evidence => value === lastEvidence && !!lastEvidence &&
      lastEvidence.candidateHash === filesHash(record.files) && lastEvidence.specHash === record.specHash && lastEvidence.evaluatorVersion === evaluatorVersion;
    const call = async (name: string, args: unknown[], named: Record<string, unknown>, span: SourceSpan, receiver?: unknown): Promise<unknown> => {
      signal.throwIfAborted();
      await this.event(record, name, name, "running", {line: span.start.line, file: moduleSources(record.moduleId).flowPath});
      let value: unknown;
      switch (name) {
        case "models.list": {
          if ((named.provider ?? "llamacpp") !== "llamacpp") throw new SynthesisError("local-files-v1 currently allows the built-in llamacpp provider only; no cloud fallbacks.");
          const available = await this.services.models.listAllModels("llamacpp");
          for (const model of available) if (model.providerId === "llamacpp") models.set(model.id, model);
          value = [...models.values()];
          break;
        }
        case "models.select": {
          if (!Array.isArray(args[0])) throw new SynthesisError("models.select expects the result of models.list.");
          const max = named.max_size === undefined ? Infinity : Number(named.max_size);
          if (!(max > 0) || (named.max_size !== undefined && !Number.isFinite(max))) throw new SynthesisError("max_size must be positive and finite.");
          if (named.provider !== undefined && named.provider !== "llamacpp") throw new SynthesisError("Only the built-in local llamacpp provider is allowed.");
          const prefer = String(named.prefer ?? "").toLowerCase();
          const eligible = args[0].filter((model): model is ManagedModel => !!model && models.get(model.id) === model && (!Number.isFinite(max) || (typeof model.sizeBytes === "number" && model.sizeBytes > 0 && model.sizeBytes <= max)));
          eligible.sort((a,b) => Number(`${b.id} ${b.displayName}`.toLowerCase().includes(prefer)) - Number(`${a.id} ${a.displayName}`.toLowerCase().includes(prefer)) || (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity) || a.id.localeCompare(b.id));
          if (!eligible[0]) throw new SynthesisError("No installed local model matches the selection. Install a suitable model in Models or adjust max_size.");
          value = eligible[0]; break;
        }
        case "model": {
          const available = await this.services.models.listAllModels("llamacpp");
          const model = available.find(item => item.id === args[0] || item.displayName === args[0]);
          if (!model) throw new SynthesisError("model() expects an exact installed local model ID or display name.");
          models.set(model.id, model);
          await this.services.loadModel(model, signal);
          const role = Object.freeze({model}); roles.add(role); value = role;
          if (!record.models.some(item => item.id === model.id)) record.models.push(model);
          break;
        }
        case "models.load": {
          const model = args[0] as ManagedModel;
          if (!model || models.get(model.id) !== model) throw new SynthesisError("models.load expects a selected installed model.");
          await this.services.loadModel(model, signal);
          const role = Object.freeze({model}); roles.add(role); value = role;
          if (!record.models.some(item => item.id === model.id)) record.models.push(model);
          break;
        }
        case "freeze": requireSpec(args[0]); value = spec; break;
        case "checkout": {
          if (record.outputPath) throw new SynthesisError("Only one checkout is allowed per run.");
          const relative = relativePath(args[0]);
          if (relative.split("/").includes("Synthesis")) throw new SynthesisError("Candidate cannot overwrite authored DSL.");
          record.outputPath = relative;
          for (const file of record.spec.artifacts) {
            const target = await containedPath(record.rootPath, `${relative}/${file}`);
            record.baseline[file] = await readOptional(target);
            if (record.baseline[file] !== null) record.files[file] = record.baseline[file]!;
          }
          value = candidate; break;
        }
        case "inspect": {
          if (!Array.isArray(args[0]) || args[0].length > 12) throw new SynthesisError("inspect expects up to 12 explicit project-relative text files.");
          const context: Record<string,string> = {};
          for (const file of args[0]) context[relativePath(file)] = await readText(await containedPath(record.rootPath, relativePath(file)), 24000);
          value = context; break;
        }
        case "accepted": requireCandidate(args[0]); requireSpec(args[1]); value = record.status === "accepted"; break;
        case "role.revise": {
          if (!receiver || typeof receiver !== "object" || !roles.has(receiver)) throw new SynthesisError("Expected a loaded model role.");
          requireCandidate(args[0]); requireSpec(args[1]);
          generationErrors.push(...await this.revise(record, (receiver as {model: ManagedModel}).model, args.slice(2), signal, named));
          lastEvidence = undefined; delete record.evidence;
          value = candidate; break;
        }
        case "role.propose": case "role.reconsider": case "role.inspect": case "role.propose_tests": {
          if (!receiver || typeof receiver !== "object" || !roles.has(receiver)) throw new SynthesisError("Expected a loaded model role.");
          const model = (receiver as {model: ManagedModel}).model;
          const response = await this.services.llm.generateText({model: model.id, signal, maxTokens: 1000, localReasoningBudget: 0, sampling: synthesisSampling,
            systemPrompt: "You are a software synthesis advisor. Suggestions are advisory, never acceptance evidence. Be concise.",
            prompt: `${name}\nContract: ${record.spec.description}\nContext: ${JSON.stringify(args).slice(0, 6000)}\nCandidate artifact excerpts (bounded; do not assume omitted text was reviewed):\n${JSON.stringify(Object.fromEntries(Object.entries(record.files).map(([file, content]) => [file, content.slice(0, 4000)]))).slice(0, 14000)}`}, model.providerId);
          this.usage(record, response.usage); if (response.error) throw new SynthesisError(response.error);
          value = name === "role.inspect" ? {notes: [response.text], violations: []} : response.text; break;
        }
        case "evaluate": {
          requireCandidate(args[0]); requireSpec(args[1]);
          // Every gate judges one snapshot, and the evidence names that snapshot's hash.
          const files = {...record.files};
          const gates: Evidence["gates"] = [];
          for (const gate of record.spec.gates) {
            signal.throwIfAborted();
            const result = record.spec.evaluator === "calculator-v1" && supportedEvaluators.has(gate.evaluatorId)
              ? await evaluateCalculator(files, gate.evaluatorId)
              : {status: "Unknown" as const, message: `No trusted evaluator registered for ${gate.evaluatorId}.`};
            gates.push({id: gate.id, evaluator: gate.evaluatorId, severity: gate.severity, ...result});
            await this.event(record, `gate.${gate.id}`, `${result.status}: ${result.message}`, result.status === "Pass" ? "ok" : "failed");
          }
          if (!gates.some(gate => gate.severity === "hard")) gates.push({id: "acceptance", evaluator: "registry", severity: "hard", status: "Unknown", message: "At least one trusted hard evaluator is required."});
          // A candidate is complete only with every declared file: the gates may judge only some.
          const missing = record.spec.artifacts.filter(file => !Object.hasOwn(files, file) || !files[file]!.trim());
          gates.push({id: "artifacts", evaluator: "registry", severity: "hard", status: missing.length ? "Fail" : "Pass",
            message: missing.length ? `Declared files are missing or empty: ${missing.join(", ")}.` : "Every declared file is present."});
          if (missing.length) await this.event(record, "gate.artifacts", `Fail: missing ${missing.join(", ")}`, "failed");
          const hard = gates.filter(gate => gate.severity === "hard");
          const status = hard.some(gate => gate.status === "Fail") ? "Fail" : hard.some(gate => gate.status === "Unknown") ? "Unknown" : "Pass";
          lastEvidence = {candidateHash: filesHash(files), specHash: record.specHash, evaluatorVersion, status, gates};
          evaluationSignatures.push(hash(JSON.stringify(gates.map(gate => [gate.id, gate.status, gate.message]))));
          record.evidence = lastEvidence; value = lastEvidence; break;
        }
        case "verify": {
          requireSpec(args[0]);
          if (!evidenceMatches(args[1])) throw new SynthesisError("Evidence is missing or stale; evaluate the exact current candidate.");
          value = {status: lastEvidence!.status, violations: [...lastEvidence!.gates.filter(gate => gate.status !== "Pass").map(gate => `${gate.id}: ${gate.message}`), ...generationErrors]}; break;
        }
        case "checkpoint":
          await writeJsonAtomically(path.join(this.directory, "checkpoints", `${record.id}-${record.events.at(-1)!.sequence}.json`), record);
          await this.save(record); value = true; break;
        case "accept": {
          requireCandidate(args[0]);
          if (!evidenceMatches(args[1]) || lastEvidence!.status !== "Pass") throw new SynthesisError("Acceptance requires fresh trusted Pass evidence for this exact candidate.");
          terminal = {status: "accepted", evidence: lastEvidence}; value = terminal; break;
        }
        case "needs_review":
          if (!evidenceMatches(args[0])) throw new SynthesisError("Review requires fresh evidence for the current candidate.");
          terminal = {status: "needs_review", evidence: lastEvidence}; value = terminal; break;
        case "unresolved": terminal = {status: "unresolved"}; value = terminal; break;
        case "merge": value = args.flat().filter(item => item !== null && item !== undefined); break;
        case "stagnant": {
          const count = Number(args[0]);
          const recent = evaluationSignatures.slice(-count);
          value = Number.isInteger(count) && count > 0 && recent.length === count && new Set(recent).size === 1 && lastEvidence?.status !== "Pass"; break;
        }
        default: throw new SynthesisError(`Runtime operation '${name}' is not supported by local-files-v1.`);
      }
      signal.throwIfAborted();
      const detail = name === "models.list" ? `${models.size} installed local models` : name === "models.select" ? (value as ManagedModel).displayName : undefined;
      await this.event(record, name, detail ?? `${name} completed`, "ok", {line: span.start.line});
      return value;
    };
    try {
      record.status = "running";
      await this.event(record, "start", "Frozen contract and flow; project files remain unchanged until Apply.", "ok");
      const interpreter = new Interpreter({signal, globals: {Pass: "Pass", Fail: "Fail", Unknown: "Unknown", Blocked: "Blocked", Unresolved: "Unresolved", NeedsReview: "NeedsReview", [record.spec.module]: {spec}}, call,
        iteration: async (iteration, span) => { record.iteration = iteration; generationErrors = []; await this.event(record, "iteration", `Iteration ${iteration}`, "running", {line: span.start.line}); }
      }, record.flow);
      const result = await interpreter.run();
      signal.throwIfAborted();
      if (result === terminal && terminal) {
        if (terminal.status === "accepted" && (!evidenceMatches(terminal.evidence) || terminal.evidence?.status !== "Pass")) throw new SynthesisError("Final acceptance evidence is stale.");
        record.status = terminal.status;
      } else record.status = "unresolved";
    } catch (error) {
      record.error = errorText(signal.aborted ? signal.reason : error);
      record.status = item.interruption ? "interrupted" : signal.aborted && !(signal.reason instanceof BudgetExhausted) ? "cancelled" : error instanceof BudgetExhausted || signal.reason instanceof BudgetExhausted ? "unresolved" : "blocked";
    } finally {
      clearTimeout(timer);
      await this.event(record, "finished", record.error ?? record.status, record.status === "accepted" ? "ok" : "failed");
    }
  }
  private usage(record: RunRecord, usage?: {inputTokens?: number; outputTokens?: number}): void {
    record.usage.calls++; record.usage.inputTokens += usage?.inputTokens ?? 0; record.usage.outputTokens += usage?.outputTokens ?? 0;
  }
  private async revise(record: RunRecord, model: ManagedModel, feedback: unknown[], signal: AbortSignal, options: Record<string, unknown>): Promise<string[]> {
    const selected = options.file;
    const format = options.format ?? "json";
    if (format !== "source" && format !== "json") throw new SynthesisError("revise format must be source or json.");
    if (options.instruction !== undefined && (typeof options.instruction !== "string" || options.instruction.length > 6000)) throw new SynthesisError("revise instruction must be a string of at most 6000 characters.");
    const files = selected === undefined ? record.spec.artifacts : [String(selected)];
    if (files.some(file => !record.spec.artifacts.includes(file))) throw new SynthesisError("Role may revise only declared artifact files.");
    const errors: string[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      await this.event(record, "agent.generate", `Writing ${file}`, "running", {model: model.displayName, file});
      const prompt = [
        `Implement only the file ${file}. Other files: ${record.spec.artifacts.filter(item => item !== file).join(", ")}.`,
        file.endsWith(".css") ? "This task is ONLY a short CSS stylesheet, at most 40 simple rules. Do not put JavaScript or HTML in CSS. Other files handle all behavior. Avoid repetition."
          : file.endsWith(".html") ? "This task is ONLY the HTML document. Use the required element IDs. Load the peer JavaScript once after all controls. Do not duplicate logic already present in peer JavaScript."
          : file.endsWith(".js") ? "This task is ONLY JavaScript. Implement the public functions and event handlers required by the contract; no HTML or CSS."
          : "Write only the requested file's contents; do not include other files or explanations.",
        options.instruction ? `Module: ${record.spec.module}. This scoped task is supplied by the authored flow; the full contract is independently verified after generation.`
          : `Contract: ${record.spec.description}`,
        format === "source" ? "Return ONLY the complete source code of this file. No JSON. No explanations. At most one code fence."
          : "Return an object with exactly one key, content, containing the complete file text. No markdown fences inside content. Do not explain.",
        `Current file:\n${(record.files[file] ?? "(empty)").slice(0, 10000)}`,
        options.instruction ? "" : `Peer file context:\n${JSON.stringify(Object.fromEntries(Object.entries(record.files).filter(([name]) => name !== file).map(([name, content]) => [name, content.slice(0, 4000)]))).slice(0, 10000)}`,
        `Feedback from trusted tests: ${JSON.stringify(feedback).slice(0, 4500)}`,
        options.instruction ? `Your focused task for this file:\n${options.instruction}` : "",
        `Use plain, minimal code under 100 lines. Finish ${format === "json" ? "the JSON object" : "the response"} as soon as this single file is complete. /no_think`
      ].join("\n\n");
      const request = {
        model: model.id, signal, prompt, systemPrompt: `You implement only ${file}, one small file of a software module. Follow the exact public interface in the contract. The contract describes the whole module; implement only this file's responsibility. ${format === "json" ? "Output only JSON with a content string." : "Output only source code, not JSON or explanations."}`,
        temperature: 0.2 + Math.min(3, Math.max(0, record.iteration - 1)) * 0.1, maxTokens: 2600, localReasoningBudget: 0, sampling: synthesisSampling
      };
      let content: string | undefined;
      let response;
      if (format === "source") {
        response = await this.services.llm.generateText(request, model.providerId);
        const text = response.text.trim();
        const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n```$/.exec(text);
        const source = fenced ? fenced[1] : text;
        // No extraction from prose or multiple files: ambiguous output remains a failed attempt.
        if (!source.includes("```") && source && (!text.includes("```") || fenced)) content = source;
      } else {
        const result = await this.services.llm.generateObject<{content: string}>({...request,
          responseFormat: {type: "json_schema", name: "synthesis_file", strict: true, schema: {
            type: "object", properties: {content: {type: "string"}}, required: ["content"], additionalProperties: false
          }}
        }, model.providerId);
        response = result.response;
        if (typeof result.data?.content === "string") content = result.data.content;
      }
      signal.throwIfAborted(); this.usage(record, response.usage);
      if (response.error || !content || Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
        const message = `${file}: ${response.error ?? "Invalid or oversized artifact response."}`;
        errors.push(message); await this.event(record, "agent.generate", message, "failed", {model: model.displayName, file, detail: response.text.slice(0, 4000)});
        continue;
      }
      record.files[file] = content;
      await this.event(record, "agent.generate", `${file}: ${Buffer.byteLength(content)} bytes`, "ok", {model: model.displayName, file});
    }
    return errors;
  }
  async diff(id: string): Promise<{files: Array<{path: string; before: string | null; after: string}>; canApply: boolean}> {
    const record = await this.read(id);
    const files = Object.entries(record.files).filter(([file, content]) => record.baseline[file] !== content).map(([file, after]) => ({path: `${record.outputPath}/${file}`, before: record.baseline[file] ?? null, after}));
    return {files, canApply: !this.active.has(id) && record.status === "accepted" && !record.appliedAt && !!record.outputPath && record.evidence?.candidateHash === filesHash(record.files)};
  }
  async apply(id: string): Promise<void> {
    if (this.active.has(id)) throw new SynthesisError("Run is active. Wait for it to finish before Apply.", 409);
    const first = await this.read(id);
    await withFileLock(path.join(first.rootPath, ".synthesis-apply-lock"), async () => {
      const record = await this.read(id); const project = await this.project(record.projectId);
      if (this.active.has(id) || project.rootPath !== record.rootPath || record.status !== "accepted" || record.appliedAt || !record.outputPath || record.evidence?.status !== "Pass" || record.evidence.candidateHash !== filesHash(record.files) || record.evidence.specHash !== record.specHash || record.evidence.evaluatorVersion !== evaluatorVersion) throw new SynthesisError("Only a fresh accepted, unapplied candidate can be applied.", 409);
      const targets: Array<{file: string; target: string; after: string}> = [];
      for (const [file, after] of Object.entries(record.files)) {
        const target = await containedPath(record.rootPath, `${record.outputPath}/${file}`);
        if (await readOptional(target) !== record.baseline[file]) throw new SynthesisError(`Apply conflict: ${file} changed since checkout. Nothing was applied.`, 409);
        if (record.baseline[file] !== after) targets.push({file, target, after});
      }
      const applied: typeof targets = [];
      try {
        for (const item of targets) {
          await fs.mkdir(path.dirname(item.target), {recursive: true});
          await containedPath(record.rootPath, `${record.outputPath}/${item.file}`);
          if (await readOptional(item.target) !== record.baseline[item.file]) throw new SynthesisError(`Apply conflict: ${item.file} changed during Apply.`, 409);
          const temporary = `${item.target}.${randomUUID()}.tmp`;
          try { await fs.writeFile(temporary, item.after, {flag: "wx"}); await fs.rename(temporary, item.target); }
          finally { await fs.unlink(temporary).catch(() => {}); }
          applied.push(item);
        }
      } catch (error) {
        // Best-effort rollback only our own exact bytes; never clobber subsequent user edits.
        for (const item of applied.reverse()) {
          await containedPath(record.rootPath, `${record.outputPath}/${item.file}`);
          if (await readOptional(item.target) === item.after) {
            const before = record.baseline[item.file];
            if (before === null) await fs.unlink(item.target); else await fs.writeFile(item.target, before);
          }
        }
        throw error;
      }
      record.appliedAt = stamp(); await this.event(record, "apply", `${targets.length} candidate files applied to ${record.outputPath}.`, "ok");
    });
  }
  /** The candidate's page as one self-contained document (its styles and scripts inlined): it loads
   * nothing else, so it runs in a sandboxed frame here and on a paired device alike. */
  async preview(id: string, file = "index.html"): Promise<string> {
    const record = await this.read(id); relativePath(file);
    if (!/\.html$/.test(file) || !Object.hasOwn(record.files, file)) throw new SynthesisError("Preview artifact not found.", 404);
    return previewDocument(record.files, file);
  }
  private async event(record: RunRecord, step: string, message: string, status: ActivityEvent["status"], extra: Partial<ActivityEvent> = {}): Promise<void> {
    record.phase = step; record.updatedAt = stamp();
    const sequence = (record.events.at(-1)?.sequence ?? 0) + 1;
    record.events.push({sequence, at: stamp(), step, message, status, iteration: record.iteration, ...extra});
    if (record.events.length > 2000) record.events.splice(0, record.events.length - 2000);
    await this.save(record);
  }
  private async save(record: RunRecord): Promise<void> { await writeJsonAtomically(path.join(this.directory, `${runId(record.id)}.json`), record); }
  private async read(id: string): Promise<RunRecord> {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${runId(id)}.json`), "utf8")) as RunRecord; }
    catch (error) { if (isMissingFile(error)) throw new SynthesisError("Synthesis run not found.", 404); throw error; }
  }
  private async ids(): Promise<string[]> { return (await fs.readdir(this.directory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).map(file => file.slice(0, -5)); }
}
