import path from "node:path";
import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { SynthesisService } from "../synthesis/SynthesisService";
import { SynthesisError } from "../synthesis/types";
import type { CommandLedger, CommandRecord } from "./CommandLedger";
import { pathScrubber, type Scrubber } from "./orchestrationDto";
import { PROJECT_ON_HOST, type ProjectAccess } from "./projectOperations";
import { publicError } from "./publicError";
import { runDetail, runSummary, safeModule } from "./synthesisDto";

/** What a diff answer carries at most; larger files are fetched one by one (`synthesis.runs.file`). */
const MAX_DIFF_BYTES = 768 * 1024, MAX_FILE_BYTES = 512 * 1024;
const commandId = z.string().min(8).max(100);
const id = z.string().min(1).max(200);
const runId = z.uuid();
const moduleId = z.string().min(1).max(300);
const schemas = {
  project: z.object({ projectId: id }).strict(),
  module: z.object({ projectId: id, moduleId }).strict(),
  folders: z.object({ projectId: id, directory: z.string().max(240).optional() }).strict(),
  create: z.object({ commandId, projectId: id, template: z.enum(["empty", "calculator"]), name: z.string().min(1).max(64).optional(),
    directory: z.string().max(240).optional() }).strict(),
  run: z.object({ runId }).strict(),
  get: z.object({ runId, after: z.number().int().nonnegative().optional() }).strict(),
  file: z.object({ runId, path: z.string().min(1).max(240), side: z.enum(["before", "after"]) }).strict(),
  start: z.object({ commandId, projectId: id, moduleId }).strict(),
  runCommand: z.object({ commandId, runId }).strict()
};
const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
  return result.data;
};

export interface SynthesisOperationDependencies {
  runtimeManager: RuntimeManager;
  ledger: CommandLedger;
  projects: ProjectAccess;
  scopeOf(context: OperationContext): string;
  isDraining(): boolean;
  /** The host's data directories, named `<server>` in what a device receives. */
  hostDirectories?: string[];
}

/** Synthesis on the host for a paired device (R5-5): modules and runs of projects a device may
 * use, read as safe views; making a module, starting, restarting and applying a run are commands
 * (a resend acts once, a restart finds what was done). The candidate preview and "Open in editor"
 * stay on the host's own screen. */
