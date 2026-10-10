#!/usr/bin/env bash
# Local Cognitive Server installer (Linux with systemd):
#
#   curl -fsSL https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/install.sh | sudo bash
#
# Downloads the newest release, checks its signature and checksum before running anything from it,
# installs it as a systemd service (with the CUDA runtime when an NVIDIA GPU is present) and prints
# the key that connects your computer. No sign-in is needed on the server: the first account that
# connects with the key owns it. Run again on an installed server, it only says how to update.
#
# Options (curl … | sudo bash -s -- <options>):
#   --data-dir <dir>   where the server keeps its data (default /srv/local-cognitive)
#   --cpu              do not install the CUDA runtime
#   --no-pair          do not print a connection key at the end
#   --yes              accept the NVIDIA license notice without asking (CUDA)
#   --manifest-url <url>  another release manifest (https, or http on this machine for tests)
#
# Supported: Linux x64 with glibc 2.34+ and libstdc++ from GCC 12+ (Ubuntu 22.04+, Debian 12+,
# Fedora 36+, Amazon Linux 2023), OpenSSL 3 and systemd.

# Plain sh up to here: `curl … | sudo sh` is told to use bash instead of failing on bash syntax.
if [ -z "${BASH_VERSION:-}" ]; then echo "Run the installer with bash: curl -fsSL <installer URL> | sudo bash" >&2; exit 1; fi
set -euo pipefail

# Release signing keys: "id:public-key" (raw Ed25519, base64url), filled in by scripts/pack-server.mjs.
RELEASE_KEYS=""
DEFAULT_MANIFEST_URL="https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/server-manifest.json"
SIGNATURE_CONTEXT="lc-release-manifest/v1"

PREFIX="/opt/local-cognitive"
DATA_DIR="/srv/local-cognitive"
SERVICE_USER="local-cognitive"
UNIT="local-cognitive"
VAULT_KEY_FILE="/etc/local-cognitive/vault.key"
COMMAND="/usr/local/bin/local-cognitive-server"
WORK=""

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nInstallation failed: %s\n' "$*" >&2; exit 1; }

download() { # url file
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https,http' --retry 3 -o "$2" "$1"
  else wget -q -O "$2" "$1"; fi
}

base64url_decode() {
  local value
  value=$(printf '%s' "$1" | tr '_-' '/+')
  case $(( ${#value} % 4 )) in 2) value="$value==" ;; 3) value="$value=" ;; esac
  printf '%s' "$value" | base64 -d
}

# The manifest's signature: Ed25519 over "context \0 manifest" by one of RELEASE_KEYS.
verify_manifest() { # manifest signature-json workdir
  local manifest="$1" signature_file="$2" work="$3" key_id signature entry public=""
  key_id=$(sed -n 's/.*"keyId" *: *"\([0-9a-f]\{16\}\)".*/\1/p' "$signature_file")
  signature=$(sed -n 's/.*"signature" *: *"\([A-Za-z0-9_-]\{40,\}\)".*/\1/p' "$signature_file")
  [ -n "$key_id" ] && [ -n "$signature" ] || fail "the release signature is unreadable."
  for entry in $RELEASE_KEYS; do
    if [ "${entry%%:*}" = "$key_id" ]; then public="${entry#*:}"; fi
  done
  [ -n "$public" ] || fail "the release is signed by key $key_id, which this installer does not trust."
  # SubjectPublicKeyInfo for Ed25519: a fixed 12-byte prefix, then the 32-byte key.
  { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; base64url_decode "$public"; } > "$work/key.der"
  { printf '%s' "$SIGNATURE_CONTEXT"; printf '\0'; cat "$manifest"; } > "$work/signed"
  base64url_decode "$signature" > "$work/signature"
  openssl pkeyutl -verify -pubin -keyform DER -inkey "$work/key.der" -rawin -in "$work/signed" -sigfile "$work/signature" >/dev/null 2>&1
}

# version, then url size sha256 of the artifact for this platform, from the signed manifest
# (pretty-printed by scripts/pack-server.mjs: one field per line).
read_manifest() { # manifest platform arch
  awk -v platform="$2" -v arch="$3" '
    /^  "version": "/ { split($0, part, "\""); version = part[4] }
    /^      "platform": "/ { split($0, part, "\""); p = part[4] }
    /^      "arch": "/ { split($0, part, "\""); a = part[4] }
    /^      "url": "/ { split($0, part, "\""); u = part[4] }
    /^      "size": / { s = $2; gsub(/[^0-9]/, "", s) }
    /^      "sha256": "/ { split($0, part, "\""); h = part[4] }
    /^    }/ { if (p == platform && a == arch) found = u " " s " " h; p = a = u = s = h = "" }
    END { if (version != "" && found != "") print version, found }
  ' "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1; fi
}

