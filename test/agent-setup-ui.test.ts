import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const appSource = fs.readFileSync("public/assets/app.js", "utf8");
const functionSource = (start: string, end: string) => {
  const offset = appSource.indexOf(start);
  assert.notEqual(offset, -1);
  return appSource.slice(offset, appSource.indexOf(end, offset));
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("required hypothesis cards omit Delete while each advisor exposes its own identity", () => {
  const context: any = {
    getSelectableSessionModels: () => [], escapeAttr: String,
    option: (value: string) => `<option>${value}</option>`, renderSessionModelControl: () => ""
  };
  vm.runInNewContext(functionSource("function renderHypothesisAgentCard", "function sessionModelLabel"), context);
  ["support", "attack", "judge"].forEach((role, index) => {
    const html = context.renderHypothesisAgentCard({ id: role, name: role, role, providerId: "ollama" }, index, []);
    assert.doesNotMatch(html, /delete-hypothesis-agent/);
    assert.match(html, new RegExp(`name="hypothesisAgentRole:${index}" disabled`));
  });
  const html = context.renderHypothesisAgentCard({ id: "advisor-4", name: "Advisor", role: "advisor", providerId: "ollama" }, 4, []);
  assert.match(html, /data-action="delete-hypothesis-agent"/);
  assert.match(html, /data-hypothesis-agent-id="advisor-4"/);
  assert.match(html, /data-setup-agent-id="advisor-4"/);
});

const settings = () => ({
  mode: "general", language: "en", outputStyle: "compact", defaultAccessMode: "ask",
  defaultTarget: { providerId: "ollama", model: "main" },
  codeAgents: [{ id: "nova", name: "Nova", providerId: "ollama", model: "tiny", accessMode: "ask" }],
  hypothesisAgents: [
    { id: "support", name: "Support", role: "support", providerId: "ollama", model: "support-model" },
    { id: "attack", name: "Attack", role: "attack", providerId: "ollama", model: "attack-model" },
    { id: "judge", name: "Judge", role: "judge", providerId: "local" },
    { id: "advisor", name: "Advisor", role: "advisor", providerId: "ollama", model: "advisor-model" }
  ],
  debate: { enabled: false, profile: "general", support: { providerId: "ollama", model: "support-model" },
    attack: { providerId: "ollama", model: "attack-model" }, judge: { providerId: "local" } }
});
const snapshotHarness = (mode: string) => {
  const initial = settings();
  const isHypothesis = mode === "hypothesis";
  const cards = isHypothesis ? initial.hypothesisAgents.map((_, index) => ({ dataset: { hypothesisAgentIndex: String(index) } })) : [];
  const form = {
    querySelector: (selector: string) => selector === ".hypothesis-agents" ? (isHypothesis ? {} : null) : (!isHypothesis ? {} : null),
    querySelectorAll: (selector: string) => selector === ".code-agent-card" ? [] : cards
  };
  const context: any = {
    state: { sessionSettings: initial }, cloneSessionSettings: structuredClone,
    getCurrentSessionSummary: () => ({ title: "Test" }),
    document: { querySelector: () => form },
    FormData: class { get(key: string) {
      if (key === "mode") return mode;
      if (key === "debateEnabled") return isHypothesis ? "on" : "off";
      const match = key.match(/^hypothesisAgent(Provider|Model):(\d+)$/);
      const agent = match && initial.hypothesisAgents[Number(match[2])];
      return agent ? match[1] === "Provider" ? agent.providerId : agent.model : null;
    } },
    getDefaultModelForProvider: () => undefined, getProviderConfiguredModel: () => undefined, MAX_HYPOTHESIS_AGENTS: 8
  };
  vm.runInNewContext(functionSource("function readSessionSetupSnapshot", "async function persistActiveSessionSetup"), context);
  return { initial, result: context.readSessionSetupSnapshot().settings };
};

test("removing the last General or Code subagent preserves invisible hypothesis cards", () => {
  for (const mode of ["general", "code"]) {
    const { initial, result } = snapshotHarness(mode);
    assert.deepEqual(plain(result.codeAgents), []);
    assert.deepEqual(plain(result.subagents), []);
    assert.deepEqual(plain(result.hypothesisAgents), initial.hypothesisAgents);
    assert.deepEqual(plain(result.debate.support), initial.debate.support);
  }
});

test("editing Hypothesis preserves the invisible General and Code subagent list", () => {
  const { initial, result } = snapshotHarness("hypothesis");
  assert.deepEqual(plain(result.codeAgents), initial.codeAgents);
  assert.deepEqual(plain(result.subagents), initial.codeAgents);
  assert.deepEqual(plain(result.hypothesisAgents), initial.hypothesisAgents);
  assert.equal(result.debate.enabled, true);
});

const motionHarness = (reduced = false) => {
  const frames = new Map<number, (time: number) => void>();
  let frameId = 0;
  const document: any = { activeElement: null, querySelector: () => panel };
  const context: any = { document, window: { matchMedia: () => ({ matches: reduced }) },
    getComputedStyle: (element: any) => ({ paddingBottom: element.style.paddingBottom || "0px" }),
    requestAnimationFrame: (callback: (time: number) => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id)
  };
  const makePanel = (contentHeight: number, mode = "general") => {
    let top = 0;
    const events = new Map<string, () => void>();
    const element: any = {
      style: { paddingBottom: "" }, clientHeight: 300, isConnected: true, cards: [], events,
      get scrollHeight() { return contentHeight + (parseFloat(this.style.paddingBottom) || 0); },
      get scrollTop() { top = Math.max(0, Math.min(top, this.scrollHeight - 300)); return top; },
      set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - 300)); },
      closest: () => ({ dataset: { sessionId: "session-a", setupMode: mode } }),
      contains: (active: any) => Boolean(active && active.panel === element),
      querySelectorAll: () => element.cards,
      getBoundingClientRect: () => ({ top: 20, bottom: 320 }),
      addEventListener: (name: string, callback: () => void) => events.set(name, callback),
      removeEventListener: (name: string) => events.delete(name)
    };
    return element;
  };
  let panel = makePanel(1200);
  vm.runInNewContext(fs.readFileSync("public/assets/session-setup-motion.js", "utf8").replace("export function", "function"), context);
  const motion = context.createSessionSetupMotion();
  const tick = (time: number) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn(time)); };
  const replace = (height: number, mode = "general") => { panel.isConnected = false; panel = makePanel(height, mode); return panel; };
  const addCard = (id: string, offset: number, height = 150) => {
    const owner = panel;
    const card: any = { dataset: { setupAgentId: id }, animations: 0,
      animate: () => { card.animations++; }, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 20 + offset - owner.scrollTop, bottom: 20 + offset + height - owner.scrollTop, height })
    };
    owner.cards.push(card);
    return card;
  };
  return { motion, tick, replace, addCard, document, frames, get panel() { return panel; } };
};

