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
// The wait ends as soon as the condition holds; a CI machine busy with other test files (the contract
// tests build C++ beside these) may need more than a couple of seconds.
async function until(check: () => boolean, label: string, timeout = 10_000) {
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
    assert.deepEqual([...ui.dom.window.document.querySelectorAll('[role="tab"]')].map((tab: any) => tab.textContent), ["Contract", "Flow", "Changes"], "no Preview tab");
    assert.equal(ui.dom.window.document.querySelector("iframe"), null, "nothing a candidate wrote runs in the app");
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

test("Changes lists the files and shows the chosen one: an added file's source with line numbers, a modified one's diff that resizes", async () => {
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
    await until(() => Boolean(ui.dom.window.document.querySelector('.synthesis-changes')), 'changes loaded');
    const doc = ui.dom.window.document;
    const options = [...doc.querySelectorAll('.synthesis-changes__files [role="option"]')] as any[];
    assert.deepEqual(options.map(item => item.textContent), ['added.tsAdded', 'empty.jsModified']);
    assert.equal(options[0].getAttribute('aria-selected'), 'true');
    const body = () => doc.querySelector('.synthesis-changes__body') as any;
    assert.equal(body().querySelector('.synthesis-lines__row code').textContent, source);
    assert.equal(body().querySelector('.synthesis-lines__number').textContent, '1');
    assert.ok(body().querySelector('.hljs-keyword'));
    assert.equal(doc.querySelector('.synthesis-changes img'), null, 'source stays text, never executable markup');
    assert.equal(doc.querySelector('.synthesis-changes__header [role="group"]'), null, 'an added code file has only its source');
    // Arrow keys move through the list.
    options[0].dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await until(() => options[1].getAttribute('aria-selected') === 'true', 'next file');
    assert.deepEqual([...doc.querySelectorAll('.synthesis-changes__header [role="group"] button')].map((item: any) => [item.textContent, item.getAttribute('aria-pressed')]), [['Diff', 'true'], ['Source', 'false']]);
    const resize = body().querySelector('[role="separator"]');
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

test("on a server the screen reaches Synthesis through its transport, with no editor or preview of this computer", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const fetched: string[] = [], asked: string[] = [];
  dom.window.fetch = async (path: string) => { fetched.push(path); return { ok: true, json: async () => ({}) }; };
  dom.window.eval(`${bundle}\nwindow.SynthesisUI = SynthesisUI;`);
  const transport = { remote: { hostName: "fedora" }, request: async (path: string, options: RequestInit = {}) => {
    asked.push(`${options.method ?? "GET"} ${path}`);
    if (path.endsWith("/runs") && !options.method) return [runEntry("r1", "accepted")];
    if (path.endsWith("/modules")) return { modules: [{ ...moduleEntry(), specPath: "Synthesis/Calculator/Calculator.lcspec" }] };
    if (path.endsWith("/modules/Calculator")) return moduleEntry();
    if (path.startsWith("/runs/r1")) return runEntry("r1", "accepted");
    return {};
  } };
  const handle = dom.window.SynthesisUI.mountSynthesisWorkspace(dom.window.document.getElementById("root"),
    { projects: [{ id: "p1", name: "Calc", rootPath: "fedora › Projects › calc" }], active: true, transport, storageKey: "host-1" });
  try {
    const text = () => dom.window.document.body.textContent;
    await until(() => text().includes("module Calculator"), "server module");
    assert.match(text(), /The source is edited on fedora/);
    const buttons = [...dom.window.document.querySelectorAll("button")].map((item: any) => item.textContent);
    assert.equal(buttons.some(label => /Open in editor|Open project/.test(label)), false, "no editor of this computer");
    assert.equal(buttons.includes("Preview"), false, "no preview of a server's candidate");
    assert.deepEqual(fetched, [], "this computer's API is not asked");
    assert.ok(asked.includes("GET /projects/p1/modules") && asked.includes("GET /projects/p1/runs"));
    assert.equal(dom.window.localStorage.getItem("lcai.synthesis.project.v1:host-1"), "p1", "this server's view is kept apart");
  } finally { handle.unmount(); dom.window.close(); }
});

test("a server's projects arriving after the screen keep the project chosen there before", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.localStorage.setItem("lcai.synthesis.project.v1:host-1", "p2");
  dom.window.eval(`${bundle}\nwindow.SynthesisUI = SynthesisUI;`);
  const asked: string[] = [];
  const transport = { remote: { hostName: "fedora" }, request: async (path: string) => {
    asked.push(path);
    return path.endsWith("/modules") ? { modules: [] } : path.endsWith("/runs") ? [] : {};
  } };
  const handle = dom.window.SynthesisUI.mountSynthesisWorkspace(dom.window.document.getElementById("root"), { projects: [], active: true, transport, storageKey: "host-1" });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.window.localStorage.getItem("lcai.synthesis.project.v1:host-1"), "p2", "no project yet is not a choice");
    handle.setProjects([{ id: "p1", name: "One", rootPath: "fedora › Projects › one" }, { id: "p2", name: "Two", rootPath: "fedora › Projects › two" }]);
    await until(() => asked.includes("/projects/p2/modules"), "saved project");
    assert.equal((dom.window.document.getElementById("synthesis-project") as HTMLSelectElement).value, "p2");
    assert.equal(asked.some(path => path.startsWith("/projects/p1/")), false);
  } finally { handle.unmount(); dom.window.close(); }
});

