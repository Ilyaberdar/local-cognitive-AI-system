#!/usr/bin/env node
// End-to-end test of the one-line server installer (deploy/server/install.sh) in a Fedora container
// with systemd, against a release packed here with a throwaway signing key:
//
//   npm run build && node scripts/test-server-install.mjs [--distro fedora|ubuntu] [--keep]
//
// Needs Docker. Packs a linux release for this machine's architecture in a Node container
// (without llama.cpp), serves it on the container's loopback, installs it, checks the service,
// the commands, a second run and uninstall, and that a changed manifest, a changed download and
// an unknown signing key are refused. Remote stays off: no test server reaches the real Cloud.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const distro = process.argv.includes("--distro") ? process.argv[process.argv.indexOf("--distro") + 1] : "fedora";
const DISTROS = {
  fedora: ["FROM fedora:42", "RUN dnf -y install systemd procps-ng openssl tar gzip python3 shadow-utils util-linux util-linux-script findutils curl && dnf clean all"],
  ubuntu: ["FROM ubuntu:24.04", "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv openssl ca-certificates curl python3 procps && rm -rf /var/lib/apt/lists/*"]
};
// systemd-binfmt in a privileged container flushes the host's binfmt_misc handlers (Docker Desktop's
// x86-64 emulation, a CI host's QEMU): never let it run.
const NO_BINFMT = "RUN systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount";
if (!DISTROS[distro]) { console.error(`--distro is one of ${Object.keys(DISTROS).join(", ")}`); process.exit(64); }
const VERSION = "0.1.0-installtest.1";
const IMAGE = `lc-install-test-${distro}`;
const CONTAINER = `lc-install-test-${process.pid}`;
const CONTEXT = "lc-release-manifest/v1";

