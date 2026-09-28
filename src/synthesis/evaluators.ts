import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

export const evaluatorVersion = "calculator-v1.1";
export const supportedEvaluators = new Set(["calculator-arithmetic-v1", "calculator-ui-v1"]);
export interface CalculatorEvaluation { status: "Pass" | "Fail" | "Unknown"; message: string }

const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_ELEMENTS = 400;
const EXECUTION_MS = 350;
type Element = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.Node;
interface ElementDescription { tag: string; attributes: Record<string, string>; text: string; value: string }
interface ParsedPage { elements: ElementDescription[]; scripts: string[]; nodes: Element[] }
class CandidateError extends Error {}

/** The arithmetic contract must keep reporting code failures while HTML is
 * incomplete. These inert controls only accommodate top-level event binding;
 * they contain no generated implementation or expected arithmetic answers.
 */
function arithmeticPage(files: Record<string, string>): ParsedPage {
  const source = files["calculator.js"];
  if (typeof source !== "string") throw new CandidateError("Missing required artifact: calculator.js.");
  if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new CandidateError("calculator.js exceeds the 128 KiB evaluator limit.");
  const controls: Array<[string, string, string]> = [
    ["body", "", ""], ["input", "a", ""], ["input", "b", ""],
    ["select", "operation", "+"], ["button", "calculate", ""],
    ["button", "clear", ""], ["output", "result", ""]
  ];
  return { nodes: [], scripts: [source], elements: controls.map(([tag, id, value]): ElementDescription => ({
    tag, attributes: id ? { id } : {}, value, text: ""
  })) };
}

/** The parser never executes candidate code or fetches resources. */
function readPage(files: Record<string, string>): ParsedPage {
  const names = ["index.html", "calculator.js", "style.css"];
  if (Object.keys(files).some(name => !names.includes(name))) throw new CandidateError("The calculator adapter permits only index.html, calculator.js and style.css.");
  let total = 0;
  for (const name of names) {
    if (typeof files[name] !== "string") throw new CandidateError(`Missing required artifact: ${name}.`);
    const bytes = Buffer.byteLength(files[name]);
    total += bytes;
    if (bytes > MAX_FILE_BYTES) throw new CandidateError(`${name} exceeds the 128 KiB evaluator limit.`);
  }
  if (total > MAX_TOTAL_BYTES) throw new CandidateError("Candidate exceeds the 256 KiB evaluator limit.");
  checkCss(files["style.css"]);
  const tree = parse(files["index.html"], { sourceCodeLocationInfo: true });
  const nodes: Element[] = [];
  const pending: HtmlNode[] = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) {
      nodes.push(node);
      if (nodes.length > MAX_ELEMENTS) throw new CandidateError("HTML exceeds the 400 element evaluator limit.");
    }
    if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
  }
  const scripts: string[] = [];
  const ids = new Set<string>();
  let calculatorScripts = 0;
  for (const node of nodes) {
    const attrs = attributes(node);
    if (["iframe", "frame", "object", "embed", "base", "template", "svg", "math", "noscript"].includes(node.tagName)) {
      throw new CandidateError(`Unsupported active or embedded HTML element: ${node.tagName}.`);
    }
    if (attrs.id) {
      if (ids.has(attrs.id)) throw new CandidateError(`Duplicate HTML id: ${attrs.id}.`);
      ids.add(attrs.id);
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith("on")) throw new CandidateError("Inline event attributes are unsupported; use addEventListener or onclick in calculator.js.");
      if (["srcset", "poster", "action", "formaction", "background", "data", "srcdoc", "ping", "manifest", "xlink:href"].includes(name)) {
        throw new CandidateError(`External/embedded resource attribute ${name} is not supported.`);
      }
      if (name === "src" && !(node.tagName === "script" && ["calculator.js", "./calculator.js"].includes(value))) {
        throw new CandidateError("Only the local calculator.js script resource is permitted.");
      }
      if (name === "href" && !(node.tagName === "link" && attrs.rel === "stylesheet" && ["style.css", "./style.css"].includes(value))) {
        throw new CandidateError("Only the local style.css stylesheet resource is permitted.");
      }
      if (name === "style") checkCss(value);
    }
    if (node.tagName === "meta" && attrs["http-equiv"]) throw new CandidateError("HTTP-equiv metadata is not supported.");
    if (node.tagName === "style") checkCss(textOf(node));
    if (node.tagName === "script") {
      if (attrs.type && !["text/javascript", "application/javascript"].includes(attrs.type)) throw new CandidateError("Only classic JavaScript scripts are supported.");
      if ("async" in attrs || "defer" in attrs) throw new CandidateError("Use a synchronous calculator.js script at the end of body for this adapter.");
      if (attrs.src) { calculatorScripts++; scripts.push(files["calculator.js"]); }
      else if (textOf(node).trim()) scripts.push(textOf(node));
      if (scripts.length > 5) throw new CandidateError("The calculator adapter permits at most five script elements.");
    }
  }
  if (calculatorScripts !== 1) throw new CandidateError("index.html must include calculator.js exactly once.");
  return { nodes, scripts, elements: nodes.map(node => {
    const attrs = attributes(node);
    const options = node.childNodes.filter((child): child is Element => "tagName" in child && child.tagName === "option");
    const selected = options.find(option => "selected" in attributes(option)) ?? options[0];
    return { tag: node.tagName, attributes: attrs, text: ["script", "style", "html", "head", "body"].includes(node.tagName) ? "" : textOf(node).slice(0, 4096),
      value: attrs.value ?? (selected ? attributes(selected).value ?? textOf(selected) : "") };
  }) };
}

