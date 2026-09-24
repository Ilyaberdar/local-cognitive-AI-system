import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const appSource = fs.readFileSync("public/assets/app.js", "utf8");
const projectsSource = fs.readFileSync("public/assets/projects-ui.js", "utf8")
  .replace(/^import .*;\n/m, "").replaceAll("export function", "function");
const appFunction = (name: string, next: string) => appSource.slice(appSource.indexOf(name), appSource.indexOf(next, appSource.indexOf(name)));

test("ordinary chats stay separate from project and archived project conversations", () => {
  const context: any = { icon: () => "" };
  vm.runInNewContext(projectsSource, context);
  const grouped = context.groupProjectSessions([
    { id: "ordinary" }, { id: "a", projectId: "project-a" }, { id: "archived", projectId: "archived-project" }
  ]);
  assert.deepEqual(Array.from(grouped.recent, (item: any) => item.id), ["ordinary"]);
  assert.deepEqual(Array.from(grouped.byProject.get("project-a"), (item: any) => item.id), ["a"]);
  assert.deepEqual(Array.from(grouped.byProject.get("archived-project"), (item: any) => item.id), ["archived"]);
});

test("compact project tree keeps an older active chat visible and hides archived projects", () => {
  const context: any = { icon: () => "" };
  vm.runInNewContext(projectsSource, context);
  const state = {
    activeProjectId: "p", activeSessionId: "p-7",
    bootstrap: { projects: [{ id: "p", name: "<Project>", rootPath: "/project" }, { id: "archive", name: "Hidden name", archivedAt: "today" }],
      sessions: [{ id: "plain", title: "Ordinary chat", channel: "HTTP" }, ...Array.from({ length: 8 }, (_, index) => ({ id: `p-${index}`, title: `Project chat ${index}`, projectId: "p" }))] }
  };
  const ui = context.createProjectsUi({ getState: () => state });
  const html = ui.sidebar();
  const chats = html.slice(html.indexOf('aria-label="Chats"'));
  assert.match(chats, /Ordinary chat/);
  assert.doesNotMatch(chats, /Project chat/);
  assert.ok(html.indexOf('aria-label="Projects"') < html.indexOf('aria-label="Chats"'));
  assert.match(html, /&lt;Project&gt;/);
  assert.match(html, /Project chat 7/);
  assert.doesNotMatch(html, /Project chat 6/);
  assert.match(html, /Show more/);
  assert.doesNotMatch(html, /Hidden name|session-meta|HTTP|Recent/);
  assert.match(html, /data-sidebar-scroll="conversations"/);
  assert.equal((html.match(/data-sidebar-scroll=/g) ?? []).length, 1);
});

test("empty project selection and last chat removal never create an unrelated conversation", async () => {
  let created = 0;
  const state: any = { activeProjectId: "empty", activeSessionId: null, messages: ["old"], sessionSettings: {},
    bootstrap: { sessions: [{ id: "ordinary" }, { id: "elsewhere", projectId: "other" }] } };
  const context: any = { state, sessionLoadSequence: 0,
    api: { createSession: async () => { created++; return { id: "new" }; } },
    refreshBootstrap: async () => {}, loadActiveSession: async () => {} };
  vm.runInNewContext(appFunction("async function ensureSession()", "async function createChatInProject"), context);
  await context.ensureSession();
  assert.equal(created, 0);
  assert.equal(state.activeSessionId, null);
  assert.equal(state.sessionSettings, null);
  assert.deepEqual(Array.from(state.messages), []);
  state.activeProjectId = null;
  await context.ensureSession();
  assert.equal(state.activeSessionId, "ordinary");
  assert.equal(created, 0);
});

test("new project chats use explicit project identity and retain other chats' drafts", async () => {
  const state: any = { activeProjectId: "a", activeSessionId: "a-chat", drafts: { "a-chat": "unfinished draft" },
    bootstrap: { appSettings: { ui: { language: "uk" } } } };
  let payload: any;
  const context: any = { state,
    readSessionSetupSnapshot: () => null, sessionSettingsToPatch: (value: unknown) => value,
    persistActiveSessionSetup: async () => {}, refreshBootstrap: async () => {}, loadActiveSession: async () => {},
    window: { location: { hash: "" } }, projectsUi: { revealSession: (projectId: string) => { assert.equal(projectId, "b"); } },
    api: { createSession: async (title: string, projectId: string) => { payload = { title, projectId }; return { id: "b-chat", projectId }; } }
  };
  vm.runInNewContext(appFunction("async function createChatInProject", "function currentProject"), context);
  await context.createChatInProject("b");
  assert.equal(payload.projectId, "b");
  assert.equal(state.activeProjectId, "b");
  assert.equal(state.activeSessionId, "b-chat");
  assert.equal(state.drafts["a-chat"], "unfinished draft");
});

