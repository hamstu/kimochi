//! Linux capture: an X11 backend over the pure-Rust `x11rb` protocol crate (plan
//! Phase 6). Wayland's portal backend is `linux_portal.rs` (Phase 7); the session rule
//! that picks between them lives here.
//!
//! **Why not `xcap`.** `xcap` links libxcb, libwayland, PipeWire and D-Bus system
//! libraries for *every* Linux build, including the Wayland recorder this tier does not
//! use, and none of that type-checks without the target's `-dev` packages. `x11rb`'s
//! `RustConnection` speaks the X protocol over the socket itself: no C library, no
//! `pkg-config`, and the whole backend cross-checks from macOS. One `GetImage` per
//! capture is what `xcap`'s X11 path does too.
//!
//! **Coordinates.** `Source.bounds` and `FrameInfo.source_bounds` are in *desktop
//! units*: X11 root-window pixels divided by GDK's window scale (`desktop_scale`), the
//! same units Tauri's logical positions, `platform::linux` and the overlay use. With
//! GDK scaling off — nearly every X11 desktop — a desktop unit *is* a root pixel. Frames
//! are root pixels, so `FrameInfo.scale_factor` is frame pixels per desktop unit (the GDK
//! scale), exactly as macOS reports pixels per point. Root pixels are global: X11 has no
//! per-monitor scaling, so this is one plane on every monitor.
//!
//! **Windows.** A window source is the *client* window (what `_NET_CLIENT_LIST` names),
//! not the window manager's frame: its content, without title bar, and without the
//! invisible shadow margin a client-side-decorated (GTK/libadwaita) window declares in
//! `_GTK_FRAME_EXTENTS`. Ids are `x11:window:{xid}:{pid}` with the xid in decimal
//! (`x11:window:{xid}` when the client never set `_NET_WM_PID`); displays are
//! `x11:display:{id}`, the RandR monitor's first output XID. `platform::linux` builds
//! its ids, catalog and display list with the `desktop` module below, so the picker,
//! the capture backend and focus tracking cannot disagree.
//!
//! **Pixels.** Without a compositor, `GetImage` on a window returns undefined contents
//! wherever another window overlaps it (usually the overlapping window's pixels); with
//! one (every mainstream desktop) the window's own redirected contents come back even
//! when it is covered. The part of a window outside the screen cannot be read at all
//! (X refuses the request), so it is left black and the frame keeps the window's size.
//! Display captures include Kimochi's own windows: X has no exclusion list.
//!
//! The pure decisions (session detection, which windows are listed, XSETTINGS parsing,
//! pixel conversion) compile on every host and are unit-tested on macOS, like
//! `windows.rs`.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[cfg(target_os = "linux")]
pub use backend::X11Capture;

/// Smallest window worth listing, in root pixels. Same thresholds as macOS and Windows.
pub(crate) const MIN_WINDOW: (i32, i32) = (80, 60);

// ----- Session ----------------------------------------------------------------------

/// Whether this desktop session is Wayland, from `XDG_SESSION_TYPE` and
/// `WAYLAND_DISPLAY` as given. The one rule both crates use (`platform::linux::rules`
/// calls it), so capture and the window layer always pick the same tier.
///
/// An explicit `GDK_BACKEND=x11` selects the XWayland tier. Otherwise the session
/// type logind records wins; a session that does not say (`tty`, or a
/// window manager started by hand with `startx`) is Wayland when a Wayland socket is
/// advertised, X11 otherwise. A Wayland session that also offers XWayland (`DISPLAY`
/// set) is still Wayland: XWayland sees only XWayland clients, so the X11 catalog and
/// geometry would silently miss every native Wayland window.
pub fn is_wayland_session(
    session_type: Option<&str>,
    wayland_display: Option<&str>,
    gdk_backend: Option<&str>,
) -> bool {
    // Explicit X11 GTK selects XWayland inside a Wayland login. Its catalog
    // remains limited to XWayland clients.
    if gdk_backend.is_some_and(|backend| backend.trim() == "x11") {
        return false;
    }
    match session_type
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("wayland") => true,
        Some("x11") => false,
        _ => wayland_display.is_some_and(|s| !s.trim().is_empty()),
    }
}

/// `is_wayland_session` over this process's environment.
pub fn wayland_session_now() -> bool {
    let var = |k: &str| std::env::var(k).ok();
    is_wayland_session(
        var("XDG_SESSION_TYPE").as_deref(),
        var("WAYLAND_DISPLAY").as_deref(),
        var("GDK_BACKEND").as_deref(),
    )
}

// ----- Window eligibility -------------------------------------------------------------

/// The first `_NET_WM_WINDOW_TYPE` a window declares, reduced to what the catalog
/// cares about. A window that declares none is `Normal` (EWMH says so for managed
/// windows, and transient-for dialogs without a type are dialogs, which are listed
/// just the same).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKind {
    Normal,
    Dialog,
    /// Docks, desktops, toolbars, menus, splash screens, notifications, utilities
    /// (Kimochi's own panels are utilities).
    Other,
}

/// What the catalog knows about one client window, as plain values.
#[derive(Clone, Debug)]
pub struct WindowFacts<'a> {
    /// `GetWindowAttributes.map_state == Viewable`: mapped, and every ancestor mapped.
    /// Minimised windows and windows on other workspaces are unmapped on X11.
    pub viewable: bool,
    /// `_NET_WM_STATE_HIDDEN`: minimised by the window manager, even if still mapped.
    pub hidden: bool,
    pub title: &'a str,
    pub kind: WindowKind,
    pub pid: Option<u32>,
    /// Visible client size, root pixels.
    pub width: i32,
    pub height: i32,
}

/// Whether a window has a size a reader could be reading.
pub fn sized(width: i32, height: i32) -> bool {
    width >= MIN_WINDOW.0 && height >= MIN_WINDOW.1
}

/// On screen as far as a person is concerned: mapped, not minimised, readable size.
pub fn on_screen(f: &WindowFacts) -> bool {
    f.viewable && !f.hidden && sized(f.width, f.height)
}

