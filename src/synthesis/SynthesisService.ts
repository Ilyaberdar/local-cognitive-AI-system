import fs from "node:fs/promises";
import { previewDocument } from "./preview";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectStore } from "../projects/ProjectStore";
import { LocalModelManagerRegistry } from "../llm/LocalModelManager";
import { LLMService } from "../llm/LLMService";
import { ManagedModel, ProviderDescriptor, ProviderModel } from "../types";
import { preciseLocalGenerationSettings, resolveLocalGenerationSettings } from "../local/GenerationSettings";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { compileProgram, namedProviders, SourceSpan, SpecProgram } from "./language";
import { BudgetExhausted, Interpreter } from "./Interpreter";
import { ActivityEvent, Evidence, EvidenceCase, RunRecord, RunStatus, SynthesisError, SynthesisModule, SynthesisRun } from "./types";
import { containedPath, filesHash, hash, MAX_ARTIFACT_BYTES, readOptional, readText, relativePath } from "./paths";
import { calculatorTemplate, emptyModuleTemplate, ModuleFiles, ModuleTemplate, rateLimiterTemplate, repositoryReviewTemplate } from "./templates";
import { discoverModules, moduleDirectory, moduleFolders, moduleName, moduleSources, sourceId } from "./modules";
import { evaluateCalculator, evaluatorVersion, supportedEvaluators } from "./evaluators";
import { CheckOptions, contractChecksVersion, runCheck } from "./checks";
import { matchesGlob } from "./checks/architecture";
import { AgentSpec, AgentSummary, CandidateStore, gatedLlm, MAX_TASK_CHARS, Permission, permission, runAgents, SynthesisFileTools, splitGoal, synthesizeResults, TaskResult } from "./agents";
import { AgentRunStore } from "../agents/runtime/AgentRunStore";
import type { AgentCounts } from "./types";

interface Services {
  projects: ProjectStore;
  models: Pick<LocalModelManagerRegistry, "listAllModels">;
  /** `shape`: a local model serving several requests at once (agents), each with its own context. */
  loadModel: (model: ManagedModel, signal: AbortSignal, shape?: {parallel: number; contextSize?: number}) => Promise<void>;
  llm: Pick<LLMService, "generateObject" | "generateText">;
  /** The models a cloud provider lists, and the providers set up here (cloud-files-v1). */
  catalog?: {listAll(providerId?: string): Promise<ProviderModel[]>};
  providers?: () => ProviderDescriptor[];
  /** The model service agents run on (agents-v1): their loops call it directly. */
  agents?: {llm: LLMService};
  /** Where Tests gates run (a sandbox and a work folder); tests of this service replace them. */
  checks?: Omit<CheckOptions, "signal">;
}
/** Evidence names the evaluators that made it: the calculator adapters and the contract checks. */
const EVALUATOR_VERSION = `${evaluatorVersion}+${contractChecksVersion}`;
/** Source in the languages the contract checks know, plus the web files of the calculator. */
const ARTIFACT_TYPES = /\.(?:js|mjs|cjs|ts|mts|cts|py|c|cc|cpp|cxx|h|hh|hpp|hxx|inl|json|html|css|txt|md)$/;
const MAX_SUITE_FILES = 24, MAX_SUITE_BYTES = 512 * 1024;
/** The most interpreter steps a flow may declare with `limit steps`. */
const MAX_STEPS = 1_000_000;
/** The most agent tasks one run may start, and agents at once in one parallel_map. */
const MAX_AGENT_TASKS = 1000, MAX_CONCURRENCY = 64;
/** The most files a candidate holds, declared ones and those agents create. */
const MAX_CANDIDATE_FILES = 300;
/** How much of the project a run keeps as its agents first read it. */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
/** Calls that only make a value (rights, an agent's description): no activity events. */
const QUIET_CALLS = new Set(["files.read", "files.write", "files.delete", "agent"]);
const counts = (agents: AgentSummary[]): AgentCounts => {
  const total = {total: agents.length, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0};
  for (const agent of agents) total[agent.status]++;
  return total;
};
/** The contract's test files: its tests section and every file a Tests gate runs. */
const suiteFiles = (spec: SpecProgram): string[] => [...new Set([...(spec.tests ?? []),
  ...spec.gates.flatMap(gate => gate.check?.kind === "tests" ? gate.check.files : [])])];
/** What the model reads next: each failing gate's own items (exact, with file:line), else its message. */
function violations(evidence: Evidence, generationErrors: string[]): string[] {
  const items = evidence.gates.filter(gate => gate.status !== "Pass")
    .flatMap(gate => gate.feedback?.length ? gate.feedback.map(item => `${gate.id}: ${item}`) : [`${gate.id}: ${gate.message}`]);
  return [...items, ...generationErrors].slice(0, 12).map(item => item.length > 300 ? `${item.slice(0, 299)}…` : item);
}
/** What each kind of file is, for a small model that writes one file at a time. */
const LANGUAGE_HINTS: Array<[RegExp, string]> = [
  [/\.css$/, "This task is ONLY a short CSS stylesheet, at most 40 simple rules. Do not put JavaScript or HTML in CSS. Other files handle all behavior. Avoid repetition."],
  [/\.html$/, "This task is ONLY the HTML document. Use the required element IDs. Load the peer JavaScript once after all controls. Do not duplicate logic already present in peer JavaScript."],
  [/\.js$/, "This task is ONLY JavaScript. Implement the public functions and event handlers required by the contract; no HTML or CSS."],
  [/\.(?:mjs|cjs)$/, "This task is ONLY JavaScript for Node.js, in the module syntax the file's extension implies, with Node's built-in modules only."],
  [/\.(?:ts|mts|cts)$/, "This task is ONLY TypeScript for Node.js: ES module imports with explicit .ts extensions for local files, erasable type syntax only (no enum, namespace or constructor parameter properties), no packages."],
  [/\.py$/, "This task is ONLY Python 3 with the standard library."],
  [/\.(?:c|cc|cpp|cxx)$/, "This task is ONLY C++20 source with the standard library. Implement the declarations of the frozen headers exactly as declared; include them, never redeclare them differently."],
  [/\.(?:h|hh|hpp|hxx|inl)$/, "This task is ONLY a C++ header with #pragma once: declarations and small inline functions."],
  [/\.json$/, "This task is ONLY a JSON document."]
];
/** What this runtime (V1, local files) can run, as diagnostics: Run refuses the errors, and a
 * module shows them as soon as it is opened. */
