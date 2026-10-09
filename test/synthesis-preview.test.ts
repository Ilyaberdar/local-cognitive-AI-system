import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
import { previewDocument } from "../src/synthesis/preview";

test("a preview page inlines its own styles and scripts, drops what it would load from elsewhere, and cannot be broken out of", () => {
  const page = previewDocument({
    "index.html": `<!doctype html><html><head><link rel="stylesheet" href="./style.css"><link rel="stylesheet" href="https://cdn.example/x.css"><script src="https://cdn.example/x.js"></script></head>
      <body><div id="out"></div><script src="js/app.js"></script><script src="../outside.js"></script><iframe src="https://example.com"></iframe><base href="https://example.com/"></body></html>`,
    "style.css": "body{color:red}</style><script>window.styleEscaped=1</script>",
    "js/app.js": `document.getElementById("out").textContent = "</script><script>window.scriptEscaped=1</script>"; /* <!-- */ window.ran = 1;`
  });
  assert.doesNotMatch(page, /cdn\.example|outside\.js|<iframe|<base/i, "nothing from elsewhere");
  assert.equal((page.match(/http-equiv="Content-Security-Policy"/g) ?? []).length, 1);
  const dom = new JSDOM(page, { runScripts: "dangerously" });
  const window = dom.window as unknown as Record<string, unknown> & { document: Document };
  assert.equal(window.ran, 1, "the page's script runs");
  assert.equal(window.document.getElementById("out")!.textContent, "</script><script>window.scriptEscaped=1</script>", "a string keeps its text");
  assert.equal(window.scriptEscaped, undefined, "no second script was opened");
  assert.equal(window.styleEscaped, undefined, "the styles cannot open a script");
  assert.equal(window.document.querySelectorAll("style").length, 1);
});

test("a preview of a page with no head still carries its policy", () => {
  const page = previewDocument({ "index.html": "<p>Hi</p>" });
  assert.match(page, /^<html><head><meta http-equiv="Content-Security-Policy"/);
});

test("a preview keeps no link, refresh or ping that would reach past its policy", () => {
  const page = previewDocument({
    "index.html": `<html><head><meta http-equiv="refresh" content="0;url=https://elsewhere.example/"><meta http-equiv="Content-Security-Policy" content="default-src *">
      <link rel="prefetch" href="https://elsewhere.example/a"><link rel="dns-prefetch" href="//elsewhere.example"><link rel="icon" href="https://elsewhere.example/i.png">
      <link rel="stylesheet" href="style.css"></head><body><a href="#top" ping="https://elsewhere.example/p">Top</a></body></html>`,
    "style.css": "a{color:red}"
  });
  assert.doesNotMatch(page, /elsewhere\.example|<link|refresh|ping=|default-src \*/i);
  assert.equal((page.match(/http-equiv=/g) ?? []).length, 1, "only the preview's own policy");
  assert.match(page, /<style>a\{color:red\}<\/style>/);
  assert.match(page, /<a href="#top">Top<\/a>/);
});