test("Cloud models is the host's switch for the selected project: it shows the project's setting and changes it", async () => {
  const sent: Array<{ path: string; body?: unknown }> = [];
  let allowed = false, listed = 0;
  const ui = harness((path, options) => {
    if (path.endsWith("/runs")) return [];
    if (path.endsWith("/cloud")) {
      if (options.method === "PUT") { sent.push({ path, body: JSON.parse(String(options.body)) }); allowed = true; }
      return { allowed };
    }
    if (path.endsWith("/modules")) { listed++; return { modules: [moduleEntry()] }; }
    if (path.endsWith("/modules/Calculator")) return moduleEntry();
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    const box = () => ui.dom.window.document.querySelector(".synthesis-cloud-toggle input") as any;
    await until(() => Boolean(box()), "cloud switch");
    assert.equal(box().checked, false);
    const before = listed;
    box().click();
    await until(() => sent.length === 1 && box().checked === true, "cloud allowed");
    assert.deepEqual(sent, [{ path: "/synthesis/projects/p1/cloud", body: { allowed: true } }]);
    await until(() => /Cloud models may now read this project/.test(ui.text()), "notice");
    await until(() => listed > before, "modules checked again for their diagnostics");
  } finally { ui.close(); }
});

test("on a server Cloud models is shown, not switched: the server's owner sets it with a command", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.fetch = async () => { throw new Error("this computer's API is not asked"); };
  dom.window.eval(`${bundle}\nwindow.SynthesisUI = SynthesisUI;`);
  const asked: string[] = [];
  const transport = { remote: { hostName: "fedora" }, request: async (path: string, options: RequestInit = {}) => {
    asked.push(`${options.method ?? "GET"} ${path}`);
    if (path.endsWith("/cloud")) return { allowed: true };
    if (path.endsWith("/modules")) return { modules: [] };
    if (path.endsWith("/runs")) return [];
    return {};
  } };
  const handle = dom.window.SynthesisUI.mountSynthesisWorkspace(dom.window.document.getElementById("root"),
    { projects: [{ id: "p1", name: "Calc", rootPath: "fedora › Projects › calc" }], active: true, transport, storageKey: "host-1" });
  try {
    const status = () => dom.window.document.querySelector(".synthesis-cloud-status") as HTMLElement | null;
    await until(() => Boolean(status()), "cloud status");
    assert.equal(status()!.textContent, "Cloud models: on");
    assert.equal(status()!.getAttribute("title"), "Set on fedora: sudo local-cognitive-server cloud-models deny p1");
    assert.equal(dom.window.document.querySelector(".synthesis-cloud-toggle"), null, "no switch on a device");
    assert.ok(asked.includes("GET /projects/p1/cloud"));
    assert.equal(asked.some(line => line.startsWith("PUT")), false, "nothing is changed from here");
  } finally { handle.unmount(); dom.window.close(); }
});

