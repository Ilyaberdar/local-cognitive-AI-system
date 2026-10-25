// This window's uncaught errors go to the main process, which reports them only with the user's
// consent and decides what may leave (src/diagnostics/sentryScrub.ts). Only the app's own scripts.
const bridge = window.desktopDiagnostics;
if (bridge?.reportError) {
  const ours = source => typeof source === "string" && source.startsWith(`${location.origin}/`);
  const forward = (error, source) => {
    if (source !== undefined && !ours(source)) return;
    try { bridge.reportError({ name: error?.name, message: error?.message ?? String(error ?? ""), stack: error?.stack }); } catch { /* Never breaks the page. */ }
  };
  window.addEventListener("error", event => forward(event.error ?? { message: event.message }, event.filename || undefined));
  window.addEventListener("unhandledrejection", event => forward(event.reason instanceof Error ? event.reason : { name: "UnhandledRejection", message: "A promise was rejected without a handler." }));
}

// The page's Content Security Policy (src/api/uiSecurityHeaders.ts) blocked something: said in the
// console, so a part of the UI that stops working says why. Nothing leaves the window.
document.addEventListener("securitypolicyviolation", event => {
  console.warn(`[csp] blocked ${event.effectiveDirective}: ${event.blockedURI || "inline"} at ${event.sourceFile || "the page"}:${event.lineNumber || 0}`);
});