test("task and schedule creation submit workspace choices without the selected chat", async () => {
  const callbacks: Record<string, (event: unknown) => Promise<void>> = {};
  const makeForm = (id: string) => ({ addEventListener: (_: string, handler: (event: unknown) => Promise<void>) => { callbacks[id] = handler; }, reset() {} });
  const forms: Record<string, unknown> = { "#task-form": makeForm("task"), "#schedule-form": makeForm("schedule") };
  const values = new Map<string, string>(Object.entries({ title: "Task", description: "Work here", workflowId: "wf", projectId: "project-b", accessMode: "ask", priority: "normal", time: "09:00", timezone: "Europe/Kyiv", frequency: "daily" }));
  const sent: any[] = [];
  const state: any = { activeSessionId: "unrelated-chat", loading: false, attachmentImports: {}, taskDraftAttachments: [] };
  const context: any = { state,
    document: { querySelector: (selector: string) => forms[selector] ?? null },
    FormData: class { get(name: string) { return values.get(name); } },
    api: { createTask: async (payload: unknown) => sent.push(payload), createSchedule: async (payload: unknown) => sent.push(payload) },
    runAction: (action: () => unknown) => action(), refreshBootstrap: async () => {}, pushToast() {}
  };
  const start = appSource.indexOf('  document.querySelector("#task-form")?.addEventListener("submit"');
  const end = appSource.indexOf('  document.querySelector("[data-action=\'refresh-orchestration\']")', start);
  vm.runInNewContext(appSource.slice(start, end), context);
  await callbacks.task({ preventDefault() {}, currentTarget: forms["#task-form"] });
  await callbacks.schedule({ preventDefault() {}, currentTarget: forms["#schedule-form"] });
  for (const payload of sent) {
    assert.equal(payload.projectId, "project-b");
    assert.equal(payload.accessMode, "ask");
    assert.equal(Object.hasOwn(payload, "sessionId"), false);
  }
  values.set("projectId", "");
  await callbacks.task({ preventDefault() {} });
  assert.equal(sent[2].projectId, null);
});

test("Agent steps uses the workflow-scoped endpoint and renders the stored turn transcript as text", async () => {
  let toggle!: () => Promise<void>;
  const output = { textContent: "" };
  const state: any = { workflowAgentTraces: {} };
  const disclosure = { open: true, dataset: { runId: "run/1", agentTrace: "workflow-run/1:agent-node" },
    querySelector: () => output, addEventListener: (_: string, handler: () => Promise<void>) => { toggle = handler; } };
  const requested: string[] = [];
  // The endpoint returns AgentRunStore's AgentRun directly, with ordered tool/result turns.
  const trace = { id: "workflow-run/1:agent-node:agent:main", status: "completed", turns: [
    { type: "tool", content: '{"tool":"file.read","arguments":{"path":"README.md"}}' },
    { type: "result", content: '{"output":"<script>project content</script>"}' }
  ] };
  const context: any = { state,
    document: { querySelectorAll: (selector: string) => selector === "[data-agent-trace]" ? [disclosure] : [] },
    request: async (url: string) => { requested.push(url); return trace; }
  };
  vm.runInNewContext(appSource.slice(appSource.indexOf("function bindWorkflowReviewActions()")), context);
  context.bindWorkflowReviewActions();
  await toggle();
  assert.deepEqual(requested, ["/workflow-runs/run%2F1/agent-runs/workflow-run%2F1%3Aagent-node"]);
  assert.match(output.textContent, /^1\. tool\n/);
  assert.match(output.textContent, /2\. result\n/);
  assert.match(output.textContent, /<script>project content<\/script>/);
  assert.equal(state.workflowAgentTraces[disclosure.dataset.agentTrace], output.textContent);
  assert.equal(Object.hasOwn(output, "innerHTML"), false);
  context.request = async () => { throw new Error("No agent steps have been recorded yet."); };
  await toggle();
  assert.equal(output.textContent, "No agent steps have been recorded yet.");
});

