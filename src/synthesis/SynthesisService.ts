import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { ProjectStore } from "../projects/ProjectStore";
import { LocalModelManagerRegistry } from "../llm/LocalModelManager";
import { LLMService } from "../llm/LLMService";
import { LLMRequest, LLMResponse, ManagedModel, ProviderDescriptor, ProviderModel } from "../types";
import { preciseLocalGenerationSettings, resolveLocalGenerationSettings } from "../local/GenerationSettings";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { answerFileProblem, compileProgram, httpTargetsOf, namedProviders, SourceSpan, SpecProgram, terminalAllowsOf } from "./language";
import { BudgetExhausted, Interpreter } from "./Interpreter";
import { ActivityEvent, Evidence, EvidenceCase, GenerationRecord, RunRecord, RunStatus, SynthesisError, SynthesisModule, SynthesisRun } from "./types";
import { containedPath, filesHash, hash, MAX_ARTIFACT_BYTES, MAX_SOURCE_BYTES, readOptional, readText, relativePath } from "./paths";
import { calculatorTemplate, emptyModuleTemplate, ModuleFiles, ModuleTemplate, rateLimiterTemplate, repositoryReviewTemplate } from "./templates";
import { discoverModules, moduleDirectory, moduleFolders, moduleName, moduleSources, sourceId } from "./modules";
import { evaluateCalculator, evaluatorVersion, supportedEvaluators } from "./evaluators";
import { CheckOptions, contractChecksVersion, references, runCheck } from "./checks";
import { matchesGlob } from "./checks/architecture";
import { AgentSpec, AgentSummary, CandidateStore, checkedLlm, gatedLlm, httpPermission, MAX_TASK_CHARS, Permission, permission, runAgents, SynthesisFileTools, splitGoal, synthesizeResults, TaskResult, terminalPermission } from "./agents";
import { AgentHttpClient, parseTarget, RequestBudget, targetLabel, targetWithin } from "./agents/AgentHttp";
import { createEgressProxy } from "./agents/AgentHttpProxy";
import { platformSandbox } from "./checks/sandbox";
import { AgentRunStore } from "../agents/runtime/AgentRunStore";
import type { AgentCounts } from "./types";
import type { ModelQueue } from "../local/types";
import { quantQuality } from "../local/quantization";
import { applyEditBlocks, implicatedFiles, RevisePromptInput, revisePrompt } from "./revisePrompt";

interface Services {
  projects: ProjectStore;
  models: Pick<LocalModelManagerRegistry, "listAllModels">;
  /** `shape`: a local model serving several requests at once (agents), each with its own context. */
  /** `queue`: the run's label for requests waiting behind it, and where the load itself waits. */
  loadModel: (model: ManagedModel, signal: AbortSignal, shape?: {parallel: number; contextSize?: number; fit?: boolean}, queue?: ModelQueue) => Promise<void>;
  /** The context a loaded local model gives one request, in tokens. */
  contextWindow?: (model: ManagedModel) => number | undefined;
  llm: Pick<LLMService, "generateObject" | "generateText">;
  /** The models a cloud provider lists, and the providers set up here (cloud-files-v1). */
  catalog?: {listAll(providerId?: string): Promise<ProviderModel[]>};
  providers?: () => ProviderDescriptor[];
  /** The model service agents run on (agents-v1): their loops call it directly. */
  agents?: {llm: LLMService; httpClient?: (budget: RequestBudget) => import("./agents/AgentHttp").HttpHost};
  /** Where Tests gates run (a sandbox and a work folder); tests of this service replace them. */
  checks?: Omit<CheckOptions, "signal">;
}
/** Evidence names the evaluators that made it: the calculator adapters and the contract checks. */
const EVALUATOR_VERSION = `${evaluatorVersion}+${contractChecksVersion}`;
/** The context a local model is loaded with for a flow that names none (one slot, cut to fit memory). */
const SYNTHESIS_CONTEXT = 16_384;
/** A local model's quantization quality; a cloud model has none, and counts as sound. */
const modelQuality = (model: ManagedModel) => model.providerId === "llamacpp" ? quantQuality(model.quantization, model.variantId ?? model.id) : quantQuality("");
/** Source in the languages the contract checks know, plus the web files of the calculator. */
const ARTIFACT_TYPES = /\.(?:js|mjs|cjs|ts|mts|cts|py|c|cc|cpp|cxx|h|hh|hpp|hxx|inl|json|html|css|txt|md)$/;
const MAX_SUITE_FILES = 24, MAX_SUITE_BYTES = 512 * 1024;
/** The most interpreter steps a flow may declare with `limit steps`. */
const MAX_STEPS = 1_000_000;
/** The most agent tasks one run may start, and agents at once in one parallel_map. */
const MAX_AGENT_TASKS = 1000, MAX_CONCURRENCY = 64;
/** A run's budget of agent HTTP requests, across all its agents and maps. */
const MAX_HTTP_REQUESTS = 2000;
/** The most files a candidate holds, declared ones and those agents create. */
const MAX_CANDIDATE_FILES = 300;
/** How much of the project a run keeps as its agents first read it. */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
/** Calls that only make a value (rights, an agent's description): no activity events. */
const QUIET_CALLS = new Set(["files.read", "files.write", "files.delete", "terminal", "agent"]);
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
  const items = evidence.gates.filter(gate => gate.status !== "Pass" && !gate.skipped)
    .flatMap(gate => gate.feedback?.length ? gate.feedback.map(item => `${gate.id}: ${item}`) : [`${gate.id}: ${gate.message}`]);
  // A long item is shortened before its "[test:line]", which says where the failed case is.
  return [...items, ...generationErrors].slice(0, 12).map(item => {
    if (item.length <= 300) return item;
    const ref = /\s\[[^\]\s]+:\d+\]$/.exec(item)?.[0] ?? "";
    return `${item.slice(0, 299 - ref.length)}…${ref}`;
  });
}
/** A candidate's standing by its visible evidence: required gates passed, then visible tests passed.
 * Hidden gates never count: choosing by them would spend the holdout on selection. */