# The terminal of whoever runs the installer, if any (cloud-init and Ansible have none).
has_terminal() { [ -t 1 ] && (exec </dev/tty) 2>/dev/null; }

# An NVIDIA GPU on the PCI bus, whether or not its driver is installed.
nvidia_gpu_present() {
  local device
  for device in /sys/bus/pci/devices/*; do
    [ "$(cat "$device/vendor" 2>/dev/null)" = 0x10de ] || continue
    case "$(cat "$device/class" 2>/dev/null)" in 0x0300* | 0x0302*) return 0 ;; esac
  done
  return 1
}

install_package() { # apt-name dnf-name
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$1" >/dev/null 2>&1 \
      || { apt-get update -q >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$1" >/dev/null 2>&1; }
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$2" >/dev/null 2>&1
  elif command -v zypper >/dev/null 2>&1; then zypper -n -q install "$1" >/dev/null 2>&1
  else return 1; fi
}

as_service_user() { (cd / && runuser -u "$SERVICE_USER" -- env LOCAL_COGNITIVE_DATA_DIR="$DATA_DIR" LOCAL_COGNITIVE_VAULT_KEY_FILE="$VAULT_KEY_FILE" "$@"); }

main() {
  local manifest_url="${LOCAL_COGNITIVE_MANIFEST_URL:-$DEFAULT_MANIFEST_URL}" cpu=false pair=true yes=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --data-dir) DATA_DIR="${2:?--data-dir needs a folder}"; shift 2 ;;
      --cpu) cpu=true; shift ;;
      --no-pair) pair=false; shift ;;
      --yes) yes=true; shift ;;
      --manifest-url) manifest_url="${2:?--manifest-url needs a URL}"; shift 2 ;;
      *) fail "unknown option $1" ;;
    esac
  done
  case "$DATA_DIR" in /*) ;; *) fail "--data-dir must be an absolute path." ;; esac
  case "$manifest_url" in https://* | http://127.0.0.1[:/]* | http://localhost[:/]*) ;; *) fail "the release manifest must come over https." ;; esac

  say "Local Cognitive Server installer"
  [ "$(id -u)" -eq 0 ] || fail "run it with sudo: curl -fsSL <installer URL> | sudo bash"
  [ "$(uname -s)" = "Linux" ] || fail "the server runs on Linux."
  [ -d /run/systemd/system ] || fail "this installer needs systemd."
  local arch
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) fail "unsupported processor $(uname -m)." ;; esac
  local tool
  for tool in tar gzip openssl base64 awk sed runuser useradd systemctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing; install it and run the installer again."
  done
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "curl or wget is needed."
  openssl version 2>/dev/null | grep -q '^OpenSSL [3-9]' || fail "OpenSSL 3 or newer is needed to check the release signature (found: $(openssl version 2>/dev/null || echo none))."
  [ -n "$RELEASE_KEYS" ] || fail "this installer trusts no release key: get it from a published release."

  # Installed: the last step wrote the marker (or the unit already runs the release layout).
  if [ -L "$PREFIX/current" ] && { [ -f "$PREFIX/.installed" ] || grep -qs "$PREFIX/current/" "/etc/systemd/system/$UNIT.service"; }; then
    say "Local Cognitive Server $(readlink "$PREFIX/current" | sed 's|.*/||') is already installed."
    say "  Update it:            sudo local-cognitive-server update"
    say "  Connect a computer:   sudo local-cognitive-server pair"
    exit 0
  fi
  [ ! -L "$PREFIX/current" ] || say "Finishing an installation that was interrupted."
  # The developer's own first server predates releases: it moves over with its first signed release.
  [ ! -e "$PREFIX/app" ] || fail "$PREFIX holds an install from before releases ($PREFIX/app): it needs the one-time adopt step, not this installer."

  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  local work="$WORK"

  step "Checking the newest release"
  local attempt
  for attempt in 1 2; do
    download "$manifest_url" "$work/manifest.json" || fail "could not download $manifest_url"
    download "$manifest_url.sig" "$work/manifest.json.sig" || fail "could not download the release signature."
    verify_manifest "$work/manifest.json" "$work/manifest.json.sig" "$work" && break
    # A release published between the two downloads: once more before giving up.
    [ "$attempt" = 1 ] || fail "the release manifest's signature does not verify: it was not made by this project."
  done
  local version url size sha256
  read -r version url size sha256 <<< "$(read_manifest "$work/manifest.json" linux "$arch")" || true
  [ -n "${sha256:-}" ] || fail "the newest release has no build for linux-$arch."
  case "$version" in *[!0-9A-Za-z.+-]* | "") fail "the release version is not valid." ;; esac
  say "Release $version (signature checked)"

  step "Downloading $version ($(( size / 1048576 )) MB)"
  download "$url" "$work/release.tar.gz" || fail "could not download $url"
  [ "$(wc -c < "$work/release.tar.gz" | tr -d ' ')" = "$size" ] && [ "$(sha256_of "$work/release.tar.gz")" = "$sha256" ] \
    || fail "the download does not match the signed release: it was changed or cut short."

  step "Installing"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/local-cognitive --create-home --shell "$(command -v nologin || echo /bin/false)" "$SERVICE_USER"
    say "Created the user $SERVICE_USER (the server never runs as root)."
  fi
  local release="$PREFIX/releases/$version"
  mkdir -p "$PREFIX/releases"
  rm -rf "$release.partial"
  mkdir -p "$release.partial"
  tar -xzf "$work/release.tar.gz" -C "$release.partial" --no-same-owner
  chown -R root:root "$PREFIX" && chmod -R go-w "$PREFIX"
  [ "$(cd / && runuser -u "$SERVICE_USER" -- "$release.partial/node/bin/node" "$release.partial/dist/src/server/cli.js" version 2>/dev/null)" = "$version" ] \
    || fail "the release does not start on this machine."
  rm -rf "$release" && mv "$release.partial" "$release"
  ln -sfn "releases/$version" "$PREFIX/current"

  # The bundled llama.cpp runtime needs OpenMP (not on a minimal Ubuntu or Debian) and a recent libstdc++.
  local runtime="$release/resources/llama/linux-$arch"
  if [ -x "$runtime/llama-server" ]; then
    ldconfig -p 2>/dev/null | grep -q 'libgomp\.so\.1' || install_package libgomp1 libgomp || true
    if ! (cd / && runuser -u "$SERVICE_USER" -- env LD_LIBRARY_PATH="$runtime" "$runtime/llama-server" --version) >/dev/null 2>"$work/runtime.err"; then
      say "Warning: the llama.cpp runtime does not start here, so local models are unavailable:"
      say "  $(grep -v '^$' "$work/runtime.err" | tail -1)"
      say "  It needs glibc 2.34+ and libstdc++ from GCC 12+ (Ubuntu 22.04+, Debian 12+, Fedora 36+, Amazon Linux 2023)."
    fi
  fi

  local cuda="linux-$arch-cuda12" driver
  if ! $cpu && nvidia_gpu_present && ! command -v nvidia-smi >/dev/null 2>&1; then
    say "NVIDIA GPU found, but its driver is not installed: models run on the CPU."
    say "Install NVIDIA driver 570 or newer, reboot, then run: sudo local-cognitive-server cuda"
  elif ! $cpu && nvidia_gpu_present && ! nvidia-smi -L 2>/dev/null | grep -q '^GPU '; then
    say "NVIDIA GPU found, but its driver does not answer (after a driver update, reboot): models run on the CPU."
    say "Then run: sudo local-cognitive-server cuda"
  elif ! $cpu && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | grep -q '^GPU '; then
    driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | cut -d. -f1)
    # The service may not load kernel modules itself (NoNewPrivileges): nvidia-uvm is loaded for it.
    if [ -x /usr/bin/nvidia-modprobe ]; then
      mkdir -p "/etc/systemd/system/$UNIT.service.d"
      printf '[Service]\nExecStartPre=-+/usr/bin/nvidia-modprobe -u -c=0\n' > "/etc/systemd/system/$UNIT.service.d/nvidia.conf"
    fi
    if ! grep -q "\"$cuda\"" "$release/resources/llama/runtime-manifest.json" 2>/dev/null; then
      say "NVIDIA GPU found, but this release has no CUDA runtime for $arch yet: models run on the CPU."
    elif [ "${driver:-0}" -lt 570 ] 2>/dev/null; then
      say "NVIDIA GPU found, but its driver ${driver:-?} is older than 570: models run on the CPU."
      say "After updating the driver: sudo local-cognitive-server cuda"
    else
      step "NVIDIA GPU found: installing the CUDA runtime"
      say "It includes NVIDIA CUDA libraries, redistributed under the NVIDIA CUDA Toolkit license:"
      say "  https://docs.nvidia.com/cuda/eula/"
      if ! $yes && has_terminal; then
        local answer=""
        read -r -p "Accept and install it? [Y/n] " answer < /dev/tty || true
        case "$answer" in [nN]*) cpu=true ;; esac
      fi
      if ! $cpu; then
        (cd / && "$release/node/bin/node" "$release/scripts/prepare-llama-runtime.mjs" --variant "$cuda" --destination "$release/resources/llama/$cuda") \
          || say "The CUDA runtime could not be installed: models run on the CPU. Try again later: sudo local-cognitive-server cuda"
        chown -R root:root "$release/resources" && chmod -R go-w "$release/resources"
      fi
    fi
  fi

  # This host's settings, root-owned; the commands themselves come with the running release.
  cat > /usr/local/bin/local-cognitive-server <<STUB
