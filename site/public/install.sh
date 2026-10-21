#!/bin/sh
# Kimochi installer for Linux (Steam Deck Desktop Mode, Ubuntu, Fedora, Arch, ...).
#
#   curl -fsSL https://<kimochi-site>/install.sh | sh
#   curl -fsSL https://<kimochi-site>/install.sh | sh -s -- --uninstall
#
# Installs the newest Kimochi AppImage for this CPU in your home directory (no sudo; SteamOS's
# read-only system partition is never touched), adds it to the application menu, and starts it.
# Run it again to update in place; settings, dictionaries and history are kept.
#
# Layout (XDG_DATA_HOME defaults to ~/.local/share):
#   $XDG_DATA_HOME/kimochi/Kimochi.AppImage            the app (a fixed name: the in-app updater
#                                                       rewrites this file in place)
#   $XDG_DATA_HOME/applications/Kimochi.desktop        the menu entry (same id as the .deb's)
#   $XDG_DATA_HOME/applications/dev.kimochi.app.desktop  hidden; the screen-capture portal looks
#                                                       up Kimochi's reverse-DNS id
#   $XDG_DATA_HOME/icons/hicolor/<size>/apps/kimochi.png
#
# Options (or environment variables):
#   --uninstall                 remove the app and its menu entries (app data is kept)
#   --no-launch                 KIMOCHI_NO_LAUNCH=1: do not start Kimochi afterwards
#   --nightly                   KIMOCHI_CHANNEL=nightly: the rolling development build
#   --appimage <file>           KIMOCHI_APPIMAGE=<file>: install this AppImage, no download
#   --help
# For testing and mirrors: KIMOCHI_INSTALL_REPO (owner/name), KIMOCHI_INSTALL_API (releases API
# base), KIMOCHI_INSTALL_RAW (raw file base), KIMOCHI_INSTALL_ARCH (overrides `uname -m`).
#
# The whole script is one function called on the last line, so a download cut short runs nothing.

