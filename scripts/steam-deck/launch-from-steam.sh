#!/bin/sh
# Steam runs this short-lived launcher; the app itself belongs to a user service.
set -eu
if [ "$#" -eq 0 ]; then
  echo 'Usage: sh launch-from-steam.sh /absolute/path/to/Kimochi.AppImage [arguments...]' >&2
  exit 2
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Steam's preload and game X server belong to the launcher, not the sidecar.
unset LD_PRELOAD
export DISPLAY=:0
export KIMOCHI_GAMESCOPE_SCALE=${KIMOCHI_GAMESCOPE_SCALE:-1}
export KIMOCHI_GAMESCOPE_UI_SCALE=${KIMOCHI_GAMESCOPE_UI_SCALE:-1.5}
if systemctl --user is-active --quiet kimochi-gaming-mode.service; then
  # The existing single-instance handler opens the first app's controls and exits.
  exec /bin/sh "$script_dir/launch-gaming-mode.sh" "$@"
fi
exec /bin/sh "$script_dir/launch-gaming-mode-service.sh" "$@"
