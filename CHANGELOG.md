# Changelog

## 0.1.3 — 2026-10-11

Synthesis tests on your own GPU server, and Local Cognitive's license.

### Synthesis

- **Contract tests run on a Linux server.** The server installer sets up bubblewrap, and the service may now create the namespaces its sandbox needs. Inside the sandbox, the code under test can no longer create user namespaces of its own (bubblewrap 0.8 or later).
- **A server installed before 0.1.3:** after updating, run `sudo local-cognitive-server sandbox` once. It installs bubblewrap and the service's new settings, then restarts the server; accepted work finishes first. On Ubuntu 24.04 and later it also turns on the distribution's AppArmor profile for bubblewrap.
- C++ tests on a server need a compiler: `sudo dnf install gcc-c++` or `sudo apt install g++`.

### Server

- `update` and `rollback` now run each release with its own service settings, so later changes arrive with updates. Settings you add with `systemctl edit` are kept.

### Desktop

- Light theme: the arrow next to the microphone no longer sits in an oval.

### License

- Local Cognitive is source available under the Elastic License 2.0. You may use, copy, change and share it; you may not offer it as a hosted or managed service or get around its license-key features. See [License](https://docs.local-cognitive.com/reference/license/).

### Known limits

- Tests don't run on Windows yet, which has no sandbox. The architecture gates work everywhere.

## 0.1.2 — 2026-10-11

Synthesis for real modules: a contract keeps a small local model on the architecture the engineer designed.

### Synthesis

- **Your tests decide.** `Tests(...)` runs the engineer's own tests, kept next to the contract, against every candidate in a sandbox: TypeScript and JavaScript (Node.js 22.18 or newer), Python 3, and C++20 built with AddressSanitizer and UndefinedBehaviorSanitizer. Each failure goes back to the model as an exact item: the test, the expected and actual values, and its file and line. `hidden = true` keeps a holdout set sealed.
- **Frozen interfaces.** `frozen "include/AbilitySystem.h"` marks a file the engineer wrote: the model reads it in every revision and cannot change it.
- **Architecture gates.** `Exports` checks the public shape, `Imports` what may depend on what (no `<thread>` in a game core, no `node:fs` in a domain layer), and `Forbid` what the code may not use, outside comments and strings.
- **More languages.** A module may be TypeScript, Python, C or C++, besides HTML, CSS and JavaScript. Replies in a code block labelled `c++` are no longer dropped.
- **A sandbox for every test run:** no network, writes only to its own folder, nothing read from your folders, and no other program to act for it: `sandbox-exec` on macOS, bubblewrap on Linux. The module's code may not reach into the test harness, and each result line is signed for its run.
- **To start:** New module → **Rate limiter (TypeScript, with tests)**. For C++, the [ability system example](https://github.com/Ilyaberdar/local-cognitive-AI-system/tree/main/examples/synthesis-ability-system) builds an engine-agnostic core in the spirit of Unreal's Gameplay Ability System against a frozen header.
- The gates panel lists every test with its result.

### Desktop

- **macOS 13.3 or later**, which the bundled model and speech runtimes need.

### Known limits

- Tests don't run on Windows yet, which has no sandbox, or on a Linux server, whose service may not create the namespaces bubblewrap needs. The architecture gates work everywhere.

## 0.1.1 — 2026-10-11

The first public release of Local Cognitive: private chats, agents and workflows with models on your own computer, or on your own GPU server through Remote.

### Desktop

- **macOS (Apple silicon).** Signed and notarized. New versions install from the app: the update button in the title bar, or Settings → About.
- **Windows (x64), new.**
  - Models run on any GPU through Vulkan. On a PC with an NVIDIA GPU, the app offers the CUDA build: about 515 MB, after NVIDIA's license.
  - The installer is not signed yet. Windows asks once (More info → Run anyway), and the app announces new versions with a link to this page.
- **Clearer model errors.** A model file that the bundled runtime cannot read now says why, for example a format made for a modified llama.cpp. The error can be dismissed.
- **Split models.** Models made of several GGUF files install and import.
- **GPU memory.** Models shows the GPU's memory beside RAM.
- **Server models in answers.** Answers from a server name the server's model.
- **Menus.** A click anywhere closes an open menu, the title bar included.

### Server (Linux)

- **Several NVIDIA GPUs.** The service sees every NVIDIA GPU: each one gets its device file when the service starts.
- **Install:**

  ```
  curl -fsSL https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/install.sh | sudo bash
  ```

- **Update:**

  ```
  sudo local-cognitive-server update
  ```
