# Desktop Platform Build Guide

This guide describes how to build the desktop application with its bundled local inference and dictation runtimes. It applies to the Electron desktop distribution, not the standalone HTTP server.

## What a distribution contains

Every desktop package includes:

- the Electron application and compiled server/UI code;
- the pinned `llama.cpp` runtime for the target CPU architecture;
- the local Whisper CLI used for voice dictation;
- recommended-model metadata and third-party notices.

Downloaded GGUF models, conversation data, settings, and local files are stored in the user's application-data directory. They are not embedded in the DMG or Windows installer.

## Common prerequisites

- Node.js 18.18 or newer (the current project is tested with Node 22);
- npm;
- an internet connection for first-time runtime preparation;
- dependencies installed with `npm install` or `npm ci`.

Run all commands from the repository root:

```bash
cd /path/to/local-cognitive-AI-system
```

The full platform commands download the exact `llama.cpp` release declared in `resources/llama/runtime-manifest.json`, verify its SHA-256 checksum, compile Whisper from the version declared in `resources/speech/runtime-manifest.json`, compile the application, and package it.

## macOS

### Build prerequisites

Install Xcode Command Line Tools and CMake:

```bash
xcode-select --install
brew install cmake
```

The speech runtime is compiled locally with Metal enabled. CMake is required even when the rest of the application is JavaScript.

### Apple Silicon (arm64)

On an Apple Silicon Mac, run:

```bash
npm run dist:mac:arm64
```

The outputs are:

```text
release/Local Cognitive AI System-0.1.0-arm64.dmg
release/mac-arm64/Local Cognitive AI System.app
```

Verify both embedded native runtimes before distribution:

```bash
node scripts/verify-packaged-runtime.mjs \
  "release/mac-arm64/Local Cognitive AI System.app"

node scripts/verify-speech-runtime.mjs \
  "release/mac-arm64/Local Cognitive AI System.app"
```

### Intel Mac (x64)

On macOS, run:

```bash
npm run dist:mac:x64
```

This writes the x64 DMG and application under `release/` and `release/mac/` or the architecture-specific output directory selected by electron-builder.

### Both macOS architectures

To prepare and package both arm64 and x64 builds on macOS:

```bash
npm run dist:mac
```

This produces separate architecture-specific packages. It does not create one universal binary.

### Signing and notarization

The repository does not provide a Developer ID certificate or notarization credentials. A local build is unsigned unless the build environment supplies those credentials. macOS may show a Gatekeeper warning for an unsigned application distributed outside the App Store.

## Windows x64

Build Windows packages on a Windows x64 machine. The speech-runtime preparation script intentionally refuses to cross-compile from another operating system.

### Build prerequisites

Install:

- Node.js 18.18 or newer;
- CMake;
- Visual Studio Build Tools with the C++ desktop workload;
- a Windows SDK.

Then run from PowerShell or Command Prompt:

```powershell
npm run dist:win
```

electron-builder creates the NSIS installer in `release/`. The installer lets the user choose the installation directory and is not configured as a per-machine installer.

## Development build without packaging

To compile the server and UI only:

```bash
npm run build
```

To start the desktop application after compiling it:

```bash
npm run electron
```

These commands do not regenerate the bundled llama.cpp or Whisper runtimes.

## Packaging with an existing speech runtime

The standard `dist:*` commands always rebuild Whisper. When the checked-in `resources/speech/<platform>-<arch>/` runtime has already been verified and no voice-runtime code has changed, a package can be rebuilt without CMake:

```bash
npm run build
./node_modules/.bin/electron-builder --mac dmg --arm64
```

Use this only on macOS arm64 for the command shown above. It packages the existing runtime resources, so it must not substitute for a full runtime build after changing Whisper versions, build flags, or native code.

## Troubleshooting

### `spawnSync cmake ENOENT`

CMake is missing or unavailable on `PATH`. On macOS, install it with:

```bash
brew install cmake
```

Then confirm the shell can find it:

```bash
cmake --version
```

### Runtime download fails

The full build needs access to GitHub for the pinned llama.cpp archive and to GitHub's source archive endpoint for Whisper. Verify the network connection, proxy configuration, and DNS resolution, then rerun the complete platform command.

### DMG creation fails

DMG creation invokes the macOS `hdiutil` utility. Run the build from a normal macOS user session with permission to create disk images. The unpacked `.app` in `release/mac-arm64/` is still useful for local verification if the final DMG step fails.

### A model library appears empty after installing a new build

The model library is profile data, not part of the package. Launch the application with the same macOS user account and application identifier; do not delete the application's support directory when replacing the `.app`.
