# platform/linux: dependencies and integration contract

## Ubuntu build prerequisites

The README's Ubuntu command includes PipeWire/SPA development headers and libclang
for capture bindings, `libudev-dev` for gilrs gamepad support, and GStreamer development
metadata plus base/good/bad runtime plugins for packaging/audio. Missing `libudev.pc`
was reproduced by the first Ubuntu app build; see `UBUNTU_BRINGUP.md` and its evidence.
Use Node >=22, npm >=10 and Rust stable >=1.87 with Clippy/rustfmt. Japanese fonts
(`fonts-noto-cjk`) and diagnostic tools (`mesa-utils`, `wayland-utils`, `x11-utils`)
help runtime acceptance. Install an IME only by user agreement.

Optional `libgtk-layer-shell0` enables native overlays only when the current
compositor advertises layer-shell. Ubuntu 24.04 GNOME Wayland's native library probe
returned unsupported even with that package installed; capture and reader panels
remain the supported tier there. An Xorg login is a separate acceptance target.

## Cargo

```toml
[target.'cfg(target_os = "linux")'.dependencies]
# Pure-Rust X11 protocol (no libxcb, no pkg-config). Same major as capture-core's, so
# one copy is compiled and `kimochi_capture::x11::Desktop` speaks these types.
x11rb = { version = "0.13", features = ["randr", "xinput", "shape"] }
# logind PrepareForSleep. Already in the tree through tauri-plugin-single-instance
# (same default features), so nothing new is compiled.
zbus = "5.9"
# Main-loop marshalling for observe_workspace's non-Send callbacks. The glib tauri/gtk
# 0.18 already use.
glib = "0.18"
# The X window id of our own windows (tao reports Xlib handles on X11).
raw-window-handle = "0.6"
```

`png` is already an unconditional dependency. All four crates are already in
`Cargo.lock` (x11rb via arboard, zbus via single-instance, glib via gtk,
raw-window-handle via tauri), so the merge adds direct edges only.

capture-core gains `x11rb = { version = "0.13", features = ["randr"] }` for Linux (done
in `capture-core/Cargo.toml`). `xcap` was evaluated and rejected: on Linux it links
libxcb, libwayland, PipeWire and D-Bus system libraries for every build, which cannot
even be type-checked without the target's `-dev` packages.

Module wiring (done): `platform/mod.rs` selects `mod linux; pub use linux::*;` under
`cfg(target_os = "linux")`; `unsupported` remains for other targets.

## Contract notes for the integrator

- **Coordinates.** Desktop units = X11 root pixels / GDK window scale (`GDK_SCALE`, else
  the `Gdk/WindowScalingFactor` XSETTING, else 1). That equals Tauri's logical
  coordinates on X11, so `desktop_unit()` = `Points` is right for Linux (the
  `DesktopUnit::PhysicalPixels` doc comment in `platform/mod.rs` says "(Windows, X11)";
  X11 here is `Points`). `DisplayInfo.scale_factor` is the GDK scale (pixels per unit),
  never applied to coordinates. capture-core's X11 frames are root pixels with
  `FrameInfo.scale_factor` = pixels per desktop unit, as on macOS. `panel_pointer` is
  window-local CSS pixels.
- **Wayland.** Session detected once (`XDG_SESSION_TYPE`, else `WAYLAND_DISPLAY`;
  `kimochi_capture::is_wayland_session` is the single rule both crates use). Under
  Wayland: `cursor`/`front_window`/`window_bounds`/`frontmost_*`/`app_icon_png` are
  `None`, `displays`/`display_infos` empty (so `clamp_to_visible` is a no-op),
  `picker_sources`/`make_panel`/`start_key_trigger`/`activate_*` are
  `Err("unsupported on Wayland: …")`, `promote_to_key` is `Ok(false)`, `order_front`
  is a plain `show()`. `observe_workspace` still reports sleep/wake (logind), never
  activation. capture-core returns `PortalCapture` (backend `xdg-portal-pipewire`,
  `system_picker_required: true`): permission is `promptOnSelect` until
  `request_permission()` has run the system picker, then `granted` while that session
  lives; `enumerate` lists only the picked stream(s) as `portal:display:{node}` /
  `portal:window:{node}`. Startup restores a saved portal token without forcing a new-source action. The
  source submenu offers "Use Current Source" and "Choose New Source…"; the latter
  closes the old portal session and clears its token before opening a fresh picker.
  Cancel clears a spent token; non-cancellation failures retain their exact error.