export function visibleScore(evidence: Evidence, hiddenGates: ReadonlySet<string>): {value: number; passed: number; total: number; hardPassed: number; hardTotal: number} {
  const hard = evidence.gates.filter(gate => gate.severity === "hard" && !hiddenGates.has(gate.id));
  const tests = hard.filter(gate => gate.cases?.length);
  const passed = tests.reduce((sum, gate) => sum + gate.cases!.filter(item => item.status === "pass").length, 0);
  const total = tests.reduce((sum, gate) => sum + gate.cases!.length, 0);
  const hardPassed = hard.filter(gate => gate.status === "Pass").length;
  return {value: hardPassed * 100_000 + passed, passed, total, hardPassed, hardTotal: hard.length};
}
/** A request's seed: the run's, mixed with where in the run it is asked (iteration, file, request). */
export const requestSeed = (runSeed: number, iteration: number, file: string, request: number) =>
  createHash("sha256").update(`${runSeed}/${iteration}/${file}/${request}`).digest().readUInt32BE(0) % 2_147_483_647;
/** What the bundled llama.cpp writes into a thinking that reached its budget, before it ends it: the
 * model then writes its answer instead of being cut off in mid-thought. */
export const BUDGET_MESSAGE = "\n\nTime is up. I will now write the complete corrected file.\n";
/** How long a model thinks when asked again about the one failure of a file it returned unchanged. */
const ESCALATION_THINKING = 1024;
const MAX_SEED = 2_147_483_646;
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
export interface LaunchOptions { runId?: string; device?: {guard: () => Promise<string | undefined>};
  /** The run's seed (1 to 2,147,483,646): every model request's seed derives from it. A new run draws
   * one; a restart keeps its run's. */
  seed?: number }