export const createSynthesisOperations = (deps: SynthesisOperationDependencies): Record<string, RemoteOperation> => {
  const service = (): SynthesisService => deps.runtimeManager.getRuntime().synthesis;
  const scrubberFor = async (projectId: string): Promise<Scrubber> => {
    const project = await deps.runtimeManager.getRuntime().projectStore.get(projectId);
    return pathScrubber([...(project ? [[project.rootPath, "<workspace>"] as [string, string]] : []),
      ...(deps.hostDirectories ?? []).map(dir => [dir, "<server>"] as [string, string]), ...(deps.hostDirectories ?? []).map(dir => [path.resolve(dir), "<server>"] as [string, string])]);
  };
  /** A project's Synthesis is a device's to see when the project is (its own and shared), and to
   * change when it may also be used (not archived). */
  const requireProject = async (projectId: string, use: boolean) => {
    if (!await deps.projects.visible(projectId)) {
      const exists = await deps.runtimeManager.getRuntime().projectStore.get(projectId);
      throw exists ? new RemoteOperationError(PROJECT_ON_HOST, "unsupported") : new RemoteOperationError("The project does not exist on the server.", "project_unknown");
    }
    if (use) {
      const { reason } = await deps.projects.usable(projectId);
      if (reason) throw new RemoteOperationError(reason, "unsupported");
    }
  };
  /** A run is reached through its project: an id is not a permission. */
  const requireRun = async (id: string, use: boolean) => {
    const run = await service().existing(id);
    if (!run) throw new RemoteOperationError("The Synthesis run does not exist on the server.", "not_found");
    await requireProject(run.projectId, use).catch(error => {
      if (error instanceof RemoteOperationError && error.code === "project_unknown") throw new RemoteOperationError("The Synthesis run does not exist on the server.", "not_found");
      throw error;
    });
    return run;
  };
  /** Service refusals keep a code and a short, path-free text; anything else is reported generically. */
  const known = async <T>(projectId: string | undefined, task: () => Promise<T>): Promise<T> => {
    try { return await task(); }
    catch (error) {
      if (error instanceof RemoteOperationError) throw error;
      if (!(error instanceof SynthesisError)) throw error;
      const scrub = projectId ? await scrubberFor(projectId) : pathScrubber([]);
      const code = error.statusCode === 404 ? "not_found" : error.statusCode === 409 ? "conflict" : "invalid_request";
      throw new RemoteOperationError(publicError(scrub(error.message)), code);
    }
  };
  const command = <T>(context: OperationContext, operation: string, input: { commandId: string }, execute: (record: CommandRecord) => Promise<T>,
    options: { reserveRunId?: boolean; target?: string; reconcile?: (record: CommandRecord) => Promise<T | undefined>; allowWhileDraining?: boolean } = {}) => {
    const { commandId: key, ...payload } = input;
    const { allowWhileDraining, ...rest } = options;
    return deps.ledger.run({ scope: deps.scopeOf(context), key, operation, payload, ...(allowWhileDraining ? {} : { accepting: () => !deps.isDraining() }), ...rest }, execute);
  };

  return {
    "synthesis.modules.list": payload => {
      const { projectId } = parse(schemas.project, payload);
      return known(projectId, async () => {
        await requireProject(projectId, false);
        const scrub = await scrubberFor(projectId);
        return { modules: (await service().modules(projectId)).map(module => safeModule(module, scrub)) };
      });
    },
    "synthesis.modules.get": payload => {
      const { projectId, moduleId: module } = parse(schemas.module, payload);
      return known(projectId, async () => {
        await requireProject(projectId, false);
        return safeModule(await service().module(projectId, module), await scrubberFor(projectId), true);
      });
    },
    "synthesis.folders.list": payload => {
      const { projectId, directory } = parse(schemas.folders, payload);
      return known(projectId, async () => {
        await requireProject(projectId, false);
        return service().folders(projectId, directory ?? "");
      });
    },
    /** Makes a module from a template in the project's folder. */
    "synthesis.modules.create": (payload, context) => {
      const input = parse(schemas.create, payload);
      return known(input.projectId, () => command(context, "synthesis.modules.create", input, () => known(input.projectId, async () => {
        await requireProject(input.projectId, true);
        const name = input.name ?? (input.template === "empty" ? "NewModule" : "Calculator");
        return safeModule(await service().createModule(input.projectId, name, { template: input.template, ...(input.directory !== undefined ? { directory: input.directory } : {}) }),
          await scrubberFor(input.projectId), true);
      })));
    },
    "synthesis.runs.list": payload => {
      const { projectId } = parse(schemas.project, payload);
      return known(projectId, async () => {
        await requireProject(projectId, false);
        const scrub = await scrubberFor(projectId);
        return { runs: (await service().list(projectId)).map(run => runSummary(run, scrub)) };
      });
    },
    /** A run and its events after `after`: the device polls it while the run goes on. */
    "synthesis.runs.get": payload => {
      const { runId: id, after } = parse(schemas.get, payload);
      return known(undefined, async () => {
        const run = await requireRun(id, false);
        return runDetail(run, await scrubberFor(run.projectId), after ?? 0);
      });
    },
    "synthesis.runs.sources": payload => {
      const { runId: id } = parse(schemas.run, payload);
      return known(undefined, async () => { await requireRun(id, false); return service().sources(id); });
    },
    /** The run's changes against the project, contents while they fit a frame (`omitted` past that). */
    "synthesis.runs.diff": payload => {
      const { runId: id } = parse(schemas.run, payload);
      return known(undefined, async () => {
        await requireRun(id, false);
        const diff = await service().diff(id);
        let budget = MAX_DIFF_BYTES;
        const files = diff.files.map(file => {
          const size = Buffer.byteLength(file.after) + Buffer.byteLength(file.before ?? "");
          const sizes = { beforeBytes: file.before === null ? null : Buffer.byteLength(file.before), afterBytes: Buffer.byteLength(file.after) };
          if (size > budget) return { path: file.path, ...sizes, omitted: true };
          budget -= size;
          return { path: file.path, before: file.before, after: file.after, ...sizes };
        });
        return { files, canApply: diff.canApply };
      });
    },
    "synthesis.runs.file": payload => {
      const { runId: id, path: file, side } = parse(schemas.file, payload);
      return known(undefined, async () => {
        await requireRun(id, false);
        const found = (await service().diff(id)).files.find(item => item.path === file);
        if (!found) throw new RemoteOperationError("The file is not part of this run.", "not_found");
        const content = side === "after" ? found.after : found.before;
        if (content !== null && Buffer.byteLength(content) > MAX_FILE_BYTES) throw new RemoteOperationError("The file is too large to show here.", "too_large");
        return { path: file, side, content };
      });
    },
    /** Starts a run of a module; returns once it is queued, its progress is read with `runs.get`. */
    "synthesis.runs.start": (payload, context) => {
      const input = parse(schemas.start, payload);
      return known(input.projectId, async () => {
        await requireProject(input.projectId, true);
        const scrub = await scrubberFor(input.projectId);
        return command(context, "synthesis.runs.start", input, record => known(input.projectId, async () =>
          runSummary(await service().start(input.projectId, input.moduleId, { runId: record.runId }), scrub)), {
          reserveRunId: true,
          // A restart after the run was made: that run is the answer (recovery interrupted it).
          reconcile: async record => { const run = record.runId ? await service().existing(record.runId) : undefined; return run ? runSummary(run, scrub) : undefined; }
        });
      });
    },
    /** Stops a run; answers within 10 s with what it is then (it may still be stopping). */
    "synthesis.runs.cancel": payload => {
      const { runId: id } = parse(schemas.run, payload);
      return known(undefined, async () => {
        const run = await requireRun(id, false);
        const stopped = service().cancel(id).then(() => undefined);
        await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 10_000).unref())]);
        return runSummary((await service().existing(id)) ?? run, await scrubberFor(run.projectId));
      });
    },
    /** A new run from an earlier run's frozen sources. */
    "synthesis.runs.resume": (payload, context) => {
      const input = parse(schemas.runCommand, payload);
      return known(undefined, async () => {
        const run = await requireRun(input.runId, true);
        const scrub = await scrubberFor(run.projectId);
        return command(context, "synthesis.runs.resume", input, record => known(run.projectId, async () =>
          runSummary(await service().restart(input.runId, { runId: record.runId }), scrub)), {
          reserveRunId: true, target: input.runId,
          reconcile: async record => { const made = record.runId ? await service().existing(record.runId) : undefined; return made ? runSummary(made, scrub) : undefined; }
        });
      });
    },
    /** Writes an accepted run's files into the project (a short final step: allowed while draining). */
    "synthesis.runs.apply": (payload, context) => {
      const input = parse(schemas.runCommand, payload);
      return known(undefined, async () => {
        const run = await requireRun(input.runId, true);
        return command(context, "synthesis.runs.apply", input, () => known(run.projectId, async () => {
          await service().apply(input.runId);
          return { ok: true, appliedAt: (await service().existing(input.runId))?.appliedAt ?? new Date().toISOString() };
        }), { target: input.runId, allowWhileDraining: true,
          reconcile: async () => { const applied = (await service().existing(input.runId))?.appliedAt; return applied ? { ok: true, appliedAt: applied } : undefined; } });
      });
    }
  };
};
