import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseUnit, replaceUnit } from "../src/update/systemdService";

const unit = fs.readFileSync("deploy/server/local-cognitive.service", "utf8");
const directive = (name: string) => unit.split("\n").find(line => line.startsWith(`${name}=`))?.slice(name.length + 1);
const shellFunction = (file: string, name: string) => {
  const text = fs.readFileSync(file, "utf8"), start = text.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${file} defines ${name}`);
  return text.slice(start + 1, text.indexOf("\n}\n", start) + 2);
};

test("the service may make the namespaces bubblewrap needs, and nothing covers part of its /proc", () => {
  assert.equal(directive("RestrictNamespaces"), "user mnt pid ipc net uts cgroup");
  // Each of these mounts over part of /proc, and the kernel then refuses the sandbox a /proc of its own.
  for (const name of ["ProtectKernelTunables", "ProtectKernelLogs", "ProtectHostname", "ProcSubset"]) assert.equal(directive(name), undefined, name);
  assert.match(directive("RestrictAddressFamilies")!, /\bAF_NETLINK\b/, "bubblewrap brings the loopback of its network up through netlink");
  // The rest of the hardening stays.
  for (const [name, value] of [["NoNewPrivileges", "true"], ["ProtectSystem", "strict"], ["ProtectHome", "read-only"], ["PrivateTmp", "true"],
    ["ProtectKernelModules", "true"], ["ProtectControlGroups", "true"], ["RestrictSUIDSGID", "true"], ["LockPersonality", "true"], ["CapabilityBoundingSet", ""]]) {
    assert.equal(directive(name), value, name);
  }
});

test("the installer and the server's own command set bubblewrap up the same way", () => {
  for (const name of ["install_package", "setup_sandbox"]) {
    assert.equal(shellFunction("deploy/server/local-cognitive-server", name), shellFunction("deploy/server/install.sh", name), name);
  }
  assert.match(shellFunction("deploy/server/install.sh", "setup_sandbox"), /install_package bubblewrap bubblewrap/);
  assert.match(fs.readFileSync("deploy/server/install.sh", "utf8"), /\n  setup_sandbox \|\| say "Warning: /, "a failure leaves the install going, with a warning");
  const command = fs.readFileSync("deploy/server/local-cognitive-server", "utf8");
  const sandbox = command.slice(command.indexOf("\n  sandbox)"), command.indexOf(";;", command.indexOf("\n  sandbox)")));
  assert.match(sandbox, /need_root/);
  assert.match(sandbox, /setup_sandbox \|\|/);
  assert.match(sandbox, /grep -qs "\$PREFIX\/current\/" "\$unit"/, "only a unit a release installed is replaced");
  assert.match(sandbox, /"\$PREFIX\/current\/deploy\/server\/local-cognitive\.service"/, "with the running release's unit");
  assert.match(sandbox, /systemctl daemon-reload/);
  assert.match(command, /^#   sudo local-cognitive-server sandbox /m, "its help names it");
});

test("a release's unit replaces the installed one: with this host's data folder, only when it differs and only if a release installed it", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-unit-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const release = path.join(base, "releases", "0.2.0"), file = path.join(base, "local-cognitive.service");
  fs.mkdirSync(path.join(release, "deploy", "server"), { recursive: true });
  fs.copyFileSync("deploy/server/local-cognitive.service", path.join(release, "deploy", "server", "local-cognitive.service"));
  const options = { prefix: "/opt/local-cognitive", dataDir: "/data/lc" };
  const wanted = releaseUnit(release, options.dataDir);
  assert.ok(wanted.includes("ReadWritePaths=/data/lc\n") && wanted.includes("--data-dir /data/lc ") && !wanted.includes("/srv/local-cognitive"));

  fs.writeFileSync(file, unit.replace("RestrictNamespaces=user mnt pid ipc net uts cgroup", "RestrictNamespaces=true"));
  assert.equal(replaceUnit(file, release, options), true);
  assert.equal(fs.readFileSync(file, "utf8"), wanted);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "644");
  assert.equal(replaceUnit(file, release, options), false, "the same unit is left alone");

  const handMade = "[Service]\nExecStart=/usr/bin/node /srv/app/cli.js start\n";
  fs.writeFileSync(file, handMade);
  assert.equal(replaceUnit(file, release, options), false);
  assert.equal(fs.readFileSync(file, "utf8"), handMade, "a unit the administrator wrote stays theirs");
  fs.writeFileSync(file, unit);
  assert.equal(replaceUnit(file, path.join(base, "releases", "0.1.0"), options), false, "a release without a unit changes nothing");
  assert.equal(fs.readFileSync(file, "utf8"), unit);
  assert.deepEqual(fs.readdirSync(base).sort(), ["local-cognitive.service", "releases"], "no temporary file is left");

  // Root takes only what nobody else can change, and never makes the server root.
  const shipped = path.join(release, "deploy", "server", "local-cognitive.service"), old = unit.replace("RestrictNamespaces=user mnt pid ipc net uts cgroup", "RestrictNamespaces=true");
  fs.writeFileSync(file, old);
  fs.chmodSync(shipped, 0o666);
  assert.equal(replaceUnit(file, release, options), false, "a unit other users may change");
  fs.chmodSync(path.join(release, "deploy"), 0o777);
  fs.chmodSync(shipped, 0o644);
  assert.equal(replaceUnit(file, release, options), false, "a unit in a folder other users may change");
  fs.chmodSync(path.join(release, "deploy"), 0o755);
  fs.rmSync(shipped);
  fs.writeFileSync(path.join(base, "elsewhere.service"), unit);
  fs.symlinkSync(path.join(base, "elsewhere.service"), shipped);
  assert.equal(replaceUnit(file, release, options), false, "a link out of the release");
  fs.rmSync(shipped);
  fs.writeFileSync(shipped, unit.replace(/^User=.*$/m, "User=root"));
  assert.equal(replaceUnit(file, release, options), false, "a unit that runs the server as root");
  fs.writeFileSync(shipped, unit.replace(/^User=.*\n/m, ""));
  assert.equal(replaceUnit(file, release, options), false, "a unit without a user of its own");
  assert.equal(fs.readFileSync(file, "utf8"), old, "the installed unit stays as it was");
});
