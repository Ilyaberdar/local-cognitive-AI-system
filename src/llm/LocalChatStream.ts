/** Consume OpenAI-compatible SSE without exposing reasoning or partial tool actions. */
export async function readLocalChatStream(response: Response, onText: (delta: string) => void, onNote?: (delta: string) => void): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Local runtime returned an empty response stream.");
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ""; let content = ""; let finish: string | null = null; let done = false;
  let usage: unknown; let timings: unknown;
  const consume = (event: string) => {
    const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(typeof chunk.error === "string" ? chunk.error : chunk.error.message || "Local stream failed.");
    if (chunk.usage) usage = chunk.usage;
    if (chunk.timings) timings = chunk.timings;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (choice?.delta?.refusal) throw new Error(`Model refused the request: ${choice.delta.refusal}`);
    const delta = choice?.delta?.content;
    const note = choice?.delta?.reasoning_content;
    if (typeof note === "string" && note) onNote?.(note);
    if (typeof delta === "string" && delta) { content += delta; onText(delta); }
  };
  try {
    while (!done) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      // Normalize only complete CRLF pairs; a trailing CR may arrive in the next chunk.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (next.done) { if (buffer.trim()) consume(buffer); break; }
    }
    if (!done && !finish) throw new Error("Local response stream ended before completion.");
    return { choices: [{ message: { role: "assistant", content }, finish_reason: finish }], usage, timings };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
