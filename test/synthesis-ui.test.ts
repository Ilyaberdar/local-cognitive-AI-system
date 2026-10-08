import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";

const { JSDOM } = require("jsdom");
const bundle = buildSync({
  entryPoints: ["frontend/synthesis/index.tsx"], bundle: true, write: false, format: "iife", globalName: "SynthesisUI",
  outfile: "synthesis-ui.js", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }
}).outputFiles.find(file => file.path.endsWith(".js"))!.text;

const projects = [{ id: "p1", name: "Project one", rootPath: "/p1" }, { id: "p2", name: "Project two", rootPath: "/p2" }];
const moduleEntry = (id = "Calculator") => ({ id, name: id, valid: true, diagnostics: [], specSource: `module ${id} version "1" {}`, flowSource: `implement ${id} { return unresolved(); }` });
const runEntry = (id: string, status = "interrupted") => ({
  id, projectId: "p1", moduleId: "Calculator", moduleName: "Calculator", status, phase: "developer", iteration: 1,
  createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z",
  events: [{ sequence: 1, at: "2026-09-28T12:00:00.000Z", step: "developer", message: `${id} activity`, iteration: 1, status: "ok" }]
});
async function until(check: () => boolean, label: string, timeout = 1800) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function harness(route: (path: string, options: RequestInit) => unknown | Promise<unknown>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.fetch = async (path: string, options: RequestInit) => {
    // The local API guard rejects mutations without this header (403).
    if (options.method && options.method !== "GET") assert.equal((options.headers as Record<string, string>)["X-Local-Cognitive"], "1", `${options.method} ${path}`);
    return { ok: true, json: async () => route(path, options) };
  };
  dom.window.eval(`${bundle}\nwindow.SynthesisUI = SynthesisUI;`);
  const handle = dom.window.SynthesisUI.mountSynthesisWorkspace(dom.window.document.getElementById("root"), { projects, active: true });
  const text = () => dom.window.document.body.textContent;
  const click = (label: string) => {
    const element = [...dom.window.document.querySelectorAll("button")].find((item: any) => item.textContent === label) as any;
    assert.ok(element, `Button ${label} exists`); assert.equal(element.disabled, false, `Button ${label} is enabled`); element.click();
  };
  return { dom, handle, text, click, close: () => { handle.unmount(); dom.window.close(); } };
}

function input(ui: ReturnType<typeof harness>, id: string, value: string) {
  const element = ui.dom.window.document.getElementById(id);
  Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new ui.dom.window.Event("input", {bubbles: true}));
}

