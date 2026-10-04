import assert from "node:assert/strict";
import test from "node:test";
import { readLocalChatStream } from "../src/llm/LocalChatStream";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { Logger } from "../src/utils/Logger";

const streamResponse = (text: string) => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
  controller.close();
} }), { headers: { "content-type": "text/event-stream" } });

test("local SSE handles fragmented UTF-8 and CRLF, preserves usage and never displays reasoning", async () => {
  const chunks: string[] = [];
  const source = [
    { choices: [{delta:{reasoning_content:"private reasoning"}}] },
    { choices: [{delta:{content:"Привет "}}] },
    { choices: [{delta:{content:"🌍"}, finish_reason:"stop"}] },
    { choices:[], usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6} }
  ].map(x => `data: ${JSON.stringify(x)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const result: any = await readLocalChatStream(streamResponse(source), text => chunks.push(text));
  assert.equal(chunks.join(""),"Привет 🌍"); assert.equal(result.choices[0].message.content,"Привет 🌍");
  assert.equal(result.usage.total_tokens,6);
});

test("truncated streams and native errors cannot become successful answers", async () => {
  await assert.rejects(readLocalChatStream(streamResponse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {}), /before completion/);
  await assert.rejects(readLocalChatStream(streamResponse('data: {"error":{"message":"native failure"}}\n\n'), () => {}), /native failure/);
});

test("streaming is local plain-text only and is never enabled for executable agent actions", async () => {
  const bodies: any[] = [];
  const provider = new OpenAICompatibleProvider({ id:"llamacpp",name:"Local",baseUrl:"http://127.0.0.1/v1",model:"tiny",timeoutMs:5000 },new Logger(), async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({choices:[{message:{content:"hello"},finish_reason:"stop"}]}),{headers:{"content-type":"application/json"}});
  });
  await provider.generateText({prompt:"hello",onTextDelta:()=>{}});
  await provider.generateText({prompt:"act",outputPurpose:"agent-action",onTextDelta:()=>{}});
  assert.equal(bodies[0].stream,true); assert.equal(bodies[1].stream,undefined);
});
