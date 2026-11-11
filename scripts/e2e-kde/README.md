# KDE Plasma desktop tests

These drive the **real debug app** in a **real Plasma 6 session**: KWin (virtual backend, with GL
and XWayland), PipeWire, kglobalacceld and `xdg-desktop-portal-kde`, all headless in a rootless
Podman container. The window is chosen in KDE's own screen-share picker; the pointer and keys are
real compositor input (KWin's fake-input protocol). No browser previews and no mocked OCR.
Nothing on the host's own desktop is touched, so it runs unattended, also over SSH.

## Requirements

Linux with rootless Podman and a GPU render node (`/dev/dri/renderD*`: KWin's screencast, which the
portal needs, and its screenshots require GL; a VM's virtio-gpu is enough, and so is WSL2's `vgem`
node, where Mesa renders with llvmpipe). Your user must be able to open both `/dev/dri/renderD*` and
`/dev/dri/card*` (KWin opens the primary node to identify the device; without it KWin falls back to
QPainter and every screencast fails with "Unsupported compositing type"); the `render` and `video`
groups are the usual way. About 3 GB of disk for
the image. The repo's usual Node/Rust setup builds the app on the host; the container only runs it
(it mounts the repo and the binary's directory at the same paths).

```sh
scripts/e2e-kde/rig.sh image                  # once (~2 GB, Fedora 43 + Plasma 6)
node scripts/prepare.mjs && npm run build:frontend
npx tauri build --debug --no-bundle           # the binary the rig runs (KIMOCHI_BIN overrides)
```

## Run

```sh
node scripts/e2e-kde/run.mjs                  # native Wayland game window, 100%, one monitor
node scripts/e2e-kde/run.mjs --scale 1.5      # fractional scaling (set like System Settings does)
node scripts/e2e-kde/run.mjs --x11            # the game through XWayland
node scripts/e2e-kde/run.mjs --outputs 2      # two monitors; the game moves to the second
node scripts/e2e-kde/run.mjs --twin           # two equal-size windows: Kimochi must ask which
node scripts/e2e-kde/run.mjs --dictionary     # downloads 10ten (network) and checks Shift lookups
node scripts/e2e-kde/run.mjs --no-eavesdrop   # Legacy X11 App Support: Never (no Shift; hover lookups)
```

Each run starts a fresh session and profile, opens a fake game (`target.py`, which reports where it
drew its text), starts Kimochi, approves its global shortcuts, shares the game's window through the
picker and checks: OCR, the stream linked to the right KWin window, overlay boxes on the game's text
(also after a move, on another output), the Shift gate (without Shift a click on the text reaches
the game and nothing lights; with it the line's card shows and the overlay takes the click), the
compositor pointer, the overlay clearing for a minimized game, Bring to front and the Shift+F8
portal shortcut. Results and screenshots go to
`$KIMOCHI_KDE_RIG/out` (default `${TMPDIR:-/tmp}/kimochi-kde-rig/out`); logs (KWin, portal, Kimochi)
to `$KIMOCHI_KDE_RIG/log`. Exit code 1 when any check fails.

## Poking at it by hand

`rig.sh` keeps a session up between commands:

```sh
scripts/e2e-kde/rig.sh up                     # WIDTH HEIGHT SCALE OUTPUTS
scripts/e2e-kde/rig.sh target                 # the fake game; GDK_BACKEND=x11 for XWayland
scripts/e2e-kde/rig.sh app                    # Kimochi (log: $KIMOCHI_KDE_RIG/log/kimochi.log)
scripts/e2e-kde/rig.sh k status --json        # the kimochi CLI against it
scripts/e2e-kde/rig.sh shot /tmp/desk.png     # screenshot (KWin's ScreenShot2)
scripts/e2e-kde/rig.sh js 'for (const w of workspace.windowList()) out([w.caption, w.frameGeometry])'
scripts/e2e-kde/rig.sh input move 600 400 click
node scripts/e2e-kde/wk.mjs eval overlay.html 'document.title'   # JS in any Kimochi window
```

Each `input` call is its own fake device, and KWin releases its keys when it ends: hold a key and
check things in one call (or `rig.hold` in run.mjs), never `keydown` alone.

`wk.mjs` talks to WebKitGTK's remote inspector (`WEBKIT_INSPECTOR_HTTP_SERVER`, port 9333, set by
`rig.sh app`); `ui.mjs` taps Kimochi's UI by visible text with real pointer clicks.

## Native capture driver

`native-kwin.sh` checks capture-core's `kwin` driver (`linux_native/kwin.rs`: KWin's window list and
screencast by window uuid, no picker) with `examples/native_probe`: a Wayland and an XWayland game
window, overlapping, then list, capture, thumbnails, bench and activate; PNGs in `$RIG/out`.
`--auth` runs KWin with its real permission checks (`RIG_PERMISSION_CHECKS=1`) and proves the probe
is refused until a desktop file with `X-KDE-Wayland-Interfaces` names its executable.
`KWIN_LOGGING_RULES` (e.g. `kwin_core.debug=true;KWIN_UTILS.debug=true`) replaces KWin's logging
rules for a session.

## Rig notes

- KWin starts through `kwin_wayland_wrapper`, as Plasma does: it owns the XWayland sockets. KWin
  itself must start without `XDG_CURRENT_DESKTOP=KDE` and friends (it crashes in this minimal
  session); only its clients get them.
- `KWIN_WAYLAND_NO_PERMISSION_CHECKS=1` opens fake input to the injector; the screenshot helper gets
  KWin's screenshot API from a desktop file, as real apps do.
- The virtual backend's `--scale` only makes the output bigger; `SCALE` is applied with
  `kscreen-doctor`, a real output scale.
- Screen locking is off (nobody is at this desktop).
