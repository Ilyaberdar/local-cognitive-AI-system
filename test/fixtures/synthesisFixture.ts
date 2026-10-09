import type { LLMRequest, LLMResponse, ManagedModel } from "../../src/types";

// Test-only output from a deterministic mock provider. The product template never
// includes a prewritten candidate: real local models generate the actual demo.
export const workingFiles: Record<string, string> = {
  "calculator.js": `function calculate(a,b,operation) {
    if(operation === '+') return a+b;
    if(operation === '-') return a-b;
    if(operation === '*') return a*b;
    if(operation === '/') { if(b === 0) throw new Error('Cannot divide by zero'); return a/b; }
    throw new Error('Unknown operation');
  }
  document.getElementById('calculate').addEventListener('click', function() {
    const result = document.getElementById('result');
    try { result.textContent = String(calculate(Number(document.getElementById('a').value), Number(document.getElementById('b').value), document.getElementById('operation').value)); }
    catch(error) { result.textContent = error.message; }
  });
  document.getElementById('clear').onclick = function() {
    document.getElementById('a').value = '';
    document.getElementById('b').value = '';
    document.getElementById('result').textContent = '';
  };`,
  "style.css": "body { color: #eee; background: #111; }",
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Calculator</title><link rel="stylesheet" href="style.css"></head><body><main>
    <label for="a">First number</label><input type="number" id="a">
    <label for="b">Second number</label><input type="number" id="b">
    <label for="operation">Operation</label><select id="operation"><option value="+">Add</option><option value="-">Subtract</option><option value="*">Multiply</option><option value="/">Divide</option></select>
    <button type="button" id="calculate">Calculate</button><button type="button" id="clear">Clear</button><output id="result" aria-live="polite"></output>
    </main><script src="calculator.js"></script></body></html>`
};
export const localModel = (id: string, sizeBytes: number): ManagedModel => ({
  id, displayName: id, sizeBytes, providerId: "llamacpp", providerName: "Local llama.cpp", loaded: false, loadedInstanceIds: []
});

/** A provider whose answers are the working calculator: it implements whichever file it is asked for. */
export const workingProvider = (calls: string[] = []) => {
  const fileOf = (request: LLMRequest) => /^Implement only the file (.+?)\. Other files:/.exec(request.prompt)?.[1];
  return {
    generateObject: async <T extends object>(request: LLMRequest, provider?: string): Promise<{ data: T | null; response: LLMResponse }> => {
      const file = fileOf(request)!; calls.push(file);
      return { data: { content: workingFiles[file] } as unknown as T, response: { provider: provider ?? "llamacpp", model: request.model ?? "", text: "", usage: { inputTokens: 5, outputTokens: 5 } } };
    },
    generateText: async (request: LLMRequest, provider?: string): Promise<LLMResponse> => {
      const file = fileOf(request);
      if (file) calls.push(file);
      return { provider: provider ?? "llamacpp", model: request.model ?? "", text: file ? workingFiles[file]! : "Advisory notes only.", usage: { inputTokens: 5, outputTokens: 5 } };
    }
  };
};
