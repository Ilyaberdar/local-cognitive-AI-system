/** What leaves for Sentry (crash and error reports, bug reports), decided here, before sending.
 * Allowlists, not clean-up: only the listed contexts, the technical log's own breadcrumbs, stack
 * frames without variables, and error texts cut short with paths, addresses and tokens masked.
 * Nothing automatic is sent without the user's consent; a bug report is sent because they pressed
 * Send, with what they saw in its preview. Sentry's own server-side scrubbing is a second layer. */

export const SENTRY_DSN = "https://4f216cbcb0930a8b75fe0123ef140b38@o4512229397233664.ingest.de.sentry.io/4512229424889936";
/** Breadcrumbs from the technical log (src/diagnostics/events.ts): codes only. */
export const DIAGNOSTIC_BREADCRUMB = "lc";

type Json = Record<string, unknown>;
const CONTEXTS = new Set(["os", "device", "app", "runtime", "gpu", "electron", "chrome", "node", "culture", "trace", "feedback", "lc"]);
const DEVICE_FIELDS = new Set(["arch", "family", "model", "memory_size", "free_memory", "processor_count", "cpu_description", "processor_frequency", "boot_time", "screen_density", "screen_resolution", "simulator", "battery_level", "charging", "online"]);
const APP_FIELDS = new Set(["app_name", "app_version", "app_build", "app_start_time", "app_memory", "build_type"]);
const ELECTRON_FIELDS = new Set(["details", "crashed_process", "crashed_url"]);

/** A text that may hold a path, an address, a token or a user's words: cut short, and the
 * recognisable parts masked. Not a privacy guarantee on its own; it bounds what a message carries. */
export const maskText = (value: unknown, limit = 300): string => String(value ?? "")
  .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<token>")
  .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "<credential>")
  .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_]?[A-Za-z0-9_-]{12,}/g, "<secret>")
  .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, "<secret>")
  .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#'"]+[^\s'"]*/gi, (_match, scheme: string) => `${scheme}<host>`)
  .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/:*?"<>|]+){2,}[\\/]?/g, path => `<path>/${path.split(/[\\/]/).filter(Boolean).pop() ?? ""}`)
  .slice(0, limit);

const pick = (value: unknown, allowed: Set<string>): Json | undefined => {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Json).filter(([key]) => allowed.has(key)));
};

const scrubFrames = (stacktrace: unknown): void => {
  const frames = (stacktrace as { frames?: Json[] } | undefined)?.frames;
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    delete frame.vars;
    // A frame outside the app (a user's file, a server's code) keeps no source lines.
    if (typeof frame.filename === "string" && !frame.filename.startsWith("app:///")) {
      frame.filename = maskText(frame.filename, 200);
      delete frame.abs_path; delete frame.pre_context; delete frame.context_line; delete frame.post_context;
    }
  }
};

/** The event as it may leave, or null when it may not. `automatic`: the user's consent to error
 * and crash reports. */
export const scrubSentryEvent = <T extends Json>(event: T, automatic: boolean): T | null => {
  const feedback = event.type === "feedback";
  if (!feedback && !automatic) return null;
  const out = event as Json;
  delete out.user; delete out.request; delete out.extra; delete out.server_name; delete out.modules;
  // A bug report carries what its preview showed; an error carries the log's own breadcrumbs only.
  out.breadcrumbs = feedback ? [] : (Array.isArray(out.breadcrumbs) ? out.breadcrumbs : []).filter(crumb => (crumb as Json)?.category === DIAGNOSTIC_BREADCRUMB);
  const contexts = (out.contexts ?? {}) as Json;
  for (const key of Object.keys(contexts)) if (!CONTEXTS.has(key)) delete contexts[key];
  if (contexts.device) contexts.device = pick(contexts.device, DEVICE_FIELDS);
  if (contexts.app) contexts.app = pick(contexts.app, APP_FIELDS);
  if (contexts.electron) {
    const electron = pick(contexts.electron, ELECTRON_FIELDS) ?? {};
    // A window's address names the chat or project it showed.
    if (electron.crashed_url) electron.crashed_url = "app";
    contexts.electron = electron;
  }
  if (contexts.feedback && typeof contexts.feedback === "object") delete (contexts.feedback as Json).url;
  if (typeof out.message === "string") out.message = maskText(out.message);
  const logentry = out.logentry as Json | undefined;
  if (logentry) { logentry.message = maskText(logentry.message); delete logentry.params; }
  for (const value of ((out.exception as { values?: Json[] } | undefined)?.values ?? [])) {
    if (value.value !== undefined) value.value = maskText(value.value);
    scrubFrames(value.stacktrace);
  }
  for (const thread of ((out.threads as { values?: Json[] } | undefined)?.values ?? [])) scrubFrames(thread.stacktrace);
  return out as T;
};

/** Only the technical log's breadcrumbs: no console lines, requests, window titles or clicks. */
export const scrubSentryBreadcrumb = <T extends Json>(breadcrumb: T): T | null =>
  breadcrumb.category === DIAGNOSTIC_BREADCRUMB ? breadcrumb : null;
