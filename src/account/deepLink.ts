export const DEEP_LINK_SCHEME = "localcognitive";

/** Parses localcognitive://auth/complete/<attemptId>. The raw string is matched instead of
 * using URL, which would normalise case, user info and encoded dots. A link only focuses the
 * app; it never authorizes anything. */
export const parseAuthDeepLink = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length > 128) return undefined;
  return /^localcognitive:\/\/auth\/complete\/([A-Za-z0-9_-]{22})\/?$/i.exec(value)?.[1];
};

export const isDeepLinkArgument = (value: unknown): value is string =>
  typeof value === "string" && value.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`);
