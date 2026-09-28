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

test("Review highlights multiline tokens without changing line text, whitespace or escaped HTML", t => {
  const f = fixture(t);
  const source = '/* first line\r\n   second <tag> */\r\nconst greeting = `Привет\r\n  ${name}!`;\r\n\r\n';
  const lines = f.renderCodeLines(source, 'C:\\workspace\\demo.TSX');
  const expected = source.replace(/\r?\n$/, '').split(/\r?\n/);
  assert.equal(lines.length, expected.length);
  lines.forEach((line: string, index: number) => {
    f.root.innerHTML = `<code>${line}</code>`;
    assert.equal(f.root.textContent, expected[index]);
    assert.equal(f.root.querySelectorAll('tag,script').length, 0);
    if (index < 2) assert.ok(f.root.querySelector('.hljs-comment'));
  });
  f.root.innerHTML = lines.join('\n');
  assert.ok(f.root.querySelector('.hljs-keyword'));
  assert.ok(f.root.querySelector('.hljs-string'));
  for (const text of ['<img src=x onerror="alert(1)">\n', 'a'.repeat(80_001), '']) {
    f.root.innerHTML = f.renderCodeLines(text, text.length > 80_000 ? 'large.ts' : 'unknown.txt').join('\n');
    assert.equal(f.root.textContent, text.replace(/\r?\n$/, ''));
    assert.equal(f.root.querySelectorAll('img,script,span').length, 0);
  }
});

test("Review selection across highlighted spans preserves original CRLF offsets, copy and refreshed text", async t => {
  const f = fixture(t);
  const reviewBundle = buildSync({ entryPoints: ["public/assets/review-panel.js"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "ReviewPanel" }).outputFiles[0].text;
  f.window.eval(reviewBundle + ';window.ReviewPanel=ReviewPanel;');
  f.window.TextEncoder = TextEncoder;
  f.window.Range.prototype.getBoundingClientRect = () => ({ right: 100, bottom: 100 });
  let source = 'const one = 1;\r\nconst two = 2;\r\n';
  let copied = '', sent: any;
  Object.defineProperty(f.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied = value; } } });
  const panel = f.window.ReviewPanel.createReviewPanel({
    sessionId: () => 'highlighted', beforeOpen: async () => {}, busy: () => false, icon: () => '', findChange: () => null,
    readFile: async () => ({ path: '/demo.ts', name: 'demo.ts', content: source, version: source }),
    highlightLines: f.renderCodeLines, send: async (value: unknown) => { sent = value; return true; },
    changed: () => { f.root.innerHTML = panel.render(); panel.bind(); }
  });
  await panel.open('/demo.ts');
  f.root.querySelector('[data-review-action=copy]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, source);
  const codes = f.root.querySelectorAll('.review-line code');
  const range = f.window.document.createRange();
  range.setStart(codes[0].querySelector('.hljs-keyword').firstChild, 1);
  range.setEnd(codes[1].querySelector('.hljs-number').firstChild, 1);
  f.window.getSelection().addRange(range);
  f.window.document.dispatchEvent(new f.window.Event('selectionchange'));
  assert.equal(f.root.querySelector('.review-selection-plus').hidden, false);
  f.root.querySelector('[data-review-action=comment]').click();
  const input = f.root.querySelector('.review-comment textarea');
  input.value = 'Explain this selection';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  input.form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.reviewSelection.startOffset, 1);
  assert.equal(sent.reviewSelection.endOffset, source.indexOf('2') + 1);
  assert.equal(sent.reviewSelection.text, source.slice(1, source.indexOf('2') + 1));
  source = 'const refreshed = "current";\n';
  await panel.refresh();
  assert.equal(f.root.querySelector('.review-line code').textContent, source.trimEnd());
  assert.ok(f.root.querySelector('.hljs-string'));
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
