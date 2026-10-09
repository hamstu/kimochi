#!/bin/bash
# Run as the normal user's mapped UID in the builder container. Source siblings
# are mounted at /work; caches/artifacts survive the disposable container.
set -euo pipefail
cd /work/kimochi-tauri
logdir=/work/build-evidence
mkdir -p "$logdir" /work/cache/cargo /work/cache/clippy /work/cache/appimage-temp
export CARGO_HOME=/work/cache/cargo
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CLIPPY_CONF_DIR=/work/cache/clippy
echo 'msrv = "1.87"' > "$CLIPPY_CONF_DIR/clippy.toml"
# This is a native x86_64 build: do not request a target-specific Cargo path.
test "$(uname -m)" = x86_64
unset KIMOCHI_TARGET
export APPIMAGE_EXTRACT_AND_RUN=1
export TMPDIR=/work/cache/appimage-temp
{
  uname -m
  node --version
  npm --version
  rustc --version
  cargo clippy --version
  pkg-config --modversion webkit2gtk-4.1 gtk-layer-shell-0 libpipewire-0.3
  echo 'Qualified Clippy checks use an external msrv = "1.87".'
} > "$logdir/toolchain.txt"

step() {
  local name=$1
  shift
  printf '%s START %s\n' "$(date -u +%FT%TZ)" "$name" | tee -a "$logdir/progress.txt"
  if "$@" 2>&1 | tee "$logdir/$name.txt"; then
    printf '%s PASS %s\n' "$(date -u +%FT%TZ)" "$name" | tee -a "$logdir/progress.txt"
  else
    local status=$?
    printf '%s FAIL %s exit=%s\n' "$(date -u +%FT%TZ)" "$name" "$status" | tee -a "$logdir/progress.txt"
    exit "$status"
  fi
}

step npm-ci npm ci
step verify npm run verify
step javascript-tests npm test
step typecheck npm run typecheck
step lint npm run lint
step capture-tests cargo test --manifest-path capture-core/Cargo.toml
step capture-clippy cargo clippy --manifest-path capture-core/Cargo.toml --all-targets -- -D warnings
step app-clippy npm run check:rust
step app-tests cargo test --manifest-path src-tauri/Cargo.toml
step bundle npm run bundle
sha256sum src-tauri/target/debug/bundle/appimage/*.AppImage > "$logdir/appimage-sha256.txt"
