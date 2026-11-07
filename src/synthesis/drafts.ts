import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMService } from "../llm/LLMService";
import type { LocalModelManagerRegistry } from "../llm/LocalModelManager";
import type { ManagedModel, ProviderDescriptor, ProviderModel } from "../types";
import type { Project } from "../projects/types";
import { isMissingFile, writeJsonAtomically } from "../utils/fileStore";
import { checkDraft, DRAFT_LANGUAGES, DraftLanguage, draftFlow, draftPrompt, MAX_DESCRIPTION_CHARS, parseDraft, repairPrompt } from "./draft";
import { moduleDirectory, moduleName } from "./modules";
import { containedPath, MAX_SOURCE_BYTES, relativePath } from "./paths";
import { FlowModel, ModuleFiles } from "./templates";
import { SynthesisDiagnostic, SynthesisDraft, SynthesisError, SynthesisModule } from "./types";

// Drafts of modules a model writes from the user's description (draft.ts says how). A draft lives in
// the app's data, never in the project, until the user saves it; a run never reads it.

export interface DraftHost {
  project(id: string): Promise<Project>;
  /** Why a cloud provider may not read this project, or nothing when it may. */
  cloudRefusal(providerId: string, project: Project): string | undefined;
  /** Writes a new module's files (never over existing ones) and returns it as the module screen shows it. */
  writeModule(projectId: string, name: string, directory: string, files: ModuleFiles): Promise<SynthesisModule>;
  services: {
    models: Pick<LocalModelManagerRegistry, "listAllModels">;
    loadModel: (model: ManagedModel, signal: AbortSignal, shape?: {parallel: number; contextSize?: number; fit?: boolean}) => Promise<void>;
    contextWindow?: (model: ManagedModel) => number | undefined;
    llm: Pick<LLMService, "generateText">;
    catalog?: {listAll(providerId?: string): Promise<ProviderModel[]>};
    providers?: () => ProviderDescriptor[];
  };
}

/** How many answers a draft asks for: the first and up to three after a check found problems. */
const ATTEMPTS = 4;
/** The context a local model is loaded with for a draft, as for a run. */
const DRAFT_CONTEXT = 16_384;
const MAX_ANSWER_TOKENS = 8000;
/** A local model whose chat template thinks gets this much room to think before it writes; without a
 * budget a small model thinks until the token limit and writes nothing. */
const THINKING = 1024;
const BUDGET_MESSAGE = "\n\nTime is up. I will now write the contract and the tests.\n";
const stamp = () => new Date().toISOString();
const draftId = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new SynthesisError("Invalid draft identifier.", 404); return id; };
const text = (value: unknown, field: string, max = MAX_SOURCE_BYTES) => {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > max) throw new SynthesisError(`${field} must be text of at most ${Math.round(max / 1024)} KiB.`);
  return value;
};

