const cleanPrefix = (value: string): string =>
  value.replace(/^(final answer|answer|ответ)\s*:\s*/i, "").trim();

export class OutputSanitizer {
  sanitize(text: string): string {
    const normalized = text.trim().replace(/\r\n/g, "\n");

    if (!normalized) {
      return normalized;
    }

    // Only remove explicitly delimited reasoning, never arbitrary answer paragraphs.
    const answer = normalized
      .replace(/^(?:\s*<(think|thinking|analysis)>[\s\S]*?<\/\1>\s*)+/i, "")
      .replace(/^Thinking Process:\s*\n[^]*?\n\s*\n/i, "");
    if (/^\s*<(think|thinking|analysis)>/i.test(answer)) return "";
    return cleanPrefix(answer);
  }
}
