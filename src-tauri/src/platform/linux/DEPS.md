# platform/linux: dependencies and integration contract

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
  `portal:window:{node}`. The app boots as a detached reader and the UI must offer
  "Choose in system picker" (plan Phase 7).
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
  X11 reports `excludesOwnWindows: false` (display captures include the overlay; X has
  no exclusion list) and `windowCapture: true`; Wayland reports `windowCapture: false`
  until the portal backend lands. `ocrAccelerators: {meikiocr: "cpu", mangaocr: "cpu"}`.
- **Threading.** The X11 query connection is one process-wide `RustConnection` (it is
  `Sync`), opened on first use; if the X server cannot be reached every X11 query answers
  "nothing". Blocking event loops use their own connections.

## Not verified on Linux

Everything compiles for `x86_64-unknown-linux-gnu` (see the Phase 6 report), and the pure
rules are unit-tested on macOS, but none of it has run against an X server or a Wayland
session yet. First things to check on real hardware: XInput 2 raw events arriving while
a game has focus; `_NET_WM_WINDOW_TYPE_UTILITY` after map on GNOME/KDE/XFCE; panel
clicks not stealing focus; `GetImage` on windows of depth-32 visuals; GTK CSD windows'
bounds versus the overlay.
