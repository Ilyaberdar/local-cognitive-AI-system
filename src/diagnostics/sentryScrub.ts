import os from "node:os";

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

// This computer's name and the account's user name, wherever a message carries them.
const literals = (() => {
  const names: string[] = [];
  try { names.push(os.hostname(), os.hostname().replace(/\.local$/, "")); } catch { /* Unknown. */ }
  try { names.push(os.userInfo().username); } catch { /* Unknown. */ }
  return [...new Set(names.filter(name => name.length >= 4))].sort((a, b) => b.length - a.length);
})();
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literalPattern = literals.length ? new RegExp(literals.map(escapeRegExp).join("|"), "gi") : undefined;

/** A text that may hold a path, an address, a token or a user's words: cut short, and the
 * recognisable parts masked, quoted text among them (a JSON error quotes the text it could not
 * read: a model's answer). Not a privacy guarantee on its own; it bounds what a message carries. */
export const maskText = (value: unknown, limit = 300): string => String(value ?? "")
  .replace(/"[^"\n]{12,}"|'[^'\n]{12,}'|`[^`\n]{12,}`/g, quoted => `${quoted[0]}…${quoted[0]}`)
  .replace(literalPattern ?? /$^/, "<name>")
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

/** A server's own files in stack frames as app:/// paths (as the desktop SDK does), so they keep
 * their source lines; any other path is masked by scrubSentryEvent. */
export const rewriteAppFrames = <T extends Json>(event: T, root: string): T => {
  const prefix = root.replace(/[\\/]+$/, "");
  const rewrite = (stacktrace: unknown) => {
    for (const frame of ((stacktrace as { frames?: Json[] } | undefined)?.frames ?? [])) {
      for (const key of ["filename", "abs_path"] as const) {
        const value = frame[key];
        if (typeof value === "string" && (value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}\\`))) frame[key] = `app:///${value.slice(prefix.length + 1).replace(/\\/g, "/")}`;
      }
    }
  };
  for (const value of ((event.exception as { values?: Json[] } | undefined)?.values ?? [])) rewrite(value.stacktrace);
  for (const thread of ((event.threads as { values?: Json[] } | undefined)?.values ?? [])) rewrite(thread.stacktrace);
  return event;
};

/** Only the technical log's breadcrumbs: no console lines, requests, window titles or clicks. */
export const scrubSentryBreadcrumb = <T extends Json>(breadcrumb: T): T | null =>
  breadcrumb.category === DIAGNOSTIC_BREADCRUMB ? breadcrumb : null;
