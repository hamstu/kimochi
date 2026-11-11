#!/bin/bash
# Host side of the headless Sway rig for the native `ext` capture driver.
#   run.sh image            build the container image (Arch: sway ≥1.12, foot, xterm, Hyprland; ~1 GB)
#   run.sh up               (re)start a fresh headless Sway (HEADLESS-1 1920x1080, + HEADLESS-2)
#   run.sh x <cmd...>       run a command inside the session (env: WAYLAND_DISPLAY, SWAYSOCK)
#   run.sh probe <args...>  the native_probe example inside the session, cwd $RIG/out
#   run.sh test             up + two overlapping windows (foot, XWayland xterm) + list/capture/
#                           thumbs/bench/activate, then again at scale 1.5; PNGs in $RIG/out
#   run.sh down             stop the container
# Build the probe on the host first: (cd capture-core && cargo build --example native_probe).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export RIG=${KIMOCHI_NATIVE_RIG:-${TMPDIR:-/tmp}/kimochi-native-rig}
NAME=${KIMOCHI_NATIVE_CONTAINER:-kimochi-native-sway}
IMAGE=${KIMOCHI_NATIVE_IMAGE:-kimochi-native-sway}
BIN=${KIMOCHI_PROBE:-${CARGO_TARGET_DIR:-$REPO/capture-core/target}/debug/examples/native_probe}
inside() { podman exec -i -w "$RIG/out" -e RIG="$RIG" "$NAME" bash -c '. "$RIG/env"; "$@"' _ "$@"; }
probe() { inside env KIMOCHI_WAYLAND_CAPTURE=ext "$BIN" "$@" 2> >(grep -vE '^(driver ext: ok|Wayland capture: native driver ext)$' >&2); }
sway() { inside swaymsg "$@"; }
step() { printf '\n== %s\n' "$*"; }

focused() { probe list | sed -n '/^{/,/^}/p' | inside jq -r '[.windows[] | select(.focused) | .title] | join(",")'; }

scenario() {
  local tag=$1
  step "$tag: list (inventory JSON in $tag-list.json)"
  probe list > "$RIG/out/$tag-list.txt"
  sed -n '/^{/,/^}/p' "$RIG/out/$tag-list.txt" > "$RIG/out/$tag-list.json"
  grep '^wayland:' "$RIG/out/$tag-list.txt"
  step "$tag: capture the front window (foot) and the one under it (xterm)"
  probe capture "front" "$tag-front.png"
  probe capture "under" "$tag-under.png"
  step "$tag: outputs"
  probe capture wayland:display:HEADLESS-1 "$tag-HEADLESS-1.png"
  probe capture wayland:display:HEADLESS-2 "$tag-HEADLESS-2.png"
  step "$tag: thumbs"
  (cd "$RIG/out" && mkdir -p "thumbs-$tag")
  inside bash -c 'cd "thumbs-$0" && KIMOCHI_WAYLAND_CAPTURE=ext "$1" thumbs' "$tag" "$BIN"
  step "$tag: bench (window animating: a clock in foot)"
  probe bench "front" 5
  step "$tag: activate (focused before → after)"
  local before; before=$(focused)
  probe activate "under"
  echo "focused: $before → $(focused)"
  probe activate "front"
  echo "focused: → $(focused)"
}

cmd=${1:-}; shift || true
case "$cmd" in
  image) podman build -t "$IMAGE" "$HERE" ;;
  up)
    podman rm -f -t 0 "$NAME" >/dev/null 2>&1 || true
    rm -rf "$RIG"; mkdir -p "$RIG/out"
    podman run -d --name "$NAME" --device /dev/dri --security-opt label=disable \
      -v "$REPO:$REPO:ro" -v "$RIG:$RIG" -v "$(dirname "$BIN"):$(dirname "$BIN"):ro" "$IMAGE" sleep infinity >/dev/null
    podman exec -d -e RIG="$RIG" ${WLR_RENDERER:+-e WLR_RENDERER=$WLR_RENDERER} "$NAME" bash "$HERE/session.sh"
    for _ in $(seq 100); do [ -e "$RIG/ready" ] && break; sleep 0.1; done
    [ -e "$RIG/ready" ] || { echo "sway failed; log in $RIG/log" >&2; exit 1; }
    sway create_output >/dev/null
    echo "sway $(inside sway --version | awk '{print $3}') ready ($RIG)" ;;
  x) inside "$@" ;;
  probe) probe "$@" ;;
  test)
    "$0" up
    step "globals"
    inside wayland-info 2>/dev/null | grep -oE "'(ext|zwlr|zxdg_output|wl_output|wl_shm)[a-z0-9_]*'" | sort -u | tr '\n' ' '; echo
    # Two overlapping floating windows on HEADLESS-1: xterm (XWayland) under, foot in front.
    # Spawned by sway, so they get its DISPLAY.
    sway "exec xterm -title under -geometry 100x30 -bg '#602020' -fg white -fa Mono -fs 12 -e sh -c 'while :; do date; sleep 1; done'" >/dev/null
    sleep 2
    sway '[title="under"] floating enable, resize set 900 600, move position 100 100' >/dev/null
    sway "exec foot --title=front -o locked-title=yes -o colors-dark.background=204020 sh -c 'while :; do date +%T.%N; sleep 0.1; done'" >/dev/null
    sleep 2
    sway '[title="front"] floating enable, resize set 800 500, move position 500 300' >/dev/null
    sleep 0.5
    # A third window, on HEADLESS-2's top-left corner, to check output orientation.
    sway "focus output HEADLESS-2, exec foot --title=side -o locked-title=yes -o colors-dark.background=202060 sh -c 'echo TOP LEFT; echo side window; sleep 1000'" >/dev/null
    sleep 2
    sway '[title="side"] floating enable, resize set 500 300, move absolute position 1930 10' >/dev/null
    sway '[title="front"] focus' >/dev/null
    sleep 0.5
    scenario scale1
    step "HEADLESS-2 rotated/flipped: the side window must stay upright at the top left"
    for t in 90 270 flipped-90 flipped; do
      sway output HEADLESS-2 transform $t >/dev/null; sleep 0.5
      probe capture wayland:display:HEADLESS-2 "rotated-$t-HEADLESS-2.png" | sed -n 1p
    done
    sway output HEADLESS-2 transform normal >/dev/null
    step "without IPC (SWAYSOCK unset): wlr foreign-toplevel state and activation"
    noipc() { inside bash -c 'unset SWAYSOCK; KIMOCHI_WAYLAND_CAPTURE=ext "$0" "$@" 2>&1' "$BIN" "$@" | grep -vE '^(driver|Wayland capture: native)'; }
    noipc list | grep '^wayland:window'
    noipc list | sed -n '/^{/,/^}/p' | inside jq -c '.windows[] | {title, focused, minimized, output}'
    noipc activate side
    echo "focused (per sway IPC): $(focused)"
    echo "xterm: ext has no app_id for it, wlr has its class, so no unique match:"
    noipc activate under
    sway '[title="front"] focus' >/dev/null
    step "scale 1.5 on HEADLESS-1"
    sway output HEADLESS-1 scale 1.5 >/dev/null
    sway '[title="under"] move position 100 100' >/dev/null
    sway '[title="front"] focus, move position 400 250' >/dev/null
    sleep 1
    scenario scale1.5
    echo; echo "PNGs: $RIG/out" ;;
  down) podman rm -f -t 0 "$NAME" >/dev/null ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
