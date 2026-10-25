import assert from "node:assert/strict";
import test from "node:test";
import { KEY_PATTERNS, keyShapes, looksLikeKey, maskKeyShapes } from "../src/security/keyPatterns";
import { maskText } from "../src/diagnostics/sentryScrub";
import { withoutSecrets } from "../src/runtime/settingsDto";
import { importCandidate } from "../src/mcp/client/importConfig";

// Made at run time: no key-shaped literal sits in the sources.
const fill = (length: number, alphabet = "a1B2c3D4e5") => Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("");
const SAMPLES: Record<string, string> = {
  groq: `gsk_${fill(52)}`,
  perplexity: `pplx-${fill(48)}`,
  openrouter: `sk-or-v1-${fill(64, "0123456789abcdef")}`,
  xai: `xai-${fill(80)}`,
  huggingface: `hf_${fill(34)}`,
  github: `github_pat_${fill(22)}_${fill(59)}`,
  githubClassic: `ghp_${fill(36)}`,
  slack: `xoxb-${fill(12, "0123456789")}-${fill(24)}`,
  aws: `AKIA${fill(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
  sentry: `sntrys_${fill(60)}`,
  telegram: `${fill(10, "1234567890")}:${fill(35)}`,
  anthropic: `sk-ant-api03-${fill(40)}`,
  google: `AIza${fill(35)}`
};

test("one list of key shapes: each service's form is recognised, ordinary words are not", () => {
  assert.ok(KEY_PATTERNS.length >= 12);
  for (const [service, key] of Object.entries(SAMPLES)) {
    assert.equal(looksLikeKey(key), true, service);
    assert.equal(maskKeyShapes(`failed with ${key} here`), "failed with <key> here", service);
  }
  for (const text of ["task_queue_runner_worker", "skeleton", "The request failed with status 401 at 12:30", "hf_short", "localhost:3000"]) {
    assert.equal(keyShapes().test(text), false, text);
    assert.equal(looksLikeKey(text), false, text);
  }
});

test("error reports, a device's error text and an imported MCP server all use the shared shapes", () => {
  for (const [service, key] of Object.entries(SAMPLES)) {
    assert.equal(maskText(`provider said: ${key}`).includes(key), false, `Sentry: ${service}`);
    assert.equal(withoutSecrets(`The service did not answer: ${key}`, []).includes(key), false, `device: ${service}`);
    const candidate = importCandidate("server", { command: "npx", args: ["some-server"], env: { CONFIG_VALUE: key, PLAIN: "eu-west" } }, new Set());
    assert.deepEqual(candidate?.secrets.map(item => item.name), ["CONFIG_VALUE"], `import: ${service}`);
  }
});
