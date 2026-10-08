/** What a remote device may see of an error: the first line, without file system paths,
 * bounded. Runtime and provider errors can carry a 64 KB process log or an HTTP response body;
 * the full text stays in the host's log. */
export const publicError = (message: unknown, fallback = "The operation failed on the server."): string => {
  const first = String(message ?? "").split(/\r?\n/, 1)[0]!.trim();
  if (!first) return fallback;
  const redacted = first.replace(/(?:\b[A-Za-z]:)?(?:[\\/][^\\/\s"'`:,;()]+){2,}[\\/]?/g, "<path>");
  return redacted.length > 300 ? `${redacted.slice(0, 299)}…` : redacted;
};
