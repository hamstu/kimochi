#!/bin/bash
# Inside the container: a D-Bus session, PipeWire, and headless GNOME Shell with Kimochi's
# extension installed the way the app installs it (loader + immutable revision). Writes $RIG/env.
set -u
export XDG_RUNTIME_DIR=/tmp/xdg HOME=/root
mkdir -p "$XDG_RUNTIME_DIR" "$RIG/log"; chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p /tmp/.X11-unix; chmod 1777 /tmp/.X11-unix   # Xwayland (GNOME 47/48 do not create it)
HERE=$(cd "$(dirname "$0")" && pwd)
EXT_SRC=$(cd "$HERE/../../src-tauri/gnome-extension" && pwd)
# GNOME Shell needs a system bus (it asks it for logind), even when nothing answers there.
mkdir -p /run/dbus; dbus-daemon --system --fork --nopidfile 2>"$RIG/log/dbus-system.log"
python3 "$HERE/login1.py" > "$RIG/log/login1.log" 2>&1 &
for _ in $(seq 50); do gdbus introspect --system -d org.freedesktop.login1 -o /org/freedesktop/login1 >/dev/null 2>&1 && break; sleep 0.1; done
dbus-daemon --session --address="unix:path=$XDG_RUNTIME_DIR/bus" --nofork --nopidfile > "$RIG/log/dbus.log" 2>&1 &
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 0.1; done
pipewire > "$RIG/log/pipewire.log" 2>&1 &
sleep 0.3
wireplumber > "$RIG/log/wireplumber.log" 2>&1 &

if [ "${RIG_NO_EXTENSION:-0}" != 1 ]; then
  dir=$HOME/.local/share/gnome-shell/extensions/kimochi-overlay@hamstu.github.io
  rev=$(sha256sum "$EXT_SRC/implementation.js" | cut -d' ' -f1)
  mkdir -p "$dir/revisions"
  cp "$EXT_SRC/metadata.json" "$EXT_SRC/extension.js" "$dir/"
  cp "$EXT_SRC/implementation.js" "$dir/revisions/$rev.js"
  printf %s "$rev" > "$dir/revision"
  gsettings set org.gnome.shell enabled-extensions "['kimochi-overlay@hamstu.github.io']"
fi
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.interface enable-animations false
gsettings set org.gnome.mutter experimental-features "[$( [ "${SCALE:-1}" != 1 ] && echo "'scale-monitor-framebuffer'")]"

export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland XDG_SESSION_DESKTOP=gnome
# 47/48 still take --wayland; 49+ is Wayland-only and rejects it.
flags=(--headless --virtual-monitor "${WIDTH:-1920}x${HEIGHT:-1080}")
[ "${OUTPUTS:-1}" = 2 ] && flags+=(--virtual-monitor 1280x800)
gnome-shell --help 2>&1 | grep -q -- '--wayland' && flags+=(--wayland)
gnome-shell "${flags[@]}" > "$RIG/log/gnome-shell.log" 2>&1 &
for _ in $(seq 300); do
  gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion >/dev/null 2>&1 \
    && [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break
  sleep 0.1
done
# A new session opens in the Activities overview, which hides every window (and the overlay).
gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.freedesktop.DBus.Properties.Set \
  org.gnome.Shell OverviewActive '<false>' >/dev/null 2>&1
xauth=$(ls "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
cat > "$RIG/env" <<ENV
export XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR HOME=$HOME DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
export WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 ${xauth:+XAUTHORITY=$xauth}
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland XDG_SESSION_DESKTOP=gnome
ENV
touch "$RIG/ready"
wait
