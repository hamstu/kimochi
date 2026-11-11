#!/bin/bash
# Host side of the headless GNOME rig: the Kimochi Shell extension and the native Mutter capture
# driver on each GNOME release. See README.md.
#   run.sh image [41..45|all]   build kimochi-gnome:f<N> (Fedora N; 41=GNOME 47 … 45=GNOME 51)
#   run.sh up <N>               (re)start headless GNOME Shell with the extension installed
#                               env: WIDTH HEIGHT OUTPUTS=2 RIG_NO_EXTENSION=1
#   run.sh x <cmd...>           run a command inside the session
#   run.sh ext <Method> [json]  call the extension's D-Bus method (Status takes no argument)
#   run.sh probe <args...>      capture-core's native_probe (KIMOCHI_WAYLAND_CAPTURE=mutter)
#   run.sh test <N>             up + extension/driver checks; PNGs and logs in $RIG
#   run.sh app <N>              up + the real app (KIMOCHI_BIN): own window list, scan, overlay
#   run.sh matrix               test + app on every image built
#   run.sh down
# Build the probe first: (cd capture-core && cargo build --example native_probe).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export RIG=${KIMOCHI_GNOME_RIG:-${TMPDIR:-/tmp}/kimochi-gnome-rig}
NAME=${KIMOCHI_GNOME_CONTAINER:-kimochi-gnome}
PROBE=${KIMOCHI_PROBE:-${CARGO_TARGET_DIR:-$REPO/capture-core/target}/debug/examples/native_probe}
APP=${KIMOCHI_BIN:-${CARGO_TARGET_DIR:-$REPO/src-tauri/target}/debug/kimochi}
inside() { podman exec -i -w "$RIG" -e RIG="$RIG" "$NAME" bash -c '. "$RIG/env"; "$@"' _ "$@"; }
ext() {
  local method=$1; shift
  if [ "$method" = Status ]; then inside gdbus call --session -d dev.kimochi.GnomeOverlay -o /dev/kimochi/GnomeOverlay -m "dev.kimochi.GnomeOverlay.$method"
  else inside gdbus call --session -d dev.kimochi.GnomeOverlay -o /dev/kimochi/GnomeOverlay -m "dev.kimochi.GnomeOverlay.$method" "${1:-{\}}"; fi
}
unwrap() { sed -E "s/^\('(.*)',\)$/\1/"; }
probe() { inside env KIMOCHI_WAYLAND_CAPTURE=mutter "$PROBE" "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail=0
check() { local what=$1; shift; if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fail=1; fi; }

cmd=${1:-}; shift || true
case "$cmd" in
  image)
    vs=${1:-all}; [ "$vs" = all ] && vs="41 42 43 44 45"
    for v in $vs; do podman build --build-arg FEDORA="$v" -t "kimochi-gnome:f$v" "$HERE"; done ;;
  up)
    v=${1:?Fedora release}
    podman rm -f -t 0 "$NAME" >/dev/null 2>&1 || true
    rm -rf "$RIG"; mkdir -p "$RIG"
    podman run -d --name "$NAME" --device /dev/dri --network host --security-opt label=disable \
      -v "$REPO:$REPO:ro" -v "$RIG:$RIG" -v "$(dirname "$PROBE"):$(dirname "$PROBE"):ro" \
      -v "$(dirname "$APP"):$(dirname "$APP"):ro" "kimochi-gnome:f$v" sleep infinity >/dev/null
    podman exec -d -e RIG="$RIG" -e WIDTH="${WIDTH:-1920}" -e HEIGHT="${HEIGHT:-1080}" -e OUTPUTS="${OUTPUTS:-1}" \
      -e RIG_NO_EXTENSION="${RIG_NO_EXTENSION:-0}" "$NAME" bash "$HERE/session.sh"
    for _ in $(seq 300); do [ -e "$RIG/ready" ] && break; sleep 0.1; done
    [ -e "$RIG/ready" ] || { echo "GNOME failed; log in $RIG/log" >&2; exit 1; }
    echo "$(inside gnome-shell --version) ready ($RIG)" ;;
  x) inside "$@" ;;
  ext) ext "$@" | unwrap ;;
  probe) probe "$@" ;;
  test)
    v=${1:?Fedora release}
    "$0" up "$v"
    step "extension state"
    info=$(inside gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Extensions.GetExtensionInfo kimochi-overlay@hamstu.github.io)
    # state 1 = ENABLED (ACTIVE on 48+); anything else is an error/out-of-date/initialized.
    echo "$info" | grep -oE "'(state|error)': <[^>]*>" | tr '\n' ' '; echo
    for _ in $(seq 50); do ext Status >/dev/null 2>&1 && break; sleep 0.1; done
    status=$(ext Status | unwrap)
    echo "$status" | head -c 400; echo
    check "extension enabled and serving Status" bash -c '[[ "$0" == *"\"protocol\":1"* && "$0" == *"\"nativeWindows\":true"* ]]' "$status"

    step "windows: a Wayland one and an XWayland one"
    inside bash -c 'nohup python3 '"$REPO"'/scripts/e2e-kde/target.py 900 500 "Rig Wayland" > "$RIG/log/target-wl.log" 2>&1 &'
    inside bash -c 'GDK_BACKEND=x11 nohup python3 '"$REPO"'/scripts/e2e-kde/target.py 700 400 "Rig X11" > "$RIG/log/target-x.log" 2>&1 &'
    for _ in $(seq 100); do ext Windows '{"operation":"list"}' 2>/dev/null | grep -q 'Rig X11' && ext Windows '{"operation":"list"}' | grep -q 'Rig Wayland' && break; sleep 0.2; done
    list=$(ext Windows '{"operation":"list"}' | unwrap)
    echo "$list" > "$RIG/windows.json"
    inside jq -c '.windows[] | {id,title,appId,pid,bounds,minimized,onScreen,focused,xwayland}' "$RIG/windows.json" || true
    check "Windows lists both windows" bash -c 'grep -q "Rig Wayland" "$0" && grep -q "Rig X11" "$0"' "$RIG/windows.json"
    wid=$(inside jq -r '.windows[] | select(.title=="Rig Wayland") | .id' "$RIG/windows.json")
    pid=$(inside jq -r '.windows[] | select(.title=="Rig Wayland") | .pid' "$RIG/windows.json")
    xid=$(inside jq -r '.windows[] | select(.title=="Rig X11") | .id' "$RIG/windows.json")

    step "native driver (Mutter ScreenCast)"
    probe list > "$RIG/probe-list.txt" 2>&1 || true
    grep -E '^(driver|wayland:)' "$RIG/probe-list.txt" || tail -n 5 "$RIG/probe-list.txt"
    check "driver mutter chosen" grep -q '^driver mutter: ok' "$RIG/probe-list.txt"
    for t in "Rig Wayland" "Rig X11"; do
      probe capture "$t" "$RIG/capture-${t// /-}.png" 2>&1 | tail -n 2
      check "capture $t" test -s "$RIG/capture-${t// /-}.png"
    done
    probe capture wayland:display:Meta-0 "$RIG/capture-display.png" 2>&1 | tail -n 1 || true
    probe activate "Rig X11" 2>&1 | tail -n 1 || true
    focused=$(ext Windows '{"operation":"list"}' | unwrap | inside jq -r '.windows[] | select(.focused) | .title')
    check "activate focuses Rig X11 (focused: $focused)" test "$focused" = "Rig X11"

    step "overlay: bind, present, follow, clear"
    owner() { inside python3 - "$@" <<'PY'
import dbus, json, sys, time
bus = dbus.SessionBus()
o = dbus.Interface(bus.get_object('dev.kimochi.GnomeOverlay', '/dev/kimochi/GnomeOverlay'), 'dev.kimochi.GnomeOverlay')
src = sys.argv[1]
bound = json.loads(o.Track(json.dumps({'operation': 'bind', 'sourceId': src})))
print('bind', json.dumps(bound)[:300])
b = bound['bounds']
o.Present(json.dumps({'sourceKind': 'window', 'sourceId': src, 'referenceBounds': b,
    'words': [{'x': b['x'] + 40, 'y': b['y'] + 60, 'width': 200, 'height': 50, 'text': '今日'}]}))
print('present ok')
time.sleep(0.5)
print('status', json.dumps(json.loads(o.Track(json.dumps({'operation': 'status', 'sourceId': src}))))[:200])
o.Clear(); print('clear ok')
PY
    }
    out=$(owner "wayland:window:$wid:$pid" 2>&1) || true
    echo "$out"
    check "Track bind by Mutter id" grep -q '^bind {' <<<"$out"
    check "Present/Clear" grep -q 'clear ok' <<<"$out"

    step "shell log"
    grep -iE "kimochi|JS ERROR|TypeError|ReferenceError|is not a function|deprecated" "$RIG/log/gnome-shell.log" | grep -v 'Xwayland' | head -20 || true
    check "no Kimochi errors in the shell log" bash -c '! grep -iE "JS ERROR|TypeError|ReferenceError|Kimochi update failed" "$0"' "$RIG/log/gnome-shell.log"
    [ "$fail" = 0 ] && echo "ALL PASSED ($(inside gnome-shell --version))" || { echo "FAILED ($(inside gnome-shell --version)); logs in $RIG"; exit 1; } ;;
  app)
    v=${1:?Fedora release}
    "$0" up "$v"
    k() { inside "$APP" "$@" --no-start 2>&1; }
    inside bash -c 'nohup python3 '"$REPO"'/scripts/e2e-kde/target.py 1000 560 "Rig Game" > "$RIG/log/target.log" 2>&1 &'
    sleep 2
    inside bash -c 'nohup "$0" > "$RIG/log/kimochi.log" 2>&1 &' "$APP"
    for _ in $(seq 90); do k status --json >/dev/null 2>&1 && break; sleep 1; done
    check "app chose the native mutter driver" grep -q 'Wayland capture: native driver mutter' "$RIG/log/kimochi.log"
    sources=$(k source list); echo "$sources"
    id=$(grep -oE 'wayland:window:[0-9]+:[0-9]+' <<<"$(grep 'Rig Game' <<<"$sources")" | head -1)
    check "Kimochi's own list has the game ($id)" test -n "$id"
    k settings set liveOverlayEnabled true >/dev/null
    k source set "$id" | tail -n 1
    wid=$(cut -d: -f3 <<<"$id")
    ext Windows "{\"operation\":\"activate\",\"id\":\"$wid\"}" >/dev/null
    # The first scan can come before OCR has loaded.
    for _ in $(seq 10); do text=$(k scan --wait || true); grep -q '図書館' <<<"$text" && break; sleep 2; done
    echo "$text" | tail -n 2
    check "OCR reads the game" grep -q '図書館' <<<"$text"
    for _ in $(seq 30); do ext Status | grep -q '"painted":true' && break; sleep 0.2; done
    st=$(ext Status | unwrap)
    echo "$st" | grep -oE '"(words|painted)":[a-z0-9]+|"method":"[a-z]+"' | tr '\n' ' '; echo
    check "overlay bound natively and painted on the game" bash -c '[[ "$0" == *"\"method\":\"native\""* && "$0" == *"\"painted\":true"* ]]' "$st"
    step "closing the game clears the source"
    inside pkill -f 'target.py 1000 560' || true
    cleared=
    for _ in $(seq 40); do
      sel=$(k status --json | grep -oE '^  "source": ?(null|\{)' | tr -d ' ' | head -n 1 || true)
      [ "$sel" = '"source":null' ] && { cleared=1; break; }; sleep 0.25
    done
    check "source cleared after the window closed" test -n "$cleared"
    check "no 'could not bind' noise in the app log" bash -c '! grep -q "could not bind" "$0"' "$RIG/log/kimochi.log"
    check "no Kimochi errors in the shell log" bash -c '! grep -iE "JS ERROR|TypeError|ReferenceError|Kimochi update failed" "$0"' "$RIG/log/gnome-shell.log"
    [ "$fail" = 0 ] && echo "APP PASSED ($(inside gnome-shell --version))" || { echo "APP FAILED; logs in $RIG"; exit 1; } ;;
  matrix)
    for v in $(podman images --format '{{.Tag}}' kimochi-gnome | sed -n 's/^f//p' | sort -n); do
      printf '\n######## Fedora %s\n' "$v"; "$0" test "$v" || true
      # The app needs the host's glibc; a host newer than the image can only run the probe.
      if podman run --rm -v "$(dirname "$APP"):$(dirname "$APP"):ro" "kimochi-gnome:f$v" ldd "$APP" 2>&1 | grep -qE 'not found'; then
        echo "skip app (this build of Kimochi does not load on Fedora $v)"
      else "$0" app "$v" || true; fi
    done ;;
  down) podman rm -f -t 0 "$NAME" >/dev/null ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
