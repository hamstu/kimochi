#!/bin/bash
# Host side of the KDE Plasma test rig. See README.md.
#   rig.sh image              build the container image (once; ~2 GB)
#   rig.sh up                 (re)start a fresh headless Plasma session   env: WIDTH HEIGHT SCALE OUTPUTS
#   rig.sh x <cmd...>         run a command inside the session
#   rig.sh app [args]         (re)start Kimochi inside it (log: $RIG/log/kimochi.log)
#   rig.sh target [W H title] start the fake game window (GDK_BACKEND=x11 for an XWayland one)
#   rig.sh k <cli args>       the kimochi CLI against that app
#   rig.sh shot <file.png>    screenshot the whole desktop
#   rig.sh js '<code>'        run a KWin script; out(x) prints
#   rig.sh input <cmds...>    fake pointer/keys: move X Y | click [right] | key CODE | sleep MS
#   rig.sh down               stop the container
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export RIG=${KIMOCHI_KDE_RIG:-${TMPDIR:-/tmp}/kimochi-kde-rig}
NAME=${KIMOCHI_KDE_CONTAINER:-kimochi-kde}
IMAGE=${KIMOCHI_KDE_IMAGE:-kimochi-kde}
BIN=${KIMOCHI_BIN:-${CARGO_TARGET_DIR:-$REPO/src-tauri/target}/debug/kimochi}
inside() { podman exec -i -w "$HERE" -e RIG="$RIG" "$NAME" bash -c '. "$RIG/env"; "$@"' _ "$@"; }
cmd=${1:-}; shift || true
case "$cmd" in
  image) podman build -t "$IMAGE" "$HERE" ;;
  up)
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$RIG"; mkdir -p "$RIG"
    # Container root is the invoking user (rootless), so no ID-mapped copy of the image is made.
    # The host network lets host-side Node reach WebKit's inspector; /dev/dri gives KWin GL,
    # which its screencast (the portal) and screenshots need.
    podman run -d --name "$NAME" --device /dev/dri --network host --security-opt label=disable \
      -v "$REPO:$REPO" -v "$RIG:$RIG" -v "$(dirname "$BIN"):$(dirname "$BIN")" "$IMAGE" sleep infinity >/dev/null
    podman exec -d -e RIG="$RIG" -e WIDTH="${WIDTH:-1920}" -e HEIGHT="${HEIGHT:-1080}" -e SCALE="${SCALE:-1}" -e OUTPUTS="${OUTPUTS:-1}" -e RIG_PERMISSION_CHECKS="${RIG_PERMISSION_CHECKS:-0}" ${KWIN_LOGGING_RULES:+-e KWIN_LOGGING_RULES="$KWIN_LOGGING_RULES"} \
      "$NAME" bash "$HERE/session.sh"
    for _ in $(seq 150); do [ -e "$RIG/ready" ] && break; sleep 0.2; done
    [ -e "$RIG/ready" ] || { echo "session failed; logs in $RIG/log" >&2; exit 1; }
    echo "Plasma session ready ($RIG)" ;;
  x) inside "$@" ;;
  app)
    inside bash -c 'pkill -x kimochi || true; sleep 0.5
      WEBKIT_INSPECTOR_HTTP_SERVER=${WEBKIT_INSPECTOR_HTTP_SERVER:-127.0.0.1:9333} nohup "$0" "$@" > "$RIG/log/kimochi.log" 2>&1 &' "$BIN" "$@" ;;
  target) inside env ${GDK_BACKEND:+GDK_BACKEND=$GDK_BACKEND} bash -c 'nohup python3 target.py "$@" > "$RIG/log/target.log" 2>&1 &' _ "$@" ;;
  k) inside "$BIN" "$@" --no-start ;;
  shot) inside python3 shot.py "$@" ;;
  js) inside python3 kwin-js.py "$@" ;;
  input) inside "$RIG/bin/rig-input" "$@" ;;
  down) podman rm -f "$NAME" >/dev/null ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
