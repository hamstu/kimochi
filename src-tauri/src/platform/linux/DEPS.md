# platform/linux: dependencies and integration contract

## Ubuntu build prerequisites

The README's Ubuntu command includes PipeWire/SPA development headers and libclang
for capture bindings, `libudev-dev` for gilrs gamepad support, and GStreamer development
metadata plus base/good/bad runtime plugins for packaging/audio. Missing `libudev.pc`
was reproduced by the first Ubuntu app build.
Use Node >=22, npm >=10 and Rust stable >=1.87 with Clippy/rustfmt. Japanese fonts
(`fonts-noto-cjk`) and diagnostic tools (`mesa-utils`, `wayland-utils`, `x11-utils`)
help runtime acceptance. Install an IME only by user agreement.

Optional `libgtk-layer-shell0` enables native overlays only when the current
compositor advertises layer-shell. Ubuntu 24.04 GNOME Wayland's native library probe
returned unsupported even with that package installed; capture and reader panels
remain the supported tier there. An Xorg login is a separate acceptance target.

AppImage builders also need `libpipewire-0.3-modules` and `pipewire-bin`: the
PipeWire client loads SPA support plugins and client modules dynamically, so ELF
dependency discovery alone misses them. Packaging copies the matching support
plugins, client modules and `client.conf`, with paths inside the AppImage. It
leaves Wayland libraries on the host alongside Mesa/EGL; mixing Ubuntu's older
Wayland client with SteamOS Mesa prevented WebKit EGL initialization. No driver,
PipeWire daemon service or system configuration is bundled or installed.

Gamescope Gaming Mode needs the explicit launcher in `scripts/steam-deck/` because
Steam's exported environment reports X11 despite the native Wayland socket.
Gamescope-only window lifecycle and external-layer capture behavior still have
qualifications and remaining gaps.

## Cargo

