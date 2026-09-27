import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildSync } from "esbuild";
const { JSDOM } = require("jsdom");

const bundle = buildSync({ entryPoints: ["frontend/markdown/index.js"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "MarkdownRenderer" }).outputFiles[0].text;
function fixture(t: test.TestContext) {
  const dom = new JSDOM('<main id="app"></main>', { runScripts: "outside-only", url: "http://localhost" });
  t.after(() => dom.window.close()); dom.window.eval(bundle + ";window.MarkdownRenderer=MarkdownRenderer;");
  const root = dom.window.document.querySelector("main");
  return { window: dom.window, root, ...dom.window.MarkdownRenderer };
}

test("Markdown renders fenced code, tables, lists and inline formatting while preserving exact copy text", async t => {
  const f = fixture(t);
  const code = '{\n  "html": "<script>alert(1)</script>",\n  "path": "C:\\\\temp",\n  "unicode": "Код"\n}\n';
  f.root.innerHTML = f.renderMarkdown('## Result\n\n**Ready** and `inline`.\n\n```json\n' + code + '```\n\n| Case | Result |\n|---|---|\n| Run | done |\n\n- one\n- two');
  assert.equal(f.root.querySelector("pre code").textContent, code);
  assert.ok(f.root.querySelector(".hljs-attr")); assert.equal(f.root.querySelectorAll("table tbody tr").length, 1);
  assert.equal(f.root.querySelectorAll("li").length, 2); assert.equal(f.root.querySelector("strong").textContent, "Ready");
  let copied = "";
  Object.defineProperty(f.window.navigator, "clipboard", { value: { writeText: async (value: string) => { copied = value; } } });
  f.bindMarkdownActions(f.root);
  f.root.querySelector("[data-code-copy]").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, code); assert.equal(f.root.querySelector("[data-code-copy]").textContent, "Copied");
});

test("Markdown cannot inject active HTML, unsafe links or attributes through content, fences, or image URLs", t => {
  const f = fixture(t);
  const attack = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>\n\n' +
    '[unsafe](javascript:alert(1))\n\n![bad](data:text/html,<script>alert(1)</script>)\n\n' +
    '```json\" onclick=\"alert(1)\n</code><script>alert(1)</script>\n```\n\n[normal](https://example.com)';
  f.root.innerHTML = f.renderMarkdown(attack);
  assert.equal(f.root.querySelectorAll("script,img,iframe,style,[onclick],[onerror]").length, 0);
  for (const link of f.root.querySelectorAll("a")) assert.ok(!/^(?:javascript|data):/i.test(link.getAttribute("href") || ""));
  assert.equal(f.root.querySelector('a[href="https://example.com"]').getAttribute("rel"), "noopener noreferrer");
  assert.equal(f.window.pwned, undefined);
});

test("unknown languages and incomplete fences remain readable code", t => {
  const f = fixture(t); f.root.innerHTML = f.renderMarkdown('```customlang\nhello <world>\n');
  assert.equal(f.root.querySelector("pre code").textContent, "hello <world>\n");
  assert.equal(f.root.querySelector(".markdown-code__header span").textContent, "customlang");
});

test("chat metadata parsing leaves Provider and Model lines inside code untouched; read cards decode their content", t => {
  const f = fixture(t); const source = fs.readFileSync("public/assets/app.js", "utf8");
  const slice = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  f.window.eval('const {renderMarkdown,renderCodeBlock}=MarkdownRenderer; const formatLocalModelReferences=x=>x; const escapeHtml=x=>String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");' +
    slice("function renderPlainMessageText", "function renderInlineMessageText") + slice("function renderRuntimeMetaLine", "function renderMessageTools") +
    slice("function renderToolOutput", "function compactPath") + '; window.chatRender=renderPlainMessageText; window.readRender=renderToolOutput;');
  f.root.innerHTML = f.window.chatRender('Response\n\nProvider: openai\nModel: model\n\n```text\nProvider: keep\nModel: exact\n```');
  assert.equal(f.root.querySelector("pre code").textContent, "Provider: keep\nModel: exact\n");
  assert.equal(f.root.querySelectorAll(".message-runtime-line").length, 2);
  f.root.innerHTML = f.window.readRender(JSON.stringify({ content: '1: {\n2:   "n": 1\n3: }\n4: ', version: "hash", startLine: 1, endLine: 4, totalLines: 4, truncated: false }), "result.json");
  assert.equal(f.root.querySelector("pre code").textContent, '{\n  "n": 1\n}\n');
  assert.ok(f.root.querySelector("details").textContent.includes("hash"));
});
