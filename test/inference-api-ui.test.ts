import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildSync } from "esbuild";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

const load = () => {
  const bundle = buildSync({ entryPoints: ["public/assets/inference-api-ui.js"], bundle: true, write: false, format: "iife", globalName: "ApiUi" }).outputFiles[0]!.text;
  const dom = new JSDOM('<div id="page"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(`${bundle}\nwindow.ApiUi = ApiUi;`);
  return { dom, ui: dom.window.ApiUi };
};
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i += 1) await delay(5); assert.ok(check()); };

test("Settings → API turns the API on, shows a new key once with Copy, and revokes a key after a second click", async () => {
  const { dom, ui } = load();
  const doc = dom.window.document, container = doc.getElementById("page");
  const status = { enabled: false, port: 4141, lan: false, listening: false, url: "http://127.0.0.1:4141/v1", keys: [] as Array<Record<string, string>> };
  const calls: Array<[string, string, unknown]> = [];
  const request = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([method, url, body]);
    if (url === "/local/models/loaded") return [{ id: "qwen3-8b", loaded: true }];
    if (url === "/inference-api" && method === "PUT") { Object.assign(status, body, { listening: body.enabled ?? status.enabled }); return { ...status }; }
    if (url === "/inference-api/keys") { status.keys.push({ id: "k1", name: body.name, hint: "AbCd", createdAt: "2026-11-01T10:00:00Z" }); return { id: "k1", name: body.name, hint: "AbCd", createdAt: "2026-11-01T10:00:00Z", key: "lcsk_secretvalue000000000000000000000000AbCd" }; }
    if (url.startsWith("/inference-api/keys/") && method === "DELETE") { status.keys = []; return null; }
    return { ...status, keys: [...status.keys] };
  };
  let copied = "";
  ui.mountInferenceApiPage(container, { request, clipboard: { writeText: async (text: string) => { copied = text; } } });
  await until(() => Boolean(doc.querySelector("[data-api-enabled]")));
  assert.match(doc.querySelector("[data-api-state]")!.textContent!, /^Off\./);
  assert.match(container!.textContent!, /"model": "qwen3-8b"/, "the example names a loaded model");

  const toggle = doc.querySelector("[data-api-enabled]") as HTMLInputElement;
  toggle.checked = true;
  toggle.dispatchEvent(new dom.window.Event("change"));
  await until(() => /On at/.test(doc.querySelector("[data-api-state]")?.textContent ?? ""));
  assert.deepEqual(calls.find(([method]) => method === "PUT")?.[2], { enabled: true });

  const form = doc.querySelector("[data-api-key-form]") as HTMLFormElement;
  (form.querySelector('input[name="name"]') as HTMLInputElement).value = "News bot";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await until(() => Boolean(doc.querySelector("[data-api-made-key]")));
  assert.equal(doc.querySelector("[data-api-made-key]")!.textContent, "lcsk_secretvalue000000000000000000000000AbCd");
  assert.match(container!.textContent!, /copy the key now\. It is not shown again\./);
  (doc.querySelector("[data-api-copy]") as HTMLButtonElement).click();
  await until(() => doc.querySelector("[data-api-copy]")?.textContent === "Copied");
  assert.equal(copied, "lcsk_secretvalue000000000000000000000000AbCd");
  assert.match(doc.querySelector('[data-api-key="k1"]')!.textContent!, /News bot.*…AbCd.*never used/s);

  (doc.querySelector('[data-api-revoke="k1"]') as HTMLButtonElement).click();
  assert.equal(calls.some(([method]) => method === "DELETE"), false, "the first click only asks");
  (doc.querySelector("[data-api-revoke-confirm]") as HTMLButtonElement).click();
  await until(() => !doc.querySelector("[data-api-key]"));
  assert.deepEqual(calls.find(([method]) => method === "DELETE")?.slice(0, 2), ["DELETE", "/inference-api/keys/k1"]);
  assert.equal(doc.querySelector("[data-api-made-key]"), null, "the revoked key's value is gone from the page");
});

test("a port outside 1024–65535 is not sent, and the page says why", async () => {
  const { dom, ui } = load();
  const doc = dom.window.document;
  const sent: string[] = [];
  ui.mountInferenceApiPage(doc.getElementById("page"), { request: async (url: string, init: { method?: string } = {}) => {
    if (init.method) sent.push(init.method);
    return url === "/local/models/loaded" ? [] : { enabled: true, port: 4141, lan: false, listening: false, url: "http://127.0.0.1:4141/v1", error: "Port 4141 is used by another program: choose another port.", keys: [] };
  } });
  await until(() => Boolean(doc.querySelector("[data-api-port]")));
  assert.match(doc.querySelector("[data-api-state]")!.textContent!, /not listening: Port 4141 is used by another program/);
  (doc.querySelector("[data-api-port]") as HTMLInputElement).value = "80";
  (doc.querySelector("[data-api-port-save]") as HTMLButtonElement).click();
  await until(() => /1024 to 65535/.test(doc.getElementById("page")!.textContent!));
  assert.deepEqual(sent, []);
});
