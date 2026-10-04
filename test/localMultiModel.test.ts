import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { LocalInferenceScheduler } from "../src/local/LocalInferenceScheduler";
import { LocalRuntimePool } from "../src/local/LocalRuntimePool";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { Logger } from "../src/utils/Logger";

test("different models run concurrently, same-model requests queue, and settings form a barrier", async () => {
  const scheduler = new LocalInferenceScheduler();
  const order: string[] = []; const releases: Record<string, () => void> = {};
  const hold = (id: string) => scheduler.run(id, () => new Promise<void>(resolve => { order.push(id); releases[id] = resolve; }));
  const a = hold("a"); const b = hold("b"); await delay(0);
  assert.deepEqual(order, ["a", "b"]); assert.equal(scheduler.queueLength, 0);
  const a2 = scheduler.run("a", async () => { order.push("a2"); });
  const config = scheduler.runExclusive(async () => { order.push("settings"); });
  const c = scheduler.run("c", async () => { order.push("c"); });
  assert.equal(scheduler.queueLength, 3);
  releases.a(); await a; await a2; await delay(0);
  assert.deepEqual(order, ["a", "b", "a2"]);
  releases.b(); await Promise.all([b, config, c]);
  assert.deepEqual(order, ["a", "b", "a2", "settings", "c"]); await scheduler.dispose();
});

test("runtime pool keeps independent resident processes, reuses them, and unloads only its target", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-pool-test-"));
  const executable = path.join(root, "server");
  await fs.writeFile(executable, `#!/usr/bin/env node
const http=require('http'); const args=process.argv.slice(2);const value=k=>args[args.indexOf(k)+1];
http.createServer(async(req,res)=>{
res.setHeader('Content-Type','application/json');
if(req.url==='/health')return res.end('{"status":"ok"}');
if(req.url==='/props')return res.end('{"default_generation_settings":{"n_ctx":2048}}');
for await(const chunk of req){}
res.end(JSON.stringify({output_text:String(process.pid)}));
}).listen(Number(value('--port')),'127.0.0.1');
`, { mode: 0o755 });
  const pool = new LocalRuntimePool({ enabled:true,dataDir:root,modelsDir:root,runtimeDir:root,executablePath:executable,
    contextSize:2048,gpuLayers:0,loadTimeoutMs:5000,generationTimeoutMs:5000,memoryLimitPercent:75 }, new Logger(), () => {});
  t.after(async () => { await pool.dispose(); await fs.rm(root, { recursive:true,force:true }); });
  await pool.init();
  await Promise.all([pool.load("a",path.join(root,"a.gguf")),pool.load("b",path.join(root,"b.gguf"))]);
  const reply = (model: string) => pool.generateText({ model,prompt:"hi" });
  const [a,b] = await Promise.all([reply("a"),reply("b")]);
  assert.notEqual(a.text,b.text); assert.equal(pool.snapshot().loadedModelIds?.length,2);
  await pool.load("a",path.join(root,"a.gguf")); assert.equal((await reply("a")).text,a.text);
  await pool.stop("a"); assert.deepEqual(pool.snapshot().loadedModelIds,["b"]);
  assert.equal((await reply("b")).text,b.text);
});

test("deleted local model references resolve in old and new sessions without changing cloud targets", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-target-test-"));
  t.after(() => fs.rm(root, { recursive:true,force:true }));
  let installed = ["gguf-old", "gguf-new"];
  const store = new SessionSettingsStore({baseDir:root}, {providerId:"llamacpp",model:"gguf-old"}, {llamacpp:"gguf-old",openai:"remote"},
    id => installed.includes(id || "") ? id : installed[0]);
  await store.update("old", {defaultTarget:{providerId:"llamacpp",model:"gguf-old"},
    codeAgents:[{id:"rook",name:"Rook",providerId:"llamacpp",model:"gguf-old",accessMode:"default"}],
    debate:{ judge:{providerId:"openai",model:"remote"},support:{providerId:"llamacpp",model:"gguf-old"} }});
  installed = ["gguf-new"];
  assert.equal((await store.get("old")).defaultTarget.model,"gguf-new");
  assert.equal((await store.get("new")).defaultTarget.model,"gguf-new");
  assert.equal((await store.get("old")).debate.support.model,"gguf-new");
  assert.equal((await store.get("old")).debate.judge.model,"remote");
  const restarted = new SessionSettingsStore({baseDir:root}, {providerId:"llamacpp",model:"gguf-old"}, {llamacpp:"gguf-old"},
    id => installed.includes(id || "") ? id : installed[0]);
  assert.equal((await restarted.get("old")).codeAgents[0].model, "gguf-new");
  assert.equal((await restarted.get("new-after-restart")).defaultTarget.model, "gguf-new");
  installed = []; assert.equal((await store.get("old")).defaultTarget.model,undefined);
});