kimochi_install() {
  set -eu

  repo=${KIMOCHI_INSTALL_REPO:-hamstu/kimochi-tauri}
  api=${KIMOCHI_INSTALL_API:-https://api.github.com/repos/$repo/releases}
  raw=${KIMOCHI_INSTALL_RAW:-https://raw.githubusercontent.com/$repo}
  releases_page="https://github.com/$repo/releases"
  channel=${KIMOCHI_CHANNEL:-stable}
  no_launch=${KIMOCHI_NO_LAUNCH:-0}
  local_appimage=${KIMOCHI_APPIMAGE:-}
  action=install

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --uninstall) action=uninstall ;;
      --no-launch) no_launch=1 ;;
      --nightly) channel=nightly ;;
      --appimage)
        [ "$#" -ge 2 ] || die "--appimage needs a file"
        local_appimage=$2
        shift ;;
      --appimage=*) local_appimage=${1#--appimage=} ;;
      -h | --help) usage; return 0 ;;
      *) die "Unknown option: $1 (try --help)" ;;
    esac
    shift
  done
  case "$no_launch" in 1 | true | yes) no_launch=1 ;; *) no_launch=0 ;; esac
  case "$channel" in stable | nightly) ;; *) die "KIMOCHI_CHANNEL must be stable or nightly" ;; esac

  [ "$(uname -s)" = Linux ] || [ -n "${KIMOCHI_INSTALL_ARCH:-}" ] || die "This installer is for Linux. For macOS and Windows, see $releases_page"
  [ -n "${HOME:-}" ] || die "HOME is not set."

  data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
  case "$data_dir" in /*) ;; *) die "XDG_DATA_HOME must be an absolute path." ;; esac
  # Desktop Exec fields cannot represent embedded line breaks.
  case "$data_dir" in *'
'*) die "The installation path must not contain a newline." ;; esac
  install_dir=$data_dir/kimochi
  appimage=$install_dir/Kimochi.AppImage
  applications=$data_dir/applications
  icons=$data_dir/icons/hicolor
  entry=$applications/Kimochi.desktop
  portal_entry=$applications/dev.kimochi.app.desktop
  marker='X-Kimochi-Installer=install.sh'

  if [ "$action" = uninstall ]; then
    uninstall
  else
    install
  fi
}

usage() {
  cat <<'USAGE'
Install or update Kimochi for this user (no sudo needed).

  curl -fsSL https://<kimochi-site>/install.sh | sh
  curl -fsSL https://<kimochi-site>/install.sh | sh -s -- [options]

Options:
  --uninstall          Remove Kimochi and its menu entries (your data is kept)
  --no-launch          Do not start Kimochi when done   (KIMOCHI_NO_LAUNCH=1)
  --nightly            Install the development build     (KIMOCHI_CHANNEL=nightly)
  --appimage <file>    Install a downloaded AppImage     (KIMOCHI_APPIMAGE=<file>)
  --help               Show this help
USAGE
}

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------------------------ download

have() { command -v "$1" >/dev/null 2>&1; }

# fetch URL FILE [progress]: download URL to FILE and print the HTTP status ("000" when there
# was no response). Exit status 0 for a 2xx answer only.
fetch() {
  _url=$1 _out=$2 _progress=${3:-}
  if have curl; then
    if [ -n "$_progress" ] && [ -t 2 ]; then
      _status=$(curl -L --progress-bar --retry 2 -H 'Accept: application/vnd.github+json' -o "$_out" -w '%{http_code}' "$_url") || _status=${_status:-000}
    else
      _status=$(curl -sSL --retry 2 -H 'Accept: application/vnd.github+json' -o "$_out" -w '%{http_code}' "$_url") || _status=${_status:-000}
    fi
  elif have wget; then
    _headers=$_out.headers
    if [ -n "$_progress" ] && [ -t 2 ]; then
      wget -S --header='Accept: application/vnd.github+json' -O "$_out" "$_url" 2>"$_headers" || true
    else
      wget -q -S --header='Accept: application/vnd.github+json' -O "$_out" "$_url" 2>"$_headers" || true
    fi
    _status=$(sed -n 's/^ *HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$_headers" | tail -n 1)
    rm -f -- "$_headers"
    _status=${_status:-000}
  else
    die "Neither curl nor wget is installed. Install one of them (e.g. sudo apt install curl) and try again."
  fi
  printf '%s' "$_status"
  case "$_status" in 2??) return 0 ;; *) return 1 ;; esac
}

# A JSON string field's values, one per line (enough for GitHub's release document).
json_strings() {
  # shellcheck disable=SC2020 # three characters, each to a newline
  tr ',{}' '\n\n\n' <"$2" | sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# The release document for the chosen channel in $1; sets `release_kind`. A tagged release comes
# from /releases/latest (never a pre-release); until one exists that 404s and the rolling
# `nightly` pre-release is used, as on the website.
fetch_release() {
  if [ "$channel" = stable ]; then
    if status=$(fetch "$api/latest" "$1"); then release_kind=stable; return 0; fi
    [ "$status" = 404 ] || release_error "$status"
  fi
  if status=$(fetch "$api/tags/nightly" "$1"); then release_kind=nightly; return 0; fi
  release_error "$status"
}

release_error() {
  case "$1" in
    403 | 429) die "GitHub's download limit was reached for your network. Wait a few minutes and try again, or download the AppImage from $releases_page and run this installer with --appimage <file>." ;;
    404) die "No Kimochi release was found at $releases_page" ;;
    000) die "Could not reach GitHub. Check your internet connection and try again." ;;
    *) die "GitHub answered $1 when asked for the latest release. Try again later, or see $releases_page" ;;
  esac
}

# The AppImage asset for this CPU from a release document: a generic build, never the "-arch"
# (Arch Linux runner) variant, matching the website's choice (site/src/lib/assets.js).
pick_asset() {
  json_strings browser_download_url "$1" | grep '/releases/download/' | while IFS= read -r url; do
    name=${url##*/}
    case "$name" in *.AppImage | *.appimage) ;; *) continue ;; esac
    lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    case "$arch" in
      aarch64) case "$lower" in *aarch64* | *arm64*) ;; *) continue ;; esac ;;
      *) case "$lower" in *aarch64* | *arm64*) continue ;; *x86_64* | *x64* | *amd64*) ;; *) continue ;; esac ;;
    esac
    # A distro-specific build such as "-arch"; "aarch64" must not count.
    if printf '%s' "$lower" | grep -Eq '(^|[^a-z0-9])arch([^a-z0-9]|$)'; then continue; fi
    printf '%s\n' "$url"
  done | head -n 1
}

