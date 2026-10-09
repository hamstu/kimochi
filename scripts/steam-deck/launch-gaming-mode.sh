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
# WAYLAND_DISPLAY. Capture uses the Wayland portal; rendering uses the tested XWayland overlay path.
export XDG_RUNTIME_DIR WAYLAND_DISPLAY
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=gamescope GDK_BACKEND=x11
export KIMOCHI_GAMESCOPE_OVERLAY=x11
# Scale the GTK/WebKit rendering, without changing saved appearance settings or
# the desktop session. Capture still uses physical pixels; GTK reports its scale
# to the existing overlay geometry/input-region conversions.
GDK_SCALE=${KIMOCHI_GAMESCOPE_SCALE:-2}
case "$GDK_SCALE" in
  1|2|3|4) ;;
  *) echo 'KIMOCHI_GAMESCOPE_SCALE must be 1, 2, 3 or 4' >&2; exit 2 ;;
esac
GDK_DPI_SCALE=1
export GDK_SCALE GDK_DPI_SCALE
DISPLAY=${DISPLAY:-:0}
export DISPLAY
DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
export DBUS_SESSION_BUS_ADDRESS
echo "Kimochi Gaming Mode: portal $socket_path, XWayland $DISPLAY, UI scale ${GDK_SCALE}x" >&2
exec "$@"