test("Agents lists a run's agents with their model, status and files, and shows one agent's steps; Changes marks deleted files", async () => {
  const run = { ...runEntry("swarm", "accepted"), agents: { total: 2, queued: 0, running: 0, done: 1, failed: 1, cancelled: 0 } };
  const items = [
    { index: 0, call: 1, task: "Review src/a.ts", providerId: "deepseek", model: "deepseek-flash", status: "done", steps: 3, inputTokens: 12000, outputTokens: 900, durationMs: 4200, files: ["review/notes/a.md"] },
    { index: 1, call: 1, task: "Review src/b.ts", providerId: "perplexity", model: "openai/gpt-5-mini", status: "failed", steps: 16, inputTokens: 300, outputTokens: 20, durationMs: 900, files: [], error: "Agent reached its step limit (16)" }
  ];
  const requested: string[] = [];
  const ui = harness(path => {
    requested.push(path);
    if (path.endsWith('/modules')) return { modules: [moduleEntry()] };
    if (path.endsWith('/modules/Calculator')) return moduleEntry();
    if (path.endsWith('/runs')) return [run];
    if (path === '/synthesis/runs/swarm') return run;
    if (path === '/synthesis/runs/swarm/agents') return { counts: run.agents, items };
    if (path === '/synthesis/runs/swarm/agents/0') return { ...items[0], protocol: "json", final: "Wrote review/notes/a.md: src/a.ts:12", turns: [
      { type: "tool", content: '{"tool":"file.read","arguments":{"path":"src/a.ts"}}' }, { type: "result", content: "file.read: succeeded" }] };
    if (path === '/synthesis/runs/swarm/agents/1') return { ...items[1], protocol: "json", turns: [{ type: "tool", content: '{"tool":"file.list","arguments":{}}' }] };
    if (path.endsWith('/diff')) return { canApply: true, files: [{ path: 'review/notes/old.md', before: 'stale', after: null }] };
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes('swarm activity'), 'run loaded');
    ui.click('Agents · 2');
    await until(() => ui.dom.window.document.querySelectorAll('.synthesis-agents__row').length === 2, 'agents listed');
    const doc = ui.dom.window.document;
    assert.match(doc.querySelector('.synthesis-agents__counts').textContent, /2 agents.*1 done.*1 failed/);
    const [first, second] = [...doc.querySelectorAll('.synthesis-agents__row')] as any[];
    assert.match(first.textContent, /deepseek-flash.*Done.*Review src\/a\.ts.*3 steps · 12k \/ 900 · 4\.2 s.*review\/notes\/a\.md/);
    assert.match(second.textContent, /openai\/gpt-5-mini.*Failed.*step limit/);
    // Beside the list: the first that failed, until one is chosen.
    await until(() => /Agent 2/.test(doc.querySelector('.synthesis-agent-detail header')?.textContent ?? ''), 'failed agent shown first');
    assert.equal(second.getAttribute('aria-selected'), 'true');
    first.click();
    await until(() => /Agent 1/.test(doc.querySelector('.synthesis-agent-detail header')?.textContent ?? ''), 'agent steps');
    assert.equal(first.getAttribute('aria-selected'), 'true');
    assert.match(doc.querySelector('.synthesis-agent-detail').textContent, /Agent 1.*deepseek\/deepseek-flash · Done · json actions.*Action.*file\.read.*Result.*Answer.*src\/a\.ts:12/s);
    ui.click('Changes');
    await until(() => Boolean(doc.querySelector('.synthesis-changes')), 'changes loaded');
    assert.match(doc.querySelector('.synthesis-changes__files [role="option"]').textContent, /review\/notes\/old\.md.*Deleted/);
    await until(() => doc.querySelector('.synthesis-changes__body .synthesis-markdown')?.textContent.trim() === 'stale', "a deleted note shows what it held");
    assert.ok(requested.includes('/synthesis/runs/swarm/agents/0'));
  } finally { ui.close(); }
});

