import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const wrapper = fs.readFileSync("deploy/server/local-cognitive-server", "utf8");
const installer = fs.readFileSync("deploy/server/install.sh", "utf8");
// GPU 0 and nvidia-uvm as before (a release without gpu-devices still starts), then every GPU.
const DROP_IN = "printf '[Service]\\nExecStartPre=-+/usr/bin/nvidia-modprobe -u -c=0\\nExecStartPre=-+/usr/local/bin/local-cognitive-server gpu-devices\\n'";

test("a GPU host gets a device file for every GPU before the service starts, set up alike by the installer and the cuda command", { skip: process.platform === "win32" }, () => {
  assert.ok(installer.includes(DROP_IN), "the installer writes the drop-in");
  assert.ok(wrapper.includes(DROP_IN), "the cuda command writes the same drop-in, over an older one too");
  const body = /\n {2}gpu-devices\)\n([\s\S]*?) ;;\n/.exec(wrapper)?.[1];
  assert.ok(body, "the gpu-devices command");

  // The command itself, against a driver's /proc listing of three GPUs (minors 0, 1 and 5).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-gpu-devices-"));
  try {
    const gpus = path.join(root, "gpus"), calls = path.join(root, "calls"), modprobe = path.join(root, "nvidia-modprobe");
    for (const [bus, minor] of [["0000:02:00.0", 0], ["0000:03:00.0", 1], ["0000:81:00.0", 5]] as const) {
      fs.mkdirSync(path.join(gpus, bus), { recursive: true });
      fs.writeFileSync(path.join(gpus, bus, "information"), `Model: \t\t NVIDIA GeForce RTX 3090\nIRQ:   \t\t 120\nGPU UUID: \t GPU-${minor}\nDevice Minor: \t ${minor}\nBus Location: \t ${bus}\n`);
    }
    fs.writeFileSync(modprobe, `#!/bin/sh\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
    assert.ok(body.includes("repair_runtimes || true"), "it also repairs the CUDA runtime's links, without ever failing the start");
    const script = "set -euo pipefail\nneed_root() { :; }\nrepair_runtimes() { :; }\n" + body.replaceAll("/proc/driver/nvidia/gpus", gpus).replaceAll("/usr/bin/nvidia-modprobe", modprobe);
    execFileSync("bash", ["-c", script]);
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["-u -c=0", "-c=1", "-c=5"]);

    // Without the driver (no /proc listing, nvidia-modprobe failing) the service still starts.
    fs.rmSync(gpus, { recursive: true }); fs.writeFileSync(modprobe, "#!/bin/sh\nexit 1\n");
    execFileSync("bash", ["-c", script]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