test("creating a project from Task or Schedule selects it without leaving the form or losing its draft", async () => {
  for (const kind of ["task", "schedule"]) {
    const draft = { title: "Keep this task", description: "Read the docs", workflowId: "my-workflow", accessMode: "ask" };
    const original = { ...draft };
    const selected = { value: "", innerHTML: "", dispatchEvent: (_event: Event) => { changes++; } };
    const created = { id: `created-${kind}`, name: "New workspace", rootPath: "/workspace" };
    const state = { route: "orchestration", bootstrap: { projects: [] as typeof created[] } };
    let submit!: (event: { preventDefault: () => void }) => void;
    let closed!: () => void;
    const completion = new Promise<void>(resolve => { closed = resolve; });
    let changes = 0;
    let selectedChatProject = false;
    let renders = 0;
    const listeners: Record<string, () => void> = {};
    const dialogForm = { dataset: {}, elements: { name: { value: "New workspace" }, rootPath: { value: "/workspace" } },
      querySelectorAll: () => [], addEventListener: (_name: string, callback: typeof submit) => { submit = callback; } };
    const dialog = { className: "", innerHTML: "", setAttribute() {}, remove() {}, showModal() {},
      addEventListener: (name: string, callback: () => void) => { listeners[name] = callback; },
      close: () => { listeners.close(); closed(); },
      querySelector: (selector: string) => selector === "form" ? dialogForm : selector === "[data-project-close]" ? { addEventListener() {} } : null
    };
    const stored = new Map<string, string>([["lcai.sidebar.collapsedSections.v1", '["projects","chats"]']]);
    const context: any = { icon: () => "", window: {}, Event, state,
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
      document: { activeElement: null, body: { append() {} }, createElement: () => dialog,
        getElementById: (id: string) => id === `${kind}-project` ? selected : null }
    };
    vm.runInNewContext(projectsSource + appFunction("function selectCreatedWorkspaceProject", "function renderTaskCard"), context);
    const ui = context.createProjectsUi({
      createProject: async (payload: any) => { assert.equal(payload.rootPath, "/workspace"); return created; },
      refresh: async () => { state.bootstrap.projects = [created]; },
      selectProject: () => { selectedChatProject = true; },
      render: () => { renders++; assert.equal(selected.value, created.id); assert.deepEqual(draft, original); }
    });
    ui.openCreateProject((project: typeof created) => context.selectCreatedWorkspaceProject(`${kind}-project`, project));
    submit({ preventDefault() {} });
    await completion;
    assert.equal(selected.value, created.id);
    assert.match(selected.innerHTML, new RegExp(`value="${created.id}" selected`));
    assert.equal(changes, 1);
    assert.equal(renders, 1);
    assert.equal(selectedChatProject, false);
    assert.deepEqual(JSON.parse(stored.get("lcai.sidebar.collapsedSections.v1")!), ["chats"]);
    assert.equal(state.route, "orchestration");
    assert.deepEqual(draft, original);
  }
});

test("Projects and Chats collapse independently, persist across reload, and expand for newly created chats", () => {
  const stored = new Map<string, string>();
  const callbacks: Record<string, () => void> = {};
  const button = (section: string) => ({ dataset: { sidebarSection: section },
    addEventListener: (_: string, handler: () => void) => { callbacks[section] = handler; } });
  const folderButton = { dataset: { projectId: "p" }, addEventListener: (_: string, handler: () => void) => { callbacks.folder = handler; } };
  const state = { bootstrap: { projects: [{ id: "p", name: "Project", rootPath: "/p" }],
    sessions: [{ id: "p-chat", projectId: "p", title: "Project conversation" }, { id: "plain", title: "Ordinary conversation" }] } };
  let renders = 0;
  const context: any = { icon: (name: string) => `<svg data-icon="${name}"></svg>`,
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    document: { querySelector: () => null, querySelectorAll: (selector: string) => selector === "[data-action='toggle-sidebar-section']" ? [button("projects"), button("chats")] : selector === "[data-action='toggle-project']" ? [folderButton] : [] }
  };
  vm.runInNewContext(projectsSource, context);
  const options = { getState: () => state, render: () => { renders++; } };
  const ui = context.createProjectsUi(options);
  ui.bind();
  callbacks.folder();
  callbacks.projects();
  let html = ui.sidebar();
  assert.match(html, /data-sidebar-section="projects" aria-expanded="false" aria-controls="sidebar-projects-content"/);
  assert.match(html, /id="sidebar-projects-content" class="project-list" hidden/);
  assert.match(html, /data-sidebar-section="chats" aria-expanded="true"/);
  assert.match(html, /data-action="new-project" aria-label="Add project"/);
  assert.match(html, /data-action="new-session" data-project-id=""/);
  assert.deepEqual(JSON.parse(stored.get("lcai.sidebar.collapsedSections.v1")!), ["projects"]);
  callbacks.projects();
  html = ui.sidebar();
  assert.doesNotMatch(html, /Project conversation/); // Section expansion retains the individual folder's collapsed state.
  callbacks.projects();
  callbacks.chats();
  const reloaded = context.createProjectsUi(options);
  html = reloaded.sidebar();
  assert.match(html, /data-sidebar-section="projects" aria-expanded="false"/);
  assert.match(html, /data-sidebar-section="chats" aria-expanded="false"/);
  reloaded.revealSession("p");
  assert.match(reloaded.sidebar(), /data-sidebar-section="projects" aria-expanded="true"/);
  assert.match(reloaded.sidebar(), /data-sidebar-section="chats" aria-expanded="false"/);
  reloaded.revealSession(null);
  assert.match(reloaded.sidebar(), /data-sidebar-section="chats" aria-expanded="true"/);
  assert.deepEqual(JSON.parse(stored.get("lcai.sidebar.collapsedSections.v1")!), []);
  assert.equal(renders, 5);
});

