import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clauseCoverage, contractClauses, sourceDiagnostics } from "../src/synthesis/check";
import { checkModules, formatChecks, runCheckCommand } from "../src/synthesis/checkFolder";
import { compileProgram } from "../src/synthesis/language";
import { flowTemplate, rateLimiterTemplate } from "../src/synthesis/templates";
import { parseServerArgs } from "../src/server/args";
import { CliError } from "../src/server/exitCodes";

const bucketSpec = (description = "[C1] take() returns true while tokens last. [C2] Throws RangeError on capacity 0.", gates = `hard behavior = Tests("tests/bucket.test.ts");`) => `module Bucket version "1" {
    target { language = TypeScript; }
    description = "${description}";
    artifacts {
        frozen "src/types.ts";
        file "src/clock.ts";
        file "src/bucket.ts";
    }
    evaluate "contract-v1" {
        ${gates}
    }
}
`;
const local = {kind: "local" as const, maxSize: "6GiB", prefer: "coder"};
const sources = (spec: string, flow: string) => ({name: "Bucket", specPath: "Bucket/Bucket.lcspec", flowPath: "Bucket/Bucket.lcflow", specSource: spec, flowSource: flow});

test("a derived flow revises the contract's files in order and compiles, local or cloud", () => {
  for (const model of [local, {kind: "local" as const, id: "qwen3.8-27b-q4_k_m"}, {kind: "cloud" as const, provider: "deepseek", id: "deepseek-flash"}]) {
    const flow = flowTemplate("Bucket", ["src/clock.ts", "src/bucket.ts"], {output: "generated/Bucket", model, iterations: 10, minutes: 40});
    assert.deepEqual(sourceDiagnostics(sources(bucketSpec(), flow)).diagnostics, [], model.kind);
    const revised = [...flow.matchAll(/file = "([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(revised, ["src/clock.ts", "src/bucket.ts"], "frozen files are never revised");
    assert.match(flow, /limit iterations 10, time 40m, cost 0usd;/);
    assert.match(flow, model.kind === "cloud" ? /policy = "cloud-files-v1";\n\n    developer = await model\("deepseek-flash", provider = "deepseek"\);/ : /policy = "local-files-v1";/);
  }
  assert.match(flowTemplate("Bucket", ["src/bucket.ts"], {output: "out", model: {kind: "local", id: "exact"}}), /models\.select\(available, id = "exact"\);/);
});

test("the rate limiter's flow is the derived one, as it was written by hand", () => {
  const {flow} = rateLimiterTemplate();
  assert.equal(flow, flowTemplate("RateLimiter", ["src/rateLimiter.ts"], {output: "rate-limiter", model: local}));
  assert.match(flow, /selected = models\.select\(available, max_size = 6GiB, prefer = "coder"\);/);
  assert.match(rateLimiterTemplate("Limiter").flow, /checkout\("generated\/Limiter"\)/);
  assert.deepEqual(compileProgram(rateLimiterTemplate().spec, flow).diagnostics, []);
});

test("source checks name a module whose contract declares another name, and the runtime's limits", () => {
  const flow = flowTemplate("Bucket", ["src/bucket.ts"], {output: "generated/Bucket", model: local});
  const renamed = sourceDiagnostics({...sources(bucketSpec(), flow), name: "Other"}).diagnostics.map(item => item.code);
  assert.ok(renamed.includes("MODULE_NAME"));
  const tooLong = sourceDiagnostics(sources(bucketSpec(), flow.replace("limit iterations 6", "limit iterations 40"))).diagnostics;
  assert.deepEqual(tooLong.map(item => [item.code, item.file]), [["FLOW_LIMIT_RANGE", "Bucket/Bucket.lcflow"]]);
});

test("numbered clauses: each needs a test that names it, and a test names only clauses there are", () => {
  assert.deepEqual(contractClauses("[C2] b. [C1] a. [C2] again. [C10] ten."), ["C2", "C1", "C10"]);
  const spec = compileProgram(bucketSpec(), flowTemplate("Bucket", ["src/bucket.ts"], {output: "o", model: local})).spec;
  const found = clauseCoverage(spec, "Bucket.lcspec", {"tests/bucket.test.ts": `test("[C1] takes", () => {}); test("[C7] other", () => {});`});
  assert.deepEqual(found.map(item => [item.severity, item.code]), [["warning", "SPEC_CLAUSE_UNTESTED"], ["warning", "SPEC_CLAUSE_UNKNOWN"]]);
  assert.match(found[0]!.message, /\[C2\]/);
  assert.match(found[1]!.message, /tests\/bucket\.test\.ts names \[C7\]/);
  // A description that numbers nothing asks nothing of the tests.
  const plain = compileProgram(bucketSpec("A token bucket."), flowTemplate("Bucket", ["src/bucket.ts"], {output: "o", model: local})).spec;
  assert.deepEqual(clauseCoverage(plain, "Bucket.lcspec", {"tests/bucket.test.ts": `test("[C1] takes", () => {});`}), []);
});

test("synthesis check reads modules from disk: missing files, missing tests, clauses, and a clean one", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lc-check-"));
  try {
    const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true}); await fs.writeFile(path.join(root, file), text); };
    const flow = flowTemplate("Bucket", ["src/clock.ts", "src/bucket.ts"], {output: "generated/Bucket", model: local});
    await write("Synthesis/Bucket/Bucket.lcspec", bucketSpec(undefined, `hard behavior = Tests("tests/bucket.test.ts"); hard more = Tests("tests/more.test.ts");`));
    await write("Synthesis/Bucket/Bucket.lcflow", flow);
    await write("Synthesis/Bucket/tests/bucket.test.ts", `test("[C1] takes", () => {}); test("[C2] refuses 0", () => {});`);
    await write("Synthesis/Lonely/Lonely.lcspec", "module Lonely version \"1\" {}");
    await write("node_modules/Hidden/Hidden.lcspec", "not a module");
    await write("Synthesis/Clean/Clean.lcspec", bucketSpec().replace("module Bucket", "module Clean"));
    await write("Synthesis/Clean/Clean.lcflow", flow.replace("implement Bucket", "implement Clean").replace("freeze(Bucket.spec)", "freeze(Clean.spec)"));
    await write("Synthesis/Clean/tests/bucket.test.ts", `test("[C1] takes", () => {}); test("[C2] refuses 0", () => {});`);

    const checks = await checkModules(".", root);
    assert.deepEqual(checks.map(check => [check.module, check.valid]), [["Bucket", false], ["Clean", true], ["Lonely", false]]);
    assert.deepEqual(checks[0]!.diagnostics.map(item => [item.code, item.file]), [["SPEC_TEST_MISSING", "Synthesis/Bucket/Bucket.lcspec"]]);
    assert.match(checks[0]!.diagnostics[0]!.message, /Synthesis\/Bucket\/tests\/more\.test\.ts/);
    assert.deepEqual(checks[2]!.diagnostics.map(item => item.code), ["SOURCE_READ"]);
    const text = formatChecks(checks).split("\n");
    assert.ok(text.includes("Clean: ok (Synthesis/Clean/Clean.lcspec)"));
    assert.ok(text.some(line => line.startsWith("Synthesis/Bucket/Bucket.lcspec:1:1 error SPEC_TEST_MISSING ")));
    assert.ok(text.includes("Bucket: 1 error, 0 warnings (Synthesis/Bucket/Bucket.lcspec)"));

    const only = await checkModules("Synthesis/Clean/Clean.lcspec", root);
    assert.deepEqual(only.map(check => check.module), ["Clean"]);
    await assert.rejects(checkModules("Synthesis/Clean/Clean.lcflow", root), /is not a \.lcspec file or a folder/);
    await assert.rejects(checkModules("nowhere", root), /nowhere does not exist/);

    const cwd = process.cwd();
    let out = "", err = "";
    try {
      process.chdir(root);
      assert.equal(await runCheckCommand(["Synthesis/Clean"], text => { out += text; }, text => { err += text; }), 0);
      assert.equal(await runCheckCommand(["Synthesis", "--json"], text => { out += text; }), 1);
      assert.equal(await runCheckCommand(["a", "b"], () => {}, text => { err += text; }), 64);
    } finally { process.chdir(cwd); }
    assert.match(out, /^Clean: ok/);
    assert.match(out, /"module": "Lonely"/);
    assert.match(err, /^Usage: check/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("the server CLI takes synthesis check without a data directory", () => {
  assert.deepEqual(parseServerArgs(["synthesis", "check", "Synthesis/Bucket"], {}).synthesis, {action: "check", path: "Synthesis/Bucket"});
  assert.deepEqual(parseServerArgs(["synthesis", "check", "--json"], {}).synthesis, {action: "check", path: "."});
  assert.throws(() => parseServerArgs(["synthesis"], {}), CliError);
  assert.throws(() => parseServerArgs(["synthesis", "check", "a", "b"], {}), /Unexpected argument: b/);
});
