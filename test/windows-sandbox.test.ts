import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathCleaner } from "../src/synthesis/checks/runners";
import { verifyIsolation, windowsEnv, winExecArgs, winOpenable } from "../src/synthesis/checks/sandbox";
import { windowsTerminalPrefix } from "../src/synthesis/agents/Terminal";
import type { SandboxProvider } from "../src/synthesis/checks/types";

// These exercise the Windows sandbox's pure logic on any OS (its path work uses path.win32), so they run
// on the Mac and in Linux CI; the live behaviour is checked on a Windows machine.

test("windowsEnv is Windows-shaped, keeps the command inside the work folder, and carries no app secrets", () => {
  const work = "C:\\Users\\me\\AppData\\app\\synthesis\\run-1";
  const env = windowsEnv("C:\\tools\\node\\node.exe", work);
  // Paths and the PATH separator are Windows', whatever host built them.
  assert.equal(env.HOME, work);
  assert.equal(env.USERPROFILE, work);
  assert.equal(env.TEMP, "C:\\Users\\me\\AppData\\app\\synthesis\\run-1\\tmp");
  assert.equal(env.TMP, env.TEMP);
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\me\\AppData\\app\\synthesis\\run-1\\tmp\\la");
  assert.ok(env.PATH!.includes(";"), env.PATH);
  assert.ok(env.PATH!.split(";").includes("C:\\tools\\node"), env.PATH);
  assert.ok(env.PATH!.toLowerCase().includes("system32"), env.PATH);
  assert.equal(env.NODE_OPTIONS, "--preserve-symlinks --preserve-symlinks-main");
  assert.equal(env.npm_config_offline, "true");
  assert.ok(env.npm_config_script_shell!.toLowerCase().endsWith("cmd.exe"));
  assert.ok(env.npm_config_cache!.startsWith(work));
  // Nothing of the app's own environment leaks in.
  const names = Object.keys(env).map(name => name.toLowerCase());
  for (const secret of ["anthropic_api_key", "openai_api_key", "path_orig", "cloud_url", "aws_secret_access_key"]) assert.ok(!names.includes(secret));
  assert.ok(!Object.values(env).some(value => value === process.env.HOME), "the host's HOME is not passed through");
});

test("winExecArgs wraps the command, one capability per work folder granted once, and refuses unopenable read dirs", () => {
  process.env.LC_SANDBOX_ROOTS = "C:\\Users\\me\\AppData\\app";
  process.env.LC_SANDBOX_HELPER = "C:\\Program Files\\LC\\resources\\sandbox\\win32-x64\\lc-sandbox.exe";
  const work = "C:\\Users\\me\\AppData\\app\\synthesis\\run-7";
  const first = winExecArgs("exec", work, ["C:\\", "C:\\Windows", "C:\\tools\\node", "C:\\Program Files\\LC\\resources\\sandbox\\win32-x64\\node"], ["C:\\tools\\node\\node.exe", "--test", "a b.js"]);
  assert.equal(first[0], "exec");
  // A profile and a capability of this folder's own, carrying the same id.
  assert.equal(first[1], "--profile");
  const id = /^LocalCognitive\.Sandbox\.([0-9a-f]{16})$/.exec(first[2]!);
  assert.ok(id, first[2]);
  assert.equal(first[first.indexOf("--run-cap") + 1], `LocalCognitive.Run.${id![1]}`);
  const rootsAt = first.indexOf("--roots");
  assert.ok(first[rootsAt + 1]!.split(";").includes("C:\\Users\\me\\AppData\\app"), first[rootsAt + 1]);
  assert.equal(first[first.indexOf("--rw") + 1], work);
  // C:\ is a drive root, C:\Windows the system folder, C:\Program Files a protected root: none is opened
  // up; the tool folder is. The bundled Node is already open to the sandbox (grant-tools).
  const ro = first.filter((_, i) => first[i - 1] === "--ro");
  assert.deepEqual(ro, ["C:\\tools\\node"]);
  // Everything after -- is the command, verbatim (an argument with a space stays one argument).
  assert.deepEqual(first.slice(first.indexOf("--") + 1), ["C:\\tools\\node\\node.exe", "--test", "a b.js"]);
  // The first command applies the folder's grant; the next ones, on the same folder and profile, do not.
  assert.ok(!first.slice(0, first.indexOf("--")).includes("--granted"));
  const second = winExecArgs("exec", work, [], ["x.exe"]);
  assert.equal(second[2], first[2], "one profile and capability for every command of a folder");
  assert.equal(second[first.indexOf("--run-cap") + 1], first[first.indexOf("--run-cap") + 1]);
  assert.ok(second.slice(0, second.indexOf("--")).includes("--granted"));
  // Another folder has a profile and capability of its own.
  const other = winExecArgs("exec", "C:\\Users\\me\\AppData\\app\\synthesis\\run-8", [], ["x.exe"]);
  assert.notEqual(other[2], first[2]);
  // empty takes no command, and is the folder's last: a folder made again later is profiled afresh.
  const empty = winExecArgs("empty", work, [], []);
  assert.ok(!empty.includes("--") && empty.includes("--granted"));
  assert.ok(!winExecArgs("exec", work, [], ["x.exe"]).includes("--granted"));
  delete process.env.LC_SANDBOX_HELPER;
});

