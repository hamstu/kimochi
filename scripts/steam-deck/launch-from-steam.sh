#!/bin/sh
# Steam tracks the actual app; independent native helpers guard modal input.
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
# Steam supplies the launcher's ID. Do not mistake this library entry for the game.
export KIMOCHI_STEAM_APP_ID=${KIMOCHI_STEAM_APP_ID:-${SteamAppId:-}}
# Keep Steam's launcher process attached to the actual application. Its normal
# STEAM_GAME controls and external overlays share one native process/data store.
export KIMOCHI_STEAM_MANAGED=1
exec /bin/sh "$script_dir/launch-gaming-mode.sh" "$@"
