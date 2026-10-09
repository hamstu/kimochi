#!/bin/sh
# A transient user service keeps Gaming Mode testing independent of SSH lifetime.
# No installed unit, auto-start, or auto-restart; normal Quit remains authoritative.
set -eu
if [ "$#" -eq 0 ]; then
  echo 'Usage: sh launch-gaming-mode-service.sh /path/to/Kimochi.AppImage [arguments...]' >&2
  exit 2
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec systemd-run --user --collect --unit=kimochi-gaming-mode \
  --working-directory="$(pwd)" \
  --description='Kimochi Gaming Mode' --property=Restart=no \
  --setenv="DISPLAY=${DISPLAY:-:0}" \
  --setenv="KIMOCHI_GAMESCOPE_SCALE=${KIMOCHI_GAMESCOPE_SCALE:-2}" \
  --setenv="KIMOCHI_GAMESCOPE_UI_SCALE=${KIMOCHI_GAMESCOPE_UI_SCALE:-${KIMOCHI_GAMESCOPE_SCALE:-2}}" \
  --setenv="KIMOCHI_GAMESCOPE_DISPLAY=${KIMOCHI_GAMESCOPE_DISPLAY:-gamescope-0}" \
  /bin/sh "$script_dir/launch-gaming-mode.sh" "$@"
