/** A provider's HTTP refusal with its status, so a caller can tell a refused key from a service that is down. */
export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** The service's own words about a refusal: `type: message` from the usual JSON error bodies. */
function reasonOf(detail: string): string {
  try {
    const error = (JSON.parse(detail) as { error?: unknown })?.error;
    if (typeof error === "string") return error.slice(0, 200);
    const fields = error as { type?: unknown; code?: unknown; status?: unknown; message?: unknown } | undefined;
    const kind = [fields?.type, fields?.code, fields?.status].find(value => typeof value === "string" && value);
    return [kind, typeof fields?.message === "string" ? fields.message : ""].filter(Boolean).join(": ").slice(0, 200);
  } catch {
    return detail.replace(/\s+/g, " ").trim().slice(0, 200);
  }
}

/** True when a service says its key is not valid: 401, and Gemini's 400 "API key not valid". */
export const isKeyRefusal = (status: number, detail = ""): boolean =>
  status === 401 || (status === 400 && /API[_ ]KEY[_ ]INVALID|API key not valid/i.test(detail));

/** What a chat shows when a cloud service refuses its key or the request (401, 403): what happened,
 * in the service's words, and where to fix it. Undefined for any other status. */
export function refusalMessage(name: string, status: number, detail: string): string | undefined {
  const reason = reasonOf(detail);
  const said = reason ? `, ${reason}` : "";
  if (isKeyRefusal(status, detail)) return `${name} refused the API key (HTTP ${status}${said}). The key is not valid: it was mistyped, expired or revoked. Enter a new one in Settings → Models & Providers.`;
  if (status === 403) return `${name} refused the request (HTTP 403${said}). The key may not have access to this model, or it was revoked. Check it in Settings → Models & Providers.`;
  return undefined;
}
