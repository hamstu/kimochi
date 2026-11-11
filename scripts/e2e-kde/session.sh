#!/bin/bash
# Inside the container: a headless Plasma 6 Wayland session (KWin's virtual backend), with the
# pieces a real Plasma session has that Kimochi talks to: PipeWire, kglobalacceld and the KDE
# desktop portal. Writes $RIG/env (source it to talk to the session) and logs to $RIG/log/.
set -u
: "${RIG:?}"; W=${WIDTH:-1920}; H=${HEIGHT:-1080}; SCALE=${SCALE:-1}; OUTPUTS=${OUTPUTS:-1}
mkdir -p "$RIG/log"
export XDG_DATA_HOME=$RIG/data XDG_CONFIG_HOME=$RIG/config XDG_CACHE_HOME=$RIG/cache XDG_STATE_HOME=$RIG/state
export XDG_RUNTIME_DIR=$RIG/run
rm -rf "$XDG_RUNTIME_DIR"; mkdir -m700 -p "$XDG_RUNTIME_DIR"
mkdir -p "$XDG_DATA_HOME/applications" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
# Nobody is at this desktop: never lock it.
printf '[Daemon]\nAutolock=false\nLockOnResume=false\nTimeout=0\n' > "$XDG_CONFIG_HOME/kscreenlockerrc"
# KWin grants its screenshot API to executables whose desktop file asks for it (shot.py runs on
# this Python).
printf '[Desktop Entry]\nType=Application\nName=Rig harness\nExec=%s\nX-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\n' \
  "$(readlink -f /usr/bin/python3)" > "$XDG_DATA_HOME/applications/rig-harness.desktop"
kbuildsycoca6 >/dev/null 2>&1

# systemd-tmpfiles makes this on a real system; XWayland needs it.
mkdir -p -m 1777 /tmp/.X11-unix
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --nofork --nopidfile >"$RIG/log/dbus.log" 2>&1 &
sleep 0.3
pipewire >"$RIG/log/pipewire.log" 2>&1 &
sleep 0.5; wireplumber >"$RIG/log/wireplumber.log" 2>&1 &
# As Plasma starts it: the wrapper owns the XWayland sockets. KWIN_WAYLAND_NO_PERMISSION_CHECKS (test
# rig only) opens fake input to the harness's injector. RIG_PERMISSION_CHECKS=1 leaves it out: KWin's
# restricted globals (screencast, window management, fake input) then go only to executables whose
# desktop file asks for them, as on a real Plasma 6.7 desktop (and `rig.sh input` stops working).
CHECKS=(KWIN_WAYLAND_NO_PERMISSION_CHECKS=1); [ "${RIG_PERMISSION_CHECKS:-0}" = 1 ] && CHECKS=()
{ env "${CHECKS[@]}" QT_FORCE_STDERR_LOGGING=1 QT_LOGGING_RULES="${KWIN_LOGGING_RULES:-kwin_scripting=true}" \
    kwin_wayland_wrapper --virtual --width "$W" --height "$H" --output-count "$OUTPUTS" --xwayland --socket wayland-0
  echo "kwin-exit=$?"; } >"$RIG/log/kwin.log" 2>&1 &
for _ in $(seq 100); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
# KWin segfaults at startup with the KDE session variables set; only its clients get them.
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE KDE_FULL_SESSION=true KDE_SESSION_VERSION=6 XDG_SESSION_DESKTOP=KDE
export WAYLAND_DISPLAY=wayland-0 QT_QPA_PLATFORM=wayland
for _ in $(seq 50); do X=$(ls /tmp/.X11-unix 2>/dev/null | head -1); [ -n "$X" ] && break; sleep 0.1; done
export DISPLAY=${X:+:${X#X}}
for _ in $(seq 50); do XAUTHORITY=$(ls "$XDG_RUNTIME_DIR"/xauth_* 2>/dev/null | head -1); [ -n "$XAUTHORITY" ] && break; sleep 0.1; done
export XAUTHORITY
dbus-update-activation-environment WAYLAND_DISPLAY DISPLAY XAUTHORITY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_RUNTIME_DIR \
  QT_QPA_PLATFORM KDE_FULL_SESSION KDE_SESSION_VERSION XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME
# A real output scale, set the way System Settings sets it (the virtual backend's --scale only
# makes the output bigger).
[ "$SCALE" = 1 ] || kscreen-doctor "output.Virtual-0.scale.$SCALE" >"$RIG/log/kscreen.log" 2>&1
/usr/libexec/kglobalacceld >"$RIG/log/kglobalacceld.log" 2>&1 &
QT_FORCE_STDERR_LOGGING=1 QT_LOGGING_RULES="xdp-kde*=true" /usr/libexec/xdg-desktop-portal-kde >"$RIG/log/portal-kde.log" 2>&1 &
sleep 0.5; /usr/libexec/xdg-desktop-portal -r >"$RIG/log/portal.log" 2>&1 &
for v in XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_RUNTIME_DIR XDG_SESSION_TYPE \
  XDG_CURRENT_DESKTOP KDE_FULL_SESSION KDE_SESSION_VERSION XDG_SESSION_DESKTOP QT_QPA_PLATFORM WAYLAND_DISPLAY \
  DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS RIG; do echo "export $v='${!v}'"; done > "$RIG/env"
# The injector (fake input) is built against this session's protocol headers.
P=/usr/share/plasma-wayland-protocols/fake-input.xml; B=$RIG/bin; mkdir -p "$B"
wayland-scanner client-header $P "$B/fake-input-client.h" && wayland-scanner private-code $P "$B/fake-input.c" \
  && gcc -O2 -I"$B" -o "$B/rig-input" "$(dirname "$0")/input.c" "$B/fake-input.c" $(pkg-config --cflags --libs wayland-client)
echo ready > "$RIG/ready"
wait
