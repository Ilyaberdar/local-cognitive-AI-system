import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import express from "express";
import { UI_CONTENT_SECURITY_POLICY, uiSecurityHeaders } from "../src/api/uiSecurityHeaders";

test("the window's page and its assets carry an enforced CSP, nosniff and no referrer", async () => {
  // As src/index.ts serves the UI: the headers before the static files.
  const publicDir = path.resolve("public");
  const app = express();
  app.use(uiSecurityHeaders);
  app.use(express.static(publicDir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const script = fs.readdirSync(path.join(publicDir, "assets")).find(name => name.endsWith(".js"))!;
    for (const route of ["/", `/assets/${script}`, "/assets/app.css"]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("content-security-policy"), UI_CONTENT_SECURITY_POLICY, route);
      assert.equal(response.headers.get("content-security-policy-report-only"), null, "enforced, not report-only");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
  } finally { server.close(); }
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(UI_CONTENT_SECURITY_POLICY.split("; ").includes(directive), directive);
  }
  assert.doesNotMatch(UI_CONTENT_SECURITY_POLICY, /unsafe-eval|script-src[^;]*unsafe-inline/);
});

test("the page has no inline script, handler attribute or script from elsewhere", () => {
  const html = fs.readFileSync(path.resolve("public", "index.html"), "utf8");
  for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
    assert.match(tag, /\ssrc="\/assets\/[^"]+"/, tag);
    assert.match(tag, /><\/script>$/, "no inline code");
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /(?:src|href)="https?:/i);
});
