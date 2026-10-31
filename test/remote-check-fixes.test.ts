import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { Logger } from "../src/utils/Logger";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

// From the owner's check of a Windows PC chatting with a Mac that hosts (2026-10-31).

test("a provider that cannot answer says why, instead of \"disabled or not configured\"", async () => {
  const registry = new LLMRegistry();
  const provider = (id: string, reason?: string) => ({ id, name: id === "llamacpp" ? "Local models" : "Other", defaultModel: "m", isConfigured: () => false,
    ...(reason ? { unavailableReason: () => reason } : {}), getDescriptor: () => ({ id, name: id, defaultModel: "m", configured: false }), generateText: async () => { throw new Error("never asked"); } });
  registry.register(provider("llamacpp", "The bundled llama.cpp runtime is missing for this platform. Prepare the runtime or install a complete desktop build."));
  registry.register(provider("other"));
  const llm = new LLMService(registry, "llamacpp", new Logger(), new OutputSanitizer());
  assert.equal((await llm.generateText({ prompt: "hi" })).error, "The bundled llama.cpp runtime is missing for this platform. Prepare the runtime or install a complete desktop build.");
  assert.equal((await llm.generateText({ prompt: "hi" }, "other")).error, "Provider Other is disabled or not configured.", "one that cannot say keeps the old words");
});

test("a toast shows at once, where nothing renders the page again (an approval the host refused), and Close removes it", () => {
  const source = fs.readFileSync("public/assets/app.js", "utf8");
  const slice = (start: string, end: string) => { const from = source.indexOf(start); assert.ok(from >= 0, start); return source.slice(from, source.indexOf(end, from)); };
  const code = [slice("function pushToast(", "function routeTitle("), slice("function renderToasts(", "function renderNavButton("),
    slice("/** Close and Copy on the toasts", "function findFileChangeMetadata(")].join("\n");
  const dom = new JSDOM('<!doctype html><main class="main"><div class="routes"></div></main>');
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  const context: any = { window: dom.window, document: dom.window.document, state: { toasts: [] }, escapeHtml: escape, escapeAttr: escape, render: () => undefined,
    navigator: { clipboard: { writeText: async () => undefined } } };
  context.window.setTimeout = () => 0;
  vm.runInNewContext(`${code}\nthis.pushToast = pushToast;`, context);
  context.pushToast("Devices cannot approve this on MacBook: it runs a command on that computer.");
  const toast = () => dom.window.document.querySelector("main.main .toast-stack .toast__message");
  assert.equal(toast()?.textContent, "Devices cannot approve this on MacBook: it runs a command on that computer.", "shown without a render");
  context.pushToast("<img src=x>");
  assert.equal(dom.window.document.querySelectorAll("main.main .toast-stack").length, 1, "one stack");
  assert.equal(dom.window.document.querySelectorAll("img").length, 0, "a message is text");
  dom.window.document.querySelector("[data-action='dismiss-toast']").click();
  assert.equal(context.state.toasts.length, 1);
  assert.equal(dom.window.document.querySelectorAll(".toast").length, 1, "Close works on a toast painted on its own");
});
