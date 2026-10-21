#!/bin/sh
# Install a stable Steam launcher in the user's data directory; never alter SteamOS.
#
# --link: the release points at the given executable instead of holding a copy. Kimochi's
# own "Add to Steam" (src-tauri/src/steam_library.rs) runs this script that way, with the
# AppImage it is running from, which the self-updater replaces in place.
set -eu
mode=copy
if [ "${1:-}" = "--link" ]; then mode=link; shift; fi
if [ "$#" -ne 1 ]; then
  echo 'Usage: sh install-gaming-mode.sh [--link] /path/to/Kimochi.AppImage' >&2
  exit 2
fi
artifact=$1
if [ ! -f "$artifact" ]; then echo "AppImage not found: $artifact" >&2; exit 1; fi
magic=$(od -An -tx1 -N11 "$artifact" | tr -d ' \n')
if [ "$mode" = link ]; then
  # Any ELF executable (an AppImage, or an installed kimochi binary), by absolute path.
  case "$artifact" in /*) ;; *) echo 'A linked executable needs an absolute path.' >&2; exit 1 ;; esac
  case "$magic" in 7f454c46*) ;; *) echo 'Expected a Kimochi executable (ELF).' >&2; exit 1 ;; esac
  if [ ! -x "$artifact" ]; then echo "Not executable: $artifact" >&2; exit 1; fi
else
  # AppImage header: ELF executable with the AI type marker at byte eight.
  case "$magic" in
    7f454c46????????414901|7f454c46????????414902) ;;
    *) echo 'Expected a Kimochi AppImage (ELF with AppImage marker).' >&2; exit 1 ;;
  esac
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
install_dir=$data_dir/kimochi/gaming-mode
applications=$data_dir/applications
# Desktop Exec fields cannot represent embedded line breaks.
case "$data_dir" in *'
'*) echo 'Installation path must not contain a newline.' >&2; exit 1;; esac
mkdir -p "$install_dir/releases" "$applications"
release=$(date +%s)-$$
staging=$install_dir/releases/.install-$release
trap 'rm -rf -- "$staging"; rm -f -- "$install_dir/.current-$$"' EXIT HUP INT TERM
mkdir -p "$staging/scripts"
if [ "$mode" = link ]; then
  ln -s -- "$artifact" "$staging/Kimochi.AppImage"
else
  cp -- "$artifact" "$staging/Kimochi.AppImage"
  chmod 755 "$staging/Kimochi.AppImage"
fi
for name in launch-gaming-mode.sh launch-gaming-mode-service.sh launch-from-steam.sh; do
  cp -- "$script_dir/$name" "$staging/scripts/$name"
  chmod 755 "$staging/scripts/$name"
done
cat > "$install_dir/.launch-$$" <<'LAUNCH'
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
release_dir=$(CDPATH= cd -- "$root/current" && pwd -P)
exec /bin/sh "$release_dir/scripts/launch-from-steam.sh" "$release_dir/Kimochi.AppImage" "$@"
LAUNCH
chmod 755 "$install_dir/.launch-$$"
mv -f -- "$install_dir/.launch-$$" "$install_dir/launch.sh"
mv -- "$staging" "$install_dir/releases/$release"
ln -s "releases/$release" "$install_dir/.current-$$"
mv -Tf -- "$install_dir/.current-$$" "$install_dir/current"
# Quote according to the Desktop Entry Exec grammar, including literal percent.
desktop_quote() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g; s/%/%%/g'; }
launcher=$(desktop_quote "$install_dir/launch.sh")
cat > "$applications/.kimochi-gaming-mode-$$.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kimochi
Comment=Read Japanese game text with OCR and dictionary overlays (Steam Gaming Mode)
Exec=/bin/sh "$launcher"
Icon=kimochi
Terminal=false
Categories=Education;Languages;
DESKTOP
mv -f -- "$applications/.kimochi-gaming-mode-$$.desktop" "$applications/kimochi-gaming-mode.desktop"
# The host portal registry requires a desktop entry matching our reverse-DNS
# identity. Preserve a normal Kimochi installation's entry if one exists.
if [ ! -f "$applications/dev.kimochi.app.desktop" ]; then
  cat "$applications/kimochi-gaming-mode.desktop" > "$applications/.kimochi-portal-$$.desktop"
  printf 'NoDisplay=true\n' >> "$applications/.kimochi-portal-$$.desktop"
  mv -f -- "$applications/.kimochi-portal-$$.desktop" "$applications/dev.kimochi.app.desktop"
fi
icon=$script_dir/kimochi.png
if [ ! -f "$icon" ]; then icon=$script_dir/../../src-tauri/icons/128x128.png; fi
if [ -f "$icon" ]; then
  mkdir -p "$data_dir/icons/hicolor/128x128/apps"
  cp -- "$icon" "$data_dir/icons/hicolor/128x128/apps/kimochi.png"
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$applications" >/dev/null 2>&1 || true; fi
printf 'Installed Kimochi Gaming Mode to %s\n' "$install_dir"
printf '%s\n' 'In Steam, choose Add a Game → Add a Non-Steam Game → Kimochi (the entry in kimochi/gaming-mode).'
printf '%s\n' 'For an update, run this installer with the new AppImage, quit Kimochi, then press Play again.'
printf '%s\n' 'Previous versions remain in releases/ for rollback. App settings and dictionaries are unchanged.'