#!/bin/sh
# Installed by the Local Cognitive Server installer: this host's settings. The commands come with
# the running release (updated with it).
export LC_PREFIX="$PREFIX" LC_DATA_DIR="$DATA_DIR" LC_SERVICE_USER="$SERVICE_USER" LC_UNIT="$UNIT" LC_VAULT_KEY_FILE="$VAULT_KEY_FILE"
exec /usr/bin/env bash "\$LC_PREFIX/current/deploy/server/local-cognitive-server" "\$@"
STUB
  chmod 755 /usr/local/bin/local-cognitive-server
  # RHEL-family and openSUSE sudo do not search /usr/local/bin.
  if command -v sudo >/dev/null 2>&1 && ! sudo -n sh -c 'command -v local-cognitive-server' >/dev/null 2>&1; then
    ln -sfn /usr/local/bin/local-cognitive-server /usr/bin/local-cognitive-server
  fi

  mkdir -p "$DATA_DIR" "$(dirname "$VAULT_KEY_FILE")"
  chown "$SERVICE_USER:" "$DATA_DIR" "$(dirname "$VAULT_KEY_FILE")"
  chmod 700 "$DATA_DIR" "$(dirname "$VAULT_KEY_FILE")"
  as_service_user "$release/node/bin/node" "$release/dist/src/server/cli.js" init --data-dir "$DATA_DIR" --vault-key-file "$VAULT_KEY_FILE" --inference auto >/dev/null

  sed -e "s|/srv/local-cognitive|$DATA_DIR|g" "$release/deploy/server/local-cognitive.service" > "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null 2>&1 && systemctl restart "$UNIT" || fail "the service did not start: see journalctl -u $UNIT"

  step "Starting"
  local state="" waited=0
  while [ $waited -lt 90 ]; do
    state=$("$COMMAND" status --json 2>/dev/null | sed -n 's/.*"remote":{"state":"\([a-z]*\)".*/\1/p') || true
    [ "$state" = "online" ] || [ "$state" = "off" ] && break
    sleep 2; waited=$(( waited + 2 ))
  done
  touch "$PREFIX/.installed"
  say "Local Cognitive Server $version is installed and running."
  say "  Status:   sudo local-cognitive-server status"
  say "  Logs:     sudo local-cognitive-server logs"
  say "  Update:   sudo local-cognitive-server update"
  if [ "$state" = "off" ]; then
    say ""
    say "Remote is turned off on this server (LOCAL_COGNITIVE_REMOTE in /etc/local-cognitive/server.env): computers cannot connect."
    exit 0
  elif [ "$state" != "online" ]; then
    say ""
    say "It cannot reach https://api.local-cognitive.com yet (outbound HTTPS is all it needs)."
    say "When it can, connect your computer with: sudo local-cognitive-server pair"
    exit 0
  fi
  # The key is printed only to a person at a terminal: never into cloud-init or Ansible logs.
  if $pair && has_terminal; then
    step "Connect your computer"
    "$COMMAND" pair < /dev/null || say "Get a new key any time with: sudo local-cognitive-server pair"
  else
    say ""
    say "To connect your computer, run: sudo local-cognitive-server pair"
  fi
}

main "$@"
