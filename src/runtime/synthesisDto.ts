import type { SynthesisModule, SynthesisRun } from "../synthesis/types";
import type { Scrubber } from "./orchestrationDto";
import { publicError } from "./publicError";

/** What a paired device sees of Synthesis on the host (R5-5): modules and runs without the
 * project's folder or the server's data directory (scrubbed to `<workspace>` / `<server>`), error
 * texts reduced by `publicError`, models by four fields, and answers bounded to fit a frame. */

const MAX_EVENT_BYTES = 256 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** A module; its sources only when asked for one module (a list of 100 would not fit a frame). */
export const safeModule = (module: SynthesisModule, scrub: Scrubber, withSources = false) => ({
  id: module.id, name: module.name, specPath: module.specPath, flowPath: module.flowPath, valid: module.valid,
  diagnostics: scrub(module.diagnostics.slice(0, 50).map(item => ({ ...item, message: publicError(item.message) }))),
  ...(withSources ? { specSource: module.specSource ?? "", flowSource: module.flowSource ?? "" } : {})
});

/** A run in a list: no events, evidence or models. */
export const runSummary = (run: SynthesisRun, scrub: Scrubber) => ({
  id: run.id, projectId: run.projectId, moduleId: run.moduleId, moduleName: run.moduleName, status: run.status, phase: run.phase,
  iteration: run.iteration, createdAt: run.createdAt, updatedAt: run.updatedAt,
  ...(run.appliedAt ? { appliedAt: run.appliedAt } : {}), ...(run.restartedFrom ? { restartedFrom: run.restartedFrom } : {}),
  ...(run.error ? { error: publicError(scrub(run.error)) } : {})
});

/** A run with its evidence, models, usage and its events after `after` (newest kept when many). */
export const runDetail = (run: SynthesisRun, scrub: Scrubber, after = 0) => {
  let events = scrub(run.events.filter(event => event.sequence > after));
  let truncated = false;
  while (events.length > 1 && bytes(events) > MAX_EVENT_BYTES) { events = events.slice(Math.ceil(events.length / 4)); truncated = true; }
  return {
    ...runSummary(run, scrub),
    ...(run.evidence ? { evidence: scrub(run.evidence) } : {}),
    models: run.models.map(model => ({ id: model.id, displayName: model.displayName, providerId: model.providerId, sizeBytes: model.sizeBytes })),
    usage: run.usage, events, lastSequence: run.events.at(-1)?.sequence ?? 0, ...(truncated ? { truncated: true } : {})
  };
};