- **Ids.** `x11:window:{xid}:{pid}` (decimal xid), `x11:window:{xid}` for clients
  without `_NET_WM_PID`; `x11:display:{first RandR output XID}` (0 = whole root when
  RandR is missing). Minted only by `kimochi_capture::x11`, shared with the capture
  backend. Window bounds are the *client* area (no WM title bar), minus GTK CSD shadow
  margins (`_GTK_FRAME_EXTENTS`), which is exactly what the backend captures.
- **Catalog rule.** Listed windows are viewable, not `_NET_WM_STATE_HIDDEN`, titled,
  ≥ 80x60 root px, `_NET_WM_WINDOW_TYPE` normal/dialog (or none), not our pid. The rule
  is `kimochi_capture::x11::is_listable` (one copy for both crates). Minimised
  windows and windows on other workspaces are not listed (X unmaps them).
- **`front_window`** = `_NET_ACTIVE_WINDOW` + `_NET_WM_PID`; `window` is `None` for
  unreadable windows (dock, desktop, unmapped, tiny); `None` overall when nothing is
  active or the client has no pid. App names (`frontmost_app`, picker `app`, focus
  events, activation) are the executable's file name from `/proc/<pid>/exe`, else
  `/proc/<pid>/comm`; for this app that is `kimochi` (`ownAppNames`).
- **Panels (`make_panel`, X11).** Tauri `set_focusable(false)` (GTK accept-focus →
  `WM_HINTS.input = False`), `set_skip_taskbar(true)` (taskbar + pager hints),
  `set_always_on_top(true)` (`_NET_WM_STATE_ABOVE`), plus `_NET_WM_WINDOW_TYPE_UTILITY`
  and `_NET_WM_USER_TIME = 0` set over X11. The type change happens after the window is
  mapped/managed: Mutter and KWin honour it, some small WMs ignore it (harmless).
  `KIMOCHI_NO_PANEL` honoured.
- **`promote_to_key` activates Kimochi's window** (`_NET_ACTIVE_WINDOW`, source
  "pager"); a panel becomes focusable for the duration and returns to accept-focus=false
  on its next blur (a `WindowEvent::Focused(false)` handler installed once per label);
  for a panel the activation is sent 50 ms later, after GDK has flushed the new `WM_HINTS`.
  `HOVER_PROMOTES_KEY` is already false off macOS, so this only runs for explicit
  editing. Grant is asynchronous; `Ok(true)` means "requested".
- **`order_front`** = tao `show()` (a map, never `present`) + `_NET_RESTACK_WINDOW`
  (Above) + `ConfigureWindow(StackMode::Above)`. No focus change for panels.
- **`panel_pointer`** uses `QueryPointer` on the root: the server reports the top-level
  whose *input region* contains the pointer, so a window currently click-through (tao's
  `set_ignore_cursor_events` installs an empty input shape) never has the pointer, the
  same limit `WindowFromPoint` has on Windows. **`panel_cursor`** is a no-op `Ok`:
  X11 sends motion to unfocused windows, so WebKitGTK maintains the cursor itself
  (`nativeHoverWorkaround: false`).
