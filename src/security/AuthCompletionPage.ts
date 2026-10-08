import { createHash } from "crypto";
import type { ServerResponse } from "http";

const style = "body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111214;color:#ecedef}main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#a6abb5;margin:0 0 24px}a{display:inline-block;padding:10px 18px;border-radius:10px;background:#b4c9eb;color:#111214;text-decoration:none;font-weight:600}.failure h1{color:#f2b8b5}small{display:block;margin-top:20px;color:#7d828c}";
const styleHash = createHash("sha256").update(style).digest("base64");
const appLinkPattern = /^localcognitive:\/\/auth\/complete\/[A-Za-z0-9_-]{22}$/;

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** No scripts, no external resources: only the hashed inline style is allowed. */
export const authPageHeaders: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "Cache-Control": "no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer", Connection: "close"
};

export interface AuthPage { outcome: "success" | "failure"; title: string; message: string; appLink?: string }

/** Browser page shown after account or plugin authorization. It never contains codes or tokens;
 * the optional deep link carries only an opaque attempt id. */
export const renderAuthCompletionPage = (page: AuthPage): string => {
  const link = page.appLink && appLinkPattern.test(page.appLink) ? `<a href="${escapeHtml(page.appLink)}">Open Local Cognitive</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)}</title><style>${style}</style></head><body><main class="${page.outcome}"><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.message)}</p>${link}<small>Return to Local Cognitive. You can close this tab.</small></main></body></html>`;
};

export const sendAuthPage = (response: ServerResponse, status: number, page: AuthPage): void => {
  response.writeHead(status, authPageHeaders);
  response.end(renderAuthCompletionPage(page));
};