test("a report in Changes is formatted: its citations open the place, broken ones are marked, and what a model wrote never runs", async () => {
  const report = [
    "# Report", "", "- `src/a.ts:12` swallows an error", "- src/missing.ts:3 does not exist", "- see notes/n1.md:2 and review/data.json",
    "", "<img src=x onerror=\"window.ran = true\">", "[run](javascript:window.ran=true) · [relative](src/a.ts) · [site](https://example.com/docs)"
  ].join("\n");
  const run = { ...runEntry("report", "needs_review"), evidence: { candidateHash: "h", specHash: "s", status: "Fail", gates: [
    { id: "grounded", evaluator: "contract-grounded-v1", status: "Fail", message: "1 of 4 references in REPORT.md do not hold", grounded: { file: "REPORT.md", references: [
      { path: "src/a.ts", start: 12, status: "ok", lines: 40 }, { path: "src/missing.ts", start: 3, status: "missing" }, { path: "notes/n1.md", start: 2, status: "ok", lines: 3 }] } }] } };
  const requested: string[] = [];
  const project = Array.from({ length: 40 }, (_value, index) => `const line${index + 1} = ${index + 1};`).join("\n");
  const ui = harness(path => {
    requested.push(path);
    if (path.endsWith('/modules')) return { modules: [moduleEntry()] };
    if (path.endsWith('/modules/Calculator')) return moduleEntry();
    if (path.endsWith('/runs')) return [run];
    if (path === '/synthesis/runs/report') return run;
    if (path.endsWith('/diff')) return { canApply: false, root: "review", files: [
      { path: "review/REPORT.md", before: null, after: report }, { path: "review/notes/n1.md", before: null, after: "first\nsecond\nthird" },
      { path: "review/data.json", before: null, after: '{"agents": [1, 2], "ok": true, "name": "<b>x</b>"}' }, { path: "review/broken.json", before: null, after: "{ not json" }] };
    if (path === '/synthesis/runs/report/project-file?path=src%2Fa.ts') return { path: "src/a.ts", content: project };
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes('report activity'), 'run loaded');
    ui.click('Changes');
    const doc = ui.dom.window.document;
    await until(() => Boolean(doc.querySelector('.synthesis-markdown .synthesis-ref')), 'report formatted');
    const markdown = doc.querySelector('.synthesis-markdown') as any;
    assert.ok(markdown.querySelector('h1'), "formatted, not raw text");
    assert.equal(markdown.querySelector('img, [onerror], script, iframe'), null, "raw HTML stays text");
    const refs = () => [...doc.querySelectorAll('.synthesis-markdown .synthesis-ref')] as any[];
    assert.deepEqual(refs().map(item => [item.tagName, item.textContent, item.className]), [
      ["BUTTON", "src/a.ts:12", "synthesis-ref is-ok"], ["BUTTON", "src/missing.ts:3", "synthesis-ref is-missing"],
      ["BUTTON", "notes/n1.md:2", "synthesis-ref is-ok"], ["BUTTON", "review/data.json", "synthesis-ref is-unchecked"]]);
    assert.equal(refs()[1].title, "src/missing.ts does not exist in the project");
    assert.match(doc.querySelector('.synthesis-changes__files [role="option"]').textContent, /REPORT\.md.*Added.*1 broken/);
    const link = (text: string) => [...markdown.querySelectorAll('a')].find((item: any) => item.textContent === text) as any;
    for (const [text, stays] of [["relative", true], ["site", false]] as const) {
      const event = new ui.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      link(text).dispatchEvent(event);
      assert.equal(event.defaultPrevented, stays, `${text}: only the web leaves the app`);
    }
    assert.equal(link("run"), undefined, "a javascript: link is not made a link at all");
    assert.equal(ui.dom.window.ran, undefined);

    // A citation of a candidate file selects it at the line.
    refs()[2].click();
    await until(() => doc.querySelector('.synthesis-changes__files [aria-selected="true"]')?.textContent.startsWith('review/notes/n1.md'), 'cited note selected');
    assert.equal(doc.querySelector('.synthesis-lines__row.is-target')?.getAttribute('data-line'), '2');
    // A project file opens read-only, at the line, on this computer.
    (doc.querySelector('.synthesis-changes__files [data-path="review/REPORT.md"]') as any).click();
    await until(() => refs().length === 4, 'report again');
    refs()[0].click();
    await until(() => Boolean(doc.querySelector('.synthesis-changes__body .synthesis-lines')) && /read-only, as it is now/.test(ui.text()), 'project file');
    assert.ok(requested.includes('/synthesis/runs/report/project-file?path=src%2Fa.ts'));
    assert.equal(doc.querySelector('.synthesis-lines__row.is-target')?.getAttribute('data-line'), '12');
    ui.click('← review/REPORT.md');
    await until(() => refs().length === 4, 'back to the report');

    // JSON is a tree; text that is not JSON says so and shows its source.
    (doc.querySelector('.synthesis-changes__files [data-path="review/data.json"]') as any).click();
    await until(() => Boolean(doc.querySelector('.synthesis-json')), 'json tree');
    assert.match(doc.querySelector('.synthesis-json').textContent, /agents: \[2\].*0: 1.*ok: true.*name: "<b>x<\/b>"/s);
    assert.equal(doc.querySelector('.synthesis-json b'), null);
    (doc.querySelector('.synthesis-changes__files [data-path="review/broken.json"]') as any).click();
    await until(() => /Not valid JSON/.test(ui.text()), 'invalid json');
    assert.equal(doc.querySelector('.synthesis-lines__row code').textContent, '{ not json');
  } finally { ui.close(); }
});

