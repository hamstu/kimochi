#!/bin/sh
# Registered Steam shortcut target; keep native sidecar guard settings explicit.
set -eu
unset LD_PRELOAD
export GDK_BACKEND=x11 KIMOCHI_SESSION_PROBE=1
probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
watchdog=${KIMOCHI_PROBE_WATCHDOG:-$HOME/.local/share/kimochi/gaming-mode/current/Kimochi.AppImage}
if [ ! -x "$watchdog" ]; then
  printf '%s\n' "Missing guarded-input helper: $watchdog" >&2
  exit 1
fi
mkdir -p "$HOME/kimochi-probes"
exec /usr/bin/python3 "$probe_dir/session-probe.py" app --seconds 3600 --input-mode guarded \
  --touch-watchdog "$watchdog" > "$HOME/kimochi-probes/session-probe-app.log" 2>&1
