import { resolveAbortSignal } from "../../llm/provider-utils";
import { describeAddress, guardedGet, type GuardedGetOptions, type GuardedResponse, type Hooks } from "../../security/egress";
import { NodeResult } from "../types";
import { readConfigNumber, readConfigString, renderWorkflowTemplate } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { nodeAccess } from "./NodeAccess";

const TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/csv", "application/json"];

export interface WebFetchOptions {
  /** The request (tests may give another). */
  get?: (url: URL, options: GuardedGetOptions) => Promise<GuardedResponse>;
  /** The app's own API port: never read, approved or not. */
  ownPort?: number;
  /** Name resolution and address checks (tests reach a server on this machine through them). */
  hooks?: Partial<Hooks>;
}

/** Read-only HTTP fetch. Pages are reference data; scripts are never executed. The address may come
 * from a model's output (a template), and full access skips the prompt, so what it may reach is
 * decided by the request itself (security/egress.ts): public addresses, and this computer or the local
 * network only at the address the user named — the one approved in the prompt, or one written in the
 * step with no template in its scheme, host or port. Link-local, metadata and the app's own API never. */
export class WebFetchNodeExecutor implements NodeExecutor {
  readonly type = "web_fetch" as const;
  constructor(private readonly options: WebFetchOptions = {}) {}

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const config = context.node.config;
    const approvalId = context.operationId ?? `web-fetch:${context.run.id}:${context.node.id}`;
    const approved = context.approval?.approvalId === approvalId ? context.approval : undefined;
    const template = readConfigString(config, "urlTemplate", "");
    const url = httpUrl(approved ? String(approved.url) : renderWorkflowTemplate(template, context));
    const maxChars = approved ? Number(approved.maxChars) : readConfigNumber(config, "maxChars", 12000, 500, 100000);
    const access = nodeAccess(context);
    const needsApproval = access.requireApproval || access.accessMode !== "full";
    if (needsApproval && !approved) {
      // Where the address is now, and the addresses it has now: the approval is for these.
      const { place, addresses } = await describeAddress(url, this.options.hooks);
      return {
        status: "needs_input", event: "web_fetch.approval_required", summary: `Allow reading ${url.href} and its redirects?`,
        data: { permissionRequired: true, approvalId, url: url.href, maxChars, addresses,
          details: `HTTP GET · ${url.href}\nRead page text only; no scripts or credentials. Redirects are followed only to public addresses, or within this address.` +
            (place ? `\nThis address is on ${place}: allowing it lets this step read what is served there.` : ""),
          ...(place ? { place, warning: `This address is on ${place}.` } : {}) }
      };
    }
    if (approved?.approved === false) return { status: "failed", event: "web_fetch.rejected", summary: "Page access rejected.", data: {}, error: "Page access rejected." };
    // The address the user named: approved in the prompt as one on this computer or the network (the
    // prompt said so), or written in the step itself. One approved as public stays public: a name that
    // points elsewhere since (DNS rebinding) is refused, and its hops go to the addresses it had then.
    const approvedPlace = typeof approved?.place === "string";
    const named = approved ? (approvedPlace ? url.origin : undefined) : staticOrigin(template) === url.origin ? url.origin : undefined;
    const approvedAddresses = approved && Array.isArray(approved.addresses) ? approved.addresses.filter((item): item is string => typeof item === "string") : undefined;
    const page = await (this.options.get ?? guardedGet)(url, {
      headers: { Accept: "text/html, text/plain, application/json" }, signal: resolveAbortSignal(30000, context.signal),
      maxBytes: 1_000_000, maxRedirects: 5, allowPrivateOrigin: named, ownPort: this.options.ownPort, hooks: this.options.hooks, approvedAddresses,
      privateRefusal: approved && !approvedPlace ? `${url.origin} now points to this computer or the local network; it was approved as a public address, so it is not read.` : undefined,
      onHop: hop => context.onProgress?.({ phase: "tools", label: "Reading webpage", detail: hop.href, at: new Date().toISOString() }),
      accept: (status, type) => status >= 200 && status < 300 && TEXT_TYPES.includes(type || "text/plain")
    });
    if (page.status < 200 || page.status >= 300) throw new Error(`Webpage returned HTTP ${page.status}.`);
    const type = page.contentType || "text/plain";
    if (!TEXT_TYPES.includes(type)) throw new Error(`Cannot read ${type} as webpage text.`);
    const raw = page.body.toString("utf8");
    const html = type.includes("html");
    const title = html ? decodeEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 300) : "";
    const text = html ? pageText(raw) : raw.trim();
    const truncated = page.truncated || text.length > maxChars;
    return { status: "ok", event: "web_fetch.completed", summary: `Read ${page.url}${truncated ? " (truncated)" : ""}`,
      data: { url: page.url, requestedUrl: url.href, title, text: text.slice(0, maxChars), truncated, contentType: type } };
  }
}

/** The origin a step's address names when no template part decides its scheme, host or port: a model
 * may fill a path or a query, never where the request goes. */
export function staticOrigin(template: string): string | undefined {
  const authority = /^\s*([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(template)?.[1];
  if (!authority || authority.includes("{{")) return undefined;
  try { return new URL(authority).origin; } catch { return undefined; }
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