function profileDiagnostics(compiled: ReturnType<typeof compileProgram>, specPath: string, flowPath: string) {
  const found: Array<{severity: "error" | "warning"; code: string; message: string; file: string; line: number; column: number}> = [];
  const add = (severity: "error" | "warning", code: string, message: string, file: string) => found.push({severity, code, message, file, line: 1, column: 1});
  if (!compiled.spec || !compiled.flow) return found;
  if (compiled.flow.limits.iterations < 1 || compiled.flow.limits.iterations > 32 || compiled.flow.limits.timeMs > 7200000) {
    add("error", "FLOW_LIMIT_RANGE", "V1 supports at most 32 iterations and 120 minutes per run.", flowPath);
  }
  if ((compiled.flow.limits.steps ?? 0) > MAX_STEPS) add("error", "FLOW_LIMIT_RANGE", `A run takes at most ${MAX_STEPS.toLocaleString("en")} steps.`, flowPath);
  if ((!compiled.spec.artifacts.length && !compiled.spec.areas?.length) || compiled.spec.artifacts.length > 12 || (compiled.spec.areas?.length ?? 0) > 12) add("error", "SPEC_ARTIFACT_LIMIT", "Declare 1 to 12 artifact files, or a files area, and at most 12 areas.", specPath);
  if ((compiled.spec.frozen ?? []).length > 12) add("error", "SPEC_ARTIFACT_LIMIT", "Declare at most 12 frozen files.", specPath);
  for (const file of [...compiled.spec.artifacts, ...compiled.spec.frozen ?? []]) {
    try { relativePath(file); }
    catch { add("error", "SPEC_ARTIFACT_PATH", `${file}: use a project-relative path without spaces, hidden folders or "..".`, specPath); continue; }
    if (!ARTIFACT_TYPES.test(file)) add("error", "SPEC_ARTIFACT_TYPE", `${file}: local-files-v1 supports source files (JavaScript, TypeScript, Python, C and C++), json, html, css, txt and md.`, specPath);
  }
  const suite = suiteFiles(compiled.spec);
  if (suite.length > MAX_SUITE_FILES) add("error", "SPEC_TEST_LIMIT", `Declare at most ${MAX_SUITE_FILES} test files.`, specPath);
  for (const file of suite) {
    try { relativePath(file); } catch { add("error", "SPEC_TEST_PATH", `${file}: use a path relative to the contract's folder, without spaces, hidden folders or "..".`, specPath); }
  }
  for (const gate of compiled.spec.gates) {
    if (!gate.check && (compiled.spec.evaluator !== "calculator-v1" || !supportedEvaluators.has(gate.evaluatorId))) {
      add("warning", "SPEC_EVALUATOR_UNREGISTERED", `No trusted evaluator is registered for ${gate.evaluatorId}: the gate ${gate.id} will be Unknown and cannot pass.`, specPath);
    }
  }
  return found;
}
const activeStatus = (status: RunStatus) => status === "running" || status === "queued";
const stamp = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** An agent's step as a person reads it: the action with its file, the result's text (a file's lines,
 * not escaped JSON) and whether it was refused, at most 4,000 characters. */
function readableTurn(turn: {type: "tool" | "result" | "format_error"; content: string}): {type: string; content: string; ok?: boolean} {
  try {
    if (turn.type === "tool") {
      const action = JSON.parse(turn.content) as {tool: string; arguments?: Record<string, unknown>};
      const args = action.arguments ?? {};
      const target = typeof args.path === "string" ? args.path : Array.isArray(args.paths) ? args.paths.join(", ") : "";
      // Lines only when the agent chose them: a whole read starts at 1 by default.
      const detail = action.tool === "file.read" && (args.endLine || Number(args.startLine) > 1) ? ` · lines ${String(args.startLine ?? 1)}${args.endLine ? `–${String(args.endLine)}` : " on"}`
        : action.tool === "file.search" ? ` · "${String(args.query ?? "")}"` : action.tool === "file.checkout" && args.waitSeconds ? ` · waits ${String(args.waitSeconds)} s` : "";
      return {type: "tool", content: `${action.tool} ${target}${detail}`.trim()};
    }
    if (turn.type === "result") {
      const result = JSON.parse(turn.content) as {ok?: boolean; output?: string};
      let text = String(result.output ?? "");
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        text = typeof data.content === "string" ? data.content : JSON.stringify(data, null, 1);
      } catch { /* Plain text output. */ }
      return {type: "result", ok: result.ok !== false, content: text.slice(0, 4000)};
    }
  } catch { /* Not the shape the loop writes: shown as it is. */ }
  return {type: turn.type, content: turn.content.slice(0, 4000)};
}
/** Providers whose installed models the app lists itself (local runtimes); the rest are listed by the provider. */
const MANAGED_PROVIDERS = new Set(["llamacpp", "lmstudio", "ollama"]);
/** A provider's model as a run's model: it needs no loading and has no file size. */
const cloudModel = (model: ProviderModel, providerName: string): ManagedModel => ({id: model.id, displayName: model.id, providerId: model.providerId,
  providerName: model.providerName || providerName, ...(model.vision !== undefined ? {vision: model.vision} : {}), loaded: true, loadedInstanceIds: []});
const runId = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new SynthesisError("Invalid run identifier."); return id; };
// Synthesis turns produce structured source/JSON and should not inherit a creative chat profile.
const synthesisSampling = resolveLocalGenerationSettings(preciseLocalGenerationSettings()).sampling;
function publicRun(record: RunRecord): SynthesisRun {
  const {files, baseline, specSource, flowSource, rootPath, specHash, spec, flow, version, outputPath, frozen, suite, suiteHash, removed, agentRuns, ...run} = record;
  return run;
}

/** How a run is started: an id the caller reserved, and whether a paired device starts it. */
export interface LaunchOptions { runId?: string; device?: {guard: () => Promise<string | undefined>} }

