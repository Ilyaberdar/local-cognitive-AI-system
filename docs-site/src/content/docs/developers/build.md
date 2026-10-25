---
title: Build from source
description: Run Local Cognitive from a checkout, run the tests, and build the installers and the server release.
---

## Run from source

You need Node.js 22.16 or newer and npm, plus CMake and a C++ compiler for the speech runtime.

```bash
git clone https://github.com/Ilyaberdar/local-cognitive-AI-system.git
cd local-cognitive-AI-system
npm ci
npm run prepare:llama     # the pinned llama.cpp for this machine
npm run prepare:speech    # whisper.cpp for dictation
npm run electron          # the desktop app
npm run dev               # or the browser UI: open the link it prints
```

Development runs keep their data in the system's user-data folder under `local-cognitive-ai-system`, apart from an installed app. The browser UI and headless runs read `.env` (see `.env.example`); the desktop app keeps its settings in the app.

The local HTTP API (`http://127.0.0.1:3000` for `npm start` and `npm run dev`) needs its key for every request but `/health`. `npm start` prints a link, `http://127.0.0.1:3000/?token=…`: opening it signs the browser in with an HttpOnly cookie, and the key stays the same across restarts (it is kept in `app/runtime/api-token` in the data folder). A script sends the key as `Authorization: Bearer <key>`:

```bash
curl -H "Authorization: Bearer $(cat <data folder>/app/runtime/api-token)" http://127.0.0.1:3000/sessions
```

The desktop app makes a new key at every launch and keeps it in memory; a server makes one at every start (`sudo local-cognitive-server api-token`).

## Tests

```bash
npm test                                         # the full suite
LLAMA_CPP_INTEGRATION=1 LLAMA_TEST_DATA_DIR=/tmp/llama-acceptance npm run test:llama
node scripts/test-server-install.mjs --distro fedora    # installer, update and rollback in Docker systemd
```

`test:llama` downloads about 1.8 GB of small models and runs real inference: downloads, loading, chat, workflows and an offline restart.

## Desktop builds

**macOS.** `npm run dist:mac:arm64` builds the dmg and the zip in `release/`. For a release:

```bash
CSC_NAME=<Developer ID identity> APPLE_KEYCHAIN_PROFILE=<notarytool profile> \
  npx electron-builder --mac dmg zip --arm64 --publish never -c.forceCodeSigning=true
npm run verify:release -- --team-id <team id>
```

`verify:release` refuses to pass anything that isn't signed with the Developer ID, hardened, notarized and stapled.

**Windows.** The **Windows installer** workflow in GitHub Actions builds the NSIS installer with the Vulkan llama.cpp and the Visual C++ runtime beside it, checks that every runtime starts with all its libraries, and runs a silent install and uninstall. `npm run dist:win` builds the same on a Windows machine.

## Server releases

On Linux x64:

```bash
npm ci && npm run build
node scripts/pack-server.mjs --out release/server --platform linux --arch x64 \
  --url-base https://github.com/<owner>/<repo>/releases/download/v<version>/ --notes-file NOTES.md
node scripts/release-key.mjs sign release/server/server-manifest.json --key <private key>
```

`pack-server` builds a tarball with the compiled server, its production packages, a pinned Node and the CPU llama.cpp, with no links or credentials, plus `server-manifest.json` and `install.sh`. The release key signs the manifest; its public part is built into the server (`src/update/releaseKeys.ts`).

The CUDA runtime for servers comes from the **llama-cuda-runtime** workflow. It builds `libggml-cuda.so` for every NVIDIA architecture from the pinned llama.cpp and publishes it with NVIDIA's libraries as a prerelease that `resources/llama/runtime-manifest.json` pins by SHA-256.

## Where things are

| Path | What it is |
| --- | --- |
| `electron/` | The desktop shell: windows, updates, preload bridges |
| `src/` | The backend shared by the app and the server: chats, agents, models, Remote, workflows |
| `public/` | The UI |
| `apps/cloud/` | The Cloud API and relay (Node 24, Postgres 17) |
| `deploy/server/` | The installer, the server command and the systemd unit |
| `resources/llama/` | The pinned llama.cpp builds (`runtime-manifest.json`) |
| `docs-site/` | This documentation (Astro Starlight) |
