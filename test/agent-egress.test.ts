import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import { RequestBudget } from "../src/synthesis/agents/AgentHttp";
import { createEgressProxy, EgressProxy } from "../src/synthesis/agents/AgentHttpProxy";
import { AgentTerminal, TerminalHost } from "../src/synthesis/agents/Terminal";
import { platformSandbox } from "../src/synthesis/checks/sandbox";

// Terminal egress: on macOS sandbox-exec opens one loopback port; on Linux bubblewrap keeps a network of
// its own with only lo, and a forwarder inside bridges 127.0.0.1:3128 to the proxy's socket. These run
// where the sandbox works and says it can route to the proxy.
const supported = process.platform === "darwin" || process.platform === "linux";
const unix = () => platformSandbox().egressTransport === "unix";
const ready = async () => !await platformSandbox().unavailable() && platformSandbox().egressSupported === true;
const haveCurl = fsSync.existsSync("/usr/bin/curl");
const hooks = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

async function upstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer((_req, res) => res.end("ARRIVED"));
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  return { port: (srv.address() as AddressInfo).port, close: () => new Promise(resolve => srv.close(() => resolve())) };
}
test("terminal egress: a sandboxed tool reaches an allowed target only through the proxy; direct and off-list are refused", { skip: !(supported && haveCurl) }, async () => {
  if (!await ready()) return;
  const up = await upstream();
  const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-egress-")));
  const p = await createEgressProxy({ allow: [`http://local.test:${up.port}`], budget: new RequestBudget(100), hooks, unix: unix() });
  const curl = (args: string[], endpoint = p.endpoint) => new Promise<{ code: number; stdout: string }>(resolve => {
    const wrapped = platformSandbox().wrap("/usr/bin/curl", args, workDir, [], endpoint);
    const url = wrapped.proxyUrl!;
    const env = { http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url };
    execFile(wrapped.executable, wrapped.args, { cwd: workDir, env: { ...wrapped.env, ...env }, timeout: 15_000 },
      (error, stdout) => resolve({ code: (error as NodeJS.ErrnoException & { code?: number })?.code ? Number((error as { code?: number }).code) : 0, stdout: String(stdout) }));
  });
  try {
    const ok = await curl(["-s", "-m", "8", `http://local.test:${up.port}/scan`]);
    assert.match(ok.stdout, /ARRIVED/, `through the proxy the allowed target is reached: ${JSON.stringify(ok)}`);

    const offList = await curl(["-s", "-m", "8", `http://other.test:${up.port}/`]);
    assert.match(offList.stdout, /not in this agent's allowed targets/, `the proxy refuses an off-list target: ${JSON.stringify(offList)}`);

    // --noproxy forces a direct connection: the sandbox allows only the proxy's port, so it cannot connect.
    const direct = await curl(["-s", "-m", "8", "--noproxy", "*", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${up.port}/`]);
    assert.notEqual(direct.code, 0, `a direct connection past the proxy is blocked by the sandbox: ${JSON.stringify(direct)}`);
    assert.doesNotMatch(direct.stdout, /ARRIVED/);
  } finally { await p.close(); await up.close(); await fs.rm(workDir, { recursive: true, force: true }); }
});

test("terminal egress: the proxy env is set for an agent with web targets and absent for one without", { skip: !supported }, async () => {
  if (!await ready()) return;
  const started: EgressProxy[] = [];
  const host: TerminalHost = {
    sandbox: platformSandbox(), git: false,
    workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "lcai-egress-work-")),
    egress: async allow => { const p = await createEgressProxy({ allow, budget: new RequestBudget(100), hooks, unix: unix() }); started.push(p); return p; }
  };
  const view = { root: await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-egress-root-"))), readable: async () => [], content: async () => null, candidate: () => ({ files: {}, removed: [] }) };
  const print = 'console.log("PROXY=" + (process.env.HTTP_PROXY || "none"))';
  try {
    const withWeb = new AgentTerminal(host, view, "agent-0", ["node"], ["http://local.test:9"]);
    const a = await withWeb.run("node", ["-e", print], "", 30);
    assert.match(a.stdout, /PROXY=http:\/\/127\.0\.0\.1:\d+/, `an agent with web targets runs its terminal behind the proxy: ${a.stdout}${a.stderr}`);
    await withWeb.dispose();

    const noWeb = new AgentTerminal(host, view, "agent-1", ["node"], []);
    const b = await noWeb.run("node", ["-e", print], "", 30);
    assert.match(b.stdout, /PROXY=none/, "an agent with no web targets has no proxy and no network");
    await noWeb.dispose();
  } finally {
    for (const p of started) await p.close().catch(() => undefined);
    await fs.rm(host.workRoot, { recursive: true, force: true });
    await fs.rm(view.root, { recursive: true, force: true });
  }
});