detect_arch() {
  machine=${KIMOCHI_INSTALL_ARCH:-$(uname -m)}
  case "$machine" in
    x86_64 | amd64 | x64) arch=x86_64 ;;
    aarch64 | arm64 | armv8*) arch=aarch64 ;;
    *) die "Kimochi has Linux builds for x86_64 and ARM64 (aarch64); this computer is $machine." ;;
  esac
}

# AppImage header: ELF executable with the AI type marker at byte eight.
is_appimage() {
  magic=$(od -An -tx1 -N11 "$1" 2>/dev/null | tr -d ' \n')
  case "$magic" in
    7f454c46????????414901 | 7f454c46????????414902) return 0 ;;
    *) return 1 ;;
  esac
}

is_png() {
  [ "$(od -An -tx1 -N8 "$1" 2>/dev/null | tr -d ' \n')" = 89504e470d0a1a0a ]
}

# --------------------------------------------------------------------------------- environment

# The AppImage runtime mounts itself with a setuid `fusermount` from FUSE 3 (it bundles libfuse,
# so libfuse2 is not needed). Without one it can still run by extracting itself on every start.
have_fuse() {
  [ -e /dev/fuse ] || return 1
  for candidate in fusermount3 fusermount; do
    if have "$candidate" && "$candidate" --version 2>&1 | grep -Eq 'version:? *3'; then return 0; fi
  done
  return 1
}

fuse_hint() {
  distro=
  if [ -r /etc/os-release ]; then
    distro=$(sed -n 's/^ID=//p; s/^ID_LIKE=//p' /etc/os-release | tr -d '"' | tr '\n' ' ')
  fi
  case " $distro " in
    *' steamos '*) say "  SteamOS normally includes FUSE. A system update may fix it." ;;
    *' fedora '* | *' rhel '*) say "  To fix it: sudo dnf install fuse3" ;;
    *' arch '*) say "  To fix it: sudo pacman -S fuse3" ;;
    *' suse '* | *' opensuse '*) say "  To fix it: sudo zypper install fuse3" ;;
    *' debian '* | *' ubuntu '*) say "  To fix it: sudo apt install fuse3" ;;
    *) say "  To fix it, install your distribution's fuse3 package." ;;
  esac
  say "  Then run this installer again for faster starts."
}

# Quote according to the Desktop Entry Exec grammar, including literal percent.
# shellcheck disable=SC2016 # literal $ and ` are what is escaped
desktop_quote() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g; s/%/%%/g'; }

# Whether FILE was written by this installer, or by the app itself for this AppImage.
ours() {
  [ -f "$1" ] || return 1
  grep -q "^$marker" "$1" && return 0
  grep -q '^X-Kimochi-Generated=true' "$1" && return 0
  return 1
}

# -------------------------------------------------------------------------------------- install

install() {
  detect_arch
  mkdir -p "$install_dir" "$applications"
  work=$(mktemp -d "$install_dir/.install-XXXXXX") || die "Could not create a temporary directory in $install_dir"
  # shellcheck disable=SC2064 # expand now: $work is fixed for this run
  trap "rm -rf -- '$work'" EXIT
  trap 'exit 130' HUP INT TERM
  download=$work/Kimochi.AppImage
  tag=

  if [ -n "$local_appimage" ]; then
    [ -f "$local_appimage" ] || die "AppImage not found: $local_appimage"
    step "Installing $local_appimage"
    cp -- "$local_appimage" "$download"
    release_kind=local
  else
    have curl || have wget || die "Neither curl nor wget is installed. Install one of them (for example: sudo apt install curl) and try again."
    step "Looking up the newest Kimochi release"
    fetch_release "$work/release.json"
    tag=$(json_strings tag_name "$work/release.json" | head -n 1)
    url=$(pick_asset "$work/release.json")
    [ -n "$url" ] || die "The ${tag:-latest} release has no AppImage for $arch. See $releases_page"
    if [ "$release_kind" = nightly ]; then label="development build (nightly)"; else label=$tag; fi
    step "Downloading Kimochi $label for $arch"
    say "    $url"
    status=$(fetch "$url" "$download" progress) || die "The download failed (HTTP $status). Try again, or see $releases_page"
  fi

  is_appimage "$download" || die "Expected a Kimochi AppImage (ELF with AppImage marker); the downloaded file is not one."
  chmod 755 "$download"

  if [ -f "$appimage" ]; then updating=1; else updating=0; fi
  # The same directory, so the rename is atomic; a running Kimochi keeps its old copy open.
  mv -f -- "$download" "$appimage"

  fuse=1
  have_fuse || fuse=0

  install_icons
  write_entries
  refresh_caches

  say ""
  if [ "$updating" = 1 ]; then say "Kimochi is updated."; else say "Kimochi is installed."; fi
  say "  App:        $appimage"
  say "  Menu entry: $entry"
  say "  Your settings and dictionaries are kept across updates and reinstalls."
  say "  Kimochi updates itself from inside the app; you can also run this installer again."
  say "  To remove it, run this installer again with --uninstall (sh -s -- --uninstall)."
  if [ -f /usr/share/applications/Kimochi.desktop ]; then
    say ""
    warn "the Kimochi .deb package is also installed. Its menu entry is now hidden behind this one; remove it with: sudo apt remove kimochi"
  fi
  if [ "$fuse" = 0 ]; then
    say ""
    warn "FUSE 3 was not found, so Kimochi will unpack itself each time it starts (slower, but it works)."
    fuse_hint
  fi

  launch
}