/// Whether a client window belongs in the source list: on screen, titled, an ordinary
/// window or dialog (not a dock, menu, notification or utility panel), and not ours.
/// The shared semantic rule of plan §3.1, applied to X11's metadata.
///
/// Minimised windows are *not* listed, unlike on Windows: X unmaps them, and an unmapped
/// window has no pixels to capture or bounds to follow until it is restored.
pub fn is_listable(f: &WindowFacts, own_pid: u32) -> bool {
    on_screen(f)
        && !f.title.trim().is_empty()
        && matches!(f.kind, WindowKind::Normal | WindowKind::Dialog)
        && f.pid != Some(own_pid)
}

// ----- Geometry -----------------------------------------------------------------------

/// A rectangle in root-window pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PxRect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.width <= 0 || self.height <= 0
    }

    /// The overlap of two rectangles; empty (zero size) when they do not meet.
    pub fn intersect(&self, other: &PxRect) -> PxRect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let bottom = (self.y + self.height).min(other.y + other.height);
        PxRect::new(x, y, (right - x).max(0), (bottom - y).max(0))
    }

    /// Shrink by `_GTK_FRAME_EXTENTS`-style margins `[left, right, top, bottom]`.
    /// Margins that would leave nothing (a bogus property) are ignored.
    pub fn inset(&self, extents: [i32; 4]) -> PxRect {
        let [left, right, top, bottom] = extents.map(|v| v.max(0));
        let inner = PxRect::new(
            self.x + left,
            self.y + top,
            self.width - left - right,
            self.height - top - bottom,
        );
        if inner.is_empty() {
            *self
        } else {
            inner
        }
    }

    /// In desktop units (root pixels / GDK scale).
    pub fn to_desktop(self, scale: f64) -> crate::Rect {
        let s = if scale.is_finite() && scale > 0. {
            scale
        } else {
            1.
        };
        crate::Rect {
            x: f64::from(self.x) / s,
            y: f64::from(self.y) / s,
            width: f64::from(self.width) / s,
            height: f64::from(self.height) / s,
        }
    }
}

// ----- Scale --------------------------------------------------------------------------

/// GDK 3's window scale on X11: `GDK_SCALE` if it is a positive integer, else the
/// `Gdk/WindowScalingFactor` XSETTING (what GNOME's settings daemon publishes for
/// "200 %"), else 1. This is the factor tao reports as the window scale factor, so it is
/// what converts root pixels to Tauri's logical units. `Xft.dpi` and `GDK_DPI_SCALE`
/// only scale text and are deliberately not consulted.
pub fn desktop_scale_from(gdk_scale: Option<&str>, xsettings: Option<i32>) -> f64 {
    if let Some(v) = gdk_scale.and_then(|s| s.trim().parse::<i32>().ok()) {
        if v > 0 {
            return f64::from(v);
        }
    }
    match xsettings {
        Some(v) if v > 0 => f64::from(v),
        _ => 1.,
    }
}

/// Read one integer setting from an `_XSETTINGS_SETTINGS` property (the XSETTINGS
/// wire format: byte order, serial, count, then typed, 4-byte-padded records).
/// `None` for a missing setting, a non-integer one, or a malformed buffer.
pub fn parse_xsettings_int(data: &[u8], name: &str) -> Option<i32> {
    let big_endian = match *data.first()? {
        0 => false,
        1 => true,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = data.get(at..at + 2)?.try_into().ok()?;
        Some(if big_endian {
            u16::from_be_bytes(b)
        } else {
            u16::from_le_bytes(b)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
        Some(if big_endian {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        })
    };
    let pad4 = |n: usize| n.div_ceil(4) * 4;
    let count = u32_at(8)?;
    let mut at = 12usize;
    for _ in 0..count.min(4096) {
        let kind = *data.get(at)?;
        let name_len = usize::from(u16_at(at + 2)?);
        let key = data.get(at + 4..at + 4 + name_len)?;
        at += 4 + pad4(name_len) + 4; // header, name, last-change serial
        match kind {
            0 => {
                let value = u32_at(at)? as i32;
                if key == name.as_bytes() {
                    return Some(value);
                }
                at += 4;
            }
            1 => {
                let len = u32_at(at)? as usize;
                at += 4 + pad4(len);
            }
            2 => at += 8,
            _ => return None,
        }
    }
    None
}

// ----- Pixels -------------------------------------------------------------------------

/// How a `GetImage` Z-pixmap reply lays out its pixels.
#[derive(Clone, Copy, Debug)]
pub struct PixelLayout {
    pub bits_per_pixel: u8,
    /// Each row is padded to a multiple of this many bits.
    pub scanline_pad: u8,
    /// `ImageByteOrder` of the server: least significant byte first.
    pub lsb_first: bool,
    pub red_mask: u32,
    pub green_mask: u32,
    pub blue_mask: u32,
}

/// Convert a Z-pixmap image (TrueColor, 24 or 32 bits per pixel) to tightly packed,
/// fully opaque RGBA8. `None` for a layout this does not handle (8- or 16-bit visuals,
/// which no current desktop runs) or a buffer shorter than the layout promises.
///
/// Alpha is forced opaque: a depth-32 window's alpha channel describes how it blends
/// with the desktop, not what the reader saw, and OCR wants what they saw.
pub fn zpixmap_to_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    layout: PixelLayout,
) -> Option<Vec<u8>> {
    let bytes_pp = match layout.bits_per_pixel {
        32 => 4usize,
        24 => 3usize,
        _ => return None,
    };
    let pad = usize::from(layout.scanline_pad.max(8));
    let stride = (width as usize * usize::from(layout.bits_per_pixel)).div_ceil(pad) * pad / 8;
    if data.len() < stride * height as usize {
        return None;
    }
    let shift = |mask: u32| if mask == 0 { 0 } else { mask.trailing_zeros() };
    let (rs, gs, bs) = (
        shift(layout.red_mask),
        shift(layout.green_mask),
        shift(layout.blue_mask),
    );
    let channel = |pixel: u32, mask: u32, s: u32| -> u8 {
        let bits = mask.count_ones();
        let v = (pixel & mask) >> s;
        match bits {
            0 => 0,
            8 => v as u8,
            n if n < 8 => ((v * 255) / ((1 << n) - 1)) as u8,
            n => (v >> (n - 8)) as u8,
        }
    };
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height as usize {
        let line = &data[row * stride..row * stride + width as usize * bytes_pp];
        for p in line.chunks_exact(bytes_pp) {
            let pixel = match (bytes_pp, layout.lsb_first) {
                (4, true) => u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
                (4, false) => u32::from_be_bytes([p[0], p[1], p[2], p[3]]),
                (_, true) => u32::from_le_bytes([p[0], p[1], p[2], 0]),
                (_, false) => u32::from_be_bytes([0, p[0], p[1], p[2]]),
            };
            out.extend_from_slice(&[
                channel(pixel, layout.red_mask, rs),
                channel(pixel, layout.green_mask, gs),
                channel(pixel, layout.blue_mask, bs),
                255,
            ]);
        }
    }
    Some(out)
}

/// Paste a tightly packed RGBA `tile` into `canvas` (also RGBA, `canvas_width` wide)
/// with its top-left at `(x, y)`. The caller guarantees the tile fits.
pub fn paste_rgba(
    canvas: &mut [u8],
    canvas_width: u32,
    tile: &[u8],
    tile_width: u32,
    x: u32,
    y: u32,
) {
    let row_bytes = tile_width as usize * 4;
    if row_bytes == 0 {
        return;
    }
    for (row, line) in tile.chunks_exact(row_bytes).enumerate() {
        let at = ((y as usize + row) * canvas_width as usize + x as usize) * 4;
        canvas[at..at + row_bytes].copy_from_slice(line);
    }
}

// ----- Processes ------------------------------------------------------------------------

/// The name an application is known by: the file name of its executable
/// (`/proc/<pid>/exe`), else its `comm` (which the kernel truncates to 15 bytes).
/// `kimochi`, `firefox`, `wine64-preloader`. The picker, `frontmost_app` and focus
/// events all use this, so `ownAppNames` and saved sources match on one spelling.
pub fn process_name_from(exe: Option<&str>, comm: Option<&str>) -> Option<String> {
    let from_exe = exe
        .map(|p| p.trim_end_matches(" (deleted)"))
        .and_then(|p| p.rsplit('/').next())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    from_exe
        .or_else(|| comm.map(str::trim).filter(|s| !s.is_empty()))
        .map(str::to_string)
}

/// `process_name_from` for a live process.
pub fn process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let exe = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok();
    process_name_from(exe.as_deref(), comm.as_deref())
}

