import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts", "verify-package-secrets.mjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const afterPack = require(path.resolve("scripts", "after-pack.cjs")) as { default: (context: unknown) => Promise<void>; appFolder: (context: unknown) => string };
const fill = (length: number) => Array.from({ length }, (_, index) => "a1B2c3D4"[index % 8]).join("");
const run = (...targets: string[]) => spawnSync(process.execPath, [script, ...targets], { encoding: "utf8" });

function appAt(root: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content); }
  return root;
}

test("the package check finds the newer key shapes, names file and pattern only, and passes a clean app", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lc-secrets-"));
  try {
    const groq = `gsk_${fill(52)}`, sentry = `sntrys_${fill(64)}`, openrouter = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
    const dirty = appAt(path.join(temp, "dirty"), { "package.json": "{}", "dist/src/config.js": `const k = "${groq}";`, "public/a.js": `x("${openrouter}")` });
    const result = run(dirty);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/src\/config\.js: Groq key/);
    assert.match(result.stderr, /public\/a\.js: (?:OpenAI key|OpenRouter key)/);
    for (const value of [groq, openrouter]) assert.equal(result.stderr.includes(value) || result.stdout.includes(value), false, "never the value");
    // A folder that is not an app (src/ of a checkout) is scanned whole.
    const sources = appAt(path.join(temp, "src"), { "diagnostics/token.ts": `export const t = "${sentry}";` });
    const whole = run(sources);
    assert.equal(whole.status, 1); assert.match(whole.stderr, /diagnostics\/token\.ts: Sentry auth token/);
    const clean = appAt(path.join(temp, "clean"), { "package.json": "{}", "dist/src/ok.js": "const pattern = /\\bgsk_[A-Za-z0-9]{40,}/;", "node_modules/x/fixture.js": `"${groq}"` });
    assert.equal(run(clean).status, 0, "regular expressions and third-party fixtures are not findings");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("electron-builder's afterPack hook checks the unpacked app of each platform and fails the build on a finding", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lc-after-pack-"));
  try {
    const mac = { electronPlatformName: "darwin", appOutDir: path.join(temp, "mac-arm64"), packager: { appInfo: { productFilename: "Local Cognitive" } } };
    const win = { electronPlatformName: "win32", appOutDir: path.join(temp, "win-unpacked"), packager: { appInfo: { productFilename: "Local Cognitive" } } };
    assert.equal(afterPack.appFolder(mac), path.join(temp, "mac-arm64", "Local Cognitive.app", "Contents", "Resources", "app"));
    assert.equal(afterPack.appFolder(win), path.join(temp, "win-unpacked", "resources", "app"));
    appAt(afterPack.appFolder(mac), { "package.json": "{}", "dist/src/ok.js": "ok" });
    await afterPack.default(mac);
    appAt(afterPack.appFolder(win), { "package.json": "{}", "dist/src/bad.js": `"hf_${fill(34)}"` });
    await assert.rejects(afterPack.default(win));
    await assert.rejects(afterPack.default({ ...win, appOutDir: path.join(temp, "missing") }), /no unpacked app/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