const docker = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
const inContainer = (script, { check = true } = {}) => {
  const result = spawnSync("docker", ["exec", CONTAINER, "bash", "-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (check && result.status !== 0) throw new Error(`Failed in the container (${result.status}): ${script}\n${result.stdout}\n${result.stderr}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};
let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${what}${!ok && detail ? `\n${detail.trim().split("\n").map(line => `    ${line}`).join("\n")}` : ""}`); if (!ok) failures++; };
const keyIdOf = raw => createHash("sha256").update(raw).digest("hex").slice(0, 16);
const rawPublic = privateKey => Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
const signManifest = (file, privateKey) => {
  const bytes = fs.readFileSync(file);
  const signature = sign(null, Buffer.concat([Buffer.from(CONTEXT), Buffer.from([0]), bytes]), privateKey);
  fs.writeFileSync(`${file}.sig`, `${JSON.stringify({ keyId: keyIdOf(rawPublic(privateKey)), signature: signature.toString("base64url") })}\n`);
};

if (!fs.existsSync(path.join(root, "dist", "src", "server", "cli.js"))) { console.error("Build first: npm run build"); process.exit(1); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lc-install-test-"));
const cleanup = () => {
  if (!keep) spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  fs.rmSync(work, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  // A throwaway signing key, embedded in the copy that is packed.
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const raw = rawPublic(privateKey);
  const source = path.join(work, "source");
  for (const item of ["package.json", "package-lock.json", "dist/src", "deploy/server", "scripts/pack-server.mjs", "scripts/prepare-llama-runtime.mjs",
    "scripts/verify-package-secrets.mjs", "scripts/lib", "resources/models", "resources/llama/runtime-manifest.json", "resources/llama/THIRD_PARTY_NOTICES.txt", "apps/cloud/package.json"]) {
    if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(source, item), { recursive: true });
  }
  const pkgFile = path.join(source, "package.json");
  fs.writeFileSync(pkgFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, "utf8")), version: VERSION }, null, 2)}\n`);
  const keysFile = path.join(source, "dist", "src", "update", "releaseKeys.js");
  const keys = fs.readFileSync(keysFile, "utf8");
  if (!/exports\.RELEASE_KEYS = \[\];/.test(keys)) throw new Error("dist/src/update/releaseKeys.js has an unexpected shape.");
  fs.writeFileSync(keysFile, keys.replace("exports.RELEASE_KEYS = [];", `exports.RELEASE_KEYS = [{ id: "${keyIdOf(raw)}", publicKey: "${raw.toString("base64url")}" }];`));

  console.log("Packing a linux release in a container…");
  // Packed inside the container's own filesystem: a Docker Desktop mount does not keep file modes.
  const out = path.join(work, "out");
  fs.mkdirSync(out);
  docker(["run", "--rm", "-v", `${source}:/src:ro`, "-v", `${out}:/out`, "node:22-bookworm", "bash", "-c",
    "cp -a /src /build && cd /build && node scripts/pack-server.mjs --out /build/out --skip-llama --url-base http://127.0.0.1:8977/ && cp /build/out/*.tar.gz /build/out/server-manifest.json /build/out/install.sh /out/"],
    { stdio: ["ignore", "ignore", "inherit"] });
  signManifest(path.join(out, "server-manifest.json"), createPrivateKey(pem));
  const installer = fs.readFileSync(path.join(out, "install.sh"), "utf8");
  check(installer.includes(`RELEASE_KEYS="${keyIdOf(raw)}:${raw.toString("base64url")}"`), "the published installer carries the release key");

  console.log(`Starting ${distro} with systemd…`);
  docker(["build", "-q", "-t", IMAGE, "-"], { input: [...DISTROS[distro], NO_BINFMT, 'CMD ["/sbin/init"]'].join("\n") });
  docker(["run", "-d", "--name", CONTAINER, "--privileged", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--tmpfs", "/run", "--tmpfs", "/tmp", IMAGE]);
  for (let waited = 0; ; waited += 1) {
    if (inContainer("systemctl is-system-running 2>/dev/null | grep -Eq 'running|degraded'", { check: false }).status === 0) break;
    if (waited > 60) throw new Error("systemd did not start in the container.");
    execFileSync("sleep", ["1"]);
  }
  docker(["cp", `${out}/.`, `${CONTAINER}:/release`]);
  docker(["exec", "-d", CONTAINER, "python3", "-m", "http.server", "8977", "--bind", "127.0.0.1", "--directory", "/release"]);
  inContainer("for i in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:8977/server-manifest.json && exit 0; sleep 0.5; done; exit 1");
  // Remote, error reports and the update check stay off in this test.
  inContainer("mkdir -p /etc/local-cognitive && printf 'LOCAL_COGNITIVE_REMOTE=off\\nLOCAL_COGNITIVE_SENTRY=off\\nLOCAL_COGNITIVE_UPDATE_CHECK=off\\n' > /etc/local-cognitive/server.env");
  const install = (options = "") => inContainer(`bash /release/install.sh --manifest-url http://127.0.0.1:8977/server-manifest.json --no-pair ${options} 2>&1`, { check: false });

  // Refusals first: nothing may be installed from a changed or foreign release.
  inContainer("cp /release/server-manifest.json /tmp/manifest.orig && sed -i 's/\"channel\": \"stable\"/\"channel\": \"stabl3\"/' /release/server-manifest.json");
  let result = install();
  check(result.status !== 0 && /signature does not verify/.test(result.output), "a changed manifest is refused", result.output);
  inContainer("cp /tmp/manifest.orig /release/server-manifest.json");
  const tarball = `/release/local-cognitive-server-${VERSION}-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
  inContainer(`cp ${tarball} /tmp/tarball.orig && printf 'x' | dd of=${tarball} bs=1 seek=100 conv=notrunc 2>/dev/null`);
  result = install();
  check(result.status !== 0 && /does not match the signed release/.test(result.output), "a changed download is refused", result.output);
  inContainer(`cp /tmp/tarball.orig ${tarball}`);
  const foreign = generateKeyPairSync("ed25519").privateKey;
  fs.copyFileSync(path.join(out, "server-manifest.json"), path.join(work, "foreign.json"));
  signManifest(path.join(work, "foreign.json"), foreign);
  docker(["cp", path.join(work, "foreign.json.sig"), `${CONTAINER}:/release/server-manifest.json.sig`]);
  result = install();
  check(result.status !== 0 && /does not trust/.test(result.output), "a release signed by another key is refused", result.output);
  docker(["cp", path.join(out, "server-manifest.json.sig"), `${CONTAINER}:/release/server-manifest.json.sig`]);
  check(inContainer("test ! -e /opt/local-cognitive && ! id local-cognitive 2>/dev/null", { check: false }).status === 0, "nothing was installed by the refused attempts");

  if (distro === "ubuntu") {
    const dash = inContainer("sh /release/install.sh 2>&1", { check: false });
    check(dash.status === 1 && /Run the installer with bash/.test(dash.output), "run with sh (dash), it says to use bash", dash.output);
  }

  // The real install.
  result = install();
  check(result.status === 0 && /is installed and running/.test(result.output) && /Remote is turned off on this server/.test(result.output),
    "the installer installs and starts the server, and says Remote is off here", result.output);
  check(inContainer("! ls -d /tmp/tmp.* 2>/dev/null", { check: false }).status === 0, "the installer leaves no download behind");
  check(inContainer("systemctl is-active local-cognitive", { check: false }).output.trim() === "active", "the systemd service is active");
  check(inContainer(`readlink /opt/local-cognitive/current`, { check: false }).output.trim() === `releases/${VERSION}`, "current points to the release");
  check(/^root root 755$/m.test(inContainer("stat -c '%U %G %a' /opt/local-cognitive/current/dist/src/server /usr/local/bin/local-cognitive-server | sort -u", { check: false }).output),
    "the release and the command are root's", inContainer("stat -c '%n %U %G %a' /opt/local-cognitive/current/dist/src/server /usr/local/bin/local-cognitive-server", { check: false }).output);
  check(inContainer("stat -c '%U %a' /srv/local-cognitive /etc/local-cognitive/vault.key", { check: false }).output.trim() === "local-cognitive 700\nlocal-cognitive 600",
    "the data and the credential key are private to the server's user", inContainer("stat -c '%n %U %a' /srv/local-cognitive /etc/local-cognitive/vault.key", { check: false }).output);
  check(inContainer("ps -o user= -C node | sort -u", { check: false }).output.trim() === "local-cognitive", "the server does not run as root");
  let status = "";
  for (let waited = 0; waited < 30 && !/running/.test(status); waited++) { status = inContainer("local-cognitive-server status 2>&1", { check: false }).output; execFileSync("sleep", ["1"]); }
  check(/Local Cognitive Server 0\.1\.0-installtest\.1 — running/.test(status) && /Remote: +off/.test(status), "sudo local-cognitive-server status", status);
  const asUser = inContainer("useradd -m someone 2>/dev/null; runuser -u someone -- local-cognitive-server status 2>&1", { check: false });
  check(asUser.status === 78 && /Run: sudo local-cognitive-server status/.test(asUser.output), "another user is told to use sudo", asUser.output);
  const pairOff = inContainer("local-cognitive-server pair --no-wait 2>&1", { check: false });
  check(pairOff.status !== 0 && /Remote is (turned )?off|not connected/i.test(pairOff.output), "pair explains why it cannot work while Remote is off", pairOff.output);
  const help = inContainer("local-cognitive-server < /dev/null 2>&1", { check: false });
  check(help.status === 0 && /Usage: local-cognitive-server/.test(help.output), "without a terminal, the bare command prints the help", help.output);
  const consoleRun = inContainer("printf 'status\\nexit\\n' | script -qec local-cognitive-server /dev/null | sed 's/\\x1b\\[[0-9;?]*[A-Za-z]//g'", { check: false });
  check(/Welcome to Local Cognitive Server!/.test(consoleRun.output) && /Server +running/.test(consoleRun.output) && /Bye\. The server keeps running\./.test(consoleRun.output),
    "in a terminal, the bare command opens the console", consoleRun.output);
  const again = install();
  check(again.status === 0 && /already installed/.test(again.output), "running the installer again only says how to update", again.output);
  check(inContainer("test -f /opt/local-cognitive/.installed", { check: false }).status === 0, "a finished install leaves its marker");
  // Interrupted before the end (no marker, no unit yet): running the installer again finishes it.
  inContainer("rm -f /opt/local-cognitive/.installed /etc/systemd/system/local-cognitive.service && systemctl daemon-reload");
  const resumed = install();
  check(resumed.status === 0 && /Finishing an installation that was interrupted/.test(resumed.output) && /is installed and running/.test(resumed.output)
    && inContainer("systemctl is-active local-cognitive", { check: false }).output.trim() === "active", "an interrupted install is finished by running it again", resumed.output);
  const restart = inContainer("local-cognitive-server restart && sleep 3 && systemctl is-active local-cognitive", { check: false });
  check(restart.output.trim().endsWith("active"), "sudo local-cognitive-server restart", restart.output);

  // Uninstall keeps the data.
  const removed = inContainer("local-cognitive-server uninstall 2>&1", { check: false });
  check(removed.status === 0 && /Kept: the data/.test(removed.output), "uninstall removes the server and says what it kept", removed.output);
  check(inContainer("test ! -e /opt/local-cognitive && test ! -e /usr/local/bin/local-cognitive-server && test ! -e /etc/systemd/system/local-cognitive.service && test -d /srv/local-cognitive && test -f /etc/local-cognitive/vault.key", { check: false }).status === 0,
    "the release, the command and the unit are gone; the data and the key are kept");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failures++;
}
console.log(failures ? `\n${failures} check(s) failed${keep ? ` (container ${CONTAINER} kept)` : ""}.` : "\nThe installer works end to end.");
process.exitCode = failures ? 1 : 0;
