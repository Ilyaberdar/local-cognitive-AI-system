import { createHash } from "crypto";
import type { ServerResponse } from "http";
import { APP_ICON_PNG_BASE64 } from "./authPageIcon";

// The app's own look (public/assets/liquid-glass.css): its UI font stack, its dark tokens and, when the
// browser is in light mode, its light ones, the way the app's System appearance follows the OS.
const style = [
  ":root{color-scheme:light dark;--bg:#111214;--surface:#18191d;--line:rgba(230,233,242,.09);--text:#ecedef;--muted:#a0a2ab;--faint:#838791;",
  "--success:#8bcca6;--danger:#ed9295;--focus:rgba(159,190,234,.45);--shadow:0 24px 64px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.05)}",
  "@media (prefers-color-scheme:light){:root{--bg:#e9edf2;--surface:#f5f7fa;--line:rgba(40,54,78,.10);--text:#273140;--muted:#5f6c7d;--faint:#7b8796;",
  "--success:#337851;--danger:#b64d57;--focus:rgba(70,104,150,.35);--shadow:0 18px 48px rgba(45,64,94,.10),inset 0 1px 0 #fff}}",
  "*{box-sizing:border-box}html,body{height:100%}",
  "body{margin:0;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);",
  "font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}",
  "main{width:100%;max-width:380px;padding:32px 28px 26px;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:var(--shadow);text-align:center}",
  ".mark{position:relative;width:56px;height:56px;margin:0 auto 14px}.mark img{display:block;width:56px;height:56px}",
  ".badge{position:absolute;right:-5px;bottom:-3px;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--success);color:var(--surface);",
  "box-shadow:0 0 0 3px var(--surface)}.failure .badge{background:var(--danger)}.badge svg{width:12px;height:12px}",
  ".brand{margin:0 0 6px;color:var(--faint);font-size:12px;letter-spacing:.01em}",
  "h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-.01em;line-height:1.3}",
  "p{margin:0;color:var(--muted);font-size:13px}",
  "a{display:inline-flex;align-items:center;justify-content:center;min-height:34px;margin-top:20px;padding:7px 16px;border-radius:11px;",
  "background:var(--text);color:var(--bg);font-size:13px;font-weight:500;text-decoration:none}a:hover{opacity:.9}a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}",
  ".hint{margin-top:18px;color:var(--faint);font-size:12px}"
].join("");
// A tab the browser opened for the app may be closed by its page only when nothing else is in its
// history; after a sign-in with several pages it stays open, and its text says it can be closed.
const closeScript = "setTimeout(function(){window.close()},1200)";
const hash = (value: string) => createHash("sha256").update(value).digest("base64");
const appLinkPattern = /^localcognitive:\/\/auth\/complete\/[A-Za-z0-9_-]{22}$/;
const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const cross = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>';

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Nothing from elsewhere: only the hashed inline style and close script, and the inline icon. */
export const authPageHeaders: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(closeScript)}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "Cache-Control": "no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer", Connection: "close"
};

export interface AuthPage { outcome: "success" | "failure"; title: string; message: string; appLink?: string }

/** Browser page shown after account or plugin authorization. It never contains codes or tokens;
 * the optional deep link carries only an opaque attempt id. A success tries to close its tab. */
export const renderAuthCompletionPage = (page: AuthPage): string => {
  const success = page.outcome === "success";
  const link = page.appLink && appLinkPattern.test(page.appLink) ? `<a href="${escapeHtml(page.appLink)}">Open Local Cognitive</a>` : "";
  const hint = success ? "You can close this tab." : "You can close this tab and try again in Local Cognitive.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">` +
    `<title>${escapeHtml(page.title)} · Local Cognitive</title><style>${style}</style></head><body><main class="${success ? "success" : "failure"}">` +
    `<div class="mark"><img src="data:image/png;base64,${APP_ICON_PNG_BASE64}" width="56" height="56" alt=""><span class="badge" aria-hidden="true">${success ? check : cross}</span></div>` +
    `<p class="brand">Local Cognitive</p><h1>${escapeHtml(page.title)}</h1>${page.message ? `<p>${escapeHtml(page.message)}</p>` : ""}${link}<p class="hint">${hint}</p></main>` +
    `${success ? `<script>${closeScript}</script>` : ""}</body></html>`;
};

export const sendAuthPage = (response: ServerResponse, status: number, page: AuthPage): void => {
  response.writeHead(status, authPageHeaders);
  response.end(renderAuthCompletionPage(page));
};