install_icons() {
  extracted=$work/icons
  mkdir -p "$extracted"
  # The icons the AppImage carries (usr/share/icons/hicolor/<size>/apps/kimochi.png). Extracting
  # needs no FUSE.
  (cd "$work" && "$appimage" --appimage-extract 'usr/share/icons/hicolor/*' >/dev/null 2>&1 </dev/null) || true
  found=0
  if [ -d "$work/squashfs-root/usr/share/icons/hicolor" ]; then
    for icon in "$work"/squashfs-root/usr/share/icons/hicolor/*/apps/kimochi.png; do
      if [ ! -f "$icon" ] || ! is_png "$icon"; then continue; fi
      size=$(basename "$(dirname "$(dirname "$icon")")")
      # tauri names its 2x icon "256x256@2"; the pixels are what matter here.
      size=${size%@*}
      case "$size" in [0-9]*x[0-9]*) ;; *) continue ;; esac
      cp -- "$icon" "$extracted/$size.png"
      found=1
    done
  fi
  # Otherwise the sources this release was built from (main for a local AppImage).
  if [ "$found" = 0 ] && { have curl || have wget; }; then
    for pair in 32x32:32x32 64x64:64x64 128x128:128x128 256x256:128x128@2x 512x512:icon; do
      size=${pair%%:*} name=${pair#*:}
      if fetch "$raw/${tag:-main}/src-tauri/icons/$name.png" "$extracted/$size.png" >/dev/null && is_png "$extracted/$size.png"; then
        found=1
      else
        rm -f -- "$extracted/$size.png"
      fi
    done
  fi
  if [ "$found" = 0 ]; then
    warn "could not find Kimochi's icon; the menu entry will use a generic one until the next update."
    return 0
  fi
  for icon in "$extracted"/*.png; do
    size=$(basename "$icon" .png)
    mkdir -p "$icons/$size/apps"
    cp -- "$icon" "$icons/$size/apps/.kimochi.png.$$"
    mv -f -- "$icons/$size/apps/.kimochi.png.$$" "$icons/$size/apps/kimochi.png"
  done
}

write_entries() {
  quoted=$(desktop_quote "$appimage")
  if [ "$fuse" = 1 ]; then exec_line="\"$quoted\" %u"; else exec_line="env APPIMAGE_EXTRACT_AND_RUN=1 \"$quoted\" %u"; fi
  # Kimochi.desktop: the .deb's file name, the id the app registers with the desktop portal, and
  # the entry the app itself would otherwise generate (it keeps any entry without its marker).
  # StartupWMClass is the executable's name, which GTK reports as the window's class/app id.
  if [ -f "$entry" ] && ! ours "$entry"; then
    cp -- "$entry" "$entry.bak"
    warn "replaced your own $entry (a copy is in $entry.bak)."
  fi
  cat >"$applications/.Kimochi.desktop.$$" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kimochi
GenericName=Japanese Reading Assistant
Comment=Read your games in Japanese with on-screen OCR, pop-up dictionaries and a reading log
Exec=$exec_line
Icon=kimochi
Terminal=false
StartupWMClass=kimochi
Categories=Education;Languages;
Keywords=Japanese;OCR;dictionary;Yomitan;reader;games;
MimeType=x-scheme-handler/kimochi;
$marker
DESKTOP
  mv -f -- "$applications/.Kimochi.desktop.$$" "$entry"

  # The screen-capture portal looks Kimochi up by its reverse-DNS id when it runs from Steam.
  # Hidden, so the menu shows one Kimochi. An existing one (the Gaming Mode helper's) is kept.
  if [ ! -f "$portal_entry" ] || grep -q "^$marker" "$portal_entry"; then
    cat >"$applications/.dev.kimochi.app.desktop.$$" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kimochi
Exec=$exec_line
Icon=kimochi
Terminal=false
StartupWMClass=kimochi
NoDisplay=true
$marker
DESKTOP
    mv -f -- "$applications/.dev.kimochi.app.desktop.$$" "$portal_entry"
  fi
}

refresh_caches() {
  if have update-desktop-database; then update-desktop-database -q "$applications" >/dev/null 2>&1 || true; fi
  if [ -d "$icons" ] && have gtk-update-icon-cache; then gtk-update-icon-cache -q -t -f "$icons" >/dev/null 2>&1 || true; fi
  # KDE Plasma (Steam Deck Desktop Mode) rebuilds its menu from this cache.
  for tool in kbuildsycoca6 kbuildsycoca5; do
    if have "$tool"; then "$tool" >/dev/null 2>&1 </dev/null || true; break; fi
  done
}

launch() {
  if [ "$no_launch" = 1 ]; then
    say ""
    say "Open Kimochi from your application menu when you are ready."
    return 0
  fi
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    say ""
    say "No desktop session found here, so Kimochi was not started. Open it from your application menu."
    return 0
  fi
  if have pgrep && pgrep -x kimochi >/dev/null 2>&1; then
    say ""
    say "Kimochi is already running. Quit it and open it again to use this version."
    return 0
  fi
  say ""
  step "Starting Kimochi"
  if [ "$fuse" = 0 ]; then export APPIMAGE_EXTRACT_AND_RUN=1; fi
  if have setsid; then
    setsid "$appimage" </dev/null >/dev/null 2>&1 &
  else
    nohup "$appimage" </dev/null >/dev/null 2>&1 &
  fi
}

# ------------------------------------------------------------------------------------ uninstall

# Whether a desktop file starts this installation's AppImage.
runs_ours() {
  [ -f "$1" ] && grep '^Exec=' "$1" | grep -qF "$(desktop_quote "$appimage")"
}

uninstall() {
  removed=0
  if [ -f "$appimage" ]; then rm -f -- "$appimage"; removed=1; fi
  for file in "$entry" "$portal_entry"; do
    if [ -f "$file" ] && { grep -q "^$marker" "$file" || { ours "$file" && runs_ours "$file"; }; }; then
      rm -f -- "$file"
      removed=1
    fi
  done
  # The kimochi:// handler the app registers for itself.
  if runs_ours "$applications/kimochi-handler.desktop"; then rm -f -- "$applications/kimochi-handler.desktop"; fi
  # The Steam Deck Gaming Mode helper shares the icon; keep it while that is installed.
  if [ ! -d "$install_dir/gaming-mode" ]; then
    for icon in "$icons"/*/apps/kimochi.png; do
      [ -f "$icon" ] && rm -f -- "$icon"
    done
  fi
  rm -rf -- "$install_dir"/.install-*
  rmdir -- "$install_dir" 2>/dev/null || true
  refresh_caches
  if [ "$removed" = 1 ]; then say "Kimochi is uninstalled."; else say "Kimochi was not installed by this installer; nothing to remove."; fi
  if [ -d "$install_dir/gaming-mode" ]; then
    say "  The Steam Gaming Mode launcher in $install_dir/gaming-mode was left in place."
  fi
  say "  Your settings and dictionaries were kept. To delete them too:"
  say "    rm -rf \"$data_dir/dev.kimochi.app\" \"${XDG_CONFIG_HOME:-$HOME/.config}/dev.kimochi.app\" \"${XDG_CACHE_HOME:-$HOME/.cache}/dev.kimochi.app\""
}

kimochi_install "$@"
