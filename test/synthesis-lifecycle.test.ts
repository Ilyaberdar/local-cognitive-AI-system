import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import express from "express";
import { localApiOriginGuard } from "../src/api/integrationControllers";
import { createSynthesisRouter } from "../src/api/synthesisControllers";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { calculatorTemplate } from "../src/synthesis/templates";
import { RunRecord } from "../src/synthesis/types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Existing candidate fixtures isolate persistence/lifecycle behavior from inference.
// Real-model quality and the complete UI contract are covered by separate tests.
const baselineFiles: Record<string, string> = {
  "calculator.js": `function calculate(a,b,op) {
    if(op === '+') return a+b;
    if(op === '-') return a-b;
    if(op === '*') return a*b;
    if(op === '/') { if(b === 0) throw new Error('Cannot divide by zero'); return a/b; }
    throw new Error('Unsupported operation');
  }`,
  "index.html": '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="calculator.js"></script></body></html>',
  "style.css": "body { color: white; background: black; }"
};
const flow = (body: string) => `implement Calculator using "calculator-v1" {
  limit iterations 2, time 1m, cost 0usd;
  policy = "local-files-v1";
  ${body}
}`;
const acceptanceFlow = flow(`spec = freeze(Calculator.spec);
  candidate = checkout("calculator");
  evidence = await evaluate(candidate, spec);
  verdict = verify(spec, evidence);
  if (verdict.status == Pass) { return accept(candidate, evidence); }
  return needs_review(evidence);`);

async function fixture(t: TestContext, source = flow('available = await models.list(provider = "llamacpp"); return unresolved();')) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synthesis-lifecycle-")));
  const projectRoot = path.join(temporary, "project");
  const appData = path.join(temporary, "app");
  await fs.mkdir(projectRoot);
  const projects = new ProjectStore(appData);
  const project = await projects.create({ name: "Lifecycle fixture", rootPath: projectRoot });
  let modelLists = 0;
  const service = new SynthesisService(appData, {
    projects,
    models: { listAllModels: async () => { modelLists++; return []; } },
    loadModel: async () => { throw new Error("Unexpected inference in lifecycle test"); },
    llm: {
      generateObject: async () => { throw new Error("Unexpected generation in lifecycle test"); },
      generateText: async () => { throw new Error("Unexpected generation in lifecycle test"); }
    }
  });
  await service.init();
  const module = await service.createModule(project.id);
  const spec = calculatorTemplate("Calculator", "compact").spec.replace('        hard ui = Pass("calculator-ui-v1");\n', "");
  await fs.writeFile(path.join(projectRoot, module.specPath), spec);
  await fs.writeFile(path.join(projectRoot, module.flowPath), source);
  t.after(async () => {
    await service.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return {
    service, project, projectRoot, appData,
    runDirectory: path.join(appData, "synthesis", "runs"),
    modelLists: () => modelLists,
    start: () => service.start(project.id, "Calculator"),
    seedCandidate: async () => {
      await fs.mkdir(path.join(projectRoot, "calculator"));
      for (const [file, content] of Object.entries(baselineFiles)) await fs.writeFile(path.join(projectRoot, "calculator", file), content);
    }
  };
}

test("disposal waits for a pending launch and prevents an orphan run after its initial save", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const saveEntered = deferred(), releaseSave = deferred();
  const rename = fs.rename.bind(fs);
  let delayed = false;
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (!delayed && String(to).startsWith(f.runDirectory + path.sep)) {
      delayed = true; saveEntered.resolve(); await releaseSave.promise;
    }
    await rename(from, to);
  });
  const starting = f.start();
  const rejectedStart = assert.rejects(starting, /Runtime stopped before this run was admitted/);
  try {
    await saveEntered.promise;
    let disposed = false;
    const disposing = f.service.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(disposed, false, "dispose must account for launches not registered as active yet");
    releaseSave.resolve();
    await rejectedStart;
    await disposing;
    assert.equal(f.modelLists(), 0, "the disposed service must not execute any DSL operations");
    const runs = await f.service.list(f.project.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "interrupted");
    assert.match(runs[0].error!, /before this run was admitted/);
    await assert.rejects(f.start(), /Runtime is stopping/);
  } finally { releaseSave.resolve(); await rejectedStart; }
});