/** Project source is read-only until Apply. Runs contain frozen sources and an isolated artifact tree. */
export class SynthesisService {
  private readonly directory: string;
  private readonly active = new Map<string, {controller: AbortController; done: Promise<void>; interruption: boolean}>();
  /** How often a run a paired device started asks whether the device may still use its project. */
  guardIntervalMs = 5_000;
  private accepting = true;
  private readonly pendingStarts = new Set<Promise<SynthesisRun>>();
  private reservations = 0;
  private disposed = false;
  /** Each run's record is written by one writer at a time: the last write holds the latest state. */
  private readonly writes = new Map<string, {last: Promise<void>; queued?: {record: RunRecord; done: Promise<void>}}>();
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
  /** Whether Synthesis may send the project's contract and files to cloud models. Set only on this computer. */
  async cloudModels(projectId: string): Promise<{allowed: boolean}> { return {allowed: (await this.project(projectId)).cloudModels === true}; }
  async setCloudModels(projectId: string, allowed: unknown): Promise<{allowed: boolean}> {
    await this.project(projectId);
    if (typeof allowed !== "boolean") throw new SynthesisError("allowed must be true or false.");
    const saved = await this.services.projects.update(projectId, {cloudModels: allowed});
    return {allowed: saved?.cloudModels === true};
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
    // What Run would refuse about the providers the flow names: unknown, without a key, or cloud without consent.
    if (compiled.flow && !diagnostics.some(item => item.severity === "error")) {
      const seen = new Set<string>();
      for (const {provider, span} of namedProviders(compiled.flow)) {
        if (provider === "llamacpp" || seen.has(provider)) continue;
        seen.add(provider);
        const descriptor = this.services.providers?.().find(item => item.id === provider);
        const add = (code: string, message: string) => diagnostics.push({severity: "error", code, message, file: flowPath, line: span.start.line, column: span.start.column});
        if (!descriptor) add("SYNTHESIS_PROVIDER", `No provider ${provider} is set up here. Add it in Settings → Models & Providers.`);
        else if (!descriptor.configured) add("SYNTHESIS_PROVIDER", `${descriptor.name} has no key or is turned off. Set it up in Settings → Models & Providers.`);
        else if (descriptor.capabilities?.local !== true && project.cloudModels !== true) add("SYNTHESIS_CLOUD_CONSENT", `This project does not allow cloud models: the contract and project files would be sent to ${descriptor.name}. Allow cloud models for the project first.`);
      }
    }
    const folder = path.posix.dirname(specPath);
    for (const file of compiled.spec ? suiteFiles(compiled.spec) : []) {
      const relative = folder === "." ? file : `${folder}/${file}`;
      try { await fs.access(await containedPath(project.rootPath, relative)); }
      catch { diagnostics.push({severity: "error", code: "SPEC_TEST_MISSING", message: `Test file ${file} was not found next to the contract (${relative}).`, file: specPath, line: 1, column: 1}); }
    }
    return {id, name: compiled.spec?.module ?? name, specPath, flowPath, specSource, flowSource, valid: !diagnostics.some(item => item.severity === "error"), diagnostics};
  }
  async createModule(projectId: string, name = "Calculator", options: {template?: ModuleTemplate; directory?: string} = {}): Promise<SynthesisModule> {
    const project = await this.project(projectId); moduleName(name);
    const directory = moduleDirectory(options.directory);
    const relative = directory ? `${directory}/${name}` : name;
    const sources = moduleSources(sourceId(`${relative}/${name}`));
    const folder = await containedPath(project.rootPath, relative);
    if (options.template !== undefined && !["calculator", "empty", "rate-limiter", "repository-review"].includes(options.template)) throw new SynthesisError("Choose an empty module, the calculator, the rate limiter or the repository review template.");
    const template: ModuleFiles = options.template === "empty" ? emptyModuleTemplate(name) : options.template === "rate-limiter" ? rateLimiterTemplate(name)
      : options.template === "repository-review" ? repositoryReviewTemplate(name) : calculatorTemplate(name);
    // Check both final paths before any mutation (including path length limits).
    const specFile = await containedPath(project.rootPath, sources.specPath);
    const flowFile = await containedPath(project.rootPath, sources.flowPath);
    // mkdir is exclusive: never overwrite an authored module, even if its files are incomplete.
    if (directory) await fs.mkdir(await containedPath(project.rootPath, directory), {recursive: true});
    try { await fs.mkdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SynthesisError(`This module already exists at ${relative}. Choose another name or folder; existing files were not changed.`, 409); throw error; }
    await fs.writeFile(specFile, template.spec, {flag: "wx"});
    await fs.writeFile(flowFile, template.flow, {flag: "wx"});
    // The template's tests go next to the contract, as an engineer's would.
    for (const [file, content] of Object.entries(template.tests ?? {})) {
      const target = await containedPath(project.rootPath, `${relative}/${file}`);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, content, {flag: "wx"});
    }
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
   * finds the run it made instead of making another. `device`: a paired device starts the run; it
   * stops (cancelled) once `guard` names why the device may no longer use the project. */
  async start(projectId: string, id: string, options: LaunchOptions = {}): Promise<SynthesisRun> {
    const existing = options.runId ? await this.existing(options.runId) : undefined;
    if (existing) return existing;
    const module = await this.module(projectId, id);
    if (!module.valid) throw new SynthesisError(module.diagnostics.map(item => `${item.line}:${item.column} ${item.message}`).join("\n"));
    return this.launch(projectId, id, module.specSource!, module.flowSource!, undefined, options);
  }
  async restart(id: string, options: LaunchOptions = {}): Promise<SynthesisRun> {
    const existing = options.runId ? await this.existing(options.runId) : undefined;
    if (existing) return existing;
    const record = await this.read(id);
    if (activeStatus(record.status) || record.status === "accepted") throw new SynthesisError("Only unsuccessful or interrupted runs may be restarted.", 409);
    return this.launch(record.projectId, record.moduleId, record.specSource, record.flowSource, record.id, options, record.suite);
  }
  /** A run, if one with this id exists. */
  async existing(id: string): Promise<SynthesisRun | undefined> {
    try { return await this.get(id); } catch (error) { if (error instanceof SynthesisError && error.statusCode === 404) return undefined; throw error; }
  }
  /** Runs executing now (and starts being prepared): a server drains them before it stops. */
  activeCount(): number { return this.active.size + this.reservations; }
  /** The server is draining: no new run starts; running ones finish. */
  stopAccepting(): void { this.accepting = false; }
  private launch(projectId: string, id: string, specSource: string, flowSource: string, restartedFrom: string | undefined, options: LaunchOptions, suite?: Record<string, string>): Promise<SynthesisRun> {
    if (this.disposed) throw new SynthesisError("Runtime is stopping.", 409);
    if (!this.accepting) throw new SynthesisError("The server is shutting down. Try again when it is back.", 409);
    if (this.active.size + this.reservations >= 2) throw new SynthesisError("At most two Synthesis runs may execute concurrently.", 409);
    this.reservations++;
    const pending = this.prepareLaunch(projectId, id, specSource, flowSource, restartedFrom, options, suite).finally(() => {
      this.reservations--; this.pendingStarts.delete(pending);
    });
    this.pendingStarts.add(pending);
    return pending;
  }
  private async prepareLaunch(projectId: string, id: string, specSource: string, flowSource: string, restartedFrom: string | undefined, {runId: reservedId, device}: LaunchOptions, frozenSuite?: Record<string, string>): Promise<SynthesisRun> {
    const project = await this.project(projectId);
    if (this.disposed) throw new SynthesisError("Runtime is stopping.", 409);
    const compiled = compileProgram(specSource, flowSource);
    if (!compiled.spec || !compiled.flow || compiled.diagnostics.some(item => item.severity === "error")) throw new SynthesisError("Frozen DSL source is invalid. Fix diagnostics before running.");
    const refusal = profileDiagnostics(compiled, "", "").find(item => item.severity === "error");
    if (refusal) throw new SynthesisError(refusal.message);
    if (compiled.flow.limits.iterations > 32 || compiled.flow.limits.timeMs > 7200000) throw new SynthesisError("V1 supports at most 32 iterations and 120 minutes per run.");
    if ((!compiled.spec.artifacts.length && !compiled.spec.areas?.length) || compiled.spec.artifacts.length > 12 || (compiled.spec.areas?.length ?? 0) > 12) throw new SynthesisError("Declare 1 to 12 artifact files, or a files area, and at most 12 areas.");
    for (const file of [...compiled.spec.artifacts, ...compiled.spec.frozen]) {
      relativePath(file);
      if (!ARTIFACT_TYPES.test(file)) throw new SynthesisError(`${file}: local-files-v1 does not support this file type.`);
    }
    // A restart runs the tests it was started with; a new run reads them now and keeps them.
    const suite = frozenSuite ?? await this.readSuite(project.rootPath, id, compiled.spec);
    const record: RunRecord = {
      version: 1, id: reservedId ? runId(reservedId) : randomUUID(), projectId, moduleId: id, moduleName: compiled.spec.module,
      rootPath: project.rootPath, specSource, flowSource, specHash: hash(specSource), spec: compiled.spec, flow: compiled.flow,
      status: "queued", phase: "queued", iteration: 0, createdAt: stamp(), updatedAt: stamp(), restartedFrom, ...(device ? {startedBy: "device" as const} : {}),
      files: {}, baseline: {}, events: [], models: [], usage: {inputTokens: 0, outputTokens: 0, calls: 0},
      frozen: {}, suite, ...(Object.keys(suite).length ? {suiteHash: filesHash(suite)} : {})
    };
    await this.save(record);
    if (this.disposed) {
      record.status = "interrupted"; record.error = "Runtime stopped before this run was admitted.";
      await this.save(record); throw new SynthesisError(record.error, 409);
    }
    const item = {controller: new AbortController(), done: Promise.resolve(), interruption: false};
    this.active.set(record.id, item);
    item.done = this.execute(record, item, device?.guard).finally(() => { this.active.delete(record.id); });
    return publicRun(record);
  }
  /** The contract's test files, next to its .lcspec: the model never writes them. */
  private async readSuite(root: string, moduleId: string, spec: SpecProgram): Promise<Record<string, string>> {
    const folder = path.posix.dirname(moduleSources(moduleId).specPath);
    const suite: Record<string, string> = {};
    let total = 0;
    for (const file of suiteFiles(spec)) {
      const relative = folder === "." ? file : `${folder}/${file}`;
      try { suite[file] = await readText(await containedPath(root, relative)); }
      catch (error) { throw new SynthesisError(isMissingFile(error) ? `Test file ${file} was not found next to the contract.` : `Test file ${file} could not be read.`); }
      total += Buffer.byteLength(suite[file]);
      if (total > MAX_SUITE_BYTES) throw new SynthesisError("The contract's test files may hold at most 512 KiB together.");
    }
    return suite;
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

  private async execute(record: RunRecord, item: {controller: AbortController; interruption: boolean}, guard?: () => Promise<string | undefined>): Promise<void> {
    const signal = item.controller.signal;
    const timer = setTimeout(() => item.controller.abort(new BudgetExhausted("Wall-clock time budget exhausted.")), record.flow.limits.timeMs);
    timer.unref();
    const watch = guard ? setInterval(() => void guard().then(reason => { if (reason && !signal.aborted) item.controller.abort(new Error(reason)); }, () => undefined), this.guardIntervalMs) : undefined;
    watch?.unref();
    const candidate = Object.freeze({kind: "candidate", id: record.id, runId: record.id,
      get path() { return record.outputPath ?? ""; }, get hash() { return filesHash(record.files); }});
    const spec = Object.freeze({kind: "spec", hash: record.specHash});
    // The models this run listed or loaded: a selection must come from one of its lists.
    const listed = new WeakSet<ManagedModel>();
    const roles = new Set<object>();
    // What only this run made: rights, agents' descriptions and parallel_map's results.
    const permissions = new WeakSet<object>(), agentSpecs = new WeakSet<object>(), resultLists = new WeakSet<object>();
    let mapCalls = 0;
    let pendingSave: NodeJS.Timeout | undefined;
    const saveSoon = () => { pendingSave ??= setTimeout(() => { pendingSave = undefined; void this.save(record).catch(() => undefined); }, 1000); pendingSave.unref(); };
    const evaluationSignatures: string[] = [];
    let lastEvidence: Evidence | undefined;
    let generationErrors: string[] = [];
    let terminal: {status: RunStatus; evidence?: Evidence} | undefined;
    const requireCandidate = (value: unknown) => { if (value !== candidate || !record.outputPath) throw new SynthesisError("Expected the checked-out candidate."); };
    const requireSpec = (value: unknown) => { if (value !== spec) throw new SynthesisError("Expected the frozen module specification."); };
    const evidenceMatches = (value: unknown): value is Evidence => value === lastEvidence && !!lastEvidence &&
      lastEvidence.candidateHash === filesHash(record.files) && lastEvidence.specHash === record.specHash && lastEvidence.evaluatorVersion === EVALUATOR_VERSION &&
      lastEvidence.suiteHash === record.suiteHash;
    // A loaded model becomes a role: only the app's own llama.cpp runtime loads; others answer on request.
    const role = async (model: ManagedModel, shape?: {parallel: number; contextSize?: number}) => {
      if (model.providerId === "llamacpp") await this.services.loadModel(model, signal, shape);
      const handle = Object.freeze({model}); roles.add(handle);
      if (!record.models.some(item => item.id === model.id && item.providerId === model.providerId)) record.models.push(model);
      return handle;
    };
    const moduleFolder = path.posix.dirname(moduleSources(record.moduleId).specPath);
    // Project files as the run's agents first read them: one version for all of them, and for Grounded.
    const snapshot = new Map<string, string | null>();
    let snapshotBytes = 0;
    // The contract's own files as project paths: its sources and every test file, next to the .lcspec.
    // Compared without case: on a file system that ignores it (macOS, Windows) Tests/A.ts is tests/a.ts.
    const contractPaths = new Set([moduleSources(record.moduleId).specPath, moduleSources(record.moduleId).flowPath,
      ...Object.keys(record.suite ?? {}).map(file => moduleFolder === "." ? file : `${moduleFolder}/${file}`)].map(item => item.toLowerCase()));
    const folderKey = moduleFolder.toLowerCase();
    // The candidate as agents see it: the run's copy of what they may change, over the project.
    const store: CandidateStore = {
      root: record.rootPath, files: record.files, baseline: record.baseline,
      get outputPath() { return record.outputPath; },
      get removed() { return record.removed ??= []; }, set removed(value) { record.removed = value; },
      writable: relative => {
        const key = relative.toLowerCase();
        if (record.spec.frozen.some(file => file.toLowerCase() === key)) return `${relative} is a frozen file: the engineer's, never changed by the run.`;
        const twin = [...Object.keys(record.files), ...record.spec.artifacts].find(file => file !== relative && file.toLowerCase() === key);
        if (twin) return `${relative} differs from ${twin} only in case: write ${twin}.`;
        if (!record.spec.artifacts.includes(relative) && !(record.spec.areas ?? []).some(area => matchesGlob(relative, area))) {
          return `${relative} is not a file of the contract: write ${[...record.spec.artifacts, ...(record.spec.areas ?? [])].join(", ")} (under ${record.outputPath}).`;
        }
        if (!ARTIFACT_TYPES.test(relative)) return `${relative}: candidate files are source, json, html, css, txt or md.`;
        if (!Object.hasOwn(record.files, relative) && Object.keys(record.files).length >= MAX_CANDIDATE_FILES) return `A candidate holds at most ${MAX_CANDIDATE_FILES} files.`;
        return undefined;
      },
      // No agent reads a contract or its tests, hidden ones included: not this module's (wherever it is,
      // the project root too), and no .lcspec or .lcflow of any other module.
      // The file tools check the path as the disk spells it, so a folder named Synthesis is hidden
      // however the agent writes it, and a folder that only resembles it (src/synthesis) is not.
      hidden: target => {
        const key = target.toLowerCase();
        return target.split("/").includes("Synthesis") || /\.(?:lcspec|lcflow)$/.test(key) || contractPaths.has(key) ||
          (folderKey !== "." && (key === folderKey || key.startsWith(`${folderKey}/`)));
      },
      changed: () => { lastEvidence = undefined; delete record.evidence; saveSoon(); },
      snapshot,
      keep: (file, content) => {
        const kept = snapshot.get(file);
        if (kept !== undefined) return kept;
        const size = Buffer.byteLength(content ?? "");
        if (snapshotBytes + size <= MAX_SNAPSHOT_BYTES) { snapshot.set(file, content); snapshotBytes += size; }
        return content;
      }
    };
    const resolveModel = async (providerId: string, id: unknown): Promise<ManagedModel> => {
      const provider = await this.provider(record, providerId);
      if (!provider.managed) {
        if (typeof id !== "string" || !id.trim() || id.length > 200) throw new SynthesisError("Name the provider's model ID.");
        return cloudModel({id, providerId: provider.id, providerName: provider.name}, provider.name);
      }
      const model = (await this.services.models.listAllModels(provider.id)).find(item => item.providerId === provider.id && (item.id === id || item.displayName === id));
      if (!model) throw new SynthesisError(provider.id === "llamacpp" ? "model() expects an exact installed local model ID or display name." : `${provider.name} has no model ${String(id)}.`);
      return model;
    };
    const call = async (name: string, args: unknown[], named: Record<string, unknown>, span: SourceSpan, receiver?: unknown): Promise<unknown> => {
      signal.throwIfAborted();
      const quiet = QUIET_CALLS.has(name);
      if (!quiet) await this.event(record, name, name, "running", {line: span.start.line, file: moduleSources(record.moduleId).flowPath});
      // Keys and the project's consent may change during a run: checked again before a cloud model reads anything.
      const roleModel = name.startsWith("role.") && receiver && typeof receiver === "object" && roles.has(receiver) ? (receiver as {model: ManagedModel}).model : undefined;
      if (roleModel && roleModel.providerId !== "llamacpp") await this.provider(record, roleModel.providerId);
      let value: unknown;
      switch (name) {
        case "models.list": {
          const provider = await this.provider(record, String(named.provider ?? "llamacpp"));
          const available = (provider.managed ? await this.services.models.listAllModels(provider.id)
            : (await this.services.catalog?.listAll(provider.id) ?? []).map(item => cloudModel(item, provider.name))).filter(model => model.providerId === provider.id);
          for (const model of available) listed.add(model);
          // This call's list: models listed or loaded earlier in the run are not in it again.
          value = available;
          break;
        }
        case "models.select": {
          if (!Array.isArray(args[0])) throw new SynthesisError("models.select expects the result of models.list.");
          const max = named.max_size === undefined ? Infinity : Number(named.max_size);
          if (!(max > 0) || (named.max_size !== undefined && !Number.isFinite(max))) throw new SynthesisError("max_size must be positive and finite.");
          const list = args[0].filter((model): model is ManagedModel => !!model && listed.has(model) && (named.provider === undefined || model.providerId === named.provider));
          if (Number.isFinite(max) && list.length && list.every(model => model.sizeBytes === undefined && model.providerId !== "llamacpp")) {
            throw new SynthesisError("max_size compares the sizes of local GGUF files; cloud models have none. Choose with prefer or id.");
          }
          const exact = named.id === undefined ? undefined : String(named.id);
          const prefer = String(named.prefer ?? "").toLowerCase();
          const eligible = list.filter(model => (exact === undefined || model.id === exact || model.displayName === exact) &&
            (!Number.isFinite(max) || (typeof model.sizeBytes === "number" && model.sizeBytes > 0 && model.sizeBytes <= max)));
          eligible.sort((a,b) => Number(`${b.id} ${b.displayName}`.toLowerCase().includes(prefer)) - Number(`${a.id} ${a.displayName}`.toLowerCase().includes(prefer)) || (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity) || a.id.localeCompare(b.id));
          if (!eligible[0]) throw new SynthesisError(exact !== undefined ? `No listed model is ${exact}.` : "No installed local model matches the selection. Install a suitable model in Models or adjust max_size.");
          value = eligible[0]; break;
        }
        case "model": {
          const model = await resolveModel(String(named.provider ?? "llamacpp"), args[0]);
          listed.add(model);
          value = await role(model);
          break;
        }
        case "files.read": case "files.write": case "files.delete": {
          value = permission(name.slice(6) as Permission["access"], args, named.own); permissions.add(value as object); break;
        }
        case "agent": {
          let model: ManagedModel;
          if (args.length) {
            if (!args[0] || typeof args[0] !== "object" || !roles.has(args[0])) throw new SynthesisError("agent() takes a loaded model role, or provider and model.");
            model = (args[0] as {model: ManagedModel}).model;
          } else model = (await role(await resolveModel(String(named.provider), named.model))).model;
          const tools = named.tools ?? [];
          if (!Array.isArray(tools) || tools.some(item => !item || typeof item !== "object" || !permissions.has(item))) throw new SynthesisError("tools is a list of files.read(...), files.write(...) and files.delete(...).");
          const rights = {read: [] as string[], write: [] as string[], delete: [] as string[], own: [] as string[]};
          for (const item of tools as Permission[]) { rights[item.access].push(...item.patterns); if (item.own) rights.own.push(...item.patterns); }
          const instructions = named.instructions ?? "";
          if (typeof instructions !== "string" || instructions.length > 6000) throw new SynthesisError("An agent's instructions are at most 6,000 characters.");
          const steps = named.steps ?? 16;
          if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > 60) throw new SynthesisError("An agent takes 1 to 60 steps.");
          const spec: AgentSpec = {kind: "agent", model, rights, instructions, steps: steps as number};
          value = Object.freeze(spec); agentSpecs.add(value as object); break;
        }
        case "parallel_map": {
          if (record.flow.policy !== "agents-v1") throw new SynthesisError('parallel_map needs policy = "agents-v1".');
          if (!this.services.agents) throw new SynthesisError("This runtime cannot run agents.");
          const agents = (Array.isArray(args[0]) ? args[0] : [args[0]]) as AgentSpec[];
          if (!agents.length || agents.some(item => !item || typeof item !== "object" || !agentSpecs.has(item))) throw new SynthesisError("parallel_map takes an agent or a list of agents made with agent(...).");
          const tasks = args[1];
          if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => typeof task !== "string" || !task.trim() || task.length > MAX_TASK_CHARS)) throw new SynthesisError(`parallel_map takes a list of tasks, each a text of at most ${MAX_TASK_CHARS} characters.`);
          if ((record.agentRuns?.length ?? 0) + tasks.length > MAX_AGENT_TASKS) throw new SynthesisError(`A run starts at most ${MAX_AGENT_TASKS} agent tasks.`);
          const concurrency = named.concurrency ?? Math.min(16, tasks.length);
          if (named.checkout !== undefined && named.checkout !== "optional" && named.checkout !== "required") throw new SynthesisError('checkout is "optional" or "required".');
          if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > MAX_CONCURRENCY) throw new SynthesisError(`concurrency is 1 to ${MAX_CONCURRENCY}.`);
          for (const agent of agents) for (const pattern of [...agent.rights.write, ...agent.rights.delete]) {
            if (!record.outputPath) throw new SynthesisError("Check out the candidate before giving agents write access: they write into it.");
            if (!pattern.startsWith(`${record.outputPath}/`)) throw new SynthesisError(`files.write("${pattern}") is outside the candidate folder ${record.outputPath}: agents write only there.`);
          }
          const call = ++mapCalls, earlier = record.agentRuns ?? [];
          await this.event(record, "agents", `${tasks.length} agents, ${Math.min(concurrency as number, tasks.length)} at a time`, "running", {line: span.start.line});
          // A provider that asks to slow down gets fewer requests at once; the run says so, at most every 30 s.
          let told = 0;
          const llm = gatedLlm(this.services.agents.llm, concurrency as number, {waited: (provider, ms) => {
            if (Date.now() - told < 30_000) return; told = Date.now();
            void this.event(record, "agents", `${provider} asked to slow down: fewer requests at once, retrying in ${Math.round(ms / 1000)} s`, "running", {line: span.start.line}).catch(() => undefined);
          }});
          const {results, summaries} = await runAgents({llm, baseDir: path.join(this.directory, "..", "agents", record.id), runId: record.id, call,
            module: {name: record.spec.module, description: record.spec.description}, store, agents, tasks: tasks as string[], concurrency: concurrency as number,
            failFast: named.on_error === "fail", checkoutRequired: named.checkout === "required", signal,
            admit: async spec => { await this.provider(record, spec.model.providerId); },
            update: current => { record.agentRuns = [...earlier, ...current]; record.agents = counts(record.agentRuns); saveSoon(); }});
          for (const summary of summaries) { record.usage.calls += summary.steps; record.usage.inputTokens += summary.inputTokens; record.usage.outputTokens += summary.outputTokens; }
          const list = Object.assign(results, {completed: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length});
          resultLists.add(list); value = list;
          await this.event(record, "agents", `${list.completed} of ${results.length} agents finished${list.failed ? `, ${list.failed} failed` : ""}`, list.failed ? "failed" : "ok", {line: span.start.line});
          break;
        }
        case "role.split": {
          if (!receiver || typeof receiver !== "object" || !roles.has(receiver)) throw new SynthesisError("Expected a loaded model role.");
          const model = (receiver as {model: ManagedModel}).model;
          const scope = named.paths;
          if (scope !== undefined && (!scope || typeof scope !== "object" || !permissions.has(scope) || (scope as Permission).access !== "read")) throw new SynthesisError("paths is a files.read(...) of the files the agents will read.");
          const paths = scope ? await new SynthesisFileTools(this.directory, store, {read: (scope as Permission).patterns, write: [], delete: []}).readable(400) : undefined;
          value = await splitGoal(this.services.llm, model, {goal: String(args[0] ?? ""), count: Number(args[1]), module: record.spec.module, description: record.spec.description,
            context: args[2] === undefined ? undefined : JSON.stringify(args[2]), paths, instruction: typeof named.instruction === "string" ? named.instruction : undefined, signal,
            spent: usage => this.usage(record, usage)});
          break;
        }
        case "role.synthesize": {
          if (!receiver || typeof receiver !== "object" || !roles.has(receiver)) throw new SynthesisError("Expected a loaded model role.");
          requireCandidate(args[0]); requireSpec(args[1]);
          if (!args[2] || typeof args[2] !== "object" || !resultLists.has(args[2])) throw new SynthesisError("synthesize takes the results of parallel_map.");
          const file = String(named.file ?? record.spec.artifacts.find(item => item.endsWith(".md")) ?? "");
          const refusal = file ? store.writable(file) : "Name the file to write: file = \"REPORT.md\".";
          if (refusal) throw new SynthesisError(refusal);
          const model = (receiver as {model: ManagedModel}).model;
          await this.event(record, "agent.generate", `Writing ${file} from ${(args[2] as TaskResult[]).length} results`, "running", {model: model.displayName, file});
          const content = await synthesizeResults(this.services.llm, model, {results: args[2] as TaskResult[], file, module: record.spec.module, description: record.spec.description,
            instruction: typeof named.instruction === "string" ? named.instruction : undefined,
            feedback: Array.isArray(named.feedback) ? named.feedback.flat(2).filter((item): item is string => typeof item === "string") : undefined,
            current: Array.isArray(named.feedback) && named.feedback.length ? record.files[file] : undefined, signal,
            progress: message => this.event(record, "agent.generate", message, "running", {model: model.displayName, file}),
            spent: usage => this.usage(record, usage)});
          if (!content || Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) throw new SynthesisError(`${file}: the model's text is empty or larger than ${MAX_ARTIFACT_BYTES / 1024} KiB.`);
          if (!Object.hasOwn(record.baseline, file)) record.baseline[file] = await readOptional(await containedPath(record.rootPath, `${record.outputPath}/${file}`));
          record.files[file] = content; record.removed = (record.removed ?? []).filter(item => item !== file);
          lastEvidence = undefined; delete record.evidence;
          await this.event(record, "agent.generate", `${file}: ${Buffer.byteLength(content)} bytes`, "ok", {model: model.displayName, file});
          value = candidate; break;
        }
        case "models.load": {
          const model = args[0] as ManagedModel;
          if (!model || !listed.has(model)) throw new SynthesisError("models.load expects a selected installed model.");
          const slots = named.slots ?? 1, context = named.context;
          if (!Number.isInteger(slots) || (slots as number) < 1 || (slots as number) > 16) throw new SynthesisError("slots is 1 to 16: the requests a local model serves at once.");
          if (context !== undefined && (!Number.isInteger(context) || (context as number) < 512 || (context as number) > 131072)) throw new SynthesisError("context is a slot's tokens, 512 to 131,072.");
          if ((slots !== 1 || context !== undefined) && model.providerId !== "llamacpp") throw new SynthesisError("slots and context apply to the app's own llama.cpp models.");
          value = await role(model, slots !== 1 || context !== undefined ? {parallel: slots as number, ...(context !== undefined ? {contextSize: context as number} : {})} : undefined);
          break;
        }
        case "freeze": requireSpec(args[0]); value = spec; break;
        case "checkout": {
          if (record.outputPath) throw new SynthesisError("Only one checkout is allowed per run.");
          const relative = relativePath(args[0]);
          if (relative.toLowerCase().split("/").includes("synthesis")) throw new SynthesisError("Candidate cannot overwrite authored DSL.");
          record.outputPath = relative;
          for (const file of record.spec.artifacts) {
            const target = await containedPath(record.rootPath, `${relative}/${file}`);
            record.baseline[file] = await readOptional(target);
            if (record.baseline[file] !== null) record.files[file] = record.baseline[file]!;
          }
          record.frozen = {};
          for (const file of record.spec.frozen ?? []) {
            const content = await readOptional(await containedPath(record.rootPath, `${relative}/${file}`));
            if (content === null) throw new SynthesisError(`Frozen file ${file} is missing in ${relative}: the engineer writes it before the run.`);
            record.frozen[file] = content;
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
          const response = await this.services.llm.generateText({usagePurpose: "synthesis", model: model.id, signal, maxTokens: 1000, localReasoningBudget: 0, sampling: synthesisSampling,
            systemPrompt: "You are a software synthesis advisor. Suggestions are advisory, never acceptance evidence. Be concise.",
            prompt: `${name}\nContract: ${record.spec.description}\nContext: ${JSON.stringify(args).slice(0, 6000)}\nCandidate artifact excerpts (bounded; do not assume omitted text was reviewed):\n${JSON.stringify(Object.fromEntries(Object.entries(record.files).map(([file, content]) => [file, content.slice(0, 4000)]))).slice(0, 14000)}`}, model.providerId);
          this.usage(record, response.usage); if (response.error) throw new SynthesisError(response.error);
          value = name === "role.inspect" ? {notes: [response.text], violations: []} : response.text; break;
        }
        case "evaluate": {
          requireCandidate(args[0]); requireSpec(args[1]);
          // Every gate judges one snapshot, and the evidence names that snapshot's hash.
          const files = {...record.files};
          const checkFiles = {candidate: files, frozen: record.frozen ?? {}, suite: record.suite ?? {}};
          // What a cited path holds as Apply would leave it: the candidate's copy, else the project's file.
          const projectLines = async (cited: string): Promise<number | undefined> => {
            try { relativePath(cited); } catch { return undefined; }
            const output = record.outputPath ?? "";
            for (const relative of [cited.startsWith(`${output}/`) ? cited.slice(output.length + 1) : undefined, cited]) {
              if (relative !== undefined && Object.hasOwn(files, relative)) return files[relative].split("\n").length;
            }
            if (cited.startsWith(`${output}/`) && record.removed?.includes(cited.slice(output.length + 1))) return undefined;
            // The version the agents read, when they read it.
            const kept = snapshot.get(cited);
            if (kept !== undefined) return kept === null ? undefined : kept.split("\n").length;
            try { return (await readText(await containedPath(record.rootPath, cited), 5 * 1024 * 1024)).split("\n").length; } catch { return undefined; }
          };
          const gates: Evidence["gates"] = [];
          for (const gate of record.spec.gates) {
            signal.throwIfAborted();
            if (gate.check?.kind === "tests") await this.event(record, `gate.${gate.id}`, `Running ${gate.check.files.join(", ")}`, "running");
            const result: {status: Evidence["status"]; message: string; feedback?: string[]; cases?: EvidenceCase[]} = gate.check
              ? await runCheck(gate.check, checkFiles, {...this.services.checks, signal, projectLines})
              : record.spec.evaluator === "calculator-v1" && supportedEvaluators.has(gate.evaluatorId)
                ? await evaluateCalculator(files, gate.evaluatorId)
                : {status: "Unknown", message: `No trusted evaluator registered for ${gate.evaluatorId}.`};
            gates.push({id: gate.id, evaluator: gate.evaluatorId, severity: gate.severity, status: result.status, message: result.message,
              ...(result.feedback?.length ? {feedback: result.feedback.slice(0, 8)} : {}), ...(result.cases?.length ? {cases: result.cases.slice(0, 100)} : {})});
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
          lastEvidence = {candidateHash: filesHash(files), specHash: record.specHash, evaluatorVersion: EVALUATOR_VERSION,
            ...(record.suiteHash ? {suiteHash: record.suiteHash} : {}), status, gates};
          evaluationSignatures.push(hash(JSON.stringify(gates.map(gate => [gate.id, gate.status, gate.message]))));
          record.evidence = lastEvidence; value = lastEvidence; break;
        }
        case "verify": {
          requireSpec(args[0]);
          if (!evidenceMatches(args[1])) throw new SynthesisError("Evidence is missing or stale; evaluate the exact current candidate.");
          value = {status: lastEvidence!.status, violations: violations(lastEvidence!, generationErrors)}; break;
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
      if (quiet) return value;
      const listedFrom = name === "models.list" ? String(named.provider ?? "llamacpp") : undefined;
      const detail = listedFrom === "llamacpp" ? `${(value as ManagedModel[]).length} installed local models` : listedFrom ? `${(value as ManagedModel[]).length} models of ${listedFrom}`
        : name === "models.select" ? (value as ManagedModel).displayName : undefined;
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
      clearTimeout(timer); clearInterval(watch); clearTimeout(pendingSave);
      // A run that stopped mid-way leaves no agent marked as running.
      if (record.agentRuns?.some(agent => agent.status === "running" || agent.status === "queued")) {
        for (const agent of record.agentRuns) if (agent.status === "running" || agent.status === "queued") agent.status = "cancelled";
        record.agents = counts(record.agentRuns);
      }
      await this.event(record, "finished", record.error ?? record.status, record.status === "accepted" ? "ok" : "failed");
    }
  }
  /** Whether this run may use a provider. local-files-v1 uses the app's llama.cpp models only; a
   * cloud provider needs its key here and the project's consent, which only this computer gives. */
  private async provider(record: RunRecord, providerId: string): Promise<{id: string; name: string; managed: boolean}> {
    if (providerId === "llamacpp") return {id: providerId, name: "Local llama.cpp", managed: true};
    if ((record.flow.policy ?? "local-files-v1") === "local-files-v1") throw new SynthesisError(`local-files-v1 runs local llama.cpp models only. Use policy = "cloud-files-v1" to call ${providerId}.`);
    const descriptor = this.services.providers?.().find(item => item.id === providerId);
    if (!descriptor) throw new SynthesisError(`No provider ${providerId} is set up here. Add it in Settings → Models & Providers.`);
    if (!descriptor.configured) throw new SynthesisError(`${descriptor.name} has no key or is turned off. Set it up in Settings → Models & Providers.`);
    if (descriptor.capabilities?.local !== true && (await this.project(record.projectId)).cloudModels !== true) {
      throw new SynthesisError(`This project does not allow cloud models: the contract and project files would be sent to ${descriptor.name}. Allow cloud models for the project first.`);
    }
    return {id: descriptor.id, name: descriptor.name, managed: MANAGED_PROVIDERS.has(descriptor.id)};
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
    // The rails a small model writes along: the engineer's frozen interfaces and visible tests.
    const frozen = Object.entries(record.frozen ?? {});
    const visibleTests = record.spec.gates.flatMap(gate => gate.check?.kind === "tests" && !gate.check.hidden ? gate.check.files : [])
      .filter(name => Object.hasOwn(record.suite ?? {}, name));
    // The flow passes verdict.violations: exact items read best as a numbered list.
    const items = feedback.flat(2).filter((item): item is string => typeof item === "string");
    const feedbackText = items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n").slice(0, 4500) : JSON.stringify(feedback).slice(0, 4500);
    const web = (name: string) => /\.(?:js|html|css)$/.test(name);
    for (const file of files) {
      signal.throwIfAborted();
      await this.event(record, "agent.generate", `Writing ${file}`, "running", {model: model.displayName, file});
      const prompt = [
        `Implement only the file ${file}. Other files: ${record.spec.artifacts.filter(item => item !== file).join(", ") || "none"}.`,
        LANGUAGE_HINTS.find(([pattern]) => pattern.test(file))?.[1] ?? "Write only the requested file's contents; do not include other files or explanations.",
        options.instruction ? `Module: ${record.spec.module}. This scoped task is supplied by the authored flow; the full contract is independently verified after generation.`
          : `Contract: ${record.spec.description}`,
        frozen.length ? `Frozen interface files, written by the engineer: implement them exactly and never change them.\n${frozen.map(([name, content]) => `--- ${name}\n${content}`).join("\n").slice(0, 8000)}` : "",
        visibleTests.length ? `The engineer's tests that must pass (they import the module's files; do not copy them into the file):\n${visibleTests.map(name => `--- ${name}\n${record.suite![name]}`).join("\n").slice(0, 6000)}` : "",
        format === "source" ? "Return ONLY the complete source code of this file. No JSON. No explanations. At most one code fence."
          : "Return an object with exactly one key, content, containing the complete file text. No markdown fences inside content. Do not explain.",
        `Current file:\n${(record.files[file] ?? "(empty)").slice(0, 10000)}`,
        options.instruction ? "" : `Peer file context:\n${JSON.stringify(Object.fromEntries(Object.entries(record.files).filter(([name]) => name !== file).map(([name, content]) => [name, content.slice(0, 4000)]))).slice(0, 10000)}`,
        `Feedback from trusted tests: ${feedbackText}`,
        options.instruction ? `Your focused task for this file:\n${options.instruction}` : "",
        `${web(file) ? "Use plain, minimal code under 100 lines." : "Keep the code plain and as short as the contract allows."} Finish ${format === "json" ? "the JSON object" : "the response"} as soon as this single file is complete. /no_think`
      ].filter(Boolean).join("\n\n");
      const request = {
        usagePurpose: "synthesis", model: model.id, signal, prompt, systemPrompt: `You implement only ${file}, one small file of a software module. Follow the exact public interface in the contract. The contract describes the whole module; implement only this file's responsibility. ${format === "json" ? "Output only JSON with a content string." : "Output only source code, not JSON or explanations."}`,
        temperature: 0.2 + Math.min(3, Math.max(0, record.iteration - 1)) * 0.1, maxTokens: 2600, localReasoningBudget: 0, sampling: synthesisSampling
      };
      let content: string | undefined;
      let response;
      if (format === "source") {
        response = await this.services.llm.generateText(request, model.providerId);
        const text = response.text.trim();
        // A language label may hold symbols: ```c++, ```c#, ```objective-c.
        const fenced = /^```[\w+#.-]*\s*\n([\s\S]*?)\n```$/.exec(text);
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
  /** Every task's agent of a run, as the run shows them. */
  async agents(id: string): Promise<{counts?: AgentCounts; items: AgentSummary[]}> {
    const record = await this.read(id);
    return {...(record.agents ? {counts: record.agents} : {}), items: record.agentRuns ?? []};
  }
  /** One task's agent with its steps: each tool call, its result and the agent's answer, shortened. */
  async agent(id: string, index: number) {
    const record = await this.read(id);
    const summary = record.agentRuns?.[index];
    if (!Number.isInteger(index) || !summary) throw new SynthesisError("This run has no such agent.", 404);
    const loop = await new AgentRunStore(path.join(this.directory, "..", "agents", runId(record.id))).get(summary.loopId);
    return {...summary, final: loop?.final?.slice(0, 20_000), protocol: loop?.protocol,
      turns: (loop?.turns ?? []).slice(-120).map(readableTurn)};
  }
  async diff(id: string): Promise<{files: Array<{path: string; before: string | null; after: string | null}>; canApply: boolean}> {
    const record = await this.read(id);
    const files: Array<{path: string; before: string | null; after: string | null}> = Object.entries(record.files).filter(([file, content]) => record.baseline[file] !== content)
      .map(([file, after]) => ({path: `${record.outputPath}/${file}`, before: record.baseline[file] ?? null, after}));
    // A file the run deleted: after is null.
    for (const file of record.removed ?? []) files.push({path: `${record.outputPath}/${file}`, before: record.baseline[file] ?? null, after: null});
    return {files, canApply: !this.active.has(id) && record.status === "accepted" && !record.appliedAt && !!record.outputPath && record.evidence?.candidateHash === filesHash(record.files)};
  }
  async apply(id: string): Promise<void> {
    if (this.active.has(id)) throw new SynthesisError("Run is active. Wait for it to finish before Apply.", 409);
    const first = await this.read(id);
    await withFileLock(path.join(first.rootPath, ".synthesis-apply-lock"), async () => {
      const record = await this.read(id); const project = await this.project(record.projectId);
      if (this.active.has(id) || project.rootPath !== record.rootPath || record.status !== "accepted" || record.appliedAt || !record.outputPath || record.evidence?.status !== "Pass" || record.evidence.candidateHash !== filesHash(record.files) || record.evidence.specHash !== record.specHash || record.evidence.evaluatorVersion !== EVALUATOR_VERSION) throw new SynthesisError("Only a fresh accepted, unapplied candidate can be applied.", 409);
      // after null: a file the run deleted.
      const targets: Array<{file: string; target: string; after: string | null}> = [];
      for (const [file, after] of [...Object.entries(record.files), ...(record.removed ?? []).map(file => [file, null] as const)]) {
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
          if (item.after === null) { await fs.unlink(item.target); applied.push(item); continue; }
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
  /** After a restart during Apply: "applied" when every changed file holds the candidate (the run
   * is then marked applied), "none" when every one still holds what was checked out, "partial"
   * otherwise (some files written, or edited since). */
  async applyOutcome(id: string): Promise<"applied" | "none" | "partial"> {
    const first = await this.read(id);
    if (first.appliedAt) return "applied";
    if (!first.outputPath) return "none";
    return withFileLock(path.join(first.rootPath, ".synthesis-apply-lock"), async () => {
      const record = await this.read(id);
      if (record.appliedAt) return "applied";
      let changed = 0, written = 0, untouched = 0;
      for (const [file, after] of [...Object.entries(record.files), ...(record.removed ?? []).map(file => [file, null] as const)]) {
        if (record.baseline[file] === after) continue;
        changed++;
        const now = await readOptional(await containedPath(record.rootPath, `${record.outputPath}/${file}`));
        if (now === after) written++; else if (now === record.baseline[file]) untouched++;
      }
      if (untouched === changed) return "none";
      if (written < changed) return "partial";
      record.appliedAt = stamp(); await this.event(record, "apply", `${changed} candidate files applied to ${record.outputPath} (found after a restart).`, "ok");
      return "applied";
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
  /** Saves never overlap: a save made while one is being written waits for it, and saves of the
   * same record made meanwhile share one write, which serializes the record as it is by then. */
  private save(record: RunRecord): Promise<void> {
    const file = path.join(this.directory, `${runId(record.id)}.json`);
    let state = this.writes.get(record.id);
    if (!state) { state = {last: Promise.resolve()}; this.writes.set(record.id, state); }
    if (state.queued?.record === record) return state.queued.done;
    const writer = state;
    const queued = {record, done: writer.last.catch(() => undefined).then(() => {
      if (writer.queued === queued) writer.queued = undefined;
      return writeJsonAtomically(file, record);
    }).finally(() => { if (writer.last === queued.done && !writer.queued) this.writes.delete(record.id); })};
    writer.queued = queued; writer.last = queued.done;
    return queued.done;
  }
  private async read(id: string): Promise<RunRecord> {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${runId(id)}.json`), "utf8")) as RunRecord; }
    catch (error) { if (isMissingFile(error)) throw new SynthesisError("Synthesis run not found.", 404); throw error; }
  }
  private async ids(): Promise<string[]> { return (await fs.readdir(this.directory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).map(file => file.slice(0, -5)); }
}
