import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import { RequestBudget } from "../src/synthesis/agents/AgentHttp";
import { createEgressProxy } from "../src/synthesis/agents/AgentHttpProxy";
import { AgentTerminal, TerminalHost } from "../src/synthesis/agents/Terminal";
import { bwrapArgs, EGRESS_FORWARDER, linuxEgress, unsandboxed, verifyEgress } from "../src/synthesis/checks/sandbox";
import type { SandboxProvider } from "../src/synthesis/checks/types";

const hooks = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

test("Linux web access keeps bubblewrap's own network: the proxy's socket is bound read-only and the command starts after the forwarder", async () => {
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-bwrap-args-")));
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-node-")));
  try {
    const plain = bwrapArgs("/usr/bin/curl", ["-s", "x"], work, [], true);
    assert.deepEqual(plain.slice(plain.indexOf("--")), ["--", "/usr/bin/curl", "-s", "x"]);
    assert.equal(plain.includes("/run/lc-egress"), false);
    const socketDir = "/tmp/lce-abc";
    const web = bwrapArgs("/usr/bin/curl", ["-s", "x"], work, [], true, { socketDir, runtime: path.join(runtimeDir, "node") });
    assert.ok(web.includes("--unshare-all"), "a network of its own");
    for (const shared of ["--share-net", "--unshare-net"]) assert.equal(web.includes(shared), false, `never ${shared}`);
    const at = web.indexOf("/run/lc-egress");
    assert.deepEqual(web.slice(at - 2, at + 1), ["--ro-bind", socketDir, "/run/lc-egress"], "the socket's folder, read-only");
    assert.equal(web.filter(item => item === "/run/lc-egress").length, 1);
    const node = web.indexOf(runtimeDir);
    assert.equal(web[node - 1], "--ro-bind", "the forwarder's runtime, read-only");
    const command = web.slice(web.indexOf("--", web.indexOf("--chdir")) + 1);
    assert.equal(command[0], "/bin/sh");
    assert.match(command[2]!, /mkfifo[\s\S]*read -r ok[\s\S]*exit 70[\s\S]*exec "\$@"/, "the command runs only after the forwarder says ready");
    assert.deepEqual(command.slice(3), ["sh", "/usr/bin/curl", "-s", "x"]);
  } finally {
    await fs.rm(work, { recursive: true, force: true }); await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("Linux web access is never wired without the proxy's socket and the server's Node", () => {
  assert.throws(() => linuxEgress({}, "/opt/node/bin/node"), /needs the egress proxy's socket/);
  assert.throws(() => linuxEgress({ socketPath: "/tmp/lce-x/other.sock" }, "/opt/node/bin/node"), /needs the egress proxy's socket/);
  assert.throws(() => linuxEgress({ socketPath: `/tmp/${"x".repeat(100)}/proxy.sock` }, "/opt/node/bin/node"), /too long/);
  assert.throws(() => linuxEgress({ socketPath: "/tmp/lce-x/proxy.sock" }, null), /server's own Node/);
  const wired = linuxEgress({ socketPath: "/tmp/lce-x/proxy.sock" }, "/opt/node/bin/node");
  assert.deepEqual(wired, { socketDir: "/tmp/lce-x", runtime: "/opt/node/bin/node", env: { LC_EGRESS_NODE: "/opt/node/bin/node", LC_EGRESS_FORWARDER: EGRESS_FORWARDER } });
  new Function(EGRESS_FORWARDER);
});

test("the egress proxy on a UNIX socket enforces the allowlist, is its user's alone, and leaves nothing when closed", { skip: process.platform === "win32" }, async () => {
  const upstream = http.createServer((_req, res) => res.end("ARRIVED"));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as AddressInfo).port;
  const proxy = await createEgressProxy({ allow: [`http://local.test:${port}`], budget: new RequestBudget(10), hooks, unix: true });
  const ask = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ socketPath: proxy.endpoint.socketPath, path: url, headers: { host: new URL(url).host } }, response => {
      let body = ""; response.on("data", chunk => body += chunk); response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });
  try {
    assert.match(proxy.endpoint.socketPath!, /\/lce-[^/]+\/proxy\.sock$/);
    assert.equal(proxy.endpoint.port, 0);
    assert.equal((fsSync.statSync(path.dirname(proxy.endpoint.socketPath!)).mode & 0o777).toString(8), "700");
    assert.deepEqual(await ask(`http://local.test:${port}/scan`), { status: 200, body: "ARRIVED" });
    const refused = await ask(`http://other.test:${port}/`);
    assert.equal(refused.status, 403);
    assert.match(refused.body, /not in this agent's allowed targets/);
  } finally {
    await proxy.close();
    upstream.close();
  }
  assert.equal(fsSync.existsSync(path.dirname(proxy.endpoint.socketPath!)), false, "the socket and its folder are gone");
});

test("the web access check refuses a sandbox that does not route to the proxy alone, and its probe is valid code", async () => {
  // Without isolation the probe cannot reach the proxy through a forwarder (none starts): no web access.
  assert.ok(await verifyEgress(unsandboxed, process.execPath));
  assert.match(await verifyEgress(unsandboxed, null) ?? "", /server's own Node/);
  let probe = "";
  const capture: Pick<SandboxProvider, "wrap"> = { wrap: (executable, args, workDir) => { probe = args[1]!; return { executable: "/usr/bin/false", args: [], env: {} }; } };
  assert.match(await verifyEgress(capture, process.execPath) ?? "", /did not run to its end/);
  new Function(probe.replace(/^const net=require/, "const net=(()=>{})||require"));
});

test("a terminal sends its tools through the proxy its sandbox names, and through none when the sandbox names none", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "lc-terminal-egress-"));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-terminal-root-")));
  const seen: string[] = [];
  const fake = (proxyUrl?: string): SandboxProvider => ({ name: "fake", egressSupported: true, unavailable: async () => undefined,
    wrap: (executable, args, workDir, _readable, egress) => { seen.push(egress?.socketPath ?? "none"); return { ...unsandboxed.wrap(executable, args, workDir, []), ...(egress && proxyUrl ? { proxyUrl } : {}) }; } });
  const view = { root, readable: async () => [], content: async () => null, candidate: () => ({ files: {}, removed: [] }) };
  const print = 'console.log("PROXY=" + (process.env.HTTP_PROXY || "none") + " ALL=" + (process.env.ALL_PROXY || "none"))';
  const proxy = { url: "unix:/tmp/lce-t/proxy.sock", endpoint: { host: "127.0.0.1", port: 0, socketPath: "/tmp/lce-t/proxy.sock" }, close: async () => undefined };
  try {
    const host = (sandbox: SandboxProvider): TerminalHost => ({ sandbox, git: false, workRoot: work, egress: async () => proxy });
    const named = new AgentTerminal(host(fake("http://127.0.0.1:3128")), view, "agent-0", ["node"], ["http://local.test:9"]);
    assert.match((await named.run("node", ["-e", print], "", 30)).stdout, /PROXY=http:\/\/127\.0\.0\.1:3128 ALL=http:\/\/127\.0\.0\.1:3128/);
    await named.dispose();
    const unnamed = new AgentTerminal(host(fake()), view, "agent-1", ["node"], ["http://local.test:9"]);
    assert.match((await unnamed.run("node", ["-e", print], "", 30)).stdout, /PROXY=none ALL=none/, "egress asked, but the sandbox named no proxy: no proxy env");
    await unnamed.dispose();
    assert.deepEqual(seen.filter(item => item !== "none"), ["/tmp/lce-t/proxy.sock", "/tmp/lce-t/proxy.sock"], "the socket reaches the sandbox");
  } finally {
    await fs.rm(work, { recursive: true, force: true }); await fs.rm(root, { recursive: true, force: true });
  }
});
