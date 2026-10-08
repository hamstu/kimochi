#!/bin/sh
# Explicit Gaming Mode launcher. Changes only the child environment; no SteamOS
# configuration, Steam window properties, device grabs or persistent services.
set -eu
if [ "$#" -eq 0 ]; then
  echo 'Usage: sh launch-gaming-mode.sh /path/to/Kimochi.AppImage [arguments...]' >&2
  exit 2
fi
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
WAYLAND_DISPLAY=${KIMOCHI_GAMESCOPE_DISPLAY:-gamescope-0}
case "$WAYLAND_DISPLAY" in
  /*) socket_path=$WAYLAND_DISPLAY ;;
  *) socket_path=$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY ;;
esac
if [ ! -S "$socket_path" ]; then
  echo "Gamescope Wayland socket unavailable: $socket_path" >&2
  exit 1
fi
# Steam's Gaming Mode environment says XDG_SESSION_TYPE=x11 and usually omits
# WAYLAND_DISPLAY. Kimochi needs the actual Wayland path for portal + layer-shell.
export XDG_RUNTIME_DIR WAYLAND_DISPLAY
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=gamescope GDK_BACKEND=wayland
DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
export DBUS_SESSION_BUS_ADDRESS
echo "Kimochi Gaming Mode: Wayland socket $socket_path" >&2
exec "$@"