export class SynthesisDrafts {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly directory: string, private readonly host: DraftHost) {}

  async init(): Promise<void> {
    await fs.mkdir(this.directory, {recursive: true});
    // A draft the app stopped writing keeps what it had, and says so.
    for (const record of await this.records()) {
      if (record.status !== "drafting") continue;
      record.status = record.spec ? "ready" : "failed"; delete record.phase;
      record.error = "The app stopped while this draft was written.";
      await this.persist(record);
    }
  }

  /** The models a draft may be written with here: installed local models, larger and sounder first, and
   * the cloud providers set up here with the models they list, when the project allows cloud models. */
  async models(projectId: string) {
    const project = await this.host.project(projectId);
    const local = (await this.host.services.models.listAllModels("llamacpp"))
      .filter(model => model.providerId === "llamacpp" && (model as {filesAvailable?: boolean}).filesAvailable !== false)
      .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.id.localeCompare(b.id))
      .map(model => ({providerId: model.providerId, id: model.id, displayName: model.displayName, ...(model.sizeBytes ? {sizeBytes: model.sizeBytes} : {})}));
    const cloud = [];
    for (const provider of this.host.services.providers?.() ?? []) {
      if (!provider.configured || provider.capabilities?.local === true) continue;
      const listed = await this.host.services.catalog?.listAll(provider.id).catch(() => []) ?? [];
      cloud.push({providerId: provider.id, providerName: provider.name, models: listed.filter(item => item.providerId === provider.id).map(item => item.id).slice(0, 200)});
    }
    return {local, cloud, cloudAllowed: project.cloudModels === true};
  }

  async create(projectId: string, input: Record<string, unknown>): Promise<SynthesisDraft> {
    const project = await this.host.project(projectId);
    if (typeof input.name !== "string") throw new SynthesisError("Name the module.");
    const name = moduleName(input.name);
    if (input.directory !== undefined && typeof input.directory !== "string") throw new SynthesisError("directory must be a project-relative path.");
    const directory = moduleDirectory(input.directory ?? "Synthesis");
    const language = input.language as DraftLanguage;
    if (!DRAFT_LANGUAGES.includes(language)) throw new SynthesisError("Choose TypeScript, JavaScript, Python or C++.");
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (description.length < 20 || description.length > MAX_DESCRIPTION_CHARS) throw new SynthesisError(`Describe the module in 20 to ${MAX_DESCRIPTION_CHARS.toLocaleString("en")} characters.`);
    const output = relativePath(input.output ?? `generated/${name}`);
    if (output.toLowerCase().split("/").includes("synthesis")) throw new SynthesisError("The output folder may not be inside a Synthesis folder: that is where contracts live.");
    const relative = directory ? `${directory}/${name}` : name;
    try { await fs.access(await containedPath(project.rootPath, relative)); throw new SynthesisError(`A module already exists at ${relative}. Choose another name or folder.`, 409); }
    catch (error) { if (error instanceof SynthesisError) throw error; }
    if ([...this.active.keys()].length >= 2) throw new SynthesisError("Two drafts are being written already. Wait for one of them.", 409);
    const model = await this.resolve(project, input.model);

    const record: SynthesisDraft = {id: randomUUID(), projectId, name, directory, output, language, description,
      model: {providerId: model.providerId, id: model.id, displayName: model.displayName}, status: "drafting", attempt: 0, maxAttempts: ATTEMPTS,
      specPath: `${relative}/${name}.lcspec`, flowPath: `${relative}/${name}.lcflow`, tests: {}, diagnostics: [], clauses: [], valid: false,
      usage: {inputTokens: 0, outputTokens: 0, calls: 0}, createdAt: stamp(), updatedAt: stamp()};
    await this.persist(record);
    const controller = new AbortController();
    this.active.set(record.id, controller);
    void this.write(record, model, controller.signal).finally(() => this.active.delete(record.id));
    return record;
  }

  async get(id: string): Promise<SynthesisDraft> {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${draftId(id)}.json`), "utf8")) as SynthesisDraft; }
    catch (error) { if (isMissingFile(error)) throw new SynthesisError("This draft no longer exists.", 404); throw error; }
  }

  async list(projectId: string): Promise<SynthesisDraft[]> {
    return (await this.records()).filter(record => record.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The contract, flow or tests as the user edited them, checked again. An edited contract derives the
   * flow again unless the user edited the flow too. */
  async update(id: string, changes: Record<string, unknown>): Promise<SynthesisDraft> {
    const record = await this.get(id);
    if (record.status === "drafting") throw new SynthesisError("Wait until the model has finished this draft.", 409);
    if (changes.spec !== undefined) record.spec = text(changes.spec, "spec");
    if (changes.flow !== undefined) { record.flow = text(changes.flow, "flow"); record.flowEdited = true; }
    if (changes.tests !== undefined) {
      if (!changes.tests || typeof changes.tests !== "object" || Array.isArray(changes.tests)) throw new SynthesisError("tests maps each test file to its text.");
      const tests: Record<string, string> = {};
      for (const [file, value] of Object.entries(changes.tests)) {
        if (!file.startsWith("tests/")) throw new SynthesisError(`${file}: test files live in tests/ next to the contract.`);
        tests[relativePath(file)] = text(value, file);
      }
      record.tests = tests;
    }
    if (!record.spec) throw new SynthesisError("This draft has no contract yet.", 409);
    if (changes.spec !== undefined && !record.flowEdited) record.flow = draftFlow(record.name, record.spec, record.output, flowModel(record.model));
    await this.check(record);
    record.updatedAt = stamp(); await this.persist(record);
    return record;
  }

  /** Writes the draft into the project as a new module (never over an existing one) and forgets it:
   * from here on the contract and tests are the user's. */
  async save(id: string): Promise<SynthesisModule> {
    const record = await this.get(id);
    if (record.status === "drafting") throw new SynthesisError("Wait until the model has finished this draft.", 409);
    if (!record.spec || !record.flow) throw new SynthesisError("This draft has no contract to save. Edit it or discard it.", 409);
    const module = await this.host.writeModule(record.projectId, record.name, record.directory, {spec: record.spec, flow: record.flow, tests: record.tests});
    await fs.rm(path.join(this.directory, `${record.id}.json`), {force: true});
    return module;
  }

  async discard(id: string): Promise<void> {
    draftId(id);
    this.active.get(id)?.abort();
    await fs.rm(path.join(this.directory, `${id}.json`), {force: true});
  }

  /** Drafts being written now (a server drains them before it stops). */
  activeCount(): number { return this.active.size; }
  dispose(): void { for (const controller of this.active.values()) controller.abort(); }

  private persist(record: SynthesisDraft): Promise<void> { return writeJsonAtomically(path.join(this.directory, `${record.id}.json`), record); }

  private async records(): Promise<SynthesisDraft[]> {
    const names = await fs.readdir(this.directory).catch(error => { if (isMissingFile(error)) return [] as string[]; throw error; });
    const found: SynthesisDraft[] = [];
    for (const file of names.filter(item => /^[a-f0-9-]{36}\.json$/.test(item))) {
      try { found.push(JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8")) as SynthesisDraft); } catch { /* A half-written or removed draft is skipped. */ }
    }
    return found;
  }

  private async resolve(project: Project, value: unknown): Promise<ManagedModel> {
    const choice = value as {providerId?: unknown; id?: unknown} | undefined;
    if (!choice || typeof choice.providerId !== "string" || typeof choice.id !== "string" || !choice.id || choice.id.length > 200) throw new SynthesisError("Choose the model that writes the draft.");
    if (choice.providerId === "llamacpp") {
      const model = (await this.host.services.models.listAllModels("llamacpp")).find(item => item.providerId === "llamacpp" && item.id === choice.id);
      if (!model) throw new SynthesisError(`${choice.id} is not an installed local model.`);
      return model;
    }
    const descriptor = this.host.services.providers?.().find(item => item.id === choice.providerId);
    if (!descriptor || !descriptor.configured) throw new SynthesisError(`${descriptor?.name ?? choice.providerId} is not set up here. Set it up in Settings → Models & Providers.`);
    if (descriptor.capabilities?.local === true) throw new SynthesisError("Drafts are written by the app's own local models or a cloud provider.");
    const refusal = this.host.cloudRefusal(descriptor.id, project);
    if (refusal) throw new SynthesisError(refusal, 403);
    return {id: choice.id, displayName: choice.id, providerId: descriptor.id, providerName: descriptor.name, loaded: true, loadedInstanceIds: []} as ManagedModel;
  }

  private async check(record: SynthesisDraft): Promise<SynthesisDiagnostic[]> {
    const checked = await checkDraft({name: record.name, specPath: record.specPath, flowPath: record.flowPath, spec: record.spec ?? "", flow: record.flow, tests: record.tests});
    record.diagnostics = checked.diagnostics; record.clauses = checked.clauses; record.valid = checked.valid && Boolean(record.flow);
    return checked.diagnostics;
  }

  private async write(record: SynthesisDraft, model: ManagedModel, signal: AbortSignal): Promise<void> {
    const local = model.providerId === "llamacpp";
    const update = async (changes: Partial<SynthesisDraft>) => { Object.assign(record, changes, {updatedAt: stamp()}); if (!signal.aborted) await this.persist(record); };
    try {
      if (local) {
        await update({phase: "loading"});
        await this.host.services.loadModel(model, signal, {parallel: 1, contextSize: DRAFT_CONTEXT, fit: true});
      }
      const base = draftPrompt({name: record.name, language: record.language, output: record.output, description: record.description});
      let prompt = base.prompt;
      for (let attempt = 1; attempt <= record.maxAttempts; attempt++) {
        signal.throwIfAborted();
        // Consent may be withdrawn while a draft is written: checked again before each request.
        if (!local) { const refusal = this.host.cloudRefusal(model.providerId, await this.host.project(record.projectId)); if (refusal) throw new SynthesisError(refusal); }
        await update({attempt, phase: "writing", tokens: 0});
        const window = local ? this.host.services.contextWindow?.(model) : undefined;
        const promptTokens = Math.ceil((base.system.length + prompt.length) / 3);
        const room = window ? window - promptTokens - 64 : Infinity;
        if (room < 1500) throw new SynthesisError(`The draft's prompt takes about ${promptTokens.toLocaleString("en")} of ${model.displayName}'s ${window!.toLocaleString("en")} context tokens: choose a model that can load with a larger context, or a cloud model.`);
        let savedAt = 0;
        const note = (changes: Partial<SynthesisDraft>) => {
          Object.assign(record, changes);
          if (Date.now() - savedAt > 1000) { savedAt = Date.now(); record.updatedAt = stamp(); void this.persist(record).catch(() => undefined); }
        };
        const response = await this.host.services.llm.generateText({usagePurpose: "synthesis-draft", model: model.id, signal, systemPrompt: base.system, prompt,
          maxTokens: Math.min(MAX_ANSWER_TOKENS + (local ? THINKING : 0), room), temperature: 0.2,
          // A slow local model (on battery, a large one) may need long for 9k tokens: the token limit bounds it.
          timeoutMs: (local ? 30 : 10) * 60_000, holder: `Synthesis · draft of ${record.name}`,
          ...(local ? {localReasoningBudget: THINKING, localReasoningBudgetMessage: BUDGET_MESSAGE} : {}),
          // Progress (which also streams a local answer, so its tokens are counted as they come).
          onProgress: event => { if (event.phase === "thinking" && record.phase !== "thinking") note({phase: "thinking"}); else if ((event.phase === "generating" || event.phase === "responding") && record.phase !== "writing") note({phase: "writing"}); },
          onGenerated: tokens => note({tokens})}, model.providerId);
        signal.throwIfAborted();
        record.usage.calls++; record.usage.inputTokens += response.usage?.inputTokens ?? 0; record.usage.outputTokens += response.usage?.outputTokens ?? 0;
        const answer = response.text.trim();
        if (!answer) throw new SynthesisError(response.error ?? `${model.displayName} returned no answer.`);
        const cutOff = (response.raw as {choices?: Array<{finish_reason?: string}>} | undefined)?.choices?.[0]?.finish_reason === "length";
        const parsed = parseDraft(answer, record.name);
        let problems: SynthesisDiagnostic[];
        if (!parsed.spec || cutOff) {
          problems = [{severity: "error", code: cutOff ? "DRAFT_CUT_OFF" : "DRAFT_FORMAT", file: record.specPath, line: 1, column: 1,
            message: cutOff ? "The answer was cut off at the token limit: write a shorter description and fewer, shorter tests."
              : `The answer had no "### ${record.name}.lcspec" heading followed by one fenced block.`}];
          if (!record.spec) record.diagnostics = problems;
        } else {
          record.spec = parsed.spec; record.tests = parsed.tests;
          record.flow = draftFlow(record.name, parsed.spec, record.output, flowModel(record.model));
          await update({phase: "checking"});
          // Errors and clauses nothing checks go back to the model; other warnings are the user's to judge.
          problems = (await this.check(record)).filter(item => item.severity === "error" || item.code === "SPEC_CLAUSE_UNTESTED");
        }
        if (!problems.length) break;
        prompt = repairPrompt(base.prompt, answer, problems);
      }
      if (!record.spec) throw new SynthesisError(`${model.displayName} did not write a contract in ${record.maxAttempts} answers. Try a larger model or a clearer description.`);
      delete record.phase;
      await update({status: "ready"});
    } catch (error) {
      if (signal.aborted) return;
      delete record.phase;
      await update({status: record.spec ? "ready" : "failed", error: error instanceof Error ? error.message : String(error)}).catch(() => undefined);
    }
  }
}

/** The flow runs on the model that wrote the draft: an installed model by its id, or the provider's. */
const flowModel = (model: SynthesisDraft["model"]): FlowModel => model.providerId === "llamacpp" ? {kind: "local", id: model.id} : {kind: "cloud", provider: model.providerId, id: model.id};