test("an added card scrolls over multiple frames and finishes after an unrelated rerender", () => {
  const h = motionHarness();
  h.panel.scrollTop = 250;
  const before = h.motion.capture();
  h.replace(1600);
  const card = h.addCard("new", 1250);
  h.motion.restore(before, "new");
  assert.equal(h.panel.scrollTop, 250);
  assert.equal(card.animations, 1);
  h.tick(0); h.tick(100);
  assert.ok(h.panel.scrollTop > 250 && h.panel.scrollTop < 1112);
  const captured = h.motion.capture();
  assert.equal(captured.addedId, "new");
  const interruptedTop = captured.top;
  h.replace(1600);
  const replacement = h.addCard("new", 1250);
  h.motion.restore(captured);
  assert.equal(h.panel.scrollTop, interruptedTop);
  assert.equal(replacement.animations, 0);
  h.tick(200); h.tick(500);
  assert.equal(h.panel.scrollTop, 1112);
  assert.equal(h.frames.size, 0);
  assert.equal(h.motion.capture().addedId, undefined);
});

test("deleting the bottom card preserves the old viewport and gradually shrinks its scroll range", () => {
  const h = motionHarness();
  h.panel.scrollTop = 850;
  const before = h.motion.capture();
  h.replace(900);
  h.motion.restore(before);
  assert.equal(h.panel.scrollTop, 850);
  h.tick(0); h.tick(100);
  assert.ok(h.panel.scrollTop < 850 && h.panel.scrollTop > 600);
  h.tick(300);
  assert.equal(h.panel.scrollTop, 600);
  assert.equal(h.panel.style.paddingBottom, "");
  assert.equal(h.panel.events.size, 0);
});

test("mode switches and manual interaction cancel pending added-card scrolling", () => {
  const h = motionHarness();
  h.panel.scrollTop = 250;
  let before = h.motion.capture();
  h.replace(1600); h.addCard("new", 1250);
  h.motion.restore(before, "new"); h.tick(0); h.tick(100);
  h.panel.events.get("wheel")?.();
  assert.equal(h.frames.size, 0);
  assert.equal(h.motion.capture().addedId, undefined);
  before = h.motion.capture();
  h.replace(1600, "hypothesis");
  h.motion.restore(before);
  assert.equal(h.panel.scrollTop, 0);
  assert.equal(h.frames.size, 0);
});

test("interrupting a deletion does not clamp the viewport or override the user's scroll", () => {
  const h = motionHarness();
  h.panel.scrollTop = 850;
  const before = h.motion.capture();
  h.replace(900);
  h.motion.restore(before); h.tick(0); h.tick(100);
  const currentTop = h.panel.scrollTop;
  h.panel.events.get("pointerdown")?.();
  assert.equal(h.panel.scrollTop, currentTop);
  assert.ok(h.frames.size > 0);
  h.tick(150);
  assert.ok(h.panel.scrollTop < currentTop && h.panel.scrollTop > 600);
  h.panel.events.get("wheel")?.();
  h.panel.scrollTop = 480;
  h.tick(200); h.tick(300);
  assert.equal(h.panel.scrollTop, 480);
  assert.equal(h.panel.style.paddingBottom, "");
  assert.equal(h.panel.events.size, 0);
});

test("reduced motion adjusts only as needed without animation or retained padding", () => {
  const h = motionHarness(true);
  h.panel.scrollTop = 850;
  const before = h.motion.capture();
  h.replace(900); const card = h.addCard("new", 700);
  h.motion.restore(before, "new");
  assert.equal(h.panel.scrollTop, 600);
  assert.equal(h.panel.style.paddingBottom, "");
  assert.equal(card.animations, 0);
  assert.equal(h.frames.size, 0);
});