test("winOpenable keeps tool folders and refuses drive roots, the Windows folder, the profile root and protected roots", () => {
  assert.equal(winOpenable("C:\\tools\\node"), true);
  assert.equal(winOpenable("C:\\Program Files\\Python312"), true, "a specific tool folder under Program Files is fine");
  assert.equal(winOpenable("C:\\"), false);
  assert.equal(winOpenable("C:\\Windows"), false);
  assert.equal(winOpenable(process.env.SystemRoot ?? "C:\\Windows"), false);
  // Program Files, Program Files (x86) and ProgramData themselves are never opened up.
  assert.equal(winOpenable("C:\\Program Files"), false);
  assert.equal(winOpenable("C:\\Program Files (x86)"), false);
  assert.equal(winOpenable("C:\\ProgramData"), false);
});

test("pathCleaner turns a run's Windows paths, and its file:/// URLs, into relative ones", () => {
  const work = "C:\\Users\\me\\AppData\\app\\synthesis\\run-3";
  const clean = pathCleaner(work, work, true);
  assert.equal(clean(`at ${work}\\src\\a.ts:3`), "at src\\a.ts:3");
  assert.equal(clean(`${work}/src/a.ts:3`), "src/a.ts:3");
  assert.equal(clean(`file:///${work.replace(/\\/g, "/")}/src/a.ts`), "src/a.ts");
  assert.equal(clean(`the folder is ${work}.`), "the folder is ..");
  // The run root (one level up) becomes ".." (with the "../" prefix when a separator follows).
  const parent = path.win32.dirname(work);
  assert.equal(pathCleaner(work, work, true)(`${parent}\\other`), "../other");
});

test("windowsTerminalPrefix runs npm and npx through the shipped Node, and refuses git, ls, cat, python3, rg", () => {
  assert.deepEqual(windowsTerminalPrefix("node", "C:\\sbx\\node"), []);
  assert.deepEqual(windowsTerminalPrefix("npm", "C:\\sbx\\node"), ["C:\\sbx\\node\\node_modules\\npm\\bin\\npm-cli.js"]);
  assert.deepEqual(windowsTerminalPrefix("npx", "C:\\sbx\\node"), ["C:\\sbx\\node\\node_modules\\npm\\bin\\npx-cli.js"]);
  for (const command of ["git", "ls", "cat", "python3", "rg"] as const) {
    assert.throws(() => windowsTerminalPrefix(command, "C:\\sbx\\node"), /not available in the Windows terminal yet/);
  }
});

// verifyIsolation's checks, driven by a fake probe provider (a small node program emitting controlled
// output), so each failure reason is covered on any OS.
const fakeProbe = (body: string): Pick<SandboxProvider, "probe"> => ({
  probe: (_workDir, _readable, { canary, written, port }) => ({ executable: process.execPath, args: ["-e", body, canary, written, String(port)], env: { ...process.env } })
});

test("verifyIsolation names a read, a write, a network reach, and a probe that did not run", async () => {
  const read = await verifyIsolation(fakeProbe("const fs=require('fs');try{process.stdout.write('c:'+fs.readFileSync(process.argv[1],'utf8')+'\\n')}catch(e){}console.log('LC_PROBE_RAN')"));
  assert.equal(read, "a sandboxed process read a file outside its folders");
  const wrote = await verifyIsolation(fakeProbe("const fs=require('fs');try{fs.writeFileSync(process.argv[2],'x')}catch(e){}console.log('LC_PROBE_RAN')"));
  assert.equal(wrote, "a sandboxed process wrote outside its work folder");
  const connected = await verifyIsolation(fakeProbe("console.log('loopback: CONNECTED');console.log('LC_PROBE_RAN')"));
  assert.equal(connected, "a sandboxed process reached the network");
  const resolved = await verifyIsolation(fakeProbe("console.log('dns: RESOLVED');console.log('LC_PROBE_RAN')"));
  assert.equal(resolved, "a sandboxed process reached the network");
  const silent = await verifyIsolation(fakeProbe("process.exit(0)"));
  assert.equal(silent, "the sandbox did not run its check");
  const clean = await verifyIsolation(fakeProbe("console.log('readCanary: ERR');console.log('loopback: closed');console.log('dns: fail');console.log('LC_PROBE_RAN')"));
  assert.equal(clean, undefined);
  // Windows residual: a process on the WinSta0 alternate desktop may open the user's Default desktop
  // (userDesktop: yes), which is tolerated, but it must not be able to enumerate the user's windows there.
  const sawWindows = await verifyIsolation(fakeProbe("console.log('userDesktop: yes');console.log('userWindows: 2');console.log('LC_PROBE_RAN')"));
  assert.equal(sawWindows, "a sandboxed process could see the user's windows");
  // The known-good shape on Windows: Default reachable but no windows visible there — not a failure.
  const residualOk = await verifyIsolation(fakeProbe("console.log('userDesktop: yes');console.log('userWindows: 0');console.log('LC_PROBE_RAN')"));
  assert.equal(residualOk, undefined);
});