test("concurrent launch reservations enforce the two-run cap before either save completes", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const releaseSaves = deferred();
  const rename = fs.rename.bind(fs);
  let pendingSaves = 0;
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (String(to).startsWith(f.runDirectory + path.sep)) {
      const record = JSON.parse(await fs.readFile(from, "utf8")) as RunRecord;
      if (record.status === "queued") { pendingSaves++; await releaseSaves.promise; }
    }
    await rename(from, to);
  });
  let rejected = 0;
  const starts = Array.from({ length: 3 }, () => f.start().then(
    run => ({ run }),
    error => { rejected++; return { error: error as Error }; }
  ));
  try {
    await until(() => pendingSaves === 2 && rejected === 1, "third launch must be rejected while two starts are reserved");
    assert.equal(f.modelLists(), 0);
    releaseSaves.resolve();
    const results = await Promise.all(starts);
    const accepted = results.flatMap(result => "run" in result ? [result.run] : []);
    const denied = results.flatMap(result => "error" in result ? [result.error] : []);
    assert.equal(accepted.length, 2);
    assert.equal(denied.length, 1);
    assert.match(denied[0].message, /At most two/);
    for (const run of accepted) assert.equal((await f.service.wait(run.id)).status, "unresolved");
    assert.equal(f.modelLists(), 2);
    assert.equal((await f.service.list(f.project.id)).length, 2);
  } finally { releaseSaves.resolve(); await Promise.all(starts); }
});

test("acceptance remains Running until the terminal action finishes and Apply stays unavailable", { timeout: 15_000 }, async t => {
  const f = await fixture(t, acceptanceFlow);
  await f.seedCandidate();
  const acceptedAction = deferred(), releaseAction = deferred();
  const rename = fs.rename.bind(fs);
  let intercepted = false;
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    const ours = String(to).startsWith(f.runDirectory + path.sep);
    const record = ours ? JSON.parse(await fs.readFile(from, "utf8")) as RunRecord : undefined;
    await rename(from, to);
    if (!intercepted && record?.phase === "accept" && record.events.at(-1)?.status === "ok") {
      intercepted = true; acceptedAction.resolve(); await releaseAction.promise;
    }
  });
  const started = await f.start();
  try {
    await acceptedAction.promise;
    const during = await f.service.get(started.id);
    assert.equal(during.status, "running");
    assert.equal(during.evidence?.status, "Pass");
    assert.equal((await f.service.diff(started.id)).canApply, false);
    await assert.rejects(f.service.apply(started.id), /active|Wait for.*finish/);
    releaseAction.resolve();
    const final = await f.service.wait(started.id);
    assert.equal(final.status, "accepted", final.error);
    assert.equal(final.events.at(-1)?.step, "finished");
    assert.equal((await f.service.diff(started.id)).canApply, true);
    await f.service.apply(started.id);
    assert.ok((await f.service.get(started.id)).appliedAt);
  } finally { releaseAction.resolve(); }
});

test("preview is one self-contained page that works behind the API's origin guard", { timeout: 15_000 }, async t => {
  const f = await fixture(t, acceptanceFlow);
  await f.seedCandidate();
  const run = await f.service.wait((await f.start()).id);
  assert.equal(run.status, "accepted", run.error);
  const app = express();
  // As in the app: the whole API sits behind the origin guard. A sandboxed frame's own requests
  // would come cross-site and be refused, so the page must need none.
  app.use(localApiOriginGuard);
  app.use("/synthesis", createSynthesisRouter(() => f.service));
  app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const preview = `${origin}/synthesis/runs/${run.id}/preview/`;
  const response = await fetch(preview + "index.html", { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(page.includes(baselineFiles["calculator.js"]!.split("\n")[0]!), "the script is in the page");
  assert.ok(page.includes(baselineFiles["style.css"]!.trim().split("\n")[0]!), "the styles are in the page");
  assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+stylesheet/i, "nothing is loaded separately");
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'/);
  assert.ok(response.headers.get("content-type")?.startsWith("text/html"));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const csp = response.headers.get("content-security-policy")!;
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.match(csp, /connect-src 'none';/);
  assert.doesNotMatch(csp, /allow-same-origin|'unsafe-eval'|'self'[^;]*script|http:/);
  assert.equal((await fetch(preview + "calculator.js")).status, 404, "a script is not served on its own");
  assert.equal((await fetch(preview + "candidate.json")).status, 404);
  assert.equal((await fetch(preview + "..%2FCalculator.lcspec")).status, 400);
});
