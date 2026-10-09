#!/usr/bin/env bash
# Set up this macOS or Linux machine as a persistent GitHub Actions self-hosted runner that
# starts with the machine (launchd agent on macOS, systemd unit on Linux).
#
#   RUNNER_TOKEN=<registration token> ci/runners/setup-runner.sh --name NAME --labels a,b [options]
#
# A registration token comes from `ci/runners/token.sh` (it is valid for an hour). Run this as
# the user the runner should build as (not root); on Linux it uses sudo for packages and the
# service. Re-running replaces the existing registration with the same name.
#
# Options:
#   --name NAME       Runner name as GitHub shows it (default: this host's name)
#   --labels a,b      Extra labels. `self-hosted`, the OS and the architecture are automatic.
#   --url URL         Repository or organisation to register with
#                     (default: https://github.com/hamstu/kimochi-tauri)
#   --dir DIR         Where the runner lives (default: ~/actions-runner)
#   --deps            Also install the build prerequisites this app needs (Rust, system libs)
#   --no-service      Configure only; do not install the service
set -euo pipefail

NAME="$(uname -n | cut -d. -f1)"
LABELS=""
URL="https://github.com/hamstu/kimochi-tauri"
DIR="$HOME/actions-runner"
DEPS=0
SERVICE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --deps) DEPS=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
: "${RUNNER_TOKEN:?set RUNNER_TOKEN to a registration token (ci/runners/token.sh)}"
[[ "$(id -u)" != 0 ]] || { echo "run as the build user, not root" >&2; exit 2; }

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) runner_os=osx ;;
  Linux) runner_os=linux ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) runner_arch=arm64 ;;
  x86_64) runner_arch=x64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- prerequisites
if [[ $DEPS == 1 ]]; then
  if [[ $os == Linux ]]; then
    if command -v apt-get >/dev/null; then
      log "Installing apt packages"
      if ! command -v gh >/dev/null; then
        # GitHub CLI, for uploading bundles to releases (cli.github.com apt repository).
        sudo mkdir -p -m 755 /etc/apt/keyrings
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
        sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      fi
      sudo apt-get update
      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
        curl wget file git build-essential pkg-config libssl-dev libclang-dev patchelf \
        libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
        libpipewire-0.3-dev libspa-0.2-dev libudev-dev gh \
        libgstreamer1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-pulseaudio
    elif command -v pacman >/dev/null; then
      log "Installing pacman packages"
      sudo pacman -Sy --needed --noconfirm \
        curl wget file git base-devel pkgconf openssl clang patchelf \
        webkit2gtk-4.1 xdotool libayatana-appindicator librsvg pipewire gtk3 fuse2 github-cli \
        gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad
    else
      echo "no apt-get or pacman; install the Tauri Linux prerequisites by hand" >&2
    fi
  elif [[ $os == Darwin ]]; then
    xcode-select -p >/dev/null 2>&1 || { log "Installing Xcode command line tools"; xcode-select --install; }
  fi
  if ! command -v rustup >/dev/null && [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
    log "Installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  if ! rustup show active-toolchain >/dev/null 2>&1; then
    log "Setting the default Rust toolchain to stable"
    rustup default stable
  fi
  rustup component add clippy
fi

# Make sure the PATH the runner captures covers cargo and any node manager's default node:
# jobs inherit it from the `.path` file config.sh writes.
export PATH="$HOME/.cargo/bin:$HOME/.local/share/fnm/aliases/default/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# ---------------------------------------------------------------- runner package
mkdir -p "$DIR"
cd "$DIR"
if [[ -x ./svc.sh && -f .runner ]]; then
  log "Stopping the existing runner service"
  if [[ $os == Darwin ]]; then ./svc.sh stop || true; else sudo ./svc.sh stop || true; fi
  if [[ $os == Darwin ]]; then ./svc.sh uninstall || true; else sudo ./svc.sh uninstall || true; fi
  ./config.sh remove --token "$RUNNER_TOKEN" || true
fi

release_json="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
version="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
asset="actions-runner-${runner_os}-${runner_arch}-${version}.tar.gz"
if [[ ! -f "bin/Runner.Listener" ]] || ! grep -q "\"$version\"" .runner_version 2>/dev/null; then
  log "Downloading runner $version ($runner_os/$runner_arch)"
  curl -fL -o "/tmp/$asset" "https://github.com/actions/runner/releases/download/v${version}/${asset}"
  expected="$(printf '%s' "$release_json" | sed -n "s/.*BEGIN SHA ${runner_os}-${runner_arch} -->\([0-9a-f]*\)<!-- END SHA.*/\1/p" | head -1)"
  if [[ -n "$expected" ]]; then
    if command -v sha256sum >/dev/null; then actual="$(sha256sum "/tmp/$asset" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "/tmp/$asset" | cut -d' ' -f1)"; fi
    [[ "$actual" == "$expected" ]] || { echo "checksum mismatch for $asset" >&2; exit 1; }
  else
    echo "warning: no published checksum found for $asset; continuing unverified" >&2
  fi
  tar xzf "/tmp/$asset" -C "$DIR"
  rm -f "/tmp/$asset"
  printf '"%s"\n' "$version" > .runner_version
fi

# ---------------------------------------------------------------- register
log "Registering '$NAME' with $URL (labels: ${LABELS:-none})"
./config.sh --unattended --replace \
  --url "$URL" --token "$RUNNER_TOKEN" \
  --name "$NAME" ${LABELS:+--labels "$LABELS"} \
  --work _work

# ---------------------------------------------------------------- service
if [[ $SERVICE == 1 ]]; then
  if [[ $os == Darwin ]]; then
    log "Installing launchd agent (starts at login)"
    ./svc.sh install
    ./svc.sh start
  else
    log "Installing systemd service (starts at boot) as $(id -un)"
    sudo ./svc.sh install "$(id -un)"
    sudo ./svc.sh start
  fi
fi
log "Done. Runner '$NAME' should now show as Idle under $URL/settings/actions/runners"