test("on a server a report's citations of project files are marked but not opened: only the server reads its project", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(`${bundle}\nwindow.SynthesisUI = SynthesisUI;`);
  const run = { ...runEntry("remote", "accepted"), evidence: { candidateHash: "h", specHash: "s", status: "Pass", gates: [
    { id: "grounded", evaluator: "contract-grounded-v1", status: "Pass", message: "ok", grounded: { file: "REPORT.md", references: [{ path: "src/a.ts", start: 1, status: "ok", lines: 5 }] } }] } };
  const asked: string[] = [];
  const transport = { remote: { hostName: "fedora" }, request: async (path: string) => {
    asked.push(path);
    if (path.endsWith("/modules")) return { modules: [moduleEntry()] };
    if (path.endsWith("/modules/Calculator")) return moduleEntry();
    if (path.endsWith("/runs")) return [run];
    if (path === "/runs/remote") return run;
    if (path.endsWith("/diff")) return { canApply: true, root: "review", files: [{ path: "review/REPORT.md", before: null, after: "- src/a.ts:1 and notes/n.md:1" }, { path: "review/notes/n.md", before: null, after: "x" }] };
    return {};
  } };
  const handle = dom.window.SynthesisUI.mountSynthesisWorkspace(dom.window.document.getElementById("root"),
    { projects: [{ id: "p1", name: "Calc", rootPath: "fedora › Projects › calc" }], active: true, transport, storageKey: "host-1" });
  try {
    const doc = dom.window.document;
    await until(() => doc.body.textContent.includes("remote activity"), "run loaded");
    ([...doc.querySelectorAll('[role="tab"]')].find((tab: any) => tab.textContent === "Changes") as any).click();
    await until(() => doc.querySelectorAll(".synthesis-markdown .synthesis-ref").length === 2, "report formatted");
    const [project, note] = [...doc.querySelectorAll(".synthesis-markdown .synthesis-ref")] as any[];
    assert.deepEqual([project.tagName, project.className], ["SPAN", "synthesis-ref is-ok"], "a project file is not opened from a computer");
    assert.equal(note.tagName, "BUTTON", "a file of the run's own still opens");
    project.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(asked.some(path => path.includes("project-file")), false);
  } finally { handle.unmount(); dom.window.close(); }
});

