import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import test from "node:test";
import { AddressInfo } from "node:net";
import { guardedGet, hostOf, isBlockedAddress, isMetadataAddress, isOwnAddress, resolveAndPin } from "../src/security/egress";

async function serve(handler: http.RequestListener): Promise<{ port: number; seen: http.IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
/** Any name resolves to the test server, whose address counts as public: only for the paths that read. */
const asPublic = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

test("an IPv6 literal is checked without its brackets, and its embedded IPv4 as that IPv4", async () => {
  assert.equal(hostOf(new URL("http://[::1]:8080/")), "::1");
  assert.equal(hostOf(new URL("http://[::ffff:7f00:1]/")), "::ffff:7f00:1");
  for (const address of ["[::1]", "::1", "[::ffff:7f00:1]", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) assert.equal(isBlockedAddress(address), true, address);
  for (const address of ["127.0.0.1", "::1", "[::1]", "0.0.0.0", "::"]) assert.equal(isOwnAddress(address), true, address);
  assert.equal(isOwnAddress("1.1.1.1"), false);
  for (const address of ["169.254.169.254", "fd00:ec2::254", "100.100.100.200", "fe80::1", "::ffff:169.254.169.254"]) assert.equal(isMetadataAddress(address), true, address);
  assert.equal(isMetadataAddress("10.0.0.1"), false);
  // resolveAndPin takes the URL's hostname as it is: "[::1]" is the address ::1, not a name to look up.
  const pinned = await resolveAndPin("[::1]", { resolve: async () => { throw new Error("not a name"); }, blocked: () => false });
  assert.equal(pinned.address, "::1"); assert.equal(pinned.family, 6);
  await assert.rejects(resolveAndPin("[::1]", { resolve: async () => [], blocked: isBlockedAddress }), /private, loopback/);
});

test("a name that resolves to both public and private addresses is refused before anything is sent", async () => {
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] };
  await assert.rejects(guardedGet("http://mixed.test/", { hooks }), /both public and private addresses/);
  await assert.rejects(guardedGet("http://mixed.test/", { hooks, allowPrivateOrigin: "http://mixed.test" }), /both public and private addresses/);
  await assert.rejects(guardedGet("http://metadata.test/", { hooks: { resolve: async () => [{ address: "169.254.169.254", family: 4 }] }, allowPrivateOrigin: "http://metadata.test" }), /metadata/);
  for (const url of ["ftp://example.com/", "http://user:pass@example.com/", "file:///etc/passwd"]) await assert.rejects(guardedGet(url), /http\(s\)|user name or password/, url);
});

test("a compressed answer is read with its decompressed size capped", async () => {
  const big = zlib.gzipSync(Buffer.alloc(5_000_000, 97));
  const srv = await serve((req, res) => {
    if (req.url === "/gzip") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(big); }
    else if (req.url === "/br") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" }); res.end(zlib.brotliCompressSync(Buffer.from("brotli text"))); }
    else { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "compress" }); res.end("x"); }
  });
  try {
    const url = (path: string) => `http://gzip.test:${srv.port}${path}`;
    const capped = await guardedGet(url("/gzip"), { hooks: asPublic, maxBytes: 1_000_000 });
    assert.equal(capped.body.length, 1_000_000); assert.equal(capped.truncated, true);
    assert.ok(capped.body.every(byte => byte === 97), "decompressed");
    assert.equal((await guardedGet(url("/br"), { hooks: asPublic })).body.toString(), "brotli text");
    await assert.rejects(guardedGet(url("/other"), { hooks: asPublic }), /encoded as compress/);
    assert.match(String(srv.seen[0]!["accept-encoding"]), /gzip/);
  } finally { await srv.close(); }
});

test("the caller's headers go to the first origin only; every redirect is listed", async () => {
  const second = await serve((_req, res) => { res.setHeader("content-type", "text/plain"); res.end("second"); });
  const first = await serve((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/next" }); res.end(); return; }
    res.writeHead(307, { location: `http://second.test:${second.port}/landed` }); res.end();
  });
  try {
    const answer = await guardedGet(`http://first.test:${first.port}/start`, { hooks: asPublic, headers: { "X-Token": "only-for-first" } });
    assert.equal(answer.body.toString(), "second");
    assert.deepEqual(answer.redirects, [`http://first.test:${first.port}/next`, `http://second.test:${second.port}/landed`]);
    assert.equal(answer.url, `http://second.test:${second.port}/landed`);
    assert.deepEqual(first.seen.map(headers => headers["x-token"]), ["only-for-first", "only-for-first"]);
    assert.equal(second.seen[0]!["x-token"], undefined, "another origin gets none of the caller's headers");
  } finally { await first.close(); await second.close(); }
});
