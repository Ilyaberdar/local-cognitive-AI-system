import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// scripts/test-providers.mjs against a local stand-in for every preset: the live check itself is
// checked, without keys or money. The stand-in answers like an OpenAI-compatible service.
function standIn() {
  const seen: Array<{ url: string; body: Record<string, any>; auth?: string }> = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: request.url ?? "", body, auth: request.headers.authorization });
      if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "stand-in-model" }] })); return; }
      const prompt = JSON.stringify(body.messages);
      const text = body.response_format ? "{\"ok\": true}" : /image_url/.test(prompt) ? "Red" : /391/.test(prompt) ? "No" : /Count/.test(prompt) ? "one, two, three, four, five" : "ok";
      if (body.stream) {
        response.setHeader("content-type", "text/event-stream");
        for (const piece of [text.slice(0, 2), text.slice(2)]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  return { server, seen };
}

test("the live provider check runs every preset with a key and reports each check", async t => {
  const { server, seen } = standIn();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-keys-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keys = path.join(dir, "keys.env");
  const names = ["QWEN", "DEEPSEEK", "OPENROUTER", "GROQ", "PERPLEXITY"];
  await fs.writeFile(keys, names.map(name => `${name}_API_KEY=sk-stand-in-${name.toLowerCase()}-key\n${name}_BASE_URL=${base}`).join("\n"), { mode: 0o600 });

  const run = (extra: string[] = []) => new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(process.execPath, ["scripts/test-providers.mjs", "--keys", keys, ...extra], { cwd: process.cwd() });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("close", code => resolve({ code, output }));
  });
  const { code, output } = await run();
  assert.equal(code, 0, output);
  assert.match(output, /checks passed/);
  for (const id of ["qwen", "deepseek", "openrouter", "groq", "perplexity"]) assert.match(output, new RegExp(`^${id}\\s+answer\\s+✓`, "m"), id);
  assert.match(output, /^qwen\s+stream\s+✓/m);
  assert.match(output, /^qwen\s+image\s+✓/m);
  assert.doesNotMatch(output, /sk-stand-in/, "keys never reach the output");
  assert.ok(seen.every(call => call.auth?.startsWith("Bearer sk-stand-in-")));

  // Only the providers asked for; a keys file others can read is refused.
  const one = await run(["--only", "groq"]);
  assert.doesNotMatch(one.output, /^qwen/m);
  await fs.chmod(keys, 0o644);
  if (process.platform !== "win32") assert.match((await run()).output, /readable by others/);
});
