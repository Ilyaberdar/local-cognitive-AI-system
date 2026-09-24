import { resolveAbortSignal } from "../../llm/provider-utils";
import { NodeResult } from "../types";
import { readConfigNumber, readConfigString, renderWorkflowTemplate } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { nodeAccess } from "./NodeAccess";

/** Read-only HTTP fetch. Pages are reference data; scripts are never executed. */
export class WebFetchNodeExecutor implements NodeExecutor {
  readonly type = "web_fetch" as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const config = context.node.config;
    const approvalId = context.operationId ?? `web-fetch:${context.run.id}:${context.node.id}`;
    const approved = context.approval?.approvalId === approvalId ? context.approval : undefined;
    const url = httpUrl(approved ? String(approved.url) : renderWorkflowTemplate(readConfigString(config, "urlTemplate", ""), context));
    const maxChars = approved ? Number(approved.maxChars) : readConfigNumber(config, "maxChars", 12000, 500, 100000);
    const access = nodeAccess(context);
    const needsApproval = access.requireApproval || access.accessMode !== "full";
    if (needsApproval && !approved) return {
      status: "needs_input", event: "web_fetch.approval_required", summary: `Allow reading ${url.href} and its redirects?`,
      data: { permissionRequired: true, approvalId, url: url.href, maxChars, details: `HTTP GET · ${url.href}\nRead page text only; no scripts or credentials.` }
    };
    if (approved?.approved === false) return { status: "failed", event: "web_fetch.rejected", summary: "Page access rejected.", data: {}, error: "Page access rejected." };
    const signal = resolveAbortSignal(30000, context.signal);
    let current = url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      context.onProgress?.({ phase: "tools", label: "Reading webpage", detail: current.href, at: new Date().toISOString() });
      response = await this.fetchImpl(current, { signal, redirect: "manual", headers: { Accept: "text/html, text/plain, application/json" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 5) throw new Error("Webpage redirect limit exceeded or redirect has no location.");
      current = httpUrl(new URL(location, current).href);
    }
    if (!response!.ok) { await response!.body?.cancel(); throw new Error(`Webpage returned HTTP ${response!.status}.`); }
    const type = response!.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "text/plain";
    if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/csv", "application/json"].includes(type)) {
      await response!.body?.cancel(); throw new Error(`Cannot read ${type} as webpage text.`);
    }
    const reader = response!.body?.getReader();
    if (!reader) throw new Error("Webpage has no response body.");
    const chunks: Uint8Array[] = [];
    const maxBytes = 1_000_000;
    let bytes = 0, bodyTruncated = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const remaining = maxBytes - bytes;
        chunks.push(chunk.value.subarray(0, remaining)); bytes += Math.min(remaining, chunk.value.length);
        if (chunk.value.length > remaining) { bodyTruncated = true; break; }
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const raw = Buffer.concat(chunks).toString("utf8");
    const html = type.includes("html");
    const title = html ? decodeEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 300) : "";
    const text = html ? pageText(raw) : raw.trim();
    const truncated = bodyTruncated || text.length > maxChars;
    return { status: "ok", event: "web_fetch.completed", summary: `Read ${current.href}${truncated ? " (truncated)" : ""}`,
      data: { url: current.href, requestedUrl: url.href, title, text: text.slice(0, maxChars), truncated, contentType: type } };
  }
}

function httpUrl(value: string): URL {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) URL without embedded credentials.");
  return url;
}

function pageText(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:p|div|section|article|h[1-6]|li|tr|br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[\t\r ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? original;
    const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
  });
}
