// A browser-safe copy of parseTarget/targetLabel from src/synthesis/agents/AgentHttp.ts, so the
// web-targets editor validates and normalizes each origin exactly as the engine does before it is
// saved. The server validates again regardless; this is the same message shown as you type.
export interface Target { scheme: string; host: string; port: number; prefix: string }
export function parseTarget(pattern: string): Target {
  const url = new URL(pattern);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${pattern}: a target is an https:// (or http://) address.`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${pattern}: a target has no credentials, query or fragment.`);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const path = url.pathname.replace(/\/+$/, "");
  return { scheme: url.protocol, host: url.hostname.toLowerCase(), port, prefix: path === "/" ? "" : path };
}
/** A target as it reads, for display and to store; the canonical form the server keeps. */
export function targetLabel(t: Target): string { return `${t.scheme}//${t.host}${t.port === (t.scheme === "https:" ? 443 : 80) ? "" : `:${t.port}`}${t.prefix}`; }
