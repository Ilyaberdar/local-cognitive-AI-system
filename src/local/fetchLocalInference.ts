import http from "node:http";

/** The bundled server can spend minutes generating before sending headers. Node's
 * fetch has a separate five-minute header deadline; use only the caller's explicit
 * generation deadline here. This transport is restricted to our loopback server. */
export const fetchLocalInference: typeof fetch = async (input, init = {}) => {
  if (typeof input !== "string" && !(input instanceof URL)) throw new Error("Local inference requires a URL.");
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("Local inference requires an HTTP loopback URL without credentials.");
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("Local inference requires a text request body.");
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(url, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal ?? undefined, agent: false
    }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { request.destroy(new Error("Local inference response exceeds 32 MiB.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        const status = response.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.on("error", reject);
    request.end(init.body);
  });
};