function attributes(node: Element): Record<string, string> {
  return Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
}
function textOf(node: HtmlNode): string {
  // Iterative traversal also bounds stack use for deeply nested candidate markup.
  let result = "";
  const pending: HtmlNode[] = [node];
  while (pending.length) {
    const item = pending.pop()!;
    if ("value" in item) result += item.value;
    if ("childNodes" in item) for (let i = item.childNodes.length - 1; i >= 0; i--) pending.push(item.childNodes[i]);
  }
  return result;
}
function checkCss(source: string): void {
  const normalized = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\([0-9a-f]{1,6})\s?/gi,
    (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff))).replace(/\\([^\r\n])/g, "$1");
  if (/url\s*\(|@import\b|expression\s*\(|-moz-binding\s*:/i.test(normalized)) throw new CandidateError("CSS network resources and executable expressions are not permitted.");
}

function validateControls(page: ParsedPage): void {
  const byId = new Map(page.nodes.map(node => [attributes(node).id, node]));
  const requireControl = (id: string, tag: string) => {
    const node = byId.get(id);
    if (!node || node.tagName !== tag) throw new CandidateError(`UI requires ${tag}#${id}.`);
    const attrs = attributes(node);
    if ("disabled" in attrs || "hidden" in attrs || attrs["aria-hidden"] === "true") throw new CandidateError(`#${id} must be available to users.`);
    const label = attrs["aria-label"]?.trim() || attrs["aria-labelledby"]?.split(/\s+/).map(key => byId.get(key)).filter(Boolean).map(item => textOf(item!)).join(" ").trim()
      || page.nodes.find(item => item.tagName === "label" && attributes(item).for === id && textOf(item).trim())
      || (node.parentNode && "tagName" in node.parentNode && node.parentNode.tagName === "label" && textOf(node.parentNode).trim())
      || (tag === "button" && textOf(node).trim());
    if (tag !== "output" && !label) throw new CandidateError(`#${id} needs a visible label or accessible name.`);
    return node;
  };
  for (const id of ["a", "b"]) {
    if (attributes(requireControl(id, "input")).type !== "number") throw new CandidateError(`#${id} must be a number input.`);
  }
  const operation = requireControl("operation", "select");
  const values = operation.childNodes.filter((item): item is Element => "tagName" in item && item.tagName === "option")
    .map(item => attributes(item).value ?? textOf(item));
  if (!["+", "-", "*", "/"].every(value => values.includes(value))) throw new CandidateError("#operation must provide +, -, * and / options.");
  for (const id of ["calculate", "clear"]) requireControl(id, "button");
  requireControl("result", "output");
  // The semantic harness builds its DOM before running scripts. Restrict the
  // authored page to the same ordering so it cannot accept a head script whose
  // immediate event binding would fail against a not-yet-parsed browser DOM.
  const controlsEnd = Math.max(...["a", "b", "operation", "calculate", "clear", "result"]
    .map(id => byId.get(id)?.sourceCodeLocation?.endOffset ?? Infinity));
  for (const script of page.nodes.filter(node => node.tagName === "script")) {
    let parent = script.parentNode;
    while (parent && "tagName" in parent && parent.tagName !== "body") parent = parent.parentNode;
    if (!parent || !("tagName" in parent) || parent.tagName !== "body" ||
      (script.sourceCodeLocation?.startOffset ?? -1) < controlsEnd) {
      throw new CandidateError("Place calculator.js and every inline setup script at the end of body, after all required calculator controls.");
    }
  }
}

/** Pure guest JavaScript: no Node callbacks or object references enter this VM.
 * The returned observer stays in a host-held QuickJS handle, outside candidate globals.
 * Private element state and captured intrinsics prevent candidate getters/prototype edits
 * from manufacturing the values observed by the trusted checks.
 */
function harnessSource(elements: ElementDescription[]): string {
  return `(function () {
    "use strict";
    const string = String, number = Number, finite = Number.isFinite, abs = Math.abs;
    const trim = Function.prototype.call.bind(String.prototype.trim);
    const define = Object.defineProperty, create = Object.create, freeze = Object.freeze;
    const GuestError = Error;
    const descriptions = ${JSON.stringify(elements)};
    const states = [], nodes = [], ids = create(null), ready = [], loaded = [];
    function fail(message) { throw new GuestError(message); }
    function close(actual, expected) { return typeof actual === "number" && finite(actual) && abs(actual - expected) <= 1e-9 * (1 + abs(expected)); }
    function event(type, target) { return { type: type, target: target, currentTarget: target, preventDefault: function(){}, stopPropagation: function(){} }; }
    for (let i = 0; i < descriptions.length; i++) {
      const d = descriptions[i], state = { value: d.value, text: d.text, onclick: null, handlers: create(null) }, node = create(null);
      states[i] = state; nodes[i] = node;
      if (d.attributes.id) ids[d.attributes.id] = i;
      define(node, "id", {value:d.attributes.id || "", enumerable:true});
      define(node, "tagName", {value:d.tag.toUpperCase(), enumerable:true});
      define(node, "value", {get:function(){return d.tag === "output" ? state.text : state.value;},set:function(v){state.value=string(v);if(d.tag === "output") state.text=state.value;},enumerable:true});
      define(node, "valueAsNumber", {get:function(){return state.value === "" ? NaN : number(state.value);},set:function(v){state.value=string(v);}});
      for (const key of ["textContent", "innerText"]) define(node,key,{get:function(){return state.text;},set:function(v){state.text=string(v);if(d.tag === "output") state.value=state.text;},enumerable:true});
      define(node, "onclick", {get:function(){return state.onclick;},set:function(v){state.onclick=v;}});
      node.addEventListener = function(type, callback) { if(typeof callback !== "function") fail("Event handler must be a function"); (state.handlers[type] || (state.handlers[type]=[])).push(callback); };
      node.getAttribute = function(name) { return d.attributes[name] === undefined ? null : d.attributes[name]; };
      node.setAttribute = function(name,value) { if(name === "value") state.value=string(value); else d.attributes[name]=string(value); };
      node.click = function() { click(i); };
    }
    function click(i) {
      const s = states[i], node = nodes[i], e = event("click",node);
      if (typeof s.onclick === "function") s.onclick(e);
      const handlers = s.handlers.click || [];
      for (let j = 0; j < handlers.length; j++) handlers[j](e);
    }
    function byId(id) { const index = ids[id]; return index === undefined ? null : nodes[index]; }
    function query(selector) {
      if(selector[0] === "#") return byId(selector.slice(1));
      for (let i = 0; i < descriptions.length; i++) if(descriptions[i].tag === selector) return nodes[i];
      return null;
    }
    const document = {getElementById:byId,querySelector:query,readyState:"loading",addEventListener:function(type,cb){if(type === "DOMContentLoaded") ready.push(cb);}};
    document.body = query("body");
    globalThis.document = document;
    globalThis.window = globalThis;
    globalThis.addEventListener = function(type,cb){ if(type === "load") loaded.push(cb); if(type === "DOMContentLoaded") ready.push(cb); };
    globalThis.console = freeze({log:function(){},warn:function(){},error:function(){}});
    // Remove string compilation, including constructor paths via async/generator functions.
    for (const ctor of [Function, (async function(){}).constructor, (function*(){}).constructor, (async function*(){}).constructor]) {
      define(ctor.prototype,"constructor",{value:undefined,writable:false,configurable:false});
    }
    define(globalThis,"eval",{value:undefined,writable:false,configurable:false});
    define(globalThis,"Function",{value:undefined,writable:false,configurable:false});
    function arithmetic(calculate) {
      if(typeof calculate !== "function") fail("calculator.js must define global calculate(a, b, operation).");
      const examples = [[2,3,"+",5],[10,4,"-",6],[-3,4,"*",-12],[7,2,"/",3.5],[0.1,0.2,"+",0.3],[-1,-3,"-",2],[0,9,"*",0],[0,2,"/",0]];
      for(let i=0;i<examples.length;i++){ const e=examples[i]; if(!close(calculate(e[0],e[1],e[2]),e[3])) fail("Arithmetic example failed for " + e[0] + " " + e[2] + " " + e[1]); }
      for(let a=-7;a<=7;a++) for(let b=-5;b<=5;b++) {
        if(!close(calculate(a,b,"+"),a+b) || !close(calculate(a,b,"-"),a-b) || !close(calculate(a,b,"*"),a*b)) fail("Arithmetic property checks failed.");
        if(b !== 0 && !close(calculate(a,b,"/"),a/b)) fail("Division property checks failed.");
      }
      let threw = false;
      try { calculate(1,0,"/"); } catch(error) { threw = error instanceof GuestError; }
      if(!threw) fail("Division by zero must throw Error.");
      return "Passed 653 finite arithmetic/property checks and division-by-zero behavior.";
    }
    function ui() {
      document.readyState = "interactive";
      for(let i=0;i<ready.length;i++) ready[i](event("DOMContentLoaded",document));
      document.readyState = "complete";
      for(let i=0;i<loaded.length;i++) loaded[i](event("load",globalThis));
      const a=states[ids.a], b=states[ids.b], op=states[ids.operation], result=states[ids.result];
      const examples=[[12,7,"+",19],[12,7,"-",5],[-3,4,"*",-12],[7,2,"/",3.5],[0.1,0.2,"+",0.3],[0,5,"/",0]];
      for(let i=0;i<examples.length;i++) {
        const e=examples[i]; a.value=string(e[0]); b.value=string(e[1]); op.value=e[2]; result.text=""; result.value="";
        click(ids.calculate);
        const text=trim(result.text) || trim(result.value);
        if(!text || !close(number(text),e[3])) fail("Calculate button produced the wrong result for " + e[0] + " " + e[2] + " " + e[1] + ".");
      }
      a.value="1"; b.value="0"; op.value="/"; result.text=""; result.value="";
      click(ids.calculate);
      const errorText=trim(result.text) || trim(result.value);
      if(!errorText || finite(number(errorText)) || errorText === "Infinity" || errorText === "-Infinity" || errorText === "+Infinity" || errorText === "NaN") fail("Division by zero must display a readable error in #result.");
      a.value="13"; b.value="9"; result.text="117"; result.value="117";
      click(ids.clear);
      if(a.value !== "" || b.value !== "" || result.text !== "" || result.value !== "") fail("Clear button must reset both inputs and result to empty strings.");
      return "Passed accessible controls, six calculate interactions, division-by-zero and clear in the semantic DOM harness; full-browser layout/behavior is a separate check.";
    }
    return {arithmetic:arithmetic,ui:ui};
  })()`;
}

function evaluateCode(context: QuickJSContext, source: string, filename: string): QuickJSHandle {
  const result = context.evalCode(source, filename, { type: "global" });
  if (result.error) {
    try {
      const error = context.dump(result.error) as { message?: string } | null;
      throw new CandidateError(error?.message || "Candidate JavaScript failed.");
    } finally { result.error.dispose(); }
  }
  return result.value;
}

export async function evaluateCalculator(files: Record<string, string>, evaluatorId: string): Promise<CalculatorEvaluation> {
  if (!supportedEvaluators.has(evaluatorId)) return { status: "Unknown", message: `No trusted evaluator is registered for ${evaluatorId}.` };
  let page: ParsedPage;
  try {
    page = evaluatorId === "calculator-arithmetic-v1" ? arithmeticPage(files) : readPage(files);
    if (evaluatorId === "calculator-ui-v1") validateControls(page);
  } catch (error) { return { status: "Fail", message: error instanceof Error ? error.message : String(error) }; }
  let module: Awaited<ReturnType<typeof getQuickJS>>;
  try { module = await getQuickJS(); }
  catch { return { status: "Unknown", message: "The isolated QuickJS evaluator runtime could not be initialized." }; }
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + EXECUTION_MS;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  const handles: QuickJSHandle[] = [];
  try {
    const harness = evaluateCode(context, harnessSource(page.elements), "trusted-dom-harness.js"); handles.push(harness);
    // Arithmetic evaluates the public function independently of authored HTML/CSS.
    const scripts = page.scripts;
    for (let i = 0; i < scripts.length; i++) evaluateCode(context, scripts[i], `candidate-${i}.js`).dispose();
    const method = context.getProp(harness, evaluatorId === "calculator-arithmetic-v1" ? "arithmetic" : "ui"); handles.push(method);
    const calculate = evaluateCode(context, "typeof calculate === 'function' ? calculate : null", "resolve-api.js"); handles.push(calculate);
    const result = context.callFunction(method, context.undefined, calculate);
    if (result.error) {
      try {
        const error = context.dump(result.error) as { message?: string } | null;
        throw new CandidateError(error?.message || "Candidate failed trusted checks.");
      } finally { result.error.dispose(); }
    }
    const message = context.getString(result.value); result.value.dispose();
    return { status: "Pass", message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "Fail", message: Date.now() > deadline || /interrupted/.test(message) ? "Candidate exceeded the isolated evaluator execution budget (350 ms)." : message.slice(0, 1500) };
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].dispose();
    context.dispose(); runtime.dispose();
  }
}
