import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildSync } = require("esbuild");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

/** The whole renderer (public/assets/app.js) in JSDOM with a recording fetch and optional
 * desktop bridges. Requests are recorded as "METHOD url [body]". */
const repo = path.resolve(__dirname, "..", "..", "..");
let bundle: string | undefined;
// The workflow editor is a separately built React bundle: the page gets a recording stand-in.
const bundled = () => bundle ??= buildSync({ entryPoints: [path.join(repo, "public/assets/app.js")], bundle: true, write: false, format: "iife",
  platform: "browser", external: ["/assets/*"], logLevel: "error" }).outputFiles[0].text
  .replace('import("/assets/workflow-editor.js")', "Promise.resolve(globalThis.__workflowEditorModule)");

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const sessionSettings = () => ({ mode: "general", language: "auto", outputStyle: "balanced", reasoningEffort: "medium",
  defaultTarget: { providerId: "ollama", model: "llama3.2" }, defaultAccessMode: "default", codeAgents: [], hypothesisAgents: [],
  debate: { enabled: false, profile: "general", support: { providerId: "ollama" }, attack: { providerId: "ollama" }, judge: { providerId: "local" } } });
const bootstrap = () => ({
  providers: [{ id: "ollama", name: "Ollama", capabilities: { local: true } }, { id: "openai", name: "OpenAI", capabilities: { local: false } }],
  tools: [], plugins: [], pluginStatuses: [], tasks: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
  appSettings: { ui: { theme: "dark", animations: false }, llm: { defaultProvider: "ollama" }, providers: { ollama: { model: "llama3.2", enabled: true } } },
  sessions: [{ id: SESSION_ID, title: "First chat", updatedAt: "2026-10-01T10:00:00.000Z" }],
  availableModels: [], loadedModels: [{ providerId: "ollama", id: "llama3.2" }], allManagedModels: [], localModels: { runtime: { status: "stopped" } }, systemMetrics: {}
});

export const flush = async (turns = 20) => { for (let index = 0; index < turns; index++) await new Promise(resolve => setTimeout(resolve, 0)); };

export interface Harness {
  window: any;
  document: any;
  requests: string[];
  /** Calls the renderer made through window.desktopRemote. */
  bridgeCalls: Array<{ op: string; payload?: any }>;
  /** Workflow editors the page mounted, newest last: their props and handle. */
  editors: Array<{ props: any; handle: any }>;
  /** Runs the 600 ms process-run poll once (it is a manual interval here). */
  poll(): Promise<void>;
  /** Runs every live interval with this period once (dashboard, metrics, model refresh). */
  tick(ms: number): Promise<void>;
  resolveChat(): void;
  close(): void;
}

export interface BootOptions {
  remote?: { bridge: any; account?: any };
  /** Answers a request before the defaults; return undefined to fall through. */
  route?: (method: string, url: string, body?: string) => unknown;
  bootstrap?: () => object;
}

export async function bootApp(options: BootOptions = {}): Promise<Harness> {
  const requests: string[] = [];
  const bridgeCalls: Harness["bridgeCalls"] = [];
  const editors: Harness["editors"] = [];
  const settings = sessionSettings();
  let resolveChat: () => void = () => undefined;
  const route = (method: string, url: string, body?: string): unknown => {
    const custom = options.route?.(method, url, body);
    if (custom !== undefined) return custom;
    if (url === "/dashboard/bootstrap") return (options.bootstrap ?? bootstrap)();
    if (url === "/integrations/available") return [];
    if (url === `/sessions/${SESSION_ID}/messages`) return [];
    if (url === `/sessions/${SESSION_ID}/settings`) return method === "PUT" ? { ...settings, ...JSON.parse(body ?? "{}") } : settings;
    if (url === "/chat") return new Promise(resolve => { resolveChat = () => resolve({ sessionId: SESSION_ID }); });
    if (url.startsWith("/process-runs/")) return { status: "running", progress: { phase: "answer", label: "Writing response", answer: "Hel", at: new Date().toISOString() } };
    if (url === "/local/runtime") return { status: "stopped" };
    if (url === "/local/downloads") return [];
    return {};
  };
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://127.0.0.1/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.CSS = { escape: (value: string) => String(value) };
  window.Element.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.showPopover = function () {};
  window.HTMLElement.prototype.hidePopover = function () {};
  window.HTMLDialogElement.prototype.showModal = function (this: any) { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function (this: any) { this.removeAttribute("open"); };
  window.confirm = () => true;
  window.__workflowEditorModule = { mountWorkflowEditor: (_container: unknown, props: any) => {
    const handle = { unmounted: false, validations: [] as unknown[], executions: [] as unknown[], setPlugins() {}, setColorMode() {}, setNodeRuns() {}, setStarting() {},
      setValidation(value: unknown) { handle.validations.push(value); }, setExecution(value: unknown) { handle.executions.push(value); },
      captureState: () => undefined, unmount() { handle.unmounted = true; } };
    editors.push({ props, handle });
    return handle;
  } };
  // JSDOM has no EventSource: record which streams the page opens.
  window.EventSource = class { constructor(url: string) { requests.push(`EVENTSOURCE ${url}`); } addEventListener() {} close() {} };
  const intervals: Array<{ fn: (() => unknown) | null; ms: number }> = [];
  window.setInterval = (fn: () => unknown, ms: number) => { intervals.push({ fn, ms }); return intervals.length; };
  window.clearInterval = (id: number) => { if (intervals[id - 1]) intervals[id - 1]!.fn = null; };
  window.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    requests.push(`${method} ${url}${init.body ? ` ${init.body}` : ""}`.replace(/chat-[0-9a-f-]+/g, "chat-<id>"));
    const value = await route(method, url, init.body);
    return { ok: true, status: 200, json: async () => value };
  };
  if (options.remote) {
    const { bridge } = options.remote;
    window.desktopAccount = options.remote.account ?? { status: async () => ({ state: "signed-in", profile: { accountId: "acc", email: "a@b.c", emailVerified: true } }),
      onChange() {}, signIn() {}, signOut() {}, cancelSignIn() {} };
    const record = (name: string, fn: (...args: any[]) => any) => async (...args: any[]) => { bridgeCalls.push({ op: name, payload: args }); return fn(...args); };
    window.desktopRemote = { ...bridge, runtime: Object.fromEntries(Object.entries(bridge.runtime).map(([name, fn]) =>
      [name, name === "onEvent" ? fn : record(`runtime.${name}`, fn as (...args: any[]) => any)])) };
  }
  window.eval(bundled());
  await flush(30);
  return {
    window, document: window.document, requests, bridgeCalls, editors,
    async poll() { const poll = intervals.find(item => item.ms === 600 && item.fn); if (poll) { await poll.fn!(); await flush(10); } },
    async tick(ms: number) { for (const item of intervals.filter(entry => entry.ms === ms && entry.fn)) await item.fn!(); await flush(20); },
    resolveChat: () => resolveChat(),
    close: () => window.close()
  };
}