test("sidebar sections use content height and one bounded scroller on desktop and mobile", () => {
  const css = fs.readFileSync("public/assets/projects.css", "utf8");
  const sections = css.match(/\.sidebar-conversations \.sidebar-section \{([^}]+)\}/)?.[1] ?? "";
  assert.match(sections, /flex: 0 0 auto/);
  assert.match(sections, /min-height: 0/);
  assert.match(css, /\.sidebar-section \+ \.sidebar-section \{[^}]*border-top: 1px solid var\(--line\)/);
  const lists = css.match(/\.sidebar-conversations \.session-list, \.project-list \{([^}]+)\}/)?.[1] ?? "";
  assert.match(lists, /overflow: visible/);
  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(mobile, /height: auto; max-height: min\(580px, 75dvh\)/);
});

test("mobile sidebar disclosure renders preserve its current open state and restore keyboard focus", () => {
  const classes = new Set<string>(["mobile-sessions-open"]);
  let ariaExpanded = "false";
  let focused = "";
  let activeElement = { id: "sidebar-toggle-projects", closest: () => null };
  const context: any = {
    document: {
      get activeElement() { return activeElement; }, querySelectorAll: () => [],
      querySelector: (selector: string) => selector === ".shell" ? { classList: {
        contains: (value: string) => classes.has(value),
        toggle: (value: string, force: boolean) => { if (force) classes.add(value); else classes.delete(value); }
      } } : selector === "[data-action='toggle-mobile-sessions']" ? { setAttribute: (_name: string, value: string) => { ariaExpanded = value; } } : null,
      getElementById: (id: string) => ({ getClientRects: () => classes.has("mobile-sessions-open") ? [{}] : [], focus: () => { focused = id; } })
    }
  };
  vm.runInNewContext(appFunction("function capturePresentationState", "function getSaveButtonLabel"), context);
  for (const id of ["sidebar-toggle-projects", "sidebar-project-folder-p", "sidebar-project-more-p"]) {
    activeElement = { id, closest: () => null };
    const snapshot = context.capturePresentationState();
    classes.clear(); // Replacing the shell removes its DOM-only class.
    context.restorePresentationState(snapshot);
    assert.equal(classes.has("mobile-sessions-open"), true);
    assert.equal(ariaExpanded, "true");
    assert.equal(focused, id);
  }
  classes.clear();
  const closed = context.capturePresentationState();
  context.restorePresentationState(closed);
  assert.equal(classes.has("mobile-sessions-open"), false);
  assert.equal(ariaExpanded, "false");
});

test("folder and Show more controls retain stable IDs after their own rerenders", () => {
  const handlers: Record<string, () => void> = {};
  const button = (action: string) => ({ dataset: { projectId: "p" }, addEventListener: (_: string, callback: () => void) => { handlers[action] = callback; } });
  const context: any = { icon: () => "", document: {
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === "[data-action='toggle-project']" ? [button("folder")] : selector === "[data-action='more-project-chats']" ? [button("more")] : []
  } };
  vm.runInNewContext(projectsSource, context);
  const ui = context.createProjectsUi({ getState: () => ({ bootstrap: { projects: [{ id: "p", name: "Project" }],
    sessions: Array.from({ length: 8 }, (_, index) => ({ id: `c-${index}`, projectId: "p", title: `Chat ${index}` })) } }), render() {} });
  ui.bind();
  assert.match(ui.sidebar(), /id="sidebar-project-folder-p"/);
  handlers.folder();
  assert.match(ui.sidebar(), /id="sidebar-project-folder-p"/);
  handlers.folder();
  assert.match(ui.sidebar(), /id="sidebar-project-more-p"[^>]*>Show more/);
  handlers.more();
  assert.match(ui.sidebar(), /id="sidebar-project-more-p"[^>]*>Show less/);
  assert.match(ui.sidebar(), /Chat 7/);
  handlers.more();
  assert.match(ui.sidebar(), /id="sidebar-project-more-p"[^>]*>Show more/);
  assert.doesNotMatch(ui.sidebar(), /Chat 7/);
});
