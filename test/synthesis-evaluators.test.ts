import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCalculator, evaluatorVersion, supportedEvaluators } from "../src/synthesis/evaluators";

const calculate = `function calculate(a,b,operation) {
  if(operation === '+') return a+b;
  if(operation === '-') return a-b;
  if(operation === '*') return a*b;
  if(operation === '/') { if(b === 0) throw new Error('Cannot divide by zero'); return a/b; }
  throw new Error('Unknown operation');
}`;
const wiring = `document.getElementById('calculate').addEventListener('click', function () {
  const result = document.getElementById('result');
  try { result.textContent = String(calculate(Number(document.getElementById('a').value), Number(document.getElementById('b').value), document.getElementById('operation').value)); }
  catch(error) { result.textContent = error.message; }
});
document.getElementById('clear').onclick = function () {
  document.getElementById('a').value = '';
  document.getElementById('b').value = '';
  document.getElementById('result').textContent = '';
};`;
const fixture = (): Record<string, string> => ({
  "calculator.js": calculate + "\n" + wiring,
  "style.css": "body { color: #eee; background: #111; }",
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Calculator</title><link rel="stylesheet" href="style.css"></head><body><main>
    <label for="a">First number</label><input type="number" id="a">
    <label for="b">Second number</label><input type="number" id="b">
    <label for="operation">Operation</label><select id="operation"><option value="+">Add</option><option value="-">Subtract</option><option value="*">Multiply</option><option value="/">Divide</option></select>
    <button type="button" id="calculate">Calculate</button><button type="button" id="clear">Clear</button><output id="result" aria-live="polite"></output>
    </main><script src="calculator.js"></script></body></html>`
});

test("trusted calculator evaluator passes arithmetic and semantic DOM interactions", async () => {
  assert.equal(evaluatorVersion, "calculator-v1.1");
  for (const evaluator of supportedEvaluators) {
    const result = await evaluateCalculator(fixture(), evaluator);
    assert.equal(result.status, "Pass", result.message);
  }
});

test("calculator evaluator rejects wrong arithmetic independently of UI wiring", async () => {
  const files = fixture(); files["calculator.js"] = calculate.replace("return a+b", "return a-b");
  const result = await evaluateCalculator(files, "calculator-arithmetic-v1");
  assert.equal(result.status, "Fail"); assert.match(result.message, /Arithmetic/);
});

test("arithmetic reports division-by-zero errors even when HTML/CSS is broken or absent", async () => {
  const wrong = calculate.replace("throw new Error('Cannot divide by zero')", "return 0") + "\n" + wiring;
  const candidates: Array<Record<string, string>> = [
    { "calculator.js": wrong },
    { "calculator.js": wrong, "index.html": '<script src="style.css"></script>', "style.css": '@import "https://example.com/style.css";' }
  ];
  for (const files of candidates) {
    const result = await evaluateCalculator(files, "calculator-arithmetic-v1");
    assert.equal(result.status, "Fail"); assert.match(result.message, /Division by zero must throw Error/);
    assert.equal((await evaluateCalculator(files, "calculator-ui-v1")).status, "Fail");
  }
});

test("arithmetic can pass alone with missing or invalid HTML while UI remains failed", async () => {
  const candidates: Array<Record<string, string>> = [
    { "calculator.js": calculate + "\n" + wiring },
    { "calculator.js": calculate + "\n" + wiring, "index.html": '<script src="style.css"></script>', "style.css": "" }
  ];
  for (const files of candidates) {
    const result = await evaluateCalculator(files, "calculator-arithmetic-v1");
    assert.equal(result.status, "Pass", result.message);
    assert.equal((await evaluateCalculator(files, "calculator-ui-v1")).status, "Fail");
  }
});

test("correct arithmetic alone cannot pass the calculator UI evaluator", async () => {
  const files = fixture(); files["calculator.js"] = calculate;
  assert.equal((await evaluateCalculator(files, "calculator-arithmetic-v1")).status, "Pass");
  const result = await evaluateCalculator(files, "calculator-ui-v1");
  assert.equal(result.status, "Fail"); assert.match(result.message, /button/);
});

test("calculator UI accepts inline setup and DOMContentLoaded wiring", async () => {
  const files = fixture(); files["calculator.js"] = calculate;
  files["index.html"] = files["index.html"].replace("</body>", `<script>document.addEventListener('DOMContentLoaded', function(){${wiring}});</script></body>`);
  const result = await evaluateCalculator(files, "calculator-ui-v1");
  assert.equal(result.status, "Pass", result.message);
});

test("calculator UI rejects synchronous head scripts that bind controls before browser parsing", async () => {
  const files = fixture();
  files["index.html"] = files["index.html"].replace('<script src="calculator.js"></script>', '')
    .replace('</head>', '<script src="calculator.js"></script></head>');
  const result = await evaluateCalculator(files, "calculator-ui-v1");
  assert.equal(result.status, "Fail"); assert.match(result.message, /after all required calculator controls/);
});

test("calculator UI rejects inline setup before all controls even when calculator.js is at body end", async () => {
  const files = fixture(); files["calculator.js"] = calculate;
  files["index.html"] = files["index.html"].replace('<body>', `<body><script>${wiring}</script>`);
  const result = await evaluateCalculator(files, "calculator-ui-v1");
  assert.equal(result.status, "Fail"); assert.match(result.message, /after all required calculator controls/);
});

test("calculator clear must empty values, not replace them with zero", async () => {
  for (const id of ["a", "b", "result"]) {
    const files = fixture();
    const property = id === "result" ? "textContent" : "value";
    files["calculator.js"] = files["calculator.js"].replace(`document.getElementById('${id}').${property} = '';`,
      `document.getElementById('${id}').${property} = '0';`);
    const result = await evaluateCalculator(files, "calculator-ui-v1");
    assert.equal(result.status, "Fail"); assert.match(result.message, /empty strings/);
  }
});

test("calculator evidence rejects missing labels, resources and duplicate ids", async () => {
  for (const mutate of [
    (files: Record<string, string>) => { files["index.html"] = files["index.html"].replace('<label for="a">First number</label>', ''); },
    (files: Record<string, string>) => { files["index.html"] += '<script src="https://example.com/code.js"></script>'; },
    (files: Record<string, string>) => { files["index.html"] += '<input id="a">'; },
    (files: Record<string, string>) => { files["style.css"] = '@im\\70ort "https://example.com/x.css";'; },
    (files: Record<string, string>) => { files["index.html"] = files["index.html"].replace('id="calculate"', 'id="calculate" onclick="evil()"'); }
  ]) {
    const files = fixture(); mutate(files);
    assert.equal((await evaluateCalculator(files, "calculator-ui-v1")).status, "Fail");
  }
});

test("calculator code cannot obtain Node or host networking globals or string compilation", async () => {
  const files = fixture();
  files["calculator.js"] = `if(typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined' || typeof XMLHttpRequest !== 'undefined') throw new Error('host escape');
    if(typeof Function !== 'undefined' || typeof eval !== 'undefined' || (function(){}).constructor !== undefined || (async function(){}).constructor !== undefined) throw new Error('dynamic evaluation available');\n` + files["calculator.js"];
  const result = await evaluateCalculator(files, "calculator-arithmetic-v1");
  assert.equal(result.status, "Pass", result.message);
});

test("calculator candidate cannot fake arithmetic acceptance by replacing finite/abs", async () => {
  const files = fixture(); files["calculator.js"] = "Number.isFinite = () => true; Math.abs = () => 0; function calculate(){return NaN;}";
  assert.equal((await evaluateCalculator(files, "calculator-arithmetic-v1")).status, "Fail");
});

test("calculator clear cannot pass by replacing array membership checks", async () => {
  const files = fixture();
  files["calculator.js"] += "Array.prototype.includes = function(){return true;}; document.getElementById('clear').onclick = function(){};";
  const result = await evaluateCalculator(files, "calculator-ui-v1");
  assert.equal(result.status, "Fail"); assert.match(result.message, /Clear/);
});

test("calculator UI observer cannot be replaced with a candidate result getter", async () => {
  const files = fixture();
  files["calculator.js"] = calculate + "Object.defineProperty(document.getElementById('result'), 'textContent', {get:function(){return '19';}});";
  assert.equal((await evaluateCalculator(files, "calculator-ui-v1")).status, "Fail");
});

test("calculator loop is interrupted by the isolated execution budget", async () => {
  const files = fixture(); files["calculator.js"] = "while(true) {}";
  const started = Date.now();
  const result = await evaluateCalculator(files, "calculator-arithmetic-v1");
  assert.equal(result.status, "Fail"); assert.match(result.message, /execution budget/);
  assert.ok(Date.now() - started < 5000, "An infinite loop must not stall the application");
});

test("calculator evaluator bounds input and distinguishes unsupported evaluators", async () => {
  assert.equal((await evaluateCalculator(fixture(), "unknown-evaluator")).status, "Unknown");
  const files = fixture(); files["calculator.js"] = " ".repeat(128 * 1024 + 1);
  assert.equal((await evaluateCalculator(files, "calculator-arithmetic-v1")).status, "Fail");
});
