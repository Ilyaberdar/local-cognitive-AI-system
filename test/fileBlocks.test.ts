import assert from "node:assert/strict";
import test from "node:test";
import { ResponseFormatter } from "../src/core/ResponseFormatter";
import { fileBlocksAsMarkdown } from "../src/core/fileBlocks";

const answer = "Here it is:\n\n<<<FILE:src/app.ts>>>\nconst a = 1;\n<<<END FILE>>>\n<<<FILE:notes.txt>>>\nhello\n<<<END FILE>>>";

test("Telegram and MCP clients read a written file as a fenced code block under its path, not the raw markers", () => {
  assert.equal(fileBlocksAsMarkdown(answer), "Here it is:\n\nsrc/app.ts\n```ts\nconst a = 1;\n```\n\nnotes.txt\n```txt\nhello\n```\n");
  assert.equal(fileBlocksAsMarkdown("<<<FILE:README>>>\n```sh\nnpm i\n```\nand mo"), "README\n````\n```sh\nnpm i\n```\nand mo\n````\n", "cut off, with fences of its own");
  assert.equal(fileBlocksAsMarkdown("No files here."), "No files here.");
  const result = { input: "Create the files", mode: "general", providerId: "deepseek", tools: [], memory: [], conversationSize: 0,
    result: { response: answer, provider: "deepseek", model: "deepseek-flash" } } as never;
  const formatter = new ResponseFormatter();
  assert.doesNotMatch(formatter.formatForChat(result), /<<<|END FILE/);
  assert.match(formatter.formatForChat(result, { fileBlocks: "keep" }), /<<<FILE:notes\.txt>>>/, "the window draws them itself");
});