/** Project source is read-only until Apply. Runs contain frozen sources and an isolated artifact tree. */
export class SynthesisService {
  private readonly directory: string;
  private readonly active = new Map<string, {controller: AbortController; done: Promise<void>; interruption: boolean}>();
  /** How often a run a paired device started asks whether the device may still use its project. */
  guardIntervalMs = 5_000;
  /** How a project's owner allows cloud models here: the workspace's switch, or on a server its command. */
  cloudConsentHint: (project: {id: string; name: string}) => string = () => "Allow cloud models for the project first.";
  webConsentHint: (project: {id: string; name: string}, targets: string[]) => string = () => "Allow the web targets for the project first.";
  private accepting = true;
  private readonly pendingStarts = new Set<Promise<SynthesisRun>>();
  private reservations = 0;
  private disposed = false;
  /** Each run's record is written by one writer at a time: the last write holds the latest state. */
  private readonly writes = new Map<string, {last: Promise<void>; queued?: {record: RunRecord; done: Promise<void>}}>();
  /** Applies under way (by run id, how many at once), runs being deleted, and runs deleted: an Apply
   * and a Delete of one run never overlap, and a deleted run's record is never written again. */
  private readonly applying = new Map<string, number>();
  private readonly removing = new Set<string>();
  private readonly removed = new Set<string>();
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
    if (typeof allowed !== "boolean") throw new SynthesisError("allowed must be true or false.");
    // Withdrawing always works, for an archived or moved project too: restoring one never brings cloud models back.
    if (allowed) await this.project(projectId);
    else if (!await this.services.projects.get(projectId)) throw new SynthesisError("Select an existing project.", 404);
    const saved = await this.services.projects.update(projectId, {cloudModels: allowed});
    return {allowed: saved?.cloudModels === true};
  }
  /** The web origins this project's agents may reach (http(...)). Set only on this computer. */
  async webTargets(projectId: string): Promise<{targets: string[]}> { return {targets: (await this.project(projectId)).webTargets ?? []}; }
  async setWebTargets(projectId: string, targets: unknown): Promise<{targets: string[]}> {
    if (!Array.isArray(targets)) throw new SynthesisError("targets is a list of web addresses, such as [\"https://staging.example.com\"].");
    if (targets.length > 20) throw new SynthesisError("A project allows up to 20 web targets.");
    const normalized: string[] = [];
    for (const target of targets) {
      if (typeof target !== "string") throw new SynthesisError("A web target is a string, such as \"https://api.example.com/v1\".");
      try { const value = targetLabel(parseTarget(target)); if (!normalized.includes(value)) normalized.push(value); }
      catch (error) { throw new SynthesisError(error instanceof Error ? error.message : String(error)); }
    }
    if (!normalized.length) { if (!await this.services.projects.get(projectId)) throw new SynthesisError("Select an existing project.", 404); }
    else await this.project(projectId);
    const saved = await this.services.projects.update(projectId, {webTargets: normalized.length ? normalized : null});
    return {targets: saved?.webTargets ?? []};
  }
  private webConsentRefusal(project: {id: string; name: string}, want: string[]): string {
    return `This project does not allow these web targets: ${want.join(", ")}. An agent may reach a web service only where the project allows it. ${this.webConsentHint(project, want)}`;
  }
  private consentRefusal(providerName: string, project: {id: string; name: string}): string {
    return `This project does not allow cloud models: the contract and project files would be sent to ${providerName}. ${this.cloudConsentHint(project)}`;
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
    // Each file is read on its own, so the one that can be read is shown (and edited) as it is.
    const unread: SynthesisModule["diagnostics"] = [];
    const read = async (file: string) => {
      try { return await readText(await containedPath(project.rootPath, file)); }
      catch (error) {
        // The project-relative file, never the host's full path (it may reach a paired device).
        const message = isMissingFile(error) ? `Missing ${file}.` : error instanceof SynthesisError ? error.message : `${file} could not be read.`;
        unread.push({severity: "error", code: "SOURCE_READ", message, file, line: 1, column: 1});
        return "";
      }
    };
    const specSource = await read(specPath), flowSource = await read(flowPath);
    if (unread.length) return {id, name, specPath, flowPath, specSource, flowSource, valid: false, diagnostics: unread};
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
        else if (descriptor.capabilities?.local !== true && project.cloudModels !== true) add("SYNTHESIS_CLOUD_CONSENT", this.consentRefusal(descriptor.name, project));
      }
      // What Run would refuse about http targets: ones the project does not allow.
      const allowList = (project.webTargets ?? []).map(parseTarget);
      for (const {target, span} of httpTargetsOf(compiled.flow)) {
        let within = false;
        try { within = targetWithin(parseTarget(target), allowList); } catch { within = false; }
        if (!within) diagnostics.push({severity: "error", code: "SYNTHESIS_WEB_CONSENT", message: this.webConsentRefusal(project, [target]), file: flowPath, line: span.start.line, column: span.start.column});
      }
      // A terminal where this platform has no sandbox at all (an unsupported OS), or names a command the
      // platform's sandbox does not run (Windows runs only node, npm and npx in v1): Run would stop at
      // parallel_map. Whether a sandbox that exists isolates is checked at Run, which tries it.
      const sandbox = this.services.checks?.sandbox ?? platformSandbox();
      const terminals = terminalAllowsOf(compiled.flow);
      if (terminals.length && sandbox.name === "none") {
        const terminal = terminals[0]!.span;
        diagnostics.push({severity: "error", code: "SYNTHESIS_SANDBOX", message: `Agents with a terminal need a sandbox: ${await sandbox.unavailable()} Remove terminal(...) from their tools to run here.`,
          file: flowPath, line: terminal.start.line, column: terminal.start.column});
      } else if (sandbox.name === "appcontainer") {
        const unsupported = ["git", "ls", "cat", "python3", "rg"];
        for (const {commands, span} of terminals) {
          const named = (commands ?? unsupported).filter(command => unsupported.includes(command));
          if (named.length) diagnostics.push({severity: "error", code: "SYNTHESIS_SANDBOX",
            message: `On Windows an agent's terminal runs only node, npm and npx; ${named.join(", ")} ${named.length === 1 ? "is" : "are"} not available here yet. Narrow terminal(allow = [...]) to those, or run the flow on a Mac or a Linux server.`,
            file: flowPath, line: span.start.line, column: span.start.column});
        }
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
  /** Saves a module's contract or flow as edited in the app, and returns the module as it is then,
   * with its diagnostics. `expected`: the file's text as read when the edit began; when the file
   * holds another (it was edited elsewhere since), nothing is written. CRLF line ends and the file's
   * mode are kept. */
  async saveSource(projectId: string, id: string, file: unknown, source: unknown, expected?: unknown): Promise<SynthesisModule> {
    if (file !== "spec" && file !== "flow") throw new SynthesisError("file must be spec or flow.");
    if (typeof source !== "string" || source.includes("\0")) throw new SynthesisError("source must be text.");
    if (expected !== undefined && typeof expected !== "string") throw new SynthesisError("expected must be the text the editor started from.");
    const project = await this.project(projectId);
    const sources = moduleSources(id);
    const relative = file === "spec" ? sources.specPath : sources.flowPath;
    const target = await containedPath(project.rootPath, relative);
    const now = await readOptional(target);
    if (expected !== undefined && (now ?? "") !== expected) throw new SynthesisError(`${relative} changed on disk since it was opened here. Reload it, or save again to replace it.`, 409);
    const text = now?.includes("\r\n") ? source.replace(/\r?\n/g, "\r\n") : source;
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new SynthesisError(`${relative} may hold at most ${MAX_SOURCE_BYTES / 1024} KiB.`);
    const mode = now === null ? undefined : (await fs.stat(target)).mode & 0o777;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, {flag: "wx"});
      if (mode !== undefined) await fs.chmod(temporary, mode);
      await fs.rename(temporary, target);
    }
    catch (error) { if (isMissingFile(error)) throw new SynthesisError(`The folder of ${relative} does not exist.`, 404); throw error; }
    finally { await fs.unlink(temporary).catch(() => {}); }
    return this.module(projectId, id);
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
    return this.launch(record.projectId, record.moduleId, record.specSource, record.flowSource, record.id, {...options, seed: options.seed ?? record.seed}, record.suite);
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
  private async prepareLaunch(projectId: string, id: string, specSource: string, flowSource: string, restartedFrom: string | undefined, {runId: reservedId, device, seed}: LaunchOptions, frozenSuite?: Record<string, string>): Promise<SynthesisRun> {
    if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > MAX_SEED)) throw new SynthesisError(`A run's seed is a whole number from 1 to ${MAX_SEED.toLocaleString("en")}.`);
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
      files: {}, baseline: {}, events: [], models: [], usage: {inputTokens: 0, outputTokens: 0, calls: 0}, seed: seed ?? randomInt(1, MAX_SEED + 1),
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
  /** Deletes a finished run: its agents' steps, checkpoints and record. What Apply wrote stays in the project. */
  async remove(id: string): Promise<void> {
    const key = runId(id);
    const record = await this.read(key);
    // No await from these checks to the mark: an Apply that starts now finds the run being deleted.
    if (this.active.has(key) || activeStatus(record.status)) throw new SynthesisError("This run is still going. Stop it before deleting it.", 409);
    if (this.applying.has(key)) throw new SynthesisError("This run is being applied. Delete it once Apply is done.", 409);
    if (this.removing.has(key)) throw new SynthesisError("Synthesis run not found.", 404);
    this.removing.add(key);
    try {
      await this.writes.get(key)?.last.catch(() => undefined);
      await fs.rm(path.join(this.directory, "..", "agents", key), {recursive: true, force: true, maxRetries: 3, retryDelay: 200});
      const checkpoints = path.join(this.directory, "checkpoints");
      for (const file of await fs.readdir(checkpoints).catch(() => [] as string[])) if (file.startsWith(`${key}-`)) await fs.rm(path.join(checkpoints, file), {force: true});
      // The record goes last: if a step above fails, the run stays listed and Delete can be tried again.
      await fs.rm(path.join(this.directory, `${key}.json`), {force: true});
      this.removed.add(key);
    } finally { this.removing.delete(key); }
  }
  /** Deletes a project's finished runs, only one module's when `moduleId` is given. Runs still going
   * (or being applied) stay; one deleted meanwhile elsewhere counts as gone. */
  async clear(projectId: string, moduleId?: string): Promise<{deleted: number; kept: number}> {
    if (!await this.services.projects.get(projectId)) throw new SynthesisError("Select an existing project.", 404);
    const gone = (error: unknown) => error instanceof SynthesisError && error.statusCode === 404;
    let deleted = 0, kept = 0;
    for (const id of await this.ids()) {
      const record = await this.read(id).catch(error => { if (gone(error)) return undefined; throw error; });
      if (!record || record.projectId !== projectId || (moduleId !== undefined && record.moduleId !== moduleId)) continue;
      if (this.active.has(id) || activeStatus(record.status) || this.applying.has(id)) { kept++; continue; }
      try { await this.remove(id); deleted++; }
      catch (error) {
        if (gone(error)) continue;
        if (error instanceof SynthesisError && error.statusCode === 409) { kept++; continue; }
        throw error;
      }
    }
    return {deleted, kept};
  }
  /** Apply, and its check after a restart, hold the run: Delete refuses it meanwhile, and a run being
   * deleted is not applied. No await before the mark, so this and Delete's checks never interleave. */
  private async applyingRun<T>(id: string, task: () => Promise<T>): Promise<T> {
    const key = runId(id);
    if (this.removing.has(key) || this.removed.has(key)) throw new SynthesisError("Synthesis run not found.", 404);
    this.applying.set(key, (this.applying.get(key) ?? 0) + 1);
    try { return await task(); }
    finally {
      const left = (this.applying.get(key) ?? 1) - 1;
      if (left) this.applying.set(key, left); else this.applying.delete(key);
    }
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
    let mapCalls = 0, httpClient: import("./agents/AgentHttp").HttpHost | undefined, httpBudget: RequestBudget | undefined;
    let pendingSave: NodeJS.Timeout | undefined;
    const saveSoon = () => { pendingSave ??= setTimeout(() => { pendingSave = undefined; void this.save(record).catch(() => undefined); }, 1000); pendingSave.unref(); };
    const evaluationSignatures: string[] = [];
    let lastEvidence: Evidence | undefined;
    let generationErrors: string[] = [];
    let terminal: {status: RunStatus; evidence?: Evidence} | undefined;
    // The last evaluation's standing, as the next revisions read it, and the best candidate so far
    // (evaluate(..., keep = "best")): both by visible gates only.
    const hiddenGates = new Set(record.spec.gates.filter(gate => gate.check?.kind === "tests" && gate.check.hidden).map(gate => gate.id));
    let checked: ReturnType<typeof visibleScore> | undefined;
    let best: {files: Record<string, string>; removed: string[]; evidence: Evidence; score: ReturnType<typeof visibleScore>; iteration: number} | undefined;
    const requireCandidate = (value: unknown) => { if (value !== candidate || !record.outputPath) throw new SynthesisError("Expected the checked-out candidate."); };
    const requireSpec = (value: unknown) => { if (value !== spec) throw new SynthesisError("Expected the frozen module specification."); };
    const evidenceMatches = (value: unknown): value is Evidence => value === lastEvidence && !!lastEvidence &&
      lastEvidence.candidateHash === filesHash(record.files) && lastEvidence.specHash === record.specHash && lastEvidence.evaluatorVersion === EVALUATOR_VERSION &&
      lastEvidence.suiteHash === record.suiteHash;
    // A loaded model becomes a role: only the app's own llama.cpp runtime loads; others answer on request.
    const role = async (model: ManagedModel, shape?: {parallel: number; contextSize?: number}) => {
      // A whole file, the contract, the tests and feedback need more than a chat's context: without a
      // context of its own, one slot is asked for 16k tokens, as much as memory allows.
      if (model.providerId === "llamacpp") await this.services.loadModel(model, signal, shape ?? {parallel: 1, contextSize: SYNTHESIS_CONTEXT, fit: true},
        this.loadQueue(record, model));
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
    // Consent and keys may change during a run: asked again before every request to a cloud provider.
    const consented = async (providerId: string) => { if (providerId !== "llamacpp") await this.provider(record, providerId); };
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
          // A model whose files are gone from the disk cannot run, however it ranks.
          const eligible = list.filter(model => (model as {filesAvailable?: boolean}).filesAvailable !== false && (exact === undefined || model.id === exact || model.displayName === exact) &&
            (!Number.isFinite(max) || (typeof model.sizeBytes === "number" && model.sizeBytes > 0 && model.sizeBytes <= max)));
          // The most capable model the limit allows: a preferred name first, then a file of more than
          // about 3 bits a weight, then the larger file. A smaller file is never chosen just for its size.
          const preferred = (model: ManagedModel) => Number(`${model.id} ${model.displayName}`.toLowerCase().includes(prefer));
          const lowBit = (model: ManagedModel) => Number(modelQuality(model).lowBit);
          eligible.sort((a,b) => preferred(b) - preferred(a) || lowBit(a) - lowBit(b) || (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.id.localeCompare(b.id));
          if (!eligible[0]) throw new SynthesisError(exact !== undefined ? `No listed model is ${exact}.` : "No installed local model matches the selection. Install a suitable model in Models or adjust max_size.");
          value = eligible[0]; break;
        }
        case "model": {
          const model = await resolveModel(String(named.provider ?? "llamacpp"), args[0]);
          listed.add(model);
          value = await role(model);
          break;
        }
        case "terminal": value = terminalPermission(named.allow); permissions.add(value as object); break;
        case "http": value = httpPermission(named.allow); permissions.add(value as object); break;
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
          const rights = {read: [] as string[], write: [] as string[], delete: [] as string[], own: [] as string[], terminal: [] as string[], http: [] as string[]};
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
          const answerFile = named.answer_file;
          if (answerFile !== undefined) {
            const problem = typeof answerFile === "string" ? answerFileProblem(answerFile) : "answer_file is a string.";
            if (problem) throw new SynthesisError(problem);
            if (!record.outputPath) throw new SynthesisError("Check out the candidate before parallel_map saves answers: they go into it.");
            if (!(answerFile as string).startsWith(`${record.outputPath}/`)) throw new SynthesisError(`answer_file "${answerFile}" is outside the candidate folder ${record.outputPath}: answers are saved only there.`);
          }
          for (const agent of agents) for (const pattern of [...agent.rights.write, ...agent.rights.delete]) {
            if (!record.outputPath) throw new SynthesisError("Check out the candidate before giving agents write access: they write into it.");
            if (!pattern.startsWith(`${record.outputPath}/`)) throw new SynthesisError(`files.write("${pattern}") is outside the candidate folder ${record.outputPath}: agents write only there.`);
          }
          // A terminal runs only in a sandbox that isolates: checked before any agent starts.
          const sandbox = this.services.checks?.sandbox ?? platformSandbox();
          if (agents.some(agent => agent.rights.terminal?.length)) {
            const reason = await sandbox.unavailable();
            if (reason) throw new SynthesisError(`Agents with a terminal need a sandbox that works: ${reason}`);
          }
          // Agents with the http right may reach only web targets the project allows (its owner sets them).
          const wanted = [...new Set(agents.flatMap(agent => agent.rights.http ?? []))];
          // Re-checked before each web request, by http.request and the terminal's egress proxy alike: if
          // the owner turns web access off mid-run, it stops at once instead of in-flight agents keeping it.
          let consent: ((want: readonly string[]) => Promise<void>) | undefined;
          if (wanted.length) {
            const project = await this.project(record.projectId);
            const allowList = (project.webTargets ?? []).map(parseTarget);
            const refused = wanted.filter(target => !targetWithin(parseTarget(target), allowList)).map(target => targetLabel(parseTarget(target)));
            if (refused.length) throw new SynthesisError(this.webConsentRefusal(project, refused));
            consent = async (want: readonly string[]) => {
              const current = ((await this.project(record.projectId)).webTargets ?? []).map(parseTarget);
              const gone = want.filter(target => { try { return !targetWithin(parseTarget(target), current); } catch { return true; } });
              if (gone.length) throw new Error(`Web access is no longer allowed for ${gone.map(target => { try { return targetLabel(parseTarget(target)); } catch { return target; } }).join(", ")}: the project's owner changed its web targets.`);
            };
            // One budget for the whole run, drawn down by http.request and the terminal's egress alike.
            httpBudget ??= new RequestBudget(MAX_HTTP_REQUESTS);
            // The injected client (a test seam) gets the SAME run budget, so it and the egress proxy share one count.
            httpClient ??= this.services.agents.httpClient?.(httpBudget) ?? new AgentHttpClient(httpBudget, undefined, consent);
          }
          // Whether a terminal may reach its web targets on this platform: checked once an agent needs it.
          const terminalWeb = wanted.length && agents.some(agent => agent.rights.terminal?.length && agent.rights.http?.length)
            ? await sandbox.checkEgress?.() : undefined;
          if (terminalWeb) await this.event(record, "agents", `Agents' terminals have no web access here (${terminalWeb}); http.request still reaches the allowed targets.`, "warning", {line: span.start.line});
          const call = ++mapCalls, earlier = record.agentRuns ?? [];
          await this.event(record, "agents", `${tasks.length} agents, ${Math.min(concurrency as number, tasks.length)} at a time`, "running", {line: span.start.line});
          // A provider that asks to slow down gets fewer requests at once; the run says so, at most every 30 s.
          let told = 0;
          const llm = gatedLlm(this.services.agents.llm, concurrency as number, {waited: (provider, ms) => {
            if (Date.now() - told < 30_000) return; told = Date.now();
            void this.event(record, "agents", `${provider} asked to slow down: fewer requests at once, retrying in ${Math.round(ms / 1000)} s`, "running", {line: span.start.line}).catch(() => undefined);
          }, before: consented});
          const {results, summaries} = await runAgents({llm, baseDir: path.join(this.directory, "..", "agents", record.id), runId: record.id, call,
            module: {name: record.spec.module, description: record.spec.description}, store, agents, tasks: tasks as string[], concurrency: concurrency as number,
            failFast: named.on_error === "fail", checkoutRequired: named.checkout === "required", signal,
            ...(typeof answerFile === "string" ? {answerFile} : {}),
            ...(wanted.length && httpClient ? {http: httpClient} : {}),
            // History is out of the copies when the contract has hidden tests: it could hold them.
            terminal: {sandbox, workRoot: path.join(this.directory, "..", "agents", record.id, "terminal", `map-${call}`),
              git: !record.spec.gates.some(gate => gate.check?.kind === "tests" && gate.check.hidden),
              // An agent with both a terminal and the http right reaches its web targets through the egress
              // proxy, when the sandbox can route to it alone; it enforces the same allowlist, consent and budget.
              ...(wanted.length && sandbox.egressSupported && httpBudget && consent
                ? {egress: (allow: readonly string[]) => createEgressProxy({allow, budget: httpBudget!, consent: consent!, unix: sandbox.egressTransport === "unix"})} : {})},
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
          value = await splitGoal(checkedLlm(this.services.llm, consented), model, {goal: String(args[0] ?? ""), count: Number(args[1]), module: record.spec.module, description: record.spec.description,
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
          const content = await synthesizeResults(checkedLlm(this.services.llm, consented), model, {results: args[2] as TaskResult[], file, module: record.spec.module, description: record.spec.description,
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
          generationErrors.push(...await this.revise(record, (receiver as {model: ManagedModel}).model, args.slice(2), signal, named, checked));
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
          if (named.keep !== undefined && named.keep !== "best") throw new SynthesisError('keep is "best": evaluate(candidate, spec, keep = "best").');
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
          const missing = record.spec.artifacts.filter(file => !Object.hasOwn(files, file) || !files[file]!.trim());
          // Nothing written: each gate would only repeat that the files are missing. The artifacts gate
          // below fails, so the candidate still fails and the flow goes on to its next attempt.
          const empty = record.spec.artifacts.length > 0 && missing.length === record.spec.artifacts.length;
          if (empty) await this.event(record, "evaluate", "Not evaluated: the model wrote none of the declared files", "failed");
          for (const gate of record.spec.gates) {
            signal.throwIfAborted();
            if (empty) {
              gates.push({id: gate.id, evaluator: gate.evaluatorId, severity: gate.severity, status: "Unknown", message: "Not evaluated: no candidate file was written.", skipped: "no_candidate"});
              continue;
            }
            if (gate.check?.kind === "tests") await this.event(record, `gate.${gate.id}`, `Running ${gate.check.files.join(", ")}`, "running");
            const result: {status: Evidence["status"]; message: string; feedback?: string[]; cases?: EvidenceCase[]; grounded?: Evidence["gates"][number]["grounded"]} = gate.check
              ? await runCheck(gate.check, checkFiles, {...this.services.checks, signal, projectLines})
              : record.spec.evaluator === "calculator-v1" && supportedEvaluators.has(gate.evaluatorId)
                ? await evaluateCalculator(files, gate.evaluatorId)
                : {status: "Unknown", message: `No trusted evaluator registered for ${gate.evaluatorId}.`};
            gates.push({id: gate.id, evaluator: gate.evaluatorId, severity: gate.severity, status: result.status, message: result.message,
              ...(result.feedback?.length ? {feedback: result.feedback.slice(0, 8)} : {}), ...(result.cases?.length ? {cases: result.cases.slice(0, 100)} : {}),
              ...(result.grounded ? {grounded: {file: result.grounded.file, references: result.grounded.references.slice(0, 500)}} : {})});
            await this.event(record, `gate.${gate.id}`, `${result.status}: ${result.message}`, result.status === "Pass" ? "ok" : "failed");
          }
          if (!gates.some(gate => gate.severity === "hard")) gates.push({id: "acceptance", evaluator: "registry", severity: "hard", status: "Unknown", message: "At least one trusted hard evaluator is required."});
          // A candidate is complete only with every declared file: the gates may judge only some.
          gates.push({id: "artifacts", evaluator: "registry", severity: "hard", status: missing.length ? "Fail" : "Pass",
            message: missing.length ? `Declared files are missing or empty: ${missing.join(", ")}.` : "Every declared file is present."});
          if (missing.length) await this.event(record, "gate.artifacts", `Fail: missing ${missing.join(", ")}`, "failed");
          const hard = gates.filter(gate => gate.severity === "hard");
          const status = hard.some(gate => gate.status === "Fail") ? "Fail" : hard.some(gate => gate.status === "Unknown") ? "Unknown" : "Pass";
          lastEvidence = {candidateHash: filesHash(files), specHash: record.specHash, evaluatorVersion: EVALUATOR_VERSION,
            ...(record.suiteHash ? {suiteHash: record.suiteHash} : {}), status, gates};
          evaluationSignatures.push(hash(JSON.stringify(gates.map(gate => [gate.id, gate.status, gate.message]))));
          // keep = "best": a candidate worse than the best one so far is set aside, and the run goes on
          // from the best one with its evidence, so an iteration never loses what an earlier one had.
          // A tie goes to the newer candidate.
          const scored = visibleScore(lastEvidence, hiddenGates);
          if (named.keep === "best" && best && scored.value < best.score.value) {
            for (const file of Object.keys(record.files)) delete record.files[file];
            Object.assign(record.files, best.files); record.removed = [...best.removed];
            lastEvidence = best.evidence;
            await this.event(record, "evaluate", `Kept the candidate of iteration ${best.iteration} (${best.score.hardPassed} of ${best.score.hardTotal} required checks, ${best.score.passed} of ${best.score.total} tests) over this one (${scored.hardPassed} of ${scored.hardTotal}, ${scored.passed} of ${scored.total})`, "ok");
          } else best = {files: {...record.files}, removed: [...record.removed ?? []], evidence: lastEvidence, score: scored, iteration: record.iteration};
          checked = visibleScore(lastEvidence, hiddenGates);
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
      const selected = name === "models.select" ? value as ManagedModel : undefined;
      const detail = listedFrom === "llamacpp" ? `${(value as ManagedModel[]).length} installed local models` : listedFrom ? `${(value as ManagedModel[]).length} models of ${listedFrom}`
        : selected ? [selected.displayName, selected.quantization].filter(Boolean).join(" · ") : undefined;
      await this.event(record, name, detail ?? `${name} completed`, "ok", {line: span.start.line});
      const note = selected && modelQuality(selected).note;
      if (note) await this.event(record, name, `${selected!.displayName}: ${note}`, "warning", {line: span.start.line});
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
    if (descriptor.capabilities?.local !== true) {
      const project = await this.project(record.projectId);
      if (project.cloudModels !== true) throw new SynthesisError(this.consentRefusal(descriptor.name, project));
    }
    return {id: descriptor.id, name: descriptor.name, managed: MANAGED_PROVIDERS.has(descriptor.id)};
  }
  /** While a local request waits for its model: who holds it and how many wait ahead, logged once
   * each time that changes. */
  private waitingFor(record: RunRecord, model: ManagedModel, step: string, file?: string): (position: number, heldBy: string[]) => void {
    let last = "";
    return (position, heldBy) => {
      const message = `Waiting for ${model.displayName}: in use by ${heldBy.length ? heldBy.join(", ") : "earlier requests"}${position > 1 ? ` · ${position - 1} ahead` : ""}`;
      if (message === last) return;
      last = message;
      // A failed save (a full disk) must not end the process: the next event saves the record again.
      void this.event(record, step, message, "running", {model: model.displayName, waiting: true, ...(file ? {file} : {})}).catch(() => undefined);
    };
  }
  /** A model load's place in the queue: logged while it waits, and once more when the load begins. */
  private loadQueue(record: RunRecord, model: ManagedModel): ModelQueue {
    let waited = false;
    const queued = this.waitingFor(record, model, "models.load");
    return {label: `Synthesis · ${record.moduleName}`, onQueued: (position, heldBy) => { waited = true; queued(position, heldBy); },
      onStarted: () => { if (waited) void this.event(record, "models.load", `Loading ${model.displayName}`, "running", {model: model.displayName}).catch(() => undefined); }};
  }
  /** A model request's progress in the run's log: the wait for a local model, then the tokens written
   * so far on the running event (saved at most once a second, as the UI polls). */
  private progress(record: RunRecord, model: ManagedModel, file: string, writing: string): Pick<LLMRequest, "holder" | "onProgress" | "onGenerated"> {
    const queued = this.waitingFor(record, model, "agent.generate", file);
    let waited = false, savedAt = 0;
    return {
      holder: `Synthesis · ${record.moduleName}`,
      onProgress: event => {
        if (event.phase === "queued") { waited = true; queued(event.queuePosition ?? 1, event.heldBy ?? []); }
        else if (event.phase === "generating" && waited) { waited = false; void this.event(record, "agent.generate", writing, "running", {model: model.displayName, file}).catch(() => undefined); }
      },
      onGenerated: tokens => {
        const last = record.events.at(-1);
        if (last?.step !== "agent.generate" || last.status !== "running" || last.waiting) return;
        last.tokens = tokens;
        if (Date.now() - savedAt < 1000) return;
        savedAt = Date.now(); record.updatedAt = stamp(); void this.save(record).catch(() => undefined);
      }
    };
  }
  private usage(record: RunRecord, usage?: {inputTokens?: number; outputTokens?: number}): void {
    record.usage.calls++; record.usage.inputTokens += usage?.inputTokens ?? 0; record.usage.outputTokens += usage?.outputTokens ?? 0;
  }
  private async revise(record: RunRecord, model: ManagedModel, feedback: unknown[], signal: AbortSignal, options: Record<string, unknown>, checked?: ReturnType<typeof visibleScore>): Promise<string[]> {
    const selected = options.file;
    const format = options.format ?? "json";
    if (format !== "source" && format !== "json") throw new SynthesisError("revise format must be source or json.");
    if (options.instruction !== undefined && (typeof options.instruction !== "string" || options.instruction.length > 6000)) throw new SynthesisError("revise instruction must be a string of at most 6000 characters.");
    const files = selected === undefined ? record.spec.artifacts : [String(selected)];
    if (files.some(file => !record.spec.artifacts.includes(file))) throw new SynthesisError("Role may revise only declared artifact files.");
    const errors: string[] = [];
    // The rails a small model writes along: the engineer's frozen interfaces and visible tests.
    const frozen = Object.entries(record.frozen ?? {});
    const tests = record.spec.gates.flatMap(gate => gate.check?.kind === "tests" && !gate.check.hidden ? gate.check.files : [])
      .filter(name => Object.hasOwn(record.suite ?? {}, name)).map(name => [name, record.suite![name]!] as [string, string]);
    // The flow passes verdict.violations: exact items, grouped by the file they point into.
    const items = feedback.flat(2).filter((item): item is string => typeof item === "string");
    const given = feedback.flat(2).some(item => item !== null && item !== undefined);
    const instruction = typeof options.instruction === "string" && options.instruction ? options.instruction : undefined;
    // A local model whose chat template thinks first is asked to think when it is asked again.
    const thinks = model.providerId === "llamacpp" && (model as {metadata?: {thinkingTemplate?: boolean}}).metadata?.thinkingTemplate === true;
    for (const file of files) {
      signal.throwIfAborted();
      // Consent withdrawn while earlier files were written stops the next one.
      if (model.providerId !== "llamacpp") await this.provider(record, model.providerId);
      await this.event(record, "agent.generate", `Writing ${file}`, "running", {model: model.displayName, file});
      const ask = (extra: Partial<RevisePromptInput>) => revisePrompt({file, artifacts: record.spec.artifacts, module: record.spec.module, description: record.spec.description,
        hint: LANGUAGE_HINTS.find(([pattern]) => pattern.test(file))?.[1] ?? "Write only the requested file's contents; do not include other files or explanations.",
        instruction, frozen, tests, files: record.files, feedback: items, ...(!items.length && given ? {other: feedback} : {}), first: record.iteration <= 1,
        ...(items.length && checked ? {checked} : {}), reply: format, ...extra});
      const {system: systemPrompt, prompt} = ask({});
      // Room to write the file in the model's context: a prompt that leaves too little is not sent.
      const window = model.providerId === "llamacpp" ? this.services.contextWindow?.(model) : undefined;
      const promptTokens = Math.ceil((prompt.length + systemPrompt.length) / 3);
      const room = window ? window - promptTokens - 64 : Infinity;
      if (room < 1200) {
        const message = `${file}: the prompt takes about ${promptTokens} of the model's ${window} context tokens, too little room to write the file. Load the model with a larger context (models.load(model, context = 16384)).`;
        errors.push(message); await this.event(record, "agent.generate", message, "failed", {model: model.displayName, file});
        continue;
      }
      const before = record.files[file];
      let requests = 0;
      // One request, recorded with how it was asked: seed, sampling, thinking, a hash of the prompt.
      const generate = async (mode: GenerationRecord["mode"], ask: {system: string; prompt: string}, thinking: number, reply: "source" | "json" | "edit") => {
        const maxTokens = Math.min(2600 + thinking, room);
        const seed = requestSeed(record.seed ?? 0, record.iteration, file, ++requests);
        const temperature = 0.2 + Math.min(3, Math.max(0, record.iteration - 1)) * 0.1;
        const request: LLMRequest = {
          usagePurpose: "synthesis", model: model.id, signal, systemPrompt: ask.system, maxTokens, localReasoningBudget: thinking,
          ...(thinking ? {localReasoningBudgetMessage: BUDGET_MESSAGE} : {}), sampling: {...synthesisSampling, seed}, prompt: ask.prompt, temperature,
          ...this.progress(record, model, file, `Writing ${file}`)
        };
        const started = Date.now();
        let content: string | undefined, response: LLMResponse;
        if (reply === "json") {
          const result = await this.services.llm.generateObject<{content: string}>({...request,
            responseFormat: {type: "json_schema", name: "synthesis_file", strict: true, schema: {
              type: "object", properties: {content: {type: "string"}}, required: ["content"], additionalProperties: false
            }}
          }, model.providerId);
          response = result.response;
          content = typeof result.data?.content === "string" ? result.data.content : undefined;
        } else {
          response = await this.services.llm.generateText(request, model.providerId);
          const text = response.text.trim();
          if (reply === "edit") content = before === undefined ? undefined : applyEditBlocks(before, text);
          else {
            // A language label may hold symbols: ```c++, ```c#, ```objective-c.
            const fenced = /^```[\w+#.-]*\s*\n([\s\S]*?)\n```$/.exec(text);
            const source = fenced ? fenced[1] : text;
            // No extraction from prose or multiple files: ambiguous output remains a failed attempt.
            content = !source.includes("```") && source && (!text.includes("```") || fenced) ? source : undefined;
          }
        }
        signal.throwIfAborted(); this.usage(record, response.usage);
        const finish = (response.raw as {choices?: Array<{finish_reason?: string}>} | undefined)?.choices?.[0]?.finish_reason;
        const cutOff = finish === "length";
        const problem = cutOff ? `The answer was cut off at the token limit (${maxTokens} tokens), so the file is incomplete. Write a shorter file.`
          : response.error ?? (!content ? (reply === "edit" ? "The answer was not SEARCH/REPLACE blocks that apply to the file." : "The answer was not one complete file (no code, or code mixed with prose).")
            : Buffer.byteLength(content) > MAX_ARTIFACT_BYTES ? "The file is larger than allowed." : undefined);
        const generation: GenerationRecord = {mode, seed, temperature, topP: synthesisSampling.topP, topK: synthesisSampling.topK, minP: synthesisSampling.minP,
          repeatPenalty: synthesisSampling.repeatPenalty, thinking, ...(thinking ? {budgetMessage: BUDGET_MESSAGE} : {}), maxTokens,
          promptHash: hash(`${ask.system}\n\n${ask.prompt}`).slice(0, 16), promptChars: ask.system.length + ask.prompt.length,
          ...(response.usage?.inputTokens !== undefined ? {inputTokens: response.usage.inputTokens} : {}), ...(response.usage?.outputTokens !== undefined ? {outputTokens: response.usage.outputTokens} : {}),
          ...(finish ? {finish} : {}), ms: Date.now() - started, ...(content !== undefined && !problem ? {unchanged: content === before} : {})};
        await this.event(record, "agent.generate", `${file}: ${mode} request, seed ${seed}${thinking ? `, thinking ${thinking}` : ""}: ${problem ? "no usable file" : generation.unchanged ? "the same file" : `${Buffer.byteLength(content!)} bytes`}`,
          problem ? "failed" : "ok", {model: model.displayName, file, generation});
        return {content: problem ? undefined : content, response, problem, cutOff};
      };
      let result!: Awaited<ReturnType<typeof generate>>;
      // An empty answer (a thinking model that stopped before writing) is asked for once more, with
      // room to think first; a cut-off or unusable answer is the model's attempt and is not retried.
      for (const attempt of [1, 2]) {
        result = attempt === 1 ? await generate("write", {system: systemPrompt, prompt}, 0, format)
          : await generate("retry", {system: systemPrompt, prompt: `${prompt.replace(/\s*\/no_think$/, "")}\n\nYour previous answer contained no code. Write the complete file now.`}, 1024, format);
        // Only an empty answer: a timeout or a provider error is not sent again.
        if (result.content || result.cutOff || !/returned no final answer|returned an empty response/.test(result.response.error ?? "")) break;
      }
      // The same file back while the checks point at it: a small model copies what it is shown when it
      // cannot tell what to change. It is asked once more about the first failure in this file only,
      // thinking first when its template can; otherwise for edits, then for the whole file.
      if (result.content !== undefined && result.content === before && items.length && implicatedFiles(items, record.files, tests).has(file)) {
        await this.event(record, "agent.generate", `${file} came back unchanged while the checks point at it: asking again about its first failure only${thinks ? `, thinking first (${ESCALATION_THINKING} tokens)` : ", as edits"}`, "running", {model: model.displayName, file});
        let again = thinks ? await generate("focus", ask({focus: true, thinking: true, reply: "source"}), ESCALATION_THINKING, "source")
          : await generate("edit", ask({focus: true, reply: "edit"}), 0, "edit");
        if (!thinks && !again.content) again = await generate("whole", ask({focus: true, reply: "source"}), 0, "source");
        if (again.content) result = again;
      }
      const {content, problem, response} = result;
      if (problem || !content) {
        const message = `${file}: ${problem ?? "Invalid or oversized artifact response."}`;
        errors.push(message); await this.event(record, "agent.generate", message, "failed", {model: model.displayName, file, detail: response?.text.slice(0, 4000)});
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
  /** The run's changes against the project. `root`: the checkout folder its paths start with (a
   * citation of a candidate file may leave it out). */
  async diff(id: string): Promise<{files: Array<{path: string; before: string | null; after: string | null}>; canApply: boolean; root: string}> {
    const record = await this.read(id);
    const files: Array<{path: string; before: string | null; after: string | null}> = Object.entries(record.files).filter(([file, content]) => record.baseline[file] !== content)
      .map(([file, after]) => ({path: `${record.outputPath}/${file}`, before: record.baseline[file] ?? null, after}));
    // A file the run deleted: after is null.
    for (const file of record.removed ?? []) files.push({path: `${record.outputPath}/${file}`, before: record.baseline[file] ?? null, after: null});
    return {files, root: record.outputPath ?? "", canApply: !this.active.has(id) && record.status === "accepted" && !record.appliedAt && !!record.outputPath && record.evidence?.candidateHash === filesHash(record.files)};
  }
  async apply(id: string): Promise<void> {
    if (this.active.has(id)) throw new SynthesisError("Run is active. Wait for it to finish before Apply.", 409);
    return this.applyingRun(id, () => this.applyCandidate(id));
  }
  private async applyCandidate(id: string): Promise<void> {
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
  async applyOutcome(id: string): Promise<"applied" | "none" | "partial"> { return this.applyingRun(id, () => this.checkApplied(id)); }
  private async checkApplied(id: string): Promise<"applied" | "none" | "partial"> {
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
  /** A project file a run's candidate cites, as it is now, for the Changes view on this computer
   * (never a paired device's): only a cited path, inside the run's project folder, without links,
   * a text file of at most 1 MiB. */
  async projectFile(id: string, file: unknown): Promise<{path: string; content: string}> {
    const record = await this.read(id);
    const cited = relativePath(file);
    if (!Object.values(record.files).some(text => references(text).some(reference => reference.path === cited))) throw new SynthesisError("This run's files do not cite that path.", 403);
    const project = await this.project(record.projectId);
    if (project.rootPath !== record.rootPath) throw new SynthesisError("The project folder changed since this run.", 409);
    let content: string;
    try { content = await readText(await containedPath(record.rootPath, cited), 1024 * 1024); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SynthesisError(`${cited} does not exist in the project.`, 404);
      throw error;
    }
    if (content.includes("\0")) throw new SynthesisError(`${cited} is not a text file.`, 415);
    return {path: cited, content};
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
    // A deleted run is not written back.
    if (this.removed.has(record.id) || this.removing.has(record.id)) return Promise.resolve();
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