// ----- Shared X11 desktop queries -------------------------------------------------------

/// The X11 metadata both crates read: atoms, monitors, the client list, window facts
/// and the source catalog. `platform::linux` uses this module rather than its own copy,
/// so the picker and the capture backend cannot drift apart.
#[cfg(target_os = "linux")]
pub mod desktop {
    pub use super::{is_listable, on_screen, process_name, PxRect, WindowFacts, WindowKind};
    use crate::{Platform, Source, SourceId};
    use std::collections::HashMap;
    use x11rb::connection::Connection;
    use x11rb::protocol::randr::ConnectionExt as _;
    use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt as _, MapState, Window};
    use x11rb::rust_connection::RustConnection;

    x11rb::atom_manager! {
        /// Every atom Kimochi reads or writes on X11, interned once per connection.
        pub Atoms: AtomsCookie {
            UTF8_STRING,
            WM_NAME,
            WM_CLASS,
            WM_STATE,
            WM_TRANSIENT_FOR,
            _NET_SUPPORTED,
            _NET_ACTIVE_WINDOW,
            _NET_CLIENT_LIST,
            _NET_CLIENT_LIST_STACKING,
            _NET_CURRENT_DESKTOP,
            _NET_WORKAREA,
            _NET_WM_NAME,
            _NET_WM_PID,
            _NET_WM_ICON,
            _NET_WM_USER_TIME,
            _NET_WM_WINDOW_TYPE,
            _NET_WM_WINDOW_TYPE_NORMAL,
            _NET_WM_WINDOW_TYPE_DIALOG,
            _NET_WM_WINDOW_TYPE_UTILITY,
            _NET_WM_STATE,
            _NET_WM_STATE_HIDDEN,
            _NET_WM_STATE_ABOVE,
            _NET_WM_STATE_SKIP_TASKBAR,
            _NET_WM_STATE_SKIP_PAGER,
            _NET_RESTACK_WINDOW,
            _NET_FRAME_EXTENTS,
            _GTK_FRAME_EXTENTS,
            _XSETTINGS_SETTINGS,
        }
    }

    /// One monitor, root pixels.
    #[derive(Clone, Debug)]
    pub struct Monitor {
        /// The monitor's first RandR output XID (stable while it stays connected), or
        /// its name atom for a RandR 1.5 virtual monitor without outputs, or 0 for the
        /// whole root window when RandR is missing.
        pub id: u32,
        /// The connector name (`DP-1`, `HDMI-A-0`), when RandR provides one.
        pub name: Option<String>,
        pub rect: PxRect,
        pub primary: bool,
    }

    /// Everything known about one client window.
    #[derive(Clone, Debug)]
    pub struct WindowInfo {
        pub window: Window,
        pub title: String,
        pub pid: Option<u32>,
        /// The visible client area in root pixels (GTK shadow margins removed).
        pub rect: PxRect,
        /// Where `rect` starts inside the client window, in window pixels.
        pub offset: (i32, i32),
        pub viewable: bool,
        pub hidden: bool,
        pub kind: WindowKind,
    }

    impl WindowInfo {
        pub fn facts(&self) -> WindowFacts<'_> {
            WindowFacts {
                viewable: self.viewable,
                hidden: self.hidden,
                title: &self.title,
                kind: self.kind,
                pid: self.pid,
                width: self.rect.width,
                height: self.rect.height,
            }
        }
        pub fn on_screen(&self) -> bool {
            on_screen(&self.facts())
        }
    }

    /// A window source id: `x11:window:{xid}:{pid}`, or `x11:window:{xid}` for a
    /// client that never set `_NET_WM_PID`.
    pub fn window_source_id(window: Window, pid: Option<u32>) -> SourceId {
        match pid {
            Some(pid) => SourceId::window(Platform::X11, window, pid),
            None => SourceId::Window {
                platform: Platform::X11,
                handle: window.to_string(),
                pid: None,
            },
        }
    }

    /// `x11:display:{id}`.
    pub fn display_source_id(id: u32) -> SourceId {
        SourceId::display(Platform::X11, id)
    }

    /// One connection to the X server, with its root window and atoms.
    pub struct Desktop {
        pub conn: RustConnection,
        pub screen: usize,
        pub root: Window,
        pub atoms: Atoms,
    }

    impl Desktop {
        /// Connect to `$DISPLAY` (x11rb reads `$XAUTHORITY` itself).
        pub fn connect() -> Result<Self, String> {
            let (conn, screen) = x11rb::connect(None)
                .map_err(|e| format!("could not connect to the X server: {e}"))?;
            let root = conn
                .setup()
                .roots
                .get(screen)
                .ok_or("the X server reported no screen")?
                .root;
            let atoms = Atoms::new(&conn)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            Ok(Self {
                conn,
                screen,
                root,
                atoms,
            })
        }

        /// The root window's size, root pixels.
        pub fn root_rect(&self) -> PxRect {
            let s = &self.conn.setup().roots[self.screen];
            PxRect::new(
                0,
                0,
                i32::from(s.width_in_pixels),
                i32::from(s.height_in_pixels),
            )
        }

        /// A property's raw reply, or `None` if it is unset or the window is gone.
        pub fn property(
            &self,
            window: Window,
            property: Atom,
            kind: impl Into<Atom>,
            max_items: u32,
        ) -> Option<x11rb::protocol::xproto::GetPropertyReply> {
            let reply = self
                .conn
                .get_property(false, window, property, kind, 0, max_items)
                .ok()?
                .reply()
                .ok()?;
            (reply.type_ != u32::from(AtomEnum::NONE)).then_some(reply)
        }

        /// A 32-bit property (CARDINAL, WINDOW, ATOM) as values.
        pub fn property32(
            &self,
            window: Window,
            property: Atom,
            kind: impl Into<Atom>,
        ) -> Option<Vec<u32>> {
            let reply = self.property(window, property, kind, 1 << 16)?;
            let values: Vec<u32> = reply.value32()?.collect();
            Some(values)
        }

        /// Text from `_NET_WM_NAME` (UTF-8), else `WM_NAME` (Latin-1 or compound text,
        /// read leniently).
        pub fn title(&self, window: Window) -> String {
            if let Some(r) = self.property(
                window,
                self.atoms._NET_WM_NAME,
                self.atoms.UTF8_STRING,
                1024,
            ) {
                let s = String::from_utf8_lossy(&r.value).into_owned();
                if !s.trim().is_empty() {
                    return s;
                }
            }
            self.property(window, self.atoms.WM_NAME, AtomEnum::ANY, 1024)
                .map(|r| {
                    String::from_utf8(r.value.clone())
                        .unwrap_or_else(|_| r.value.iter().map(|&b| char::from(b)).collect())
                })
                .unwrap_or_default()
        }

        /// `_NET_WM_PID`, when the client set it (most toolkits do; Wine does).
        pub fn pid(&self, window: Window) -> Option<u32> {
            self.property32(window, self.atoms._NET_WM_PID, AtomEnum::CARDINAL)?
                .first()
                .copied()
                .filter(|&p| p != 0)
        }

        fn kind(&self, window: Window) -> WindowKind {
            let Some(types) =
                self.property32(window, self.atoms._NET_WM_WINDOW_TYPE, AtomEnum::ATOM)
            else {
                return WindowKind::Normal;
            };
            match types.first() {
                None => WindowKind::Normal,
                Some(&t) if t == self.atoms._NET_WM_WINDOW_TYPE_NORMAL => WindowKind::Normal,
                Some(&t) if t == self.atoms._NET_WM_WINDOW_TYPE_DIALOG => WindowKind::Dialog,
                Some(_) => WindowKind::Other,
            }
        }

        /// The atoms in `_NET_WM_STATE`.
        pub fn wm_state(&self, window: Window) -> Vec<Atom> {
            self.property32(window, self.atoms._NET_WM_STATE, AtomEnum::ATOM)
                .unwrap_or_default()
        }

        /// The visible client rectangle in root pixels and its offset inside the window.
        pub fn client_rect(&self, window: Window) -> Option<(PxRect, (i32, i32))> {
            let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
            let origin = self
                .conn
                .translate_coordinates(window, self.root, 0, 0)
                .ok()?
                .reply()
                .ok()?;
            let full = PxRect::new(
                i32::from(origin.dst_x),
                i32::from(origin.dst_y),
                i32::from(geometry.width),
                i32::from(geometry.height),
            );
            let extents = self
                .property32(window, self.atoms._GTK_FRAME_EXTENTS, AtomEnum::CARDINAL)
                .filter(|v| v.len() >= 4)
                .map(|v| [v[0] as i32, v[1] as i32, v[2] as i32, v[3] as i32]);
            let visible = extents.map_or(full, |e| full.inset(e));
            Some((visible, (visible.x - full.x, visible.y - full.y)))
        }

        /// Everything the catalog needs about one window; `None` if it is gone.
        pub fn window_info(&self, window: Window) -> Option<WindowInfo> {
            let attributes = self.conn.get_window_attributes(window).ok()?.reply().ok()?;
            let (rect, offset) = self.client_rect(window)?;
            let hidden = self
                .wm_state(window)
                .contains(&self.atoms._NET_WM_STATE_HIDDEN);
            Some(WindowInfo {
                window,
                title: self.title(window),
                pid: self.pid(window),
                rect,
                offset,
                viewable: attributes.map_state == MapState::VIEWABLE,
                hidden,
                kind: self.kind(window),
            })
        }

        /// Managed client windows, front to back. `_NET_CLIENT_LIST_STACKING` is
        /// bottom to top; window managers without it get `_NET_CLIENT_LIST` (mapping
        /// order) as is.
        pub fn clients(&self) -> Vec<Window> {
            if let Some(mut list) = self.property32(
                self.root,
                self.atoms._NET_CLIENT_LIST_STACKING,
                AtomEnum::WINDOW,
            ) {
                list.reverse();
                return list;
            }
            self.property32(self.root, self.atoms._NET_CLIENT_LIST, AtomEnum::WINDOW)
                .unwrap_or_default()
        }

        /// `_NET_ACTIVE_WINDOW`, `None` when nothing has focus (or no EWMH WM runs).
        pub fn active_window(&self) -> Option<Window> {
            self.property32(self.root, self.atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW)?
                .first()
                .copied()
                .filter(|&w| w != 0)
        }

        fn atom_name(&self, atom: Atom) -> Option<String> {
            let reply = self.conn.get_atom_name(atom).ok()?.reply().ok()?;
            Some(String::from_utf8_lossy(&reply.name).into_owned())
        }

        /// Monitors, primary first. RandR 1.5 `GetMonitors` (what GTK and every
        /// current desktop use); the whole root as one monitor without it.
        pub fn monitors(&self) -> Vec<Monitor> {
            let listed = self
                .conn
                .randr_get_monitors(self.root, true)
                .ok()
                .and_then(|c| c.reply().ok());
            let mut list: Vec<Monitor> = listed
                .map(|r| {
                    r.monitors
                        .into_iter()
                        .map(|m| Monitor {
                            id: m.outputs.first().copied().unwrap_or(m.name),
                            name: self.atom_name(m.name),
                            rect: PxRect::new(
                                i32::from(m.x),
                                i32::from(m.y),
                                i32::from(m.width),
                                i32::from(m.height),
                            ),
                            primary: m.primary,
                        })
                        .filter(|m| !m.rect.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if list.is_empty() {
                list.push(Monitor {
                    id: 0,
                    name: None,
                    rect: self.root_rect(),
                    primary: true,
                });
            }
            list.sort_by_key(|m| !m.primary);
            list
        }

        /// GDK's window scale for this display (see `desktop_scale_from`).
        pub fn scale(&self) -> f64 {
            let xsettings = self.xsettings_int("Gdk/WindowScalingFactor");
            super::desktop_scale_from(std::env::var("GDK_SCALE").ok().as_deref(), xsettings)
        }

        /// One integer XSETTING from the settings manager that owns `_XSETTINGS_S{n}`.
        pub fn xsettings_int(&self, name: &str) -> Option<i32> {
            let selection = format!("_XSETTINGS_S{}", self.screen);
            let atom = self
                .conn
                .intern_atom(true, selection.as_bytes())
                .ok()?
                .reply()
                .ok()?
                .atom;
            if atom == 0 {
                return None;
            }
            let owner = self
                .conn
                .get_selection_owner(atom)
                .ok()?
                .reply()
                .ok()?
                .owner;
            if owner == 0 {
                return None;
            }
            let reply = self.property(
                owner,
                self.atoms._XSETTINGS_SETTINGS,
                self.atoms._XSETTINGS_SETTINGS,
                1 << 16,
            )?;
            super::parse_xsettings_int(&reply.value, name)
        }

        /// Displays, then every listable window front to back. Bounds in desktop
        /// units. `own_pid` is excluded.
        pub fn sources(&self, own_pid: u32) -> Vec<Source> {
            let scale = self.scale();
            let mut sources: Vec<Source> = self
                .monitors()
                .into_iter()
                .enumerate()
                .map(|(index, m)| Source {
                    id: display_source_id(m.id).to_string(),
                    kind: "display",
                    name: match &m.name {
                        Some(n) if !n.trim().is_empty() => format!("Display {} ({n})", index + 1),
                        _ => format!("Display {}", index + 1),
                    },
                    app: None,
                    bounds: Some(m.rect.to_desktop(scale)),
                    on_screen: Some(true),
                })
                .collect();
            let mut names: HashMap<u32, Option<String>> = HashMap::new();
            for window in self.clients() {
                let Some(info) = self.window_info(window) else {
                    continue;
                };
                if !is_listable(&info.facts(), own_pid) {
                    continue;
                }
                let app = info.pid.and_then(|pid| {
                    names
                        .entry(pid)
                        .or_insert_with(|| process_name(pid))
                        .clone()
                });
                sources.push(Source {
                    id: window_source_id(window, info.pid).to_string(),
                    kind: "window",
                    name: info.title.clone(),
                    app,
                    bounds: Some(info.rect.to_desktop(scale)),
                    on_screen: Some(true),
                });
            }
            sources
        }
    }
}

// ----- Backends -------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod backend {
    use super::desktop::{Desktop, Monitor};
    use super::{paste_rgba, zpixmap_to_rgba, PixelLayout, PxRect};
    use crate::pixels::{box_downscale, crop_pixels, fit_within};
    use crate::{
        crop_rect, elapsed_ms, Capabilities, CaptureBackend, CaptureError, CaptureRequest, Frame,
        FrameInfo, Platform, Rect, Result, Source, SourceId,
    };
    use std::time::Instant;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder, Window};

    /// Bound allocation and PNG preview size, as macOS and Windows do.
    const MAX_PIXELS: u64 = 64_000_000;
    const PIXEL_FORMAT: &str = "RGBA8 straight alpha, top-left rows";
    const COLOR_SPACE: &str = "Display native (SDR; no embedded ICC profile)";

    fn native_error(e: impl ToString) -> CaptureError {
        CaptureError::new("native", e)
    }
    fn stale_source() -> CaptureError {
        CaptureError::new(
            "stale_source",
            "Source has closed or disconnected. Refresh sources and select again.",
        )
    }
    fn unavailable() -> CaptureError {
        CaptureError::new(
            "unavailable",
            "Window is minimized or on another workspace; bring it into view before capturing.",
        )
    }

    enum Target {
        Window { window: Window, pid: Option<u32> },
        Display { id: u32 },
    }

    fn parse_target(id: &str) -> Result<Target> {
        let parsed = SourceId::parse(id)
            .filter(|p| p.platform() == Platform::X11)
            .ok_or_else(stale_source)?;
        let handle = parsed.handle_u32().ok_or_else(stale_source)?;
        Ok(match parsed {
            SourceId::Display { .. } => Target::Display { id: handle },
            SourceId::Window { pid, .. } => Target::Window {
                window: handle,
                pid,
            },
        })
    }

    /// One located source: what to read, from which drawable, and where it sits.
    struct Located {
        /// The whole source in root pixels (frame size).
        rect: PxRect,
        /// Drawable to read and the source's origin inside it.
        drawable: Window,
        origin: (i32, i32),
    }

    /// X11 capture with `GetImage`: one request per capture, no retained session.
    pub struct X11Capture {
        desktop: Option<Desktop>,
    }

    impl X11Capture {
        /// Connect now, so a missing X server is reported at startup.
        pub fn connect() -> Result<Self> {
            let desktop = Desktop::connect().map_err(|e| CaptureError::new("unavailable", e))?;
            Ok(Self {
                desktop: Some(desktop),
            })
        }

        fn desktop(&mut self) -> Result<&Desktop> {
            if self.desktop.is_none() {
                self.desktop = Some(Desktop::connect().map_err(native_error)?);
            }
            Ok(self.desktop.as_ref().unwrap())
        }

        fn locate(desktop: &Desktop, target: &Target) -> Result<Located> {
            match *target {
                Target::Display { id } => {
                    let monitors: Vec<Monitor> = desktop.monitors();
                    let m = monitors
                        .into_iter()
                        .find(|m| m.id == id)
                        .ok_or_else(stale_source)?;
                    Ok(Located {
                        rect: m.rect,
                        drawable: desktop.root,
                        origin: (m.rect.x, m.rect.y),
                    })
                }
                Target::Window { window, pid } => {
                    let info = desktop.window_info(window).ok_or_else(stale_source)?;
                    // xids are recycled; the pid in the id is checked, not trusted.
                    if pid.is_some() && info.pid != pid {
                        return Err(stale_source());
                    }
                    if !info.viewable || info.hidden {
                        return Err(unavailable());
                    }
                    Ok(Located {
                        rect: info.rect,
                        drawable: window,
                        origin: info.offset,
                    })
                }
            }
        }

        /// Read `rect` (root pixels) of a located source. Off-screen parts stay black.
        fn read(desktop: &Desktop, located: &Located) -> Result<Vec<u8>> {
            let PxRect { width, height, .. } = located.rect;
            if width <= 0 || height <= 0 || (width as u64) * (height as u64) > MAX_PIXELS {
                return Err(CaptureError::new(
                    "dimensions",
                    "Invalid or larger than 64 megapixel source",
                ));
            }
            let visible = located.rect.intersect(&desktop.root_rect());
            let mut canvas = vec![0u8; width as usize * height as usize * 4];
            for i in 0..canvas.len() / 4 {
                canvas[i * 4 + 3] = 255;
            }
            if visible.is_empty() {
                return Ok(canvas);
            }
            // The on-screen part, in the drawable's own coordinates.
            let dx = visible.x - located.rect.x;
            let dy = visible.y - located.rect.y;
            let tile = Self::get_image(
                desktop,
                located.drawable,
                PxRect::new(
                    located.origin.0 + dx,
                    located.origin.1 + dy,
                    visible.width,
                    visible.height,
                ),
            )
            .or_else(|_| {
                // Not readable as a window (unviewable mid-flight, or an X server that
                // refuses): fall back to what the screen shows there.
                Self::get_image(desktop, desktop.root, visible)
            })?;
            paste_rgba(
                &mut canvas,
                width as u32,
                &tile,
                visible.width as u32,
                dx as u32,
                dy as u32,
            );
            Ok(canvas)
        }

        fn get_image(desktop: &Desktop, drawable: Window, r: PxRect) -> Result<Vec<u8>> {
            let reply = desktop
                .conn
                .get_image(
                    ImageFormat::Z_PIXMAP,
                    drawable,
                    r.x as i16,
                    r.y as i16,
                    r.width as u16,
                    r.height as u16,
                    !0,
                )
                .map_err(native_error)?
                .reply()
                .map_err(native_error)?;
            let setup = desktop.conn.setup();
            let format = setup
                .pixmap_formats
                .iter()
                .find(|f| f.depth == reply.depth)
                .ok_or_else(|| {
                    native_error(format!("no pixmap format for depth {}", reply.depth))
                })?;
            let visual = setup
                .roots
                .iter()
                .flat_map(|s| s.allowed_depths.iter())
                .flat_map(|d| d.visuals.iter())
                .find(|v| v.visual_id == reply.visual)
                .or_else(|| {
                    let root_visual = setup.roots[desktop.screen].root_visual;
                    setup.roots[desktop.screen]
                        .allowed_depths
                        .iter()
                        .flat_map(|d| d.visuals.iter())
                        .find(|v| v.visual_id == root_visual)
                });
            let (red, green, blue) = visual.map_or((0xff_0000, 0xff00, 0xff), |v| {
                (v.red_mask, v.green_mask, v.blue_mask)
            });
            zpixmap_to_rgba(
                &reply.data,
                r.width as u32,
                r.height as u32,
                PixelLayout {
                    bits_per_pixel: format.bits_per_pixel,
                    scanline_pad: format.scanline_pad,
                    lsb_first: setup.image_byte_order == ImageOrder::LSB_FIRST,
                    red_mask: red,
                    green_mask: green,
                    blue_mask: blue,
                },
            )
            .ok_or_else(|| {
                CaptureError::new(
                    "unsupported_format",
                    format!(
                        "X visual with {} bits per pixel is not supported",
                        format.bits_per_pixel
                    ),
                )
            })
        }

        /// Capture, crop and optionally shrink one source.
        fn grab(
            &mut self,
            source_id: &str,
            crop: Option<crate::Crop>,
            edge: Option<u32>,
        ) -> Result<Frame> {
            let start = Instant::now();
            let target = parse_target(source_id)?;
            let result = (|| -> Result<(f64, PxRect, Vec<u8>, f64, f64)> {
                let desktop = self.desktop()?;
                let scale = desktop.scale();
                let located = Self::locate(desktop, &target)?;
                let resolve_ms = elapsed_ms(start);
                let acquisition = Instant::now();
                let pixels = Self::read(desktop, &located)?;
                Ok((
                    scale,
                    located.rect,
                    pixels,
                    resolve_ms,
                    elapsed_ms(acquisition),
                ))
            })();
            let (scale, rect, pixels, resolve_ms, acquisition_ms) = match result {
                Ok(v) => v,
                Err(e) => {
                    if e.code == "native" {
                        // A broken connection stays broken: reconnect next time.
                        self.desktop = None;
                    }
                    return Err(e);
                }
            };
            let copying = Instant::now();
            let (fw, fh) = (rect.width as u32, rect.height as u32);
            let crop = crop_rect(crop, fw, fh)?;
            let mut out = if crop == [0, 0, fw, fh] {
                pixels
            } else {
                crop_pixels(&pixels, fw, crop)
            };
            let (mut info_crop, mut full, mut frame_scale) = (crop, (fw, fh), scale);
            if let Some(edge) = edge {
                let (w, h) = fit_within(crop[2], crop[3], edge.max(1));
                if (w, h) != (crop[2], crop[3]) {
                    out = box_downscale(&out, crop[2], crop[3], w, h);
                }
                frame_scale = scale * f64::from(w) / f64::from(fw.max(1));
                info_crop = [0, 0, w, h];
                full = (w, h);
            }
            let [_, _, w, h] = info_crop;
            let bounds: Rect = rect.to_desktop(scale);
            Ok(Frame {
                info: FrameInfo {
                    source_id: source_id.to_string(),
                    width: w,
                    height: h,
                    stride: w as usize * 4,
                    full_width: full.0,
                    full_height: full.1,
                    crop_pixels: info_crop,
                    scale_factor: frame_scale,
                    source_bounds: Some(bounds),
                    pixel_format: PIXEL_FORMAT,
                    color_space: COLOR_SPACE,
                    resolve_ms,
                    acquisition_ms,
                    pixels_ms: elapsed_ms(copying),
                    total_ms: elapsed_ms(start),
                },
                pixels: out,
            })
        }
    }

    impl CaptureBackend for X11Capture {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                backend: "x11-getimage",
                enumeration: true,
                system_picker_required: false,
                // One-shot GetImage per capture: nothing runs between calls.
                retained_session: false,
            }
        }
        fn permission(&self) -> &'static str {
            // X11 has no capture consent: any client may read any window.
            "granted"
        }
        fn request_permission(&self) -> bool {
            true
        }
        fn enumerate(&mut self) -> Result<Vec<Source>> {
            let own = std::process::id();
            let desktop = self.desktop()?;
            Ok(desktop.sources(own))
        }
        fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
            self.grab(&request.source_id, request.crop, None)
        }
        fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
            self.grab(source_id, None, Some(edge))
        }
        fn close(&mut self) {
            self.desktop = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logind_session_type_wins() {
        assert!(is_wayland_session(Some("wayland"), None, None));
        assert!(!is_wayland_session(Some("x11"), Some("wayland-0"), None));
        assert!(is_wayland_session(Some(" Wayland "), None, None));
    }

    #[test]
    fn unknown_session_types_fall_back_to_the_sockets() {
        assert!(is_wayland_session(Some("tty"), Some("wayland-0"), None));
        assert!(!is_wayland_session(Some("tty"), None, None));
        assert!(!is_wayland_session(None, Some(""), None));
        assert!(!is_wayland_session(None, None, None));
    }

    #[test]
    fn explicit_x11_backend_selects_xwayland() {
        assert!(!is_wayland_session(Some("wayland"), Some("wayland-1"), Some("x11")));
        assert!(is_wayland_session(Some("wayland"), Some("wayland-1"), None));
        assert!(is_wayland_session(Some("wayland"), Some("wayland-1"), Some("*")));
    }

    fn facts<'a>() -> WindowFacts<'a> {
        WindowFacts {
            viewable: true,
            hidden: false,
            title: "Game",
            kind: WindowKind::Normal,
            pid: Some(42),
            width: 1280,
            height: 720,
        }
    }

    #[test]
    fn an_ordinary_window_is_listed() {
        assert!(is_listable(&facts(), 1));
        assert!(is_listable(
            &WindowFacts {
                kind: WindowKind::Dialog,
                ..facts()
            },
            1
        ));
        assert!(is_listable(
            &WindowFacts {
                pid: None,
                ..facts()
            },
            1
        ));
    }

    #[test]
    fn unmapped_minimised_untitled_tiny_other_or_own_windows_are_not() {
        assert!(!is_listable(
            &WindowFacts {
                viewable: false,
                ..facts()
            },
            1
        ));
        assert!(!is_listable(
            &WindowFacts {
                hidden: true,
                ..facts()
            },
            1
        ));
        assert!(!is_listable(
            &WindowFacts {
                title: "  ",
                ..facts()
            },
            1
        ));
        assert!(!is_listable(
            &WindowFacts {
                kind: WindowKind::Other,
                ..facts()
            },
            1
        ));
        assert!(!is_listable(
            &WindowFacts {
                width: 79,
                ..facts()
            },
            1
        ));
        assert!(!is_listable(
            &WindowFacts {
                height: 59,
                ..facts()
            },
            1
        ));
        assert!(!is_listable(&facts(), 42));
    }

    #[test]
    fn rect_math() {
        let r = PxRect::new(-10, 5, 100, 50);
        assert_eq!(
            r.intersect(&PxRect::new(0, 0, 1920, 1080)),
            PxRect::new(0, 5, 90, 50)
        );
        assert!(r.intersect(&PxRect::new(500, 500, 10, 10)).is_empty());
        assert_eq!(r.inset([2, 3, 4, 5]), PxRect::new(-8, 9, 95, 41));
        // A margin larger than the window is ignored rather than producing nothing.
        assert_eq!(r.inset([60, 60, 0, 0]), r);
        let d = PxRect::new(100, 50, 200, 100).to_desktop(2.);
        assert_eq!((d.x, d.y, d.width, d.height), (50., 25., 100., 50.));
        let same = PxRect::new(1, 2, 3, 4).to_desktop(0.);
        assert_eq!((same.x, same.width), (1., 3.));
    }

    #[test]
    fn gdk_scale_env_beats_xsettings() {
        assert_eq!(desktop_scale_from(Some("2"), Some(1)), 2.);
        assert_eq!(desktop_scale_from(Some("0"), Some(2)), 2.);
        assert_eq!(desktop_scale_from(Some("abc"), None), 1.);
        assert_eq!(desktop_scale_from(None, Some(3)), 3.);
        assert_eq!(desktop_scale_from(None, Some(0)), 1.);
    }

    fn xsettings(big_endian: bool) -> Vec<u8> {
        let mut v = Vec::new();
        let u16b = |x: u16| {
            if big_endian {
                x.to_be_bytes()
            } else {
                x.to_le_bytes()
            }
        };
        let u32b = |x: u32| {
            if big_endian {
                x.to_be_bytes()
            } else {
                x.to_le_bytes()
            }
        };
        v.push(u8::from(big_endian));
        v.extend([0, 0, 0]);
        v.extend(u32b(7)); // serial
        v.extend(u32b(3)); // count
                           // string setting "Net/ThemeName" = "Adwaita"
        v.extend([1, 0]);
        v.extend(u16b(13));
        v.extend(b"Net/ThemeName\0\0\0");
        v.extend(u32b(0));
        v.extend(u32b(7));
        v.extend(b"Adwaita\0");
        // colour setting "Gtk/Color"
        v.extend([2, 0]);
        v.extend(u16b(9));
        v.extend(b"Gtk/Color\0\0\0");
        v.extend(u32b(0));
        v.extend([0u8; 8]);
        // integer "Gdk/WindowScalingFactor" = 2
        v.extend([0, 0]);
        v.extend(u16b(23));
        v.extend(b"Gdk/WindowScalingFactor\0");
        v.extend(u32b(0));
        v.extend(u32b(2));
        v
    }

    #[test]
    fn xsettings_integer_is_found_after_other_types() {
        for be in [false, true] {
            let data = xsettings(be);
            assert_eq!(
                parse_xsettings_int(&data, "Gdk/WindowScalingFactor"),
                Some(2)
            );
            assert_eq!(parse_xsettings_int(&data, "Net/ThemeName"), None);
            assert_eq!(parse_xsettings_int(&data, "Missing"), None);
        }
        assert_eq!(parse_xsettings_int(&[], "x"), None);
        assert_eq!(
            parse_xsettings_int(&[0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0], "x"),
            None
        );
    }

    const BGRX: PixelLayout = PixelLayout {
        bits_per_pixel: 32,
        scanline_pad: 32,
        lsb_first: true,
        red_mask: 0xff_0000,
        green_mask: 0xff00,
        blue_mask: 0xff,
    };

    #[test]
    fn little_endian_bgrx_becomes_opaque_rgba() {
        // Two pixels: pure red, then (0x10, 0x20, 0x30) with junk in the X byte.
        let data = [0, 0, 255, 0, 0x30, 0x20, 0x10, 0x7f];
        let rgba = zpixmap_to_rgba(&data, 2, 1, BGRX).unwrap();
        assert_eq!(rgba, vec![255, 0, 0, 255, 0x10, 0x20, 0x30, 255]);
    }

    #[test]
    fn big_endian_servers_and_24_bit_packed_pixels() {
        let be = PixelLayout {
            lsb_first: false,
            ..BGRX
        };
        assert_eq!(
            zpixmap_to_rgba(&[0, 1, 2, 3], 1, 1, be).unwrap(),
            vec![1, 2, 3, 255]
        );
        // 24 bpp rows of one pixel padded to 32 bits.
        let packed = PixelLayout {
            bits_per_pixel: 24,
            ..BGRX
        };
        let rows = [3, 2, 1, 0, 6, 5, 4, 0];
        assert_eq!(
            zpixmap_to_rgba(&rows, 1, 2, packed).unwrap(),
            vec![1, 2, 3, 255, 4, 5, 6, 255]
        );
    }

    #[test]
    fn rgb565_and_short_buffers() {
        let rgb565 = PixelLayout {
            bits_per_pixel: 16,
            red_mask: 0xf800,
            green_mask: 0x07e0,
            blue_mask: 0x1f,
            ..BGRX
        };
        assert!(zpixmap_to_rgba(&[0, 0], 1, 1, rgb565).is_none());
        assert!(zpixmap_to_rgba(&[0, 0, 0], 1, 1, BGRX).is_none());
        // Ten-bit (deep colour) channels keep their top eight bits.
        let deep = PixelLayout {
            red_mask: 0x3ff0_0000,
            green_mask: 0x000f_fc00,
            blue_mask: 0x3ff,
            ..BGRX
        };
        let white = 0x3fff_ffffu32.to_le_bytes();
        assert_eq!(
            zpixmap_to_rgba(&white, 1, 1, deep).unwrap(),
            vec![255, 255, 255, 255]
        );
    }

    #[test]
    fn paste_places_rows() {
        let mut canvas = vec![0u8; 3 * 2 * 4];
        paste_rgba(&mut canvas, 3, &[9; 8], 1, 2, 0);
        assert_eq!(&canvas[8..12], &[9; 4]);
        assert_eq!(&canvas[20..24], &[9; 4]);
        assert_eq!(&canvas[0..8], &[0; 8]);
    }

    #[test]
    fn process_names_prefer_the_executable() {
        assert_eq!(
            process_name_from(Some("/usr/lib/firefox/firefox"), Some("firefox-bin\n")).as_deref(),
            Some("firefox")
        );
        assert_eq!(
            process_name_from(Some("/opt/k/kimochi (deleted)"), None).as_deref(),
            Some("kimochi")
        );
        assert_eq!(
            process_name_from(None, Some("Xorg\n")).as_deref(),
            Some("Xorg")
        );
        assert_eq!(process_name_from(Some(""), Some("")), None);
    }

    #[test]
    fn x11_ids_round_trip_in_decimal() {
        let id = crate::SourceId::window(crate::Platform::X11, 62914564u32, 4242);
        assert_eq!(id.to_string(), "x11:window:62914564:4242");
        assert_eq!(
            crate::SourceId::parse("x11:window:62914564:4242")
                .unwrap()
                .handle_u32(),
            Some(62914564)
        );
        assert_eq!(
            crate::SourceId::display(crate::Platform::X11, 66u32).to_string(),
            "x11:display:66"
        );
    }
}