test("a modified file's diff reads as a diff: aligned lines, removed and added ones marked, what changed within a line, unchanged stretches folded", async () => {
  const run = runEntry("diffed", "accepted");
  const before = Array.from({ length: 24 }, (_value, index) => `const line${index + 1} = ${index + 1};`);
  before[2] = "pop(): T | undefined { return this.items.shift(); }";
  const after = [...before];
  after[2] = "pop(): T | undefined { return this.items.pop(); }";
  after.splice(20, 0, "const added = true;");
  const ui = harness(path => {
    if (path.endsWith('/modules')) return { modules: [moduleEntry()] };
    if (path.endsWith('/modules/Calculator')) return moduleEntry();
    if (path.endsWith('/runs')) return [run];
    if (path === '/synthesis/runs/diffed') return run;
    if (path.endsWith('/diff')) return { canApply: false, root: "app", files: [{ path: "app/src/stack.ts", before: before.join("\n"), after: after.join("\n") }] };
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await until(() => ui.text().includes('diffed activity'), 'run loaded');
    ui.click('Changes');
    const doc = ui.dom.window.document;
    await until(() => Boolean(doc.querySelector('.synthesis-diff2')), 'diff shown');
    const cells = (type: string) => [...doc.querySelectorAll(`.synthesis-diff2__code.is-${type}`)].map((item: any) => item.textContent);
    assert.deepEqual(cells("del"), ["pop(): T | undefined { return this.items.shift(); }"]);
    assert.deepEqual(cells("add"), ["pop(): T | undefined { return this.items.pop(); }", "const added = true;"]);
    assert.equal(doc.querySelector('.synthesis-diff2__del')?.textContent, "shift", "what changed within the line");
    assert.equal(doc.querySelector('.synthesis-diff2__add')?.textContent, "pop");
    assert.equal(doc.querySelectorAll('.synthesis-diff2__code.is-empty').length, 1, "the added line has nothing beside it");
    assert.match(doc.querySelector('.synthesis-diff2__head').textContent, /Before.*After.*\+2.*−1/);
    const fold = doc.querySelector('.synthesis-diff2__fold') as any;
    assert.match(fold.textContent, /⋯ 11 unchanged lines/);
    const shown = doc.querySelectorAll('.synthesis-diff2__row').length;
    fold.click();
    await until(() => !doc.querySelector('.synthesis-diff2__fold') && doc.querySelectorAll('.synthesis-diff2__row').length === shown + 11, 'fold opened');
    assert.ok(doc.querySelector('.synthesis-diff2 .hljs-keyword'), "still highlighted");
  } finally { ui.close(); }
});

test("Cloud models is a switch; a click leaves no focus ring; the diagnostics panel slides away before it goes", async () => {
  const ui = harness(path => {
    if (path.endsWith("/runs")) return [];
    if (path.endsWith("/cloud")) return { allowed: true };
    if (path.endsWith("/modules")) return { modules: [moduleEntry()] };
    if (path.endsWith("/modules/Calculator")) return moduleEntry();
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    const doc = ui.dom.window.document;
    await until(() => Boolean(doc.querySelector(".synthesis-cloud-toggle input")), "cloud switch");
    const box = doc.querySelector(".synthesis-cloud-toggle input") as any;
    assert.deepEqual([box.getAttribute("role"), box.className, box.checked], ["switch", "synthesis-switch", true]);
    const workspace = doc.querySelector(".synthesis-workspace") as any;
    workspace.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    assert.equal(workspace.dataset.modality, "keyboard");
    box.dispatchEvent(new ui.dom.window.Event("pointerdown", { bubbles: true }));
    assert.equal(workspace.dataset.modality, "pointer", "a click: no focus ring");
    ui.click("Diagnostics");
    await until(() => Boolean(doc.querySelector(".synthesis-layout.is-inspector-open .synthesis-inspector")), "panel in");
    ui.click("Diagnostics");
    await until(() => !doc.querySelector(".synthesis-layout.is-inspector-open"), "panel leaving");
    assert.ok(doc.querySelector(".synthesis-inspector"), "still there while it slides away");
    await until(() => !doc.querySelector(".synthesis-inspector"), "panel gone");
  } finally { ui.close(); }
});
