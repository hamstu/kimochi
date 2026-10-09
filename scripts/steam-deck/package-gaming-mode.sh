#!/bin/sh
# Optional Linux release companion; the application remains an ordinary AppImage.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: sh package-gaming-mode.sh /path/to/Kimochi.AppImage /path/to/output.tar.gz' >&2
  exit 2
fi
artifact=$1
output=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(mktemp -d)
trap 'rm -rf -- "$package_dir"' EXIT HUP INT TERM
mkdir "$package_dir/Kimochi-Gaming-Mode"
cp -- "$artifact" "$package_dir/Kimochi-Gaming-Mode/Kimochi.AppImage"
for name in install-gaming-mode.sh launch-from-steam.sh launch-gaming-mode.sh launch-gaming-mode-service.sh; do
  cp -- "$script_dir/$name" "$package_dir/Kimochi-Gaming-Mode/$name"
done
cp -- "$script_dir/../../src-tauri/icons/128x128.png" "$package_dir/Kimochi-Gaming-Mode/kimochi.png"
cat > "$package_dir/Kimochi-Gaming-Mode/INSTALL.txt" <<'INSTALL'
Kimochi Gaming Mode

One-time setup in Desktop Mode:
1. Extract this archive and open a terminal in Kimochi-Gaming-Mode.
2. Run: sh install-gaming-mode.sh ./Kimochi.AppImage
3. Steam: Add a Game > Add a Non-Steam Game > Kimochi Gaming Mode.
4. Return to Gaming Mode. Launch Kimochi from your Steam library, then your game.

Press both sticks to open Kimochi's radial menu. B returns control to the game.
Press Play on Kimochi's library entry again to reopen controls or recover after Quit.

Updating: install a new archive with the same command. Quit Kimochi and press Play
again. Settings and dictionaries persist; previous versions remain under
~/.local/share/kimochi/gaming-mode/releases/ (or your XDG_DATA_HOME).
The Steam library entry stays valid. This is a manual installation/update helper,
not an automatic updater, and does not change the SteamOS system partition.

To roll back while Kimochi is closed, point the current symlink in that directory
at a previous releases/<version> directory. To remove the helper, remove its
gaming-mode directory, applications/kimochi-gaming-mode.desktop and
icons/hicolor/128x128/apps/kimochi.png from your user data directory. Remove the
non-Steam shortcut in Steam. Your dev.kimochi.app data is retained.
INSTALL
tar -czf "$output" -C "$package_dir" Kimochi-Gaming-Mode
printf 'Packaged Gaming Mode installer: %s\n' "$output"
