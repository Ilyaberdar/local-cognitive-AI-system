// Videos need byte ranges: a browser seeks by asking for a part of the file. Workers static assets
// answer such a request with the whole file (200), so a docs video could only be paused, not
// seeked. This Worker runs only for /videos/* (assets.run_worker_first in wrangler.jsonc) and
// answers a range with that part (206), streaming it without holding the file in memory.

// An asset's response inside the Worker carries no Content-Length, so a file's size is counted once
// (read as a stream) and kept for this isolate by its ETag.
const sizes = new Map();
async function sizeOf(env, url, key) {
  if (sizes.has(key)) return sizes.get(key);
  const copy = await env.ASSETS.fetch(new Request(url));
  if (copy.status !== 200 || !copy.body) return undefined;
  let size = 0;
  const reader = copy.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
  }
  sizes.set(key, size);
  return size;
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 200 || !response.body || response.headers.has("content-encoding")) return response;
    const headers = new Headers(response.headers);
    headers.set("accept-ranges", "bytes");
    const range = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("range") ?? "").trim());
    if (!range || (range[1] === "" && range[2] === "")) return new Response(response.body, { status: 200, headers });
    const size = await sizeOf(env, request.url, response.headers.get("etag") ?? new URL(request.url).pathname);
    if (!size) return new Response(response.body, { status: 200, headers });
    const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end || start >= size) {
      await response.body.cancel();
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(slice(response.body, start, end + 1), { status: 206, headers });
  }
};

/** The bytes [from, to) of a stream; it stops reading the file once the range is sent. */
function slice(body, from, to) {
  let offset = 0;
  const part = body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const begin = Math.max(from - offset, 0), finish = Math.min(to - offset, chunk.byteLength);
      if (finish > begin) controller.enqueue(chunk.subarray(begin, finish));
      offset += chunk.byteLength;
      if (offset >= to) controller.terminate();
    }
  }));
  // A fixed length lets the response carry Content-Length, which Safari wants for a range.
  if (typeof FixedLengthStream !== "function") return part;
  const { readable, writable } = new FixedLengthStream(to - from);
  part.pipeTo(writable).catch(() => undefined);
  return readable;
}
