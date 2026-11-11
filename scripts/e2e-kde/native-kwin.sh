#!/bin/bash
# The native `kwin` capture driver (capture-core/src/linux_native/kwin.rs) against a fresh rig
# session: a Wayland and an XWayland game window, overlapping, then `native_probe` list, capture,
# thumbs, bench and activate. PNGs go to $RIG/out; look at them (each window whole, nothing of
# the other on it).
#
#   cargo build --example native_probe --manifest-path capture-core/Cargo.toml
#   scripts/e2e-kde/native-kwin.sh            # KWIN_WAYLAND_NO_PERMISSION_CHECKS=1, as the rig runs
#   scripts/e2e-kde/native-kwin.sh --auth     # real permission checks; the probe is authorized by a
#                                             # desktop file written while KWin runs, as an app would
# Env: SCALE, OUTPUTS (as rig.sh up); NATIVE_PROBE (default: the debug example).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export KIMOCHI_BIN=${NATIVE_PROBE:-$REPO/capture-core/target/debug/examples/native_probe}
export RIG=${KIMOCHI_KDE_RIG:-${TMPDIR:-/tmp}/kimochi-kde-rig}
[ -x "$KIMOCHI_BIN" ] || { echo "build it first: cargo build --example native_probe (in capture-core)" >&2; exit 2; }
auth=0; [ "${1:-}" = --auth ] && auth=1
RIG_PERMISSION_CHECKS=$auth "$HERE/rig.sh" up
"$HERE/rig.sh" target
sleep 1.5
"$HERE/rig.sh" x bash -c 'GDK_BACKEND=x11 nohup python3 target.py 800 500 "X Game" > "$RIG/log/xtarget.log" 2>&1 &'
sleep 3
probe() { "$HERE/rig.sh" x bash -c 'mkdir -p "$RIG/out" && cd "$RIG/out" && "$0" "$@"' "$KIMOCHI_BIN" "$@"; }
if [ "$auth" = 1 ]; then
  echo "== without a desktop file (must fail)"
  if probe list; then echo "FAIL: authorized without a desktop file" >&2; exit 1; fi
  # A new file in an applications directory: KWin's service cache picks it up without kbuildsycoca,
  # once its last look is over ~1.5 s old (the failed attempt above was one).
  "$HERE/rig.sh" x bash -c 'printf "[Desktop Entry]\nType=Application\nName=Native probe\nExec=\"%s\"\nNoDisplay=true\nX-KDE-Wayland-Interfaces=zkde_screencast_unstable_v1,org_kde_plasma_window_management\n" "$0" \
    > "$XDG_DATA_HOME/applications/kimochi-native-probe-$$.desktop"' "$KIMOCHI_BIN"
  sleep 2
  echo "== with one"
fi
probe list
probe capture "Rig Game" wayland.png
probe capture "X Game" xwayland.png
probe capture wayland:display:Virtual-0 display.png
probe thumbs
probe bench "Rig Game" 3
"$HERE/rig.sh" js 'for (const w of workspace.windowList()) if (w.caption == "Rig Game") w.minimized = true'
probe activate "Rig Game"
sleep 0.5
"$HERE/rig.sh" js 'for (const w of workspace.windowList()) if (w.caption == "Rig Game") out([w.minimized, w.active])'
echo "PNGs in $RIG/out"
