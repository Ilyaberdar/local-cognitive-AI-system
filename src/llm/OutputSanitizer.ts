const REASONING_MARKERS = [
  "thinking process",
  "let me think",
  "the user wants me",
  "analyze the request",
  "final verification"
];

const cleanPrefix = (value: string): string =>
  value.replace(/^(final answer|answer|ответ)\s*:\s*/i, "").trim();

export class OutputSanitizer {
  sanitize(text: string): string {
    const normalized = text.trim().replace(/\r\n/g, "\n");

    if (!normalized) {
      return normalized;
    }

    const blocks = normalized
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);

    const hasReasoningMarker = REASONING_MARKERS.some((marker) =>
      normalized.toLowerCase().includes(marker)
    );

    if (hasReasoningMarker && blocks.length > 1) {
      return cleanPrefix(blocks[blocks.length - 1]);
    }

    return cleanPrefix(normalized);
  }
}
