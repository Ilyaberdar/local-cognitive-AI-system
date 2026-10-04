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
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      const status = response.statusCode ?? 500;
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); return; }
      let bytes = 0;
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const fail = (error: Error) => { if (!closed) { closed = true; controller.error(error); } };
          response.on("error", fail);
          request.on("error", fail);
          response.on("data", (chunk: Buffer) => {
            if (closed) return;
            bytes += chunk.length;
            if (bytes > 32 * 1024 * 1024) {
              const error = new Error("Local inference response exceeds 32 MiB."); fail(error); request.destroy(error); return;
            }
            controller.enqueue(chunk);
            if ((controller.desiredSize ?? 0) <= 0) response.pause();
          });
          response.on("end", () => { if (!closed) { closed = true; controller.close(); } });
        },
        pull() { response.resume(); },
        cancel() { closed = true; response.destroy(); request.destroy(); }
      });
      resolve(new Response(body, { status, headers }));
    });
    request.on("error", reject);
    request.end(init.body);
  });
};
