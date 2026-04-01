const hyphenateUuid = (value: string): string =>
  `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;

export const extractNotionId = (value?: string): string | undefined => {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  const directUuid = normalized.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
  );

  if (directUuid?.[1]) {
    return directUuid[1];
  }

  const compactUuid = normalized.match(/\b([0-9a-f]{32})\b/i);

  if (compactUuid?.[1]) {
    return hyphenateUuid(compactUuid[1].toLowerCase());
  }

  return undefined;
};
