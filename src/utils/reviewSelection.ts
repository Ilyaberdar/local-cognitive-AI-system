export interface ReviewSelection {
  path: string;
  version: string;
  startOffset: number;
  endOffset: number;
  text: string;
}

export function reviewInputPath(input: string): string | undefined {
  const match = input.match(/^File: ("(?:[^"\\]|\\.)*") \(lines \d+–\d+\)/);
  if (!match) return;
  try { return JSON.parse(match[1]) as string; } catch { return; }
}

export function isReviewEditRequest(input: string): boolean {
  if (!reviewInputPath(input)) return false;
  const comment = input.slice(input.indexOf("\n") + 1).trim();
  return /^(?:please\s+|пожалуйста[,\s]+)?(?:edit|update|change|replace|rename|fix|rewrite|измени|обнови|замени|переименуй|исправь|перепиши|поменяй)\b/i.test(comment) ||
    /^(?:пожалуйста[,\s]+)?(?:измени|обнови|замени|переименуй|исправь|перепиши|поменяй)(?=\s|:)/i.test(comment);
}

export function readReviewSelection(metadata?: Record<string, unknown>): ReviewSelection | undefined {
  const item = metadata?.reviewSelection as ReviewSelection | undefined;
  if (!item) return;
  if (typeof item.path !== "string" || !item.path || typeof item.version !== "string" || !/^[a-f0-9]{64}$/.test(item.version) ||
      !Number.isSafeInteger(item.startOffset) || !Number.isSafeInteger(item.endOffset) ||
      item.startOffset < 0 || item.endOffset <= item.startOffset || typeof item.text !== "string" || item.text.length > 5000) {
    throw new Error("Invalid Review selection. Select the text again.");
  }
  return { path: item.path, version: item.version, startOffset: item.startOffset, endOffset: item.endOffset, text: item.text };
}
