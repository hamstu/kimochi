#!/bin/bash
# Inside the container: start headless Sway and write $RIG/env for `run.sh x`.
set -u
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" "$RIG/log"
chmod 700 "$XDG_RUNTIME_DIR"
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=${WLR_RENDERER:-pixman}
HERE=$(cd "$(dirname "$0")" && pwd)
sway -c "$HERE/sway.conf" > "$RIG/log/sway.log" 2>&1 &
sock=
for _ in $(seq 100); do
  sock=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock 2>/dev/null | head -1)
  [ -n "$sock" ] && [ -e "$XDG_RUNTIME_DIR/wayland-1" ] && break
  sleep 0.1
done
cat > "$RIG/env" <<ENV
export XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$sock XDG_CURRENT_DESKTOP=sway
ENV
touch "$RIG/ready"
wait