```toml
[target.'cfg(target_os = "linux")'.dependencies]
# Pure-Rust X11 protocol (no libxcb, no pkg-config). Same major as capture-core's, so
# one copy is compiled and `kimochi_capture::x11::Desktop` speaks these types.
x11rb = { version = "0.13", features = ["randr", "shape"] }
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
  `picker_sources`/`make_panel`/`activate_*` are
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
  active or the client has no pid. App names (`frontmost_app`, picker `app`,
  activation) are the executable's file name from `/proc/<pid>/exe`, else
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
have now run on Linux.
x86_64 runtime and a real X11 session remain unverified. Remaining X11 checks include: `_NET_WM_WINDOW_TYPE_UTILITY` after map on GNOME/KDE/XFCE; panel
clicks not stealing focus; `GetImage` on windows of depth-32 visuals; GTK CSD windows'
bounds versus the overlay.

### Native Wayland overlays (Linux bring-up)

The bring-up user explicitly expanded the original reduced-tier scope to investigate native Wayland overlays. Native layers are enabled automatically when supported; `KIMOCHI_WAYLAND_OVERLAY=0` disables them for diagnostics. During GTK setup the Linux module dynamically loads optional `libgtk-layer-shell.so.0` and probes the actual Wayland protocol. Missing library/protocol disables the overlay and crop editor entirely; there is no detached reader fallback or link-time dependency. No crate/model versions change. `session.nativeLayerShell` reports whether this integration initialized, distinct from the historical compositor-name hint `session.layerShell`.

Layer panels use keyboard mode NONE, no exclusive layout reservation, an initially empty mouse input region, and published annotation rectangles applied through GDK on the GTK main thread. The overlay anchors to all output edges; dictionary panels anchor top/left. Screen-frame coordinates map to the layer surface's actual local dimensions; portal window frames are deliberately not drawn at an invented desktop position. Multi-output mapping, dictionary placement, native hover, long-lived scheduling and desktop fallback remain acceptance gates. GNOME does not advertise layer-shell in the tested Ubuntu session; see the optional GNOME adapter below.

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

On GNOME 46 Wayland, **Set up GNOME overlay** installs the extension embedded in
this Linux build. Initial installation (or migration from the old monolithic
extension) requires one login so GNOME discovers the stable loader. Subsequent
**Update GNOME overlay** operations (Settings → General → Desktop integration) stage an immutable implementation, disable/enable
only Kimochi, verify its running revision and restore the previous implementation
if startup fails. Other enabled extension names are preserved. Unrecognized edits
to Kimochi's loader/metadata are refused; the recognized legacy implementation is
backed up before migration. No unsafe Shell evaluation or compositor restart.

On GNOME46, the annotation surface uses the same `TextOverlayRenderer`, CSS,
OCR line/segment layout, proximity indicators, hover text and DOM text scanning as
X11, native layer-shell, macOS and Windows. Shell only supplies validated placement,
source visibility, stacking and pointer/modifier delivery. The GTK surface permanently
refuses keyboard focus and takes pointer input only over the renderer's actual hit
rectangles. Estimated Shell character cells remain metadata for the legacy controller
adapter; they no longer drive mouse lookup, typography or visual highlights.
Mapped surface coordinates, rather than requested desktop coordinates, drive text,
pointer conversion and input shapes, including GNOME panel/dock placement constraints.
Linked-window annotations remain visible beside a focused Kimochi window; an overlapping
ordinary Kimochi window or another focused application hides them.
The dictionary uses the existing full Yomitan Popup/Display in a small native
window, including dictionary images, audio controls and nested lookup. GNOME supplies
geometry for Kimochi's own log/popup windows so log lookups can extend outside the
log. Hover lookup keeps the original reader's keyboard focus; the GNOME bridge
restores pre-map focus if Mutter activates the own popup automatically, and a deliberate
popup click can focus it. Non-consuming GNOME modifier/button state enables continuous
Shift lookup and outside-click dismissal without a keyboard grab. Dictionary matched
length highlights all matching OCR character cells. Desktop and reader share one root
popup chain and the app's resolved theme, bundled fonts and smoothing; explicit Yomitan
font/theme settings remain authoritative. Original resize gestures suppress accidental
text selection. These have automated/virtual-input evidence; attended UX acceptance is
still required after the reported failures (see Ubuntu ledger entries92 onward).
The WebView is mapped only under a PID/DBus-owner-validated Shell surface lease,
with an empty native input shape before its first map. Owner loss, a missing heartbeat,
source departure, crop, overview, lock and extension disable hide the surface. Screen
capture suppression includes it; preview captures do not hide it. No detached-reader
fallback, modal or keyboard grab is introduced. GNOME 46 now supports native desktop crop and
Quick Shot on the single supported monitor. GNOME hosts the original shared
`RegionSelect` editor in a transparent WebKit window only during explicit selection;
Shell supplies validated fullscreen placement and lease cleanup. Explicit selection temporarily owns
mouse input, supports drawing/moving/resizing, Save/Scan/Reset/Cancel and Escape,
and expires on client loss or missing heartbeat. Quick Shot crops are one-off.
The existing source-image editor remains the fallback for unsupported mapping.

GNOME window shares first match actual captured pixel dimensions against live
Mutter buffer bounds and scale, excluding Kimochi's own windows. A meaningful exact
title breaks size ties when supplied; generic portal labels cannot identify a
window. A unique match binds automatically without raising the window. Ambiguity
leaves annotations hidden and offers **Link window overlay…** for one explicit
click on the shared window. Pairing follows that live window's stable identity,
not its title: moving translates annotations, resizing hides them until a fresh
matching frame, and minimizing/focus departure/closure hides or clears them.
GTK client-side decorations are included through buffer bounds, not frame bounds.
Linked window crop uses that same validated geometry. Fresh portal selection clears
old pairing. Other compositor window-following remains deferred; no invented
portable desktop coordinates or general foreground tracker. Multi-monitor crop
mapping and other GNOME versions remain unsupported until verified.
Full UI/placement and loader recovery have isolated GNOME46 evidence; physical
focus/input/audio acceptance on the user's current desktop is tracked separately.
Other GNOME versions are rejected until tested.

On Linux Wayland without native layer-shell or supported GNOME desktop mapping, **Crop area → Set crop area…** opens
the full shared source image in the existing main window. Drag a rectangle, then
**Save crop**; it uses full-frame capture pixels and the normal persisted crop/OCR
path. This works for entire-screen and window shares, independently of the GNOME
annotation extension. Cancel/Escape leaves the saved crop unchanged. Automatic OCR
pauses during editing and resumes afterward. This is an image editor, not a native
desktop layer; native layer-shell and X11 retain their existing on-screen editor.

Safety update: when GNOME annotations are visible, the panel exposes **Hide Kimochi**. This clears them until a new OCR scan; heartbeat updates cannot undo dismissal. Fullscreen annotations expose a small bottom-right **Hide Kimochi** control when the panel is hidden; clearing removes annotations and any transient selection input. Ordinary application Escape is not intercepted.

GNOME caches the stable loader's entry module for the login. A change to the loader
itself still needs a new login; ordinary implementation updates use unique module
paths and reload in place. The UI reports whether the expected revision is actually
running rather than treating an enable command's success as proof.

On WebKitGTK builds without AVIF decoding (Ubuntu's, and the one the AppImage
bundles), dictionary imports fall back to libavif 1.x, which the app links
directly (`libavif-dev` to build; `libavif16` in the Debian package; Arch's
`libavif`). Images are converted to PNG only after the browser decoder fails;
vendor sources and original archives remain untouched. linuxdeploy bundles
libavif and its AV1 decoder (dav1d/aom) into the AppImage like any linked
library, with no GdkPixbuf loader or plugin path, so it behaves the same on
Ubuntu, Arch (whose GdkPixbuf decodes through glycin) and SteamOS. A build host
without libavif 1.x fails fast (`node scripts/linux-appimage.mjs --check-avif`),
and every AppImage build ends by decoding a sample AVIF with its own binary
(`kimochi --check-avif <file>`), which also works on an installed AppImage.


### GNOME source metadata, action shortcuts, and controller host

The optional GNOME46 adapter now supplies the paired native window's title, app
identity and GIcon. Source descriptors and newly recorded OCR session metadata
use that identity; no title-to-app guess or archived-history rewrite is needed.
The existing GTK icon theme loads PNG data for the normal source UI. A window
without installed app metadata uses the system generic application icon.

Where the adapter advertises nativeShortcuts, configured action combinations use
Mutter accelerator registration in NORMAL mode with IGNORE_AUTOREPEAT. Conflicts
are reported without replacing another binding. Client loss, disable/rebind and
extension updates release/reapply registrations. Other Wayland sessions retain
the GlobalShortcuts portal backend. Only the registered shortcuts are delivered.

The explicitly opened controller menu uses the unchanged shared ControllerInput,
RadialMenu, WordCursor and controller UI in a Linux-only controller-host WebKit
window. The menu is bounded to 520×520, read-along HUD to 520×100. Shell owns a
PID/DBus-owner lease, placement and normal focus; focused DOM key events replace
global unmodified arrow/Return/Escape grabs on this path. Owner loss, source
closure, focus departure, lock/disable and heartbeat timeout close it. Exit
restores previous focus only while Kimochi's own menu still has focus. The existing
OCR/Yomitan coordinator performs scans/parsing; native word indices use the real
Yomitan Popup/Display host, including scroll/entry controls. No fullscreen passive
input surface or exclusive keyboard grab is introduced.

Ubuntu evidence distinguishes native virtual input and synthetic controller events
from physical keyboard/gamepad acceptance. The available js0 is a Parallels virtual
mouse, not a controller. GNOME remains version-gated to 46 and screen mapping
single-monitor. Other compositor window tracking is still deferred; X11 and native
layer-shell paths are preserved.