- **Input regions (`set_input_regions`, X11).** An XShape *input* region on the
  window's X window (`ShapeRectangles`, `SK::INPUT`, `SO::SET`, unsorted), so the server
  routes the pointer to the window only inside the published rectangles, with no poll
  latency; the bounding (painted) shape is untouched. Rects arrive window-local in CSS
  pixels and are scaled by the GDK scale, snapped outward, clamped to the window's X
  geometry and merged (`rules::input_shape`). `None` restores the default shape
  (`ShapeMask` with no pixmap). Requests are `check()`ed (one round trip per change).
  `Ok(true)` only with SHAPE >= 1.1 on X11 (`capabilities().overlay.inputRegions` is then
  `"native"`, else `"poll"`; Wayland `"wholeWindowOnly"` and `Ok(false)`).
  The cursor poll (`main.rs` `sync_input_shapes`) probes each of the overlay and popup
  host once, then keeps their shapes in step with their regions (rewritten on change,
  and every ~2 s regardless) and never calls `set_ignore_cursor_events` on them again:
  tao implements that setter with a GDK input shape on GDK's own connection (1x1 region
  for "ignore", the default shape for "don't"), which would race and overwrite ours. A
  `SET` replaces whatever GDK last installed, so the overlay's initial "ignore" needs no
  undoing. Reparenting window managers must propagate the client's input shape to the
  frame; the mainstream ones do (tao's own click-through relies on it too).
- **`start_key_trigger`** (X11): XInput 2 raw key events on the root (`XI_RawKeyPress`/
  `Release`, all master devices) on a dedicated thread with its own connection. Lines:
  `{"key","keyCode","action","repeat"}` (Windows module's key names; `keyCode` is the
  X keycode; repeat = down while held) and `{"type":"windowFocus","appName",
  "windowTitle","appPath"}` on every `_NET_ACTIVE_WINDOW` change, our own windows
  included, plus one at start. XTEST (synthetic) devices are ignored. `stop_key_trigger()`
  exists as on Windows (not in the shared contract). `key_trigger_status` is
  `available/notRequired` on X11 with a live X connection; on Wayland `unsupported` with
  a reason and evdev-opt-in remediation text. `watcher.rs::start` sets
  `view.accessibility = permission == "granted"`, which is false for `notRequired`;
  the Windows module has the same situation.
- **`observe_workspace`** must be called on the main (GTK) thread (it is, from
  `setup`): callbacks are stored there and run there via `glib::idle_add_once` from two
  watcher threads (logind over the system bus; `_NET_ACTIVE_WINDOW` PropertyNotify,
  reported once per change of active *process*). Without logind, sleep/wake never fire
  (logged to stderr).
- **`run_cli`**: direct spawn, `PATH` resolution by std, own process group
  (`process_group(0)`), no login shell.
- **`capabilities()`** includes `session: {backend, compositor, layerShell, xwayland}`.
  X11 reports `excludesOwnWindows: false` (X has
  no native exclusion list; annotations are temporarily hidden by the Linux capture decorator) and `windowCapture: true`; Wayland reports `windowCapture: false`
  because global window tracking/placement is unavailable (the portal can still share a window). `ocrAccelerators: {meikiocr: "cpu", mangaocr: "cpu"}`.
- **Threading.** The X11 query connection is one process-wide `RustConnection` (it is
  `Sync`), opened on first use; if the X server cannot be reached every X11 query answers
  "nothing". Blocking event loops use their own connections.

## Not verified on Linux

Native ARM64 Hyprland/Wayland startup, portal capture, CPU OCR and layer overlay/crop
have now run on Linux; see `LINUX_BRINGUP.md` for exact evidence and qualifications.
x86_64 runtime and a real X11 session remain unverified. Remaining X11 checks include: XInput 2 raw events arriving while
a game has focus; `_NET_WM_WINDOW_TYPE_UTILITY` after map on GNOME/KDE/XFCE; panel
clicks not stealing focus; `GetImage` on windows of depth-32 visuals; GTK CSD windows'
bounds versus the overlay.

### Native Wayland overlays (Linux bring-up)

The bring-up user explicitly expanded the original reduced-tier scope to investigate native Wayland overlays. Native layers are enabled automatically when supported; `KIMOCHI_WAYLAND_OVERLAY=0` disables them for diagnostics. During GTK setup the Linux module dynamically loads optional `libgtk-layer-shell.so.0` and probes the actual Wayland protocol. Missing library/protocol disables the overlay and crop editor entirely; there is no detached reader fallback or link-time dependency. No crate/model versions change. `session.nativeLayerShell` reports whether this integration initialized, distinct from the historical compositor-name hint `session.layerShell`.

Layer panels use keyboard mode NONE, no exclusive layout reservation, an initially empty mouse input region, and published annotation rectangles applied through GDK on the GTK main thread. The overlay anchors to all output edges; dictionary panels anchor top/left. Screen-frame coordinates map to the layer surface's actual local dimensions; portal window frames are deliberately not drawn at an invented desktop position. Multi-output mapping, dictionary placement, native hover, long-lived scheduling and desktop fallback remain acceptance gates. See root `LINUX_BRINGUP.md` for observed passes/failures. GNOME/Ubuntu has not been tested and protocol support must not be assumed.

For an explicitly opened crop editor, `region_keys` switches the overlay alone to keyboard ON_DEMAND (never EXCLUSIVE), then restores NONE on completion/cancellation. Portal screen crops use frame-pixel dimensions versus configured logical surface size; portal window crops use a fitted screenshot because global window placement is unavailable. The editor temporarily publishes whole-surface input and releases it immediately on close. A hidden layer is mapped and configured before crop geometry is measured.

### Wayland global shortcuts

Action shortcuts use the standard GlobalShortcuts portal on a dedicated registered
D-Bus connection. The Registry application ID matches the packaged `Kimochi.desktop`.
Development/AppImage launches create a marked user desktop entry if none exists;
user-owned entries are preserved and a system entry takes precedence. Portal
registration/failure and Activated events are recorded in evidence. A denied or
missing portal reports its exact error without failing app startup. X11 retains
the existing global-shortcut plugin.

Hyprland's backend advertises actions but ignores preferred key combinations;
the user must bind those actions in compositor configuration. Capabilities/settings
explain this limitation. No compositor IPC is used by the app. Portal service
restart/rebinding, KDE/GNOME shortcut dialogs and physical fullscreen shortcuts
remain unverified.

### Dictionary audio runtime

WebKitGTK requires GStreamer base/good/bad plugins for audio, including `appsink`,
`autoaudiosink`, `volume`, `scaletempo` and `fakevideosink`. Missing elements can abort
the WebKit process instead of returning a JavaScript playback error. Debian bundles
now declare all three plugin packages. Arch development hosts need
`gst-plugins-base gst-plugins-good gst-plugins-bad` (libav is optional for further
codecs). The Linux AppImage helper deploys the required MP3/WAV playback plugins
and their ELF dependencies, plus the plugin scanner, and sets bundle-local plugin
paths. AppImage builds need GStreamer pkg-config metadata (Debian
`libgstreamer1.0-dev`; Arch provides it in the installed libraries). Native JS, Yomitan assets and macOS/Windows audio are unchanged.

### Annotation capture fallback

Linux reports `excludesOwnWindows: false` and `overlayExclusion: hideDuringCapture`. Actual OCR/observer captures hide overlay/dictionary annotation surfaces while acquiring pixels, waits up to 350 ms for tested compositor hide animations, and restores prior visibility on success/error. PipeWire monitor capture rejects pre-hide cached buffers. Main/settings windows are not excluded. This passed pixel checks on Hyprland ARM64; X11, other compositor animations and sustained observer timing remain unverified. Active crop editing blocks captures until the editor closes.

UI-only source previews and thumbnails use the unsuppressed Linux preview path, so sidebar refreshes do not flash annotations. Their images may contain overlays; they never feed OCR. Tauri/Tao content protection is unsupported on Linux. Hyprland0.56.1 `no_screen_share` blackens the full layer rectangle rather than exposing the desktop underneath; it is unsuitable for our full-screen transparent OCR layer. See the root report for the reverted compositor test.

## Wayland dictionary Shift-hover bring-up (2026-10-06)

Ordinary reader panels use an in-window Yomitan popup on Wayland: toplevel global
origins are unavailable, so the cross-window popup offset cannot be calculated.
X11 keeps the original remote popup path. Linux host glue replays a stationary
pointer on Shift press and rejects stale held-Shift pointer modifiers after release.
Editable controls remain ordinary text inputs. Vendor Yomitan stays unchanged.

Native layer-shell overlays keep keyboard mode NONE. On Hyprland, two explicit
GlobalShortcuts portal actions relay left/right Shift press and release, without
claiming a global raw keyboard watcher. Desktop bindings must be non-consuming.
For Hyprland 0.56.1 Lua configuration (add to the user's bindings file):

```lua
hl.bind("Shift_L", hl.dsp.global("Kimochi:dev.kimochi.app.dictionaryShiftLeft"), { non_consuming = true, transparent = true, ignore_mods = true })
hl.bind("Shift_R", hl.dsp.global("Kimochi:dev.kimochi.app.dictionaryShiftRight"), { non_consuming = true, transparent = true, ignore_mods = true })
```

Both edges are forwarded by the global dispatcher; releasing one Shift must not
clear the other. No exclusive keyboard grab, evdev access, root requirement, or
compositor IPC dependency is added to Kimochi. This configuration syntax is
version-specific; consult the compositor's current documentation. Other Wayland
backends do not receive modifier-only portal bindings automatically, because they
may reject them and break action shortcuts. Passive stationary Shift lookup on
those compositors remains unverified/unavailable until an equivalent explicitly
permitted modifier feed exists. Normal focused-reader Shift lookup works locally.

Sources: [portal Activated/Deactivated](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html),
[Hyprland bind flags](https://wiki.hypr.land/Configuring/Basics/Binds/).

Continuous Shift scanning: the Linux host adapter tracks physical Shift edges independently of portal state, retains passive portal holds across focus changes, and is installed in dictionary/preview frames as well as root readers. Native Wayland virtual-device tests exercise three words during a single hold in reader, OCR overlay and nested popup scanner; physical-device and other-compositor acceptance remain unverified.

Local Shift state is shared across all documents in a native window: focus entering a popup iframe does not release Shift, and a child receiving key-up releases the parent's state. Actual native-window blur clears local keys. Optional `scripts/linux-shift-native.sh` builds an isolated Shift/pointer probe from supplied protocol XMLs; use physical keyboard acceptance separately because portal-driven virtual input previously passed while the user still reported release-only failures.


Wayland Quick Shot uses a granted portal screen stream and the native layer crop editor, not global pointer/display discovery. Without a shared screen it opens the system picker; choose an entire screen. The granted screen is reused until replaced/closed. A one-off crop is converted from logical layer coordinates to captured frame pixels and is not committed as the saved source crop. Picker/crop cancellation and unsupported native layers report status rather than silently doing nothing. Window-following overlays remain deferred; sharing a window is insufficient for on-screen Quick Shot placement. Other compositor/multi-output acceptance remains unverified.


### Optional GNOME 46 Wayland overlay (Ubuntu prototype)

On GNOME 46 Wayland, **Set up GNOME overlay** in the source panel installs the
extension embedded in the Linux binary into the current user's extension directory.
It preserves other enabled extensions and refuses to overwrite a differing existing
Kimochi extension. Save work, log out and log back in once so GNOME discovers it,
then launch Kimochi and share an entire screen. No Node installation is needed by
end users. This integration is optional; native layer-shell and X11 paths remain.

The prototype supports one monitor's screen annotations, Shift-hover/click lookup
and plain dictionary definitions through the existing Yomitan backend. The Shell
owns the actors; the hidden WebKit OCR host never becomes a transparent ordinary
Wayland overlay. There is no modal or keyboard grab. Window-share annotations,
GNOME crop editing/Quick Shot, rich popup/audio controls and multi-monitor mapping
remain unavailable. GNOME versions other than 46 are rejected until tested. Actual
current-desktop acceptance requires the login reload; compositor-native isolated
GNOME tests and build evidence are recorded in `UBUNTU_BRINGUP.md`.
