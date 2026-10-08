import { createHash } from "crypto";

/** JSON with object keys sorted at every level: equal payloads give equal text, so they hash alike. */
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
