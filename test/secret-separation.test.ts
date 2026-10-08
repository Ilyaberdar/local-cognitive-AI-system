import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config, parseFileConfig, shouldLoadDotenv } from "../src/config/config";
import { childProcessEnv, hasSecretName, isSharedEnvFile, SECRET_ENV_KEYS } from "../src/config/secrets";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { runCommand } from "../src/utils/runCommand";

const repoRoot = path.resolve(__dirname, "..", "..");
const isGitCheckout = fs.existsSync(path.join(repoRoot, ".git"));
const ignored = (file: string): boolean => {
  try { execFileSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: repoRoot }); return true; }
  catch { return false; }
};

test("packaged files exclude OAuth registrations and env files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { build: { files: string[] } };
  assert.deepEqual(manifest.build.files, ["electron/*.cjs", "dist/src/**/*", "public/**/*", "package.json", "!**/.env", "!**/.env.*"]);
});

test("credential-bearing local files are git-ignored and examples are not", { skip: !isGitCheckout }, () => {
  for (const file of [".env", "deploy/server/.env", "apps/cloud/.env", "data/app/settings.json", "data/app/settings.pre-integrations.json",
    "data/app/settings.pre-llamacpp.json", "data/app/integrations/vault/connection.enc", "data/openmemory.db",
    "electron/plugin-oauth-clients.json", "local-cognitive.config.json", "signing/developer-id.p12", "deploy/cloud/.env"]) assert.equal(ignored(file), true, file);
  for (const file of [".env.example", "deploy/server/.env.example", "deploy/cloud/.env.example", "apps/cloud/.env.example", "data/app/settings.example.json",
    "electron/plugin-oauth-clients.example.json"]) assert.equal(ignored(file), false, file);
});

test("no tracked file is a credential file", { skip: !isGitCheckout }, () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  const forbidden = tracked.filter(file => /(^|\/)(?:plugin-oauth-clients\.json|\.env|settings(?:\.pre-[a-z]+)?\.json)$/.test(file) ||
    /\.(?:pem|p12|p8|key)$/.test(file));
  assert.deepEqual(forbidden, []);
});

test("env examples leave every credential empty", () => {
  for (const file of [".env.example", "deploy/server/.env.example", "deploy/cloud/.env.example", "apps/cloud/.env.example"]) {
    const assignments = fs.readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/)
      .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => line.split("=", 2) as [string, string]);
    for (const [key, value] of assignments) {
      // LM Studio accepts this fixed placeholder; it is not a credential.
      if (key === "LMSTUDIO_API_KEY" && value === "lm-studio") continue;
      if (hasSecretName(key) && !/(?:MAX|_TOKENS$)/.test(key)) assert.equal(value, "", `${file}: ${key}`);
    }
  }
});

test("child processes do not inherit credentials", async () => {
  const env = childProcessEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "a", telegram_bot_token: "b", ANTHROPIC_MAX_TOKENS: "8" });
  assert.deepEqual(env, { PATH: "/usr/bin", ANTHROPIC_MAX_TOKENS: "8" });
  assert.ok(SECRET_ENV_KEYS.includes("BRAVE_SEARCH_API_KEY"));

  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-credential";
  try {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY))"], os.tmpdir(), 10_000);
    assert.equal(result.stdout, "undefined");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test("config files are validated and may not carry credentials", () => {
  assert.deepEqual(parseFileConfig('{"localModels":{"contextSize":8192},"agentLimits":{"maxTokens":4000}}', "config.json"),
    { localModels: { contextSize: 8192 }, agentLimits: { maxTokens: 4000 } });
  assert.throws(() => parseFileConfig("{", "config.json"), /config\.json is not valid JSON/);
  assert.throws(() => parseFileConfig("[]", "config.json"), /must contain a JSON object/);
  assert.throws(() => parseFileConfig('{"providers":{"openai":{"apiKey":"value-must-not-leak"}}}', "config.json"), (error: Error) =>
    /providers\.openai\.apiKey/.test(error.message) && !error.message.includes("value-must-not-leak"));
});

test("the desktop runtime ignores .env", () => {
  assert.equal(shouldLoadDotenv({ ...process.versions, electron: "35.7.5" }), false);
  assert.equal(shouldLoadDotenv({ ...process.versions }), !process.versions.electron);
});

test("env files shared with other users are detected", { skip: process.platform === "win32" }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "env-mode-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".env");
  await fsp.writeFile(file, "OPENAI_API_KEY=\n", { mode: 0o644 });
  await fsp.chmod(file, 0o644);
  assert.equal(isSharedEnvFile(file), true);
  await fsp.chmod(file, 0o600);
  assert.equal(isSharedEnvFile(file), false);
});

test("settings files are readable only by their owner", { skip: process.platform === "win32" }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "settings-mode-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, "settings.json");
  await new AppSettingsStore(root, config).get();
  assert.equal((await fsp.stat(settingsPath)).mode & 0o777, 0o600);

  // An existing loose file is tightened on read; a legacy migration archive is restricted too.
  const current = JSON.parse(await fsp.readFile(settingsPath, "utf8")) as Record<string, unknown>;
  delete current.schemaVersion;
  await fsp.writeFile(settingsPath, JSON.stringify(current), { mode: 0o644 });
  await fsp.chmod(settingsPath, 0o644);
  await new AppSettingsStore(root, config).get();
  assert.equal((await fsp.stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(path.join(root, "settings.pre-llamacpp.json"))).mode & 0o777, 0o600);
});
