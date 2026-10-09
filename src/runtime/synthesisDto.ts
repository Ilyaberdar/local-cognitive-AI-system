import type { ActivityEvent, SynthesisModule, SynthesisRun } from "../synthesis/types";
import type { Scrubber } from "./orchestrationDto";
import { publicError } from "./publicError";

/** What a paired device sees of Synthesis on the host (R5-5): modules and runs without the
 * project's folder or the server's data directory (scrubbed to `<workspace>` / `<server>`), error
 * texts reduced by `publicError` (an event's failure to its first line, other absolute paths
 * removed), models by four fields, and answers bounded to fit a frame. */

const MAX_EVENT_BYTES = 256 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** An absolute path the scrubber did not name (a model's folder elsewhere, a process log): a path
 * relative to the project (`Source/Abilities/Dash.cpp`) or `<workspace>/…` is kept. */
const ABSOLUTE_PATH = /\bfile:\/\/\S*|(?<![\w.~<>/-])(?:[A-Za-z]:)?[\\/](?:[^\\/\s"'`:,;()<>]+[\\/])+[^\\/\s"'`:,;()<>]*/g;
const withoutPaths = (text: string) => text.replace(ABSOLUTE_PATH, "<path>");
/** A failure's text as a device sees it: its first line, bounded; a model's answer stays readable. */
const failure = (message: string) => {
  const first = withoutPaths(message.split(/\r?\n/, 1)[0]!.trim()) || "The step failed on the server.";
  return first.length > 300 ? `${first.slice(0, 299)}…` : first;
};
const safeEvent = (event: ActivityEvent): ActivityEvent => ({
  ...event, message: event.status === "failed" ? failure(event.message) : withoutPaths(event.message),
  ...(event.detail !== undefined ? { detail: withoutPaths(event.detail.slice(0, 4000)) } : {})
});

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
  let events = scrub(run.events.filter(event => event.sequence > after)).map(safeEvent);
  let truncated = false;
  while (events.length > 1 && bytes(events) > MAX_EVENT_BYTES) { events = events.slice(Math.ceil(events.length / 4)); truncated = true; }
  return {
    ...runSummary(run, scrub),
    ...(run.evidence ? { evidence: scrub(run.evidence) } : {}),
    models: run.models.map(model => ({ id: model.id, displayName: model.displayName, providerId: model.providerId, sizeBytes: model.sizeBytes })),
    usage: run.usage, events, lastSequence: run.events.at(-1)?.sequence ?? 0, ...(truncated ? { truncated: true } : {})
  };
};