test("New module validates names and collisions, previews paths and sends the selected template", async () => {
  const existing = {...moduleEntry(), specPath: "Synthesis/Calculator/Calculator.lcspec"};
  const created = {...moduleEntry("AbilitySystem"), id: "file:contracts/AbilitySystem/AbilitySystem", specPath: "contracts/AbilitySystem/AbilitySystem.lcspec"};
  let payload: any;
  const ui = harness((path, options) => {
    if (path.endsWith("/runs")) return [];
    if (path.endsWith("/modules") && options.method === "POST") { payload = JSON.parse(String(options.body)); return created; }
    if (path.endsWith("/modules")) return {modules: payload ? [existing, created] : [existing]};
    if (path.endsWith("/modules/Calculator")) return existing;
    if (path.includes("/modules/file%3A")) return created;
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    const doc = ui.dom.window.document;
    await until(() => ui.text().includes("module Calculator"), "initial module");
    ui.click("New module");
    await until(() => Boolean(doc.querySelector("dialog[open]")), "creation dialog");
    assert.equal(doc.activeElement.id, "synthesis-module-name");
    assert.equal(doc.getElementById("synthesis-module-template").value, "empty");
    input(ui, "synthesis-module-name", "Calculator");
    await until(() => ui.text().includes("already exists at Synthesis/Calculator"), "inline collision");
    assert.equal(doc.querySelector('button[type="submit"]').disabled, true);
    assert.equal(payload, undefined);
    input(ui, "synthesis-module-name", "../Bad");
    await until(() => ui.text().includes("Start with a letter"), "invalid name");
    input(ui, "synthesis-module-name", "AbilitySystem");
    input(ui, "synthesis-module-directory", "contracts");
    await until(() => ui.text().includes("contracts/AbilitySystem/AbilitySystem.lcspec"), "path preview");
    ui.click("Create module");
    await until(() => ui.text().includes("AbilitySystem created at") && !doc.querySelector("dialog"), "new module selected");
    assert.deepEqual(payload, {name: "AbilitySystem", template: "empty", directory: "contracts"});
    assert.match(doc.querySelector(".synthesis-module.is-selected").textContent, /AbilitySystem/);
  } finally { ui.close(); }
});

test("folder browser is read-only and Cancel restores focus without creating files", async () => {
  const mutations: string[] = [];
  const ui = harness((path, options) => {
    if (options.method) mutations.push(options.method);
    if (path.endsWith("/runs")) return [];
    if (path.endsWith("/modules")) return {modules: []};
    if (path.endsWith("/folders?directory=")) return {directory: "", folders: ["contracts"]};
    if (path.endsWith("/folders?directory=contracts")) return {directory: "contracts", folders: []};
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    const doc = ui.dom.window.document;
    await until(() => ui.text().includes("No DSL modules found"), "empty project");
    ui.click("New module");
    await until(() => Boolean(doc.querySelector("dialog[open]")), "dialog opened");
    ui.click("Browse");
    await until(() => Boolean(doc.querySelector(".synthesis-folder-list button")), "root folders");
    ui.click("contracts");
    await until(() => ui.text().includes("No subfolders"), "entered folder");
    ui.click("Use this folder");
    await until(() => doc.getElementById("synthesis-module-directory").value === "contracts", "folder selected");
    doc.querySelector("dialog").dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    await until(() => !doc.querySelector("dialog"), "Escape closes dialog");
    assert.equal(doc.activeElement, doc.querySelector(".synthesis-new-module"));
    assert.deepEqual(mutations, []);
  } finally { ui.close(); }
});

test("Refresh discovers new files and adding a project selects it without importing", async () => {
  let reads = 0;
  const ui = harness(path => {
    if (path.endsWith("/runs")) return [];
    if (path === "/synthesis/projects/p1/modules") return {modules: ++reads > 1 ? [moduleEntry("External")] : []};
    if (path.endsWith("/modules/External")) return moduleEntry("External");
    if (path === "/synthesis/projects/p2/modules") return {modules: [moduleEntry("ImportedProject")]};
    if (path.endsWith("/modules/ImportedProject")) return moduleEntry("ImportedProject");
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes("No DSL modules found"), "initial empty list");
    ui.click("Refresh");
    await until(() => ui.text().includes("module External"), "externally authored module discovered");
    ui.handle.selectProject("p2");
    await until(() => ui.text().includes("module ImportedProject"), "new project discovered immediately");
    assert.equal(ui.dom.window.document.getElementById("synthesis-project").value, "p2");
  } finally { ui.close(); }
});

test("synthesis source tabs and restart preserve prior run history and select the new run", async () => {
  const old = runEntry("old");
  const restarted = runEntry("restarted", "accepted");
  const calls: string[] = [];
  const ui = harness(path => {
    calls.push(path);
    if (path === "/synthesis/projects/p1/modules") return { modules: [moduleEntry()] };
    if (path === "/synthesis/projects/p1/runs") return [old];
    if (path === "/synthesis/projects/p1/modules/Calculator") return moduleEntry();
    if (path === "/synthesis/runs/old") return old;
    if (path === "/synthesis/runs/old/resume" || path === "/synthesis/runs/restarted") return restarted;
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes("old activity") && ui.text().includes("module Calculator"), "module and saved run");
    ui.click("Diagnostics");
    await until(() => ui.text().includes("Spec and flow are valid"), "source diagnostics");
    ui.click("Flow");
    await until(() => Boolean(ui.dom.window.document.querySelector('[aria-label="LC Flow source"]')), "flow tab");
    assert.match(ui.dom.window.document.querySelector('[aria-label="LC Flow source"]').textContent, /implement Calculator/);
    ui.click("Restart from snapshot");
    await until(() => ui.text().includes("restarted activity"), "new run selected");
    assert.ok(calls.includes("/synthesis/runs/old/resume"));
    assert.equal(ui.dom.window.document.querySelectorAll(".synthesis-run-history > button").length, 2);
    assert.match(ui.dom.window.document.querySelector(".synthesis-run-history .is-selected").textContent, /Accepted/);
    ui.click("Preview");
    await until(() => Boolean(ui.dom.window.document.querySelector("iframe")), "candidate preview");
    const iframe = ui.dom.window.document.querySelector("iframe");
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
    assert.match(iframe.getAttribute("src"), /runs\/restarted\/preview/);
  } finally { ui.close(); }
});

test("synthesis rejects a late project response after switching workspace", async () => {
  let resolveOld!: (value: unknown) => void;
  let requestedOld = false;
  const ui = harness(path => {
    if (path === "/synthesis/projects/p1/modules") { requestedOld = true; return new Promise(resolve => { resolveOld = resolve; }); }
    if (path.endsWith("/runs")) return [];
    if (path === "/synthesis/projects/p2/modules") return { modules: [moduleEntry("Other")] };
    if (path === "/synthesis/projects/p2/modules/Other") return moduleEntry("Other");
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => requestedOld, "first project request");
    const select = ui.dom.window.document.querySelector("#synthesis-project");
    select.value = "p2"; select.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
    await until(() => ui.text().includes("module Other"), "second project source");
    resolveOld({ modules: [moduleEntry("Stale")] });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(ui.text(), /Stale/);
    assert.equal(select.value, "p2");
  } finally { ui.close(); }
});

test("historical source views load lazily and fence snapshots from the previous selected run", async () => {
  const old = runEntry("old", "accepted"), newer = runEntry("newer", "accepted");
  const current = { ...moduleEntry(), specSource: 'module Calculator version "current" {}', flowSource: "implement Calculator { // current flow\n}" };
  const sources = (version: string) => ({ specSource: `module Calculator version "${version}" {}`, flowSource: `implement Calculator { // ${version} flow\n}`, specHash: `hash-${version}` });
  let sourceRequests = 0;
  let releaseOld!: (value: unknown) => void;
  const ui = harness(path => {
    if (path === "/synthesis/projects/p1/modules") return { modules: [current] };
    if (path === "/synthesis/projects/p1/runs") return [old, newer];
    if (path === "/synthesis/projects/p1/modules/Calculator") return current;
    if (path === "/synthesis/runs/old") return old;
    if (path === "/synthesis/runs/newer") return newer;
    if (path === "/synthesis/runs/old/sources") {
      sourceRequests++;
      return sourceRequests === 1 ? sources("old") : new Promise(resolve => { releaseOld = resolve; });
    }
    if (path === "/synthesis/runs/newer/sources") { sourceRequests++; return sources("newer"); }
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes("old activity") && ui.text().includes('version "current"'), "current source selected by default");
    assert.equal(sourceRequests, 0, "historical sources are not fetched by default");
    ui.click("Run snapshot");
    await until(() => Boolean(ui.dom.window.document.querySelector('[aria-label="LC Spec run snapshot"]')), "old frozen source");
    assert.match(ui.dom.window.document.querySelector('[aria-label="LC Spec run snapshot"]').textContent, /version "old"/);
    ui.click("Diagnostics");
    await until(() => ui.text().includes("Project diagnostics"), "diagnostics panel");
    assert.match(ui.text(), /Open project \.lcspec/);
    ui.click("Flow");
    await until(() => Boolean(ui.dom.window.document.querySelector('[aria-label="LC Flow run snapshot"]')), "frozen flow source");
    assert.match(ui.dom.window.document.querySelector('[aria-label="LC Flow run snapshot"]').textContent, /old flow/);
    ui.click("Project source");
    await until(() => ui.text().includes("current flow"), "current project flow");
    ui.click("Run snapshot");
    await until(() => sourceRequests === 2, "pending second snapshot request");
    ui.dom.window.document.querySelectorAll(".synthesis-run-history > button")[1].click();
    await until(() => ui.text().includes("newer flow"), "new run snapshot");
    releaseOld(sources("stale"));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(ui.text(), /stale flow/);
    assert.match(ui.text(), /newer flow/);
    assert.match(ui.text(), /Frozen for run newer/);
  } finally { releaseOld?.(sources("released")); ui.close(); }
});

test("diagnostics separates invalid current source from passing historical evidence and restores focus on Escape", async () => {
  const current = { ...moduleEntry(), valid: false, diagnostics: [{ severity: "error", message: "Unknown evaluator", file: "Synthesis/Calculator/Calculator.lcflow", line: 12, column: 3 }] };
  const saved = { ...runEntry("accepted", "accepted"), evidence: {
    status: "Pass", candidateHash: "candidate-hash", specHash: "frozen-contract-hash",
    gates: [{ id: "arithmetic", evaluator: "calculator.arithmetic", status: "Pass", message: "All arithmetic cases passed." }]
  } };
  const opened: unknown[] = [];
  const ui = harness((path, options) => {
    if (path === "/synthesis/projects/p1/modules") return { modules: [current] };
    if (path === "/synthesis/projects/p1/runs") return [saved];
    if (path === "/synthesis/projects/p1/modules/Calculator") return current;
    if (path === "/synthesis/runs/accepted") return saved;
    if (path === "/synthesis/projects/p1/open") { opened.push(JSON.parse(String(options.body))); return {}; }
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes("accepted activity"), "historical run loaded");
    const trigger = ui.dom.window.document.querySelector('.synthesis-diagnostics-toggle');
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.match(trigger.getAttribute("aria-label"), /1 error/);
    ui.click("Diagnostics");
    await until(() => Boolean(ui.dom.window.document.querySelector('#synthesis-diagnostics')), "inspector opened");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(ui.dom.window.document.activeElement.id, "synthesis-diagnostics-title");
    assert.match(ui.dom.window.document.querySelector('.synthesis-diagnostics').textContent, /Unknown evaluator/);
    assert.match(ui.dom.window.document.querySelector('.synthesis-gates').textContent, /arithmeticPass/);
    assert.match(ui.text(), /selected run’s frozen source/);
    assert.doesNotMatch(ui.text(), /Spec and flow are valid/);
    ui.dom.window.document.querySelector('.synthesis-diagnostic').click();
    await until(() => opened.length === 1, "diagnostic opens the correct source file");
    assert.deepEqual(opened[0], { moduleId: "Calculator", file: "flow" });
    ui.dom.window.document.querySelector('#synthesis-diagnostics').dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => !ui.dom.window.document.querySelector('#synthesis-diagnostics'), "inspector closed");
    assert.equal(ui.dom.window.document.activeElement, trigger);
  } finally { ui.close(); }
});

test("an invalid module without detailed messages is never presented as valid", async () => {
  const invalid = { ...moduleEntry(), valid: false };
  const ui = harness(path => {
    if (path.endsWith('/runs')) return [];
    if (path.endsWith('/modules')) return { modules: [invalid] };
    if (path.endsWith('/modules/Calculator')) return invalid;
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes("module Calculator"), "invalid module");
    ui.click("Diagnostics");
    await until(() => ui.text().includes("Source validation is incomplete"), "incomplete validation shown");
    assert.match(ui.text(), /Not evaluated/);
    assert.doesNotMatch(ui.text(), /Spec and flow are valid/);
  } finally { ui.close(); }
});

test("synthesis polls serially and stops polling when the view becomes inactive", async () => {
  const running = runEntry("live", "running");
  let reads = 0;
  let inflight = 0;
  let maxInflight = 0;
  let release!: () => void;
  const ui = harness(async path => {
    if (path === "/synthesis/projects/p1/modules") return { modules: [moduleEntry()] };
    if (path === "/synthesis/projects/p1/runs") return [running];
    if (path === "/synthesis/projects/p1/modules/Calculator") return moduleEntry();
    if (path === "/synthesis/runs/live") {
      reads++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise<void>(resolve => { release = resolve; });
      inflight--; return running;
    }
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => reads === 1, "first poll");
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(reads, 1, "pending request has not overlapped with an interval");
    ui.handle.setActive(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(reads, 1, "hidden view does not restart polling");
    assert.equal(maxInflight, 1);
    assert.doesNotMatch(ui.text(), /live activity/, "late inactive response is ignored");
  } finally { release?.(); ui.close(); }
});

test("Changes highlights real code, uses full width for added files, and resizes modified files", async () => {
  const run = runEntry("diff", "accepted");
  const source = 'const title: string = "<img src=x onerror=alert(1)>";';
  const ui = harness(path => {
    if (path.endsWith('/modules')) return { modules: [moduleEntry()] };
    if (path.endsWith('/modules/Calculator')) return moduleEntry();
    if (path.endsWith('/runs')) return [run];
    if (path === '/synthesis/runs/diff') return run;
    if (path.endsWith('/diff')) return { canApply: false, files: [
      { path: 'added.ts', before: null, after: source },
      { path: 'empty.js', before: '', after: 'export const value = 1;' }
    ] };
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes('diff activity'), 'run loaded');
    ui.click('Changes');
    await until(() => Boolean(ui.dom.window.document.querySelector('.synthesis-diff')), 'changes loaded');
    const doc = ui.dom.window.document;
    const files = doc.querySelectorAll('.synthesis-diff > details');
    assert.equal(files[0].querySelectorAll('.synthesis-diff__code').length, 1);
    assert.equal(files[0].querySelector('.synthesis-diff__columns'), null);
    assert.match(files[0].textContent, /TypeScript/);
    assert.equal(files[0].querySelector('code').textContent, source);
    assert.ok(files[0].querySelector('.hljs-keyword'));
    assert.equal(files[0].querySelector('img'), null, 'source stays text, never executable markup');
    assert.doesNotMatch(ui.text(), /New file|Project baseline|File removed/);
    assert.match(files[1].querySelector('summary').textContent, /Modified/);
    const resize = files[1].querySelector('[role="separator"]');
    resize.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await until(() => resize.getAttribute('aria-valuenow') === '45', 'column split updated');
    assert.equal(ui.dom.window.localStorage.getItem('lcai.synthesis.diffSplit.v1'), '45');
    const activity = doc.querySelector('[aria-label="Resize Agent activity"]');
    activity.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await until(() => activity.getAttribute('aria-valuenow') === '55', 'activity split updated');
    activity.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await until(() => activity.getAttribute('aria-valuenow') === '8', 'activity minimum bounded');
    assert.equal(ui.dom.window.localStorage.getItem('lcai.synthesis.activitySplit.v1'), '8');
  } finally { ui.close(); }
});

test("removing a module only hides it in that project and can be restored", async () => {
  const writes: string[] = [];
  const ui = harness((path, options) => {
    if (options?.method && options.method !== 'GET') writes.push(path);
    if (path.endsWith('/modules')) return { modules: [moduleEntry(), moduleEntry('Other')] };
    if (path.endsWith('/modules/Calculator')) return moduleEntry();
    if (path.endsWith('/modules/Other')) return moduleEntry('Other');
    if (path.endsWith('/runs')) return [];
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    const doc = ui.dom.window.document;
    await until(() => ui.text().includes('module Calculator'), 'initial selection');
    doc.querySelector('[aria-label="Remove Calculator from view"]').click();
    await until(() => ui.text().includes('module Other'), 'next module selected');
    assert.equal(doc.querySelector('[aria-label="Remove Calculator from view"]'), null);
    assert.deepEqual(JSON.parse(ui.dom.window.localStorage.getItem('lcai.synthesis.hiddenModules.v1')), { p1: ['Calculator'] });
    const select = doc.querySelector('#synthesis-project');
    select.value = 'p2'; select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await until(() => Boolean(doc.querySelector('[aria-label="Remove Calculator from view"]')), 'other project unaffected');
    select.value = 'p1'; select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await until(() => Boolean(doc.querySelector('[aria-label="Restore Calculator"]')), 'hidden module retained');
    doc.querySelector('[aria-label="Restore Calculator"]').click();
    await until(() => ui.text().includes('module Calculator'), 'restored and selected');
    assert.ok(doc.querySelector('[aria-label="Remove Calculator from view"]'));
    doc.querySelector('[aria-label="Remove Calculator from view"]').click();
    await until(() => ui.text().includes('module Other'), 'other selected again');
    doc.querySelector('[aria-label="Remove Other from view"]').click();
    await until(() => ui.text().includes('All modules are hidden'), 'empty view is recoverable');
    assert.equal(doc.querySelectorAll('.synthesis-module').length, 0);
    assert.equal(writes.length, 0, 'view changes make no file or run mutation requests');
  } finally { ui.close(); }
});
