# Headless GNOME rig

Runs GNOME Shell headless (Mutter's virtual monitor, software rendering) in a Fedora container, one
image per GNOME release, with Kimochi's Shell extension installed the way the app installs it
(stable loader + immutable implementation revision). It checks the extension and the native Mutter
capture driver on releases we have no VM for.

| Image | Fedora | GNOME |
| --- | --- | --- |
| `kimochi-gnome:f41` | 41 | 47 |
| `kimochi-gnome:f42` | 42 | 48 |
| `kimochi-gnome:f43` | 43 | 49 |
| `kimochi-gnome:f44` | 44 | 50 |
| `kimochi-gnome:f45` | 45 | 51 |

```sh
(cd capture-core && cargo build --example native_probe)
scripts/e2e-gnome/run.sh image all      # ~1.5 GB each
scripts/e2e-gnome/run.sh matrix         # every built image
scripts/e2e-gnome/run.sh test 45        # one release; logs and PNGs in $RIG (/tmp/kimochi-gnome-rig)
```

`test` checks that GNOME loads the extension (its `shell-version` and every API it touches at
enable), that `Windows` lists a Wayland and an XWayland window, that the `mutter` driver captures
both and activates one, that `Track` binds a window by Mutter id, that `Present`/`Clear` accept an
annotation for it, and that the Shell log has no JS errors.

The container has no systemd: `session.sh` starts a system bus with a stand-in logind
(`login1.py`, which GNOME Shell refuses to start without), a session bus, PipeWire and WirePlumber.
`run.sh x <cmd>` runs a command inside the session (`WAYLAND_DISPLAY`, `DISPLAY`,
`DBUS_SESSION_BUS_ADDRESS` set), e.g. the app itself: `run.sh x "$PWD/src-tauri/target/debug/kimochi"`.

When a GNOME release is added: build its image, run the matrix, then add the major to
`shell-version` in `src-tauri/gnome-extension/metadata.json` and `SHELL_VERSIONS` in
`src-tauri/src/platform/linux/gnome.rs` (a test keeps the two equal).
