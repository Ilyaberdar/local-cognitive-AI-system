/** A model writes files as <<<FILE:path>>> … <<<END FILE>>> blocks, which the app applies. Where a
 * person reads the answer as text (Telegram, an MCP client), each is a fenced code block under its
 * path; the app's window draws them itself (frontend/markdown). A block cut off at the end is shown
 * as far as it came. */
const FILE_BLOCK = /<<<FILE:([^\n>]+)>>>[^\S\n]*\n?([\s\S]*?)(?:<<<END FILE>>>|$)/g;

export const fileBlocksAsMarkdown = (text: string): string => text.replace(FILE_BLOCK, (_block, rawPath: string, rawContent: string) => {
  const filePath = rawPath.trim(), content = rawContent.replace(/\r?\n$/, "");
  const fence = "`".repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(run => run[0].length + 1)));
  const name = filePath.split(/[\\/]/).at(-1) ?? "";
  const language = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  return `${filePath}\n${fence}${language}\n${content}\n${fence}\n`;
});
