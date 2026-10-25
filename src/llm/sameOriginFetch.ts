const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** A provider answered with a redirect to another origin: nothing was sent there. */
export class CrossOriginRedirectError extends Error {}

/** A fetch for a provider's requests, which carry its key: a redirect is followed only within the
 * origin the request was sent to (scheme, host and port), at most five times, and one to another
 * origin is refused before anything goes there. fetch's own redirect drops Authorization on another
 * origin but keeps x-api-key (Anthropic) and x-goog-api-key (Gemini), so a 30x could carry the key
 * anywhere. The first request is sent with the caller's own input; `fetchImpl` is read at each call,
 * so a test that replaces globalThis.fetch is used. */
export const sameOriginFetch = (fetchImpl?: typeof fetch): typeof fetch => (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
  const send = fetchImpl ?? globalThis.fetch;
  if (input instanceof Request) return send(input, { ...init, redirect: "error" });
  const start = new URL(String(input));
  let target: string | URL = input, current = start;
  let method = (init.method ?? "GET").toUpperCase(), body = init.body, headers = init.headers;
  for (let hop = 0; ; hop++) {
    const response = await send(target, { ...init, method, body, headers, redirect: "manual" });
    const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    let next: URL;
    try { next = new URL(location, current); } catch { throw new CrossOriginRedirectError(`${start.origin} answered with a redirect that is not an address.`); }
    // Only the origin is named: a redirect's path or query may carry anything.
    if (next.origin !== start.origin) {
      throw new CrossOriginRedirectError(`${start.origin} redirected to ${next.origin}. A key is sent only to the address it was saved for, so nothing was sent there. If the service has moved, set its new address in Settings.`);
    }
    if (hop >= MAX_REDIRECTS) throw new CrossOriginRedirectError(`More than ${MAX_REDIRECTS} redirects from ${start.origin}.`);
    // 303, and 301/302 of a POST, continue as GET without the body, as fetch does.
    if ((response.status === 303 && method !== "HEAD") || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const without = new Headers(headers); without.delete("content-type"); without.delete("content-length");
      method = "GET"; body = undefined; headers = without;
    }
    target = next.href; current = next;
  }
}) as typeof fetch;
