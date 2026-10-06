//! Pure decisions for the Linux adapter, over plain values only.
//!
//! Nothing here talks to X11, D-Bus or GTK: every function takes environment values,
//! masks, keysyms or property contents the adapter has already read, so the rules are
//! unit-tested on any host (`cargo test` on macOS included, by `#[path]`-including this
//! file). Window *eligibility* is not here: it lives in `kimochi_capture::x11` (the
//! `linux_x11` module), because the capture backend applies the same rule and plan §3.1
//! forbids two copies of it.

/// Which display protocol this session runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    X11,
    Wayland,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::X11 => "x11",
            Backend::Wayland => "wayland",
        }
    }
}

/// The desktop session, detected once at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub backend: Backend,
    /// `GNOME`, `KDE`, `Hyprland`, `sway`, `niri`, `XFCE`… when anything says.
    pub compositor: Option<String>,
    /// Best-effort guess from the compositor's name that it implements
    /// `wlr-layer-shell` (Wayland only). Reported, never relied on: nothing in the v1
    /// Wayland tier uses layer-shell (plan §11 decision 3).
    pub layer_shell: bool,
    /// An X server is reachable (`DISPLAY` set). Under Wayland that is XWayland, which
    /// only sees XWayland clients.
    pub xwayland: bool,
}

/// Detect the session from the environment as given (`get("XDG_SESSION_TYPE")`…).
///
/// The X11/Wayland split is `kimochi_capture::is_wayland_session`, the same rule the
/// capture backend uses, so the two layers always pick the same tier.
pub fn detect_session(get: impl Fn(&str) -> Option<String>) -> Session {
    let set = |k: &str| get(k).filter(|v| !v.trim().is_empty());
    let wayland = kimochi_capture::is_wayland_session(
        get("XDG_SESSION_TYPE").as_deref(),
        get("WAYLAND_DISPLAY").as_deref(),
        get("GDK_BACKEND").as_deref(),
    );
    let compositor = compositor_name(
        set("XDG_CURRENT_DESKTOP").as_deref(),
        set("HYPRLAND_INSTANCE_SIGNATURE").is_some(),
        set("SWAYSOCK").is_some(),
        set("NIRI_SOCKET").is_some(),
    );
    Session {
        backend: if wayland {
            Backend::Wayland
        } else {
            Backend::X11
        },
        layer_shell: wayland && compositor.as_deref().is_some_and(layer_shell_likely),
        compositor,
        xwayland: wayland && set("DISPLAY").is_some(),
    }
}

/// The compositor or desktop. A compositor's own socket variable is the strongest
/// signal (it is set by the compositor itself, not by a login manager guess); otherwise
/// the first entry of `XDG_CURRENT_DESKTOP` (`ubuntu:GNOME` -> `GNOME`, since Ubuntu
/// lists its flavour first).
pub fn compositor_name(
    current_desktop: Option<&str>,
    hyprland: bool,
    sway: bool,
    niri: bool,
) -> Option<String> {
    if hyprland {
        return Some("Hyprland".into());
    }
    if sway {
        return Some("sway".into());
    }
    if niri {
        return Some("niri".into());
    }
    let entries: Vec<&str> = current_desktop?
        .split(':')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    // Distribution flavours that prefix the real desktop.
    const FLAVOURS: [&str; 3] = ["ubuntu", "pop", "zorin"];
    entries
        .iter()
        .find(|e| !FLAVOURS.contains(&e.to_ascii_lowercase().as_str()))
        .or(entries.first())
        .map(|s| s.to_string())
}

/// Compositors known to implement `zwlr_layer_shell_v1`. GNOME (Mutter) does not and
/// says it never will; unknown compositors are assumed not to.
pub fn layer_shell_likely(compositor: &str) -> bool {
    const KNOWN: [&str; 11] = [
        "kde", "hyprland", "sway", "niri", "wayfire", "river", "cosmic", "labwc", "hikari", "lxqt",
        "budgie",
    ];
    let c = compositor.to_ascii_lowercase();
    KNOWN
        .iter()
        .any(|k| c == *k || c.starts_with(&format!("{k}-")))
}

// ---------------------------------------------------------------- pointer

/// Core-protocol `KeyButMask` bits as `QueryPointer` reports them.
pub const SHIFT_MASK: u16 = 1 << 0;
#[allow(dead_code)] // Caps Lock: deliberately ignored by `held_state`.
pub const LOCK_MASK: u16 = 1 << 1;
pub const CONTROL_MASK: u16 = 1 << 2;
/// `Mod1`: Alt on every stock keymap.
pub const MOD1_MASK: u16 = 1 << 3;
/// `Mod4`: Super (the Windows key) on every stock keymap.
pub const MOD4_MASK: u16 = 1 << 6;
/// Logical button 1. X applies the pointer mapping (left-handed swap) before
/// reporting, so this is the *primary* button whichever physical one it is.
pub const BUTTON1_MASK: u16 = 1 << 8;

/// What a `QueryPointer` mask says is held.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HeldState {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
    pub primary: bool,
}

/// Read held modifiers and the primary button out of a pointer mask. Caps Lock is a
/// lock, not something held, and is ignored, as on macOS.
pub fn held_state(mask: u16) -> HeldState {
    HeldState {
        shift: mask & SHIFT_MASK != 0,
        ctrl: mask & CONTROL_MASK != 0,
        alt: mask & MOD1_MASK != 0,
        meta: mask & MOD4_MASK != 0,
        primary: mask & BUTTON1_MASK != 0,
    }
}

// ---------------------------------------------------------------- keys

/// The keytrigger name for a key, from the keysyms of its keycode (column 0 is the
/// unshifted symbol, column 1 the shifted one). Names are the Windows table's
/// (`windows/rules.rs::key_name`, itself the Go helper's), because users'
/// `autoScanSettings.triggerKeys` were written against those strings: the left
/// modifier is plain `shift`/`ctrl`/`alt`, the right one `*_right`, Super is `cmd`, and
/// anything unlisted is `unknown`.
///
/// Keypad keys carry the navigation symbol in column 0 (`KP_Home`) and the digit in
/// column 1 (`KP_7`); the digit is what Windows names them by, so it is preferred.
pub fn key_name(keysyms: &[u32]) -> &'static str {
    let first = keysyms.first().copied().unwrap_or(0);
    if (0xff95..=0xff9f).contains(&first) {
        if let Some(&second) = keysyms.get(1) {
            let name = keysym_name(second);
            if name != "unknown" {
                return name;
            }
        }
    }
    keysym_name(first)
}

/// One keysym's keytrigger name.
pub fn keysym_name(keysym: u32) -> &'static str {
    const LETTERS: [&str; 26] = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r",
        "s", "t", "u", "v", "w", "x", "y", "z",
    ];
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const F: [&str; 12] = [
        "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    ];
    const PAD: [&str; 10] = [
        "numpad_0", "numpad_1", "numpad_2", "numpad_3", "numpad_4", "numpad_5", "numpad_6",
        "numpad_7", "numpad_8", "numpad_9",
    ];
    match keysym {
        0x61..=0x7a => LETTERS[(keysym - 0x61) as usize],
        0x41..=0x5a => LETTERS[(keysym - 0x41) as usize],
        0x30..=0x39 => DIGITS[(keysym - 0x30) as usize],
        0xffbe..=0xffc9 => F[(keysym - 0xffbe) as usize],
        0xffb0..=0xffb9 => PAD[(keysym - 0xffb0) as usize],
        0xffe1 => "shift",
        0xffe2 => "shift_right",
        0xffe3 => "ctrl",
        0xffe4 => "ctrl_right",
        // Alt_L, and Meta_L which some keymaps put on the same key.
        0xffe9 | 0xffe7 => "alt",
        // Alt_R, Meta_R and AltGr (ISO_Level3_Shift), which is the right Alt key on
        // most European layouts.
        0xffea | 0xffe8 | 0xfe03 => "alt_right",
        0xffeb => "cmd",
        0xffec => "cmd_right",
        0xffe5 => "capslock",
        0xff0d | 0xff8d => "return",
        0xff09 | 0xfe20 => "tab", // Tab, ISO_Left_Tab
        0x20 => "space",
        0xff08 => "backspace",
        0xff1b => "escape",
        0xffff => "delete",
        0xff50 => "home",
        0xff57 => "end",
        0xff55 => "pageup",
        0xff56 => "pagedown",
        0xff51 => "left",
        0xff53 => "right",
        0xff54 => "down",
        0xff52 => "up",
        0x2d => "minus",
        0x3d => "equals",
        0x5b => "bracket_left",
        0x5d => "bracket_right",
        0x3b => "semicolon",
        0x27 => "quote",
        0x5c => "backslash",
        0x2c => "comma",
        0x2e => "period",
        0x2f => "slash",
        0x60 => "grave",
        0xffaa => "numpad_multiply",
        0xffab => "numpad_add",
        0xffad => "numpad_subtract",
        0xffae | 0xffac => "numpad_decimal", // KP_Decimal, KP_Separator
        0xffaf => "numpad_divide",
        _ => "unknown",
    }
}

/// Turns raw key transitions into keytrigger events, the way the Windows hook's drain
/// thread does: auto-repeat is a further `down` tagged `repeat: true`.
///
/// XInput 2 raw events carry no repeat flag, so repeat is "down while already down".
pub struct RepeatTracker {
    held: [bool; 256],
}

impl Default for RepeatTracker {
    fn default() -> Self {
        Self { held: [false; 256] }
    }
}

impl RepeatTracker {
    /// Record a transition; returns whether it was an auto-repeat.
    pub fn transition(&mut self, keycode: u32, down: bool) -> bool {
        let slot = &mut self.held[(keycode & 0xff) as usize];
        let repeat = down && *slot;
        *slot = down;
        repeat
    }
}

// ---------------------------------------------------------------- geometry

/// `[x, y, width, height]`.
pub type Area = [i32; 4];

/// A monitor's work area: its bounds intersected with the EWMH `_NET_WORKAREA` of the
/// current desktop. `_NET_WORKAREA` is one rectangle for the whole screen, so on a
/// multi-monitor desktop with a panel on only one monitor it is an approximation (the
/// panel's strut cuts into every monitor it spans); it is still what GTK itself uses.
/// No work area, or one that misses the monitor entirely, means the full monitor.
pub fn work_area(monitor: Area, workarea: Option<Area>) -> Area {
    let Some(w) = workarea else {
        return monitor;
    };
    let x = monitor[0].max(w[0]);
    let y = monitor[1].max(w[1]);
    let right = (monitor[0] + monitor[2]).min(w[0] + w[2]);
    let bottom = (monitor[1] + monitor[3]).min(w[1] + w[3]);
    if right <= x || bottom <= y {
        monitor
    } else {
        [x, y, right - x, bottom - y]
    }
}

/// The current desktop's rectangle from `_NET_WORKAREA` (four CARDINALs per desktop).
pub fn workarea_for_desktop(values: &[u32], desktop: usize) -> Option<Area> {
    let v = values.get(desktop * 4..desktop * 4 + 4)?;
    Some([v[0] as i32, v[1] as i32, v[2] as i32, v[3] as i32])
}

/// `x`/`y` window-local; inside `[0, width) x [0, height)`.
pub fn inside(x: f64, y: f64, width: f64, height: f64) -> bool {
    x >= 0. && y >= 0. && x < width && y < height
}

// ---------------------------------------------------------------- input shapes

/// One rectangle of an X input shape: window-local X pixels, the request's own types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShapeRect {
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
}

/// Window-local CSS rectangles (`[x, y, width, height]`) as the rectangles of an X
/// input shape for a window `size` X pixels big, at `scale` X pixels per CSS pixel (the
/// GDK window scale; anything not finite and positive counts as 1).
///
/// Each rectangle is scaled and snapped *outward* (floor the near edges, ceil the far
/// ones), so rounding never takes a pixel away from something the UI made clickable;
/// clamped to the window (X coordinates are 16-bit, and the server would clip anyway,
/// but a clamped list compares equal across frames); and dropped when nothing is left
/// of it or it is not finite. The survivors are merged (`merge_edges`), which only
/// shortens the request: the shape is their union whatever the overlap.
pub fn input_shape(rects: &[[f64; 4]], scale: f64, size: (u16, u16)) -> Vec<ShapeRect> {
    let scale = if scale.is_finite() && scale > 0. {
        scale
    } else {
        1.
    };
    let limit = |v: u16| f64::from(v.min(i16::MAX as u16));
    let (max_x, max_y) = (limit(size.0), limit(size.1));
    let edges: Vec<[i32; 4]> = rects
        .iter()
        .filter(|r| r.iter().all(|v| v.is_finite()) && r[2] > 0. && r[3] > 0.)
        .filter_map(|&[x, y, w, h]| {
            let x0 = (x * scale).floor().clamp(0., max_x);
            let y0 = (y * scale).floor().clamp(0., max_y);
            let x1 = ((x + w) * scale).ceil().clamp(0., max_x);
            let y1 = ((y + h) * scale).ceil().clamp(0., max_y);
            (x1 > x0 && y1 > y0).then_some([x0 as i32, y0 as i32, x1 as i32, y1 as i32])
        })
        .collect();
    merge_edges(edges)
        .into_iter()
        .map(|[x0, y0, x1, y1]| ShapeRect {
            x: x0 as i16,
            y: y0 as i16,
            width: (x1 - x0) as u16,
            height: (y1 - y0) as u16,
        })
        .collect()
}

/// Shorten a list of rectangles (`[left, top, right, bottom]`, right/bottom exclusive)
/// without changing their union: drop every rectangle another one contains, and join
/// two that line up exactly and touch or overlap (same columns stacked vertically, or
/// same rows side by side — a line of words, or the boxes of one word), repeatedly,
/// until nothing changes. The X request is sent `UNSORTED`, so order does not matter.
pub fn merge_edges(rects: Vec<[i32; 4]>) -> Vec<[i32; 4]> {
    let contains =
        |a: &[i32; 4], b: &[i32; 4]| a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
    let joined = |a: &[i32; 4], b: &[i32; 4]| -> Option<[i32; 4]> {
        let columns = a[0] == b[0] && a[2] == b[2] && a[1] <= b[3] && b[1] <= a[3];
        let rows = a[1] == b[1] && a[3] == b[3] && a[0] <= b[2] && b[0] <= a[2];
        (columns || rows).then(|| {
            [
                a[0].min(b[0]),
                a[1].min(b[1]),
                a[2].max(b[2]),
                a[3].max(b[3]),
            ]
        })
    };
    let mut out: Vec<[i32; 4]> = Vec::with_capacity(rects.len());
    for rect in rects {
        let mut current = rect;
        // Absorb into the list until `current` neither fits in nor joins anything; a
        // join can make it contain or line up with rectangles kept earlier.
        loop {
            if out.iter().any(|kept| contains(kept, &current)) {
                break;
            }
            out.retain(|kept| !contains(&current, kept));
            match out.iter().position(|kept| joined(kept, &current).is_some()) {
                Some(i) => {
                    let kept = out.remove(i);
                    current = joined(&kept, &current).unwrap_or(current);
                }
                None => {
                    out.push(current);
                    break;
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------- icons

/// Pick one icon out of a `_NET_WM_ICON` property (`width, height, width*height ARGB
/// pixels`, repeated): the smallest at least `target` pixels on its longer edge, else
/// the largest. Returns `(width, height, pixels)`. Malformed entries end the scan.
pub fn pick_icon(data: &[u32], target: u32) -> Option<(u32, u32, &[u32])> {
    let mut at = 0usize;
    let mut best: Option<(u32, u32, &[u32])> = None;
    while at + 2 <= data.len() {
        let (w, h) = (data[at], data[at + 1]);
        let count = (w as usize).checked_mul(h as usize)?;
        if w == 0 || h == 0 || w > 4096 || h > 4096 || at + 2 + count > data.len() {
            break;
        }
        let pixels = &data[at + 2..at + 2 + count];
        let edge = w.max(h);
        best = Some(match best {
            None => (w, h, pixels),
            Some(current) => {
                let current_edge = current.0.max(current.1);
                let better = match (edge >= target, current_edge >= target) {
                    (true, true) => edge < current_edge,
                    (true, false) => true,
                    (false, true) => false,
                    (false, false) => edge > current_edge,
                };
                if better {
                    (w, h, pixels)
                } else {
                    current
                }
            }
        });
        at += 2 + count;
    }
    best
}

/// `_NET_WM_ICON` pixels (0xAARRGGBB, straight alpha per the EWMH spec) as RGBA8.
pub fn argb_to_rgba(pixels: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len() * 4);
    for &p in pixels {
        out.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8, (p >> 24) as u8]);
    }
    out
}

// ---------------------------------------------------------------- misc

/// `ubuntu 24.04` from `/etc/os-release`, else its `PRETTY_NAME`, else empty.
pub fn os_version(os_release: &str) -> String {
    let field = |key: &str| {
        os_release.lines().find_map(|line| {
            let (k, v) = line.split_once('=')?;
            (k.trim() == key).then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
        })
    };
    match (field("ID"), field("VERSION_ID")) {
        (Some(id), Some(version)) if !id.is_empty() && !version.is_empty() => {
            format!("{id} {version}")
        }
        _ => field("PRETTY_NAME").or(field("ID")).unwrap_or_default(),
    }
}

/// logind's `PrepareForSleep(start)`, de-duplicated: returns `(report, suspended)`
/// where `report` is `Some(true)` for sleep, `Some(false)` for wake, `None` for a
/// repeat of the state already reported.
pub fn sleep_transition(suspended: bool, start: bool) -> (Option<bool>, bool) {
    if start == suspended {
        (None, suspended)
    } else {
        (Some(start), start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn gnome_on_x11() {
        let s = detect_session(env(&[
            ("XDG_SESSION_TYPE", "x11"),
            ("DISPLAY", ":0"),
            ("XDG_CURRENT_DESKTOP", "ubuntu:GNOME"),
        ]));
        assert_eq!(s.backend, Backend::X11);
        assert_eq!(s.compositor.as_deref(), Some("GNOME"));
        assert!(!s.layer_shell && !s.xwayland);
    }

    #[test]
    fn gnome_on_wayland_has_xwayland_but_no_layer_shell() {
        let s = detect_session(env(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("DISPLAY", ":0"),
            ("XDG_CURRENT_DESKTOP", "GNOME"),
        ]));
        assert_eq!(s.backend, Backend::Wayland);
        assert!(s.xwayland);
        assert!(!s.layer_shell);
    }

    #[test]
    fn compositor_sockets_beat_the_desktop_name() {
        let s = detect_session(env(&[
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("HYPRLAND_INSTANCE_SIGNATURE", "abc"),
            ("XDG_CURRENT_DESKTOP", "Hyprland"),
        ]));
        assert_eq!(s.backend, Backend::Wayland);
        assert_eq!(s.compositor.as_deref(), Some("Hyprland"));
        assert!(s.layer_shell);
        let sway = detect_session(env(&[("WAYLAND_DISPLAY", "w"), ("SWAYSOCK", "/run/s")]));
        assert_eq!(sway.compositor.as_deref(), Some("sway"));
        assert!(sway.layer_shell);
        let kde = detect_session(env(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("XDG_CURRENT_DESKTOP", "KDE"),
        ]));
        assert!(kde.layer_shell);
    }

    #[test]
    fn layer_shell_is_never_claimed_on_x11() {
        let s = detect_session(env(&[
            ("XDG_SESSION_TYPE", "x11"),
            ("XDG_CURRENT_DESKTOP", "KDE"),
        ]));
        assert!(!s.layer_shell);
        assert_eq!(compositor_name(None, false, false, false), None);
        assert_eq!(compositor_name(Some(""), false, false, false), None);
        assert_eq!(
            compositor_name(Some("ubuntu"), false, false, false).as_deref(),
            Some("ubuntu")
        );
    }

    #[test]
    fn modifier_bits() {
        assert_eq!(held_state(0), HeldState::default());
        let s = held_state(SHIFT_MASK | LOCK_MASK | BUTTON1_MASK);
        assert!(s.shift && s.primary && !s.ctrl && !s.alt && !s.meta);
        let s = held_state(CONTROL_MASK | MOD1_MASK | MOD4_MASK);
        assert!(s.ctrl && s.alt && s.meta && !s.shift && !s.primary);
        assert_eq!(held_state(LOCK_MASK), HeldState::default());
    }

    #[test]
    fn key_names_match_the_windows_table() {
        assert_eq!(key_name(&[0x61, 0x41]), "a");
        assert_eq!(key_name(&[0x5a]), "z");
        assert_eq!(key_name(&[0x31, 0x21]), "1");
        assert_eq!(key_name(&[0xffe1]), "shift");
        assert_eq!(key_name(&[0xffe2]), "shift_right");
        assert_eq!(key_name(&[0xffe3]), "ctrl");
        assert_eq!(key_name(&[0xffe4]), "ctrl_right");
        assert_eq!(key_name(&[0xffe9, 0xffe7]), "alt");
        assert_eq!(key_name(&[0xfe03]), "alt_right");
        assert_eq!(key_name(&[0xffeb]), "cmd");
        assert_eq!(key_name(&[0xffbe]), "f1");
        assert_eq!(key_name(&[0xffc9]), "f12");
        assert_eq!(key_name(&[0xff0d]), "return");
        assert_eq!(key_name(&[0x60, 0x7e]), "grave");
        assert_eq!(key_name(&[0x20]), "space");
        assert_eq!(key_name(&[]), "unknown");
        assert_eq!(key_name(&[0x1008ff13]), "unknown"); // XF86AudioRaiseVolume
    }

    #[test]
    fn keypad_digits_win_over_navigation_symbols() {
        assert_eq!(key_name(&[0xff95, 0xffb7]), "numpad_7"); // KP_Home / KP_7
        assert_eq!(key_name(&[0xff9f, 0xffae]), "numpad_decimal"); // KP_Delete / KP_Decimal
        assert_eq!(key_name(&[0xff95]), "unknown");
        assert_eq!(key_name(&[0xffab]), "numpad_add");
    }

    #[test]
    fn every_windows_name_is_reachable() {
        // The Linux table may not invent names: everything it emits must be a name the
        // Windows (Go-derived) table also emits, so saved trigger keys work everywhere.
        let windows_names = [
            "shift",
            "shift_right",
            "ctrl",
            "ctrl_right",
            "alt",
            "alt_right",
            "cmd",
            "cmd_right",
            "capslock",
            "return",
            "tab",
            "space",
            "backspace",
            "escape",
            "delete",
            "home",
            "end",
            "pageup",
            "pagedown",
            "left",
            "right",
            "down",
            "up",
            "minus",
            "equals",
            "bracket_left",
            "bracket_right",
            "semicolon",
            "quote",
            "backslash",
            "comma",
            "period",
            "slash",
            "grave",
            "numpad_multiply",
            "numpad_add",
            "numpad_subtract",
            "numpad_decimal",
            "numpad_divide",
            "unknown",
        ];
        for keysym in (0u32..0x100).chain(0xfe00..0x10000) {
            let name = keysym_name(keysym);
            let ok = windows_names.contains(&name)
                || (name.len() == 1 && name.chars().all(|c| c.is_ascii_alphanumeric()))
                || (name.starts_with('f')
                    && name[1..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n)))
                || name.strip_prefix("numpad_").is_some_and(|d| d.len() == 1);
            assert!(ok, "{keysym:#x} -> {name}");
        }
    }

    #[test]
    fn repeats_are_downs_while_held() {
        let mut t = RepeatTracker::default();
        assert!(!t.transition(50, true));
        assert!(t.transition(50, true));
        assert!(!t.transition(50, false));
        assert!(!t.transition(50, true));
        assert!(!t.transition(300, true)); // masked into the table, never panics
    }

    #[test]
    fn work_area_is_the_overlap_with_the_monitor() {
        let left = [0, 0, 1920, 1080];
        let right = [1920, 0, 1920, 1080];
        let workarea = Some([0, 27, 3840, 1053]);
        assert_eq!(work_area(left, workarea), [0, 27, 1920, 1053]);
        assert_eq!(work_area(right, workarea), [1920, 27, 1920, 1053]);
        assert_eq!(work_area(left, None), left);
        assert_eq!(work_area(left, Some([5000, 0, 10, 10])), left);
        assert_eq!(
            workarea_for_desktop(&[0, 27, 3840, 1053, 1, 2, 3, 4], 1),
            Some([1, 2, 3, 4])
        );
        assert_eq!(workarea_for_desktop(&[0, 27, 3840], 0), None);
    }

    #[test]
    fn icon_choice_prefers_the_smallest_big_enough() {
        let mut data = vec![16, 16];
        data.extend(std::iter::repeat_n(1u32, 256));
        data.extend([48, 48]);
        data.extend(std::iter::repeat_n(2u32, 48 * 48));
        data.extend([32, 32]);
        data.extend(std::iter::repeat_n(3u32, 1024));
        assert_eq!(
            pick_icon(&data, 24).map(|(w, _, p)| (w, p[0])),
            Some((32, 3))
        );
        assert_eq!(
            pick_icon(&data, 64).map(|(w, _, p)| (w, p[0])),
            Some((48, 2))
        );
        assert_eq!(
            pick_icon(&data, 8).map(|(w, _, p)| (w, p[0])),
            Some((16, 1))
        );
        // Truncated trailing entry is ignored, garbage yields nothing.
        let mut cut = data.clone();
        cut.extend([64, 64, 9]);
        assert_eq!(pick_icon(&cut, 64).map(|(w, _, _)| w), Some(48));
        assert_eq!(pick_icon(&[0, 0], 16), None);
        assert_eq!(pick_icon(&[u32::MAX, u32::MAX], 16), None);
    }

    #[test]
    fn argb_unpacks_to_rgba() {
        assert_eq!(argb_to_rgba(&[0x80ff_2010]), vec![0xff, 0x20, 0x10, 0x80]);
    }

    #[test]
    fn os_release_versions() {
        let ubuntu = "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\nVERSION_ID=\"24.04\"\n";
        assert_eq!(os_version(ubuntu), "ubuntu 24.04");
        let arch = "NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\nBUILD_ID=rolling\n";
        assert_eq!(os_version(arch), "Arch Linux");
        assert_eq!(os_version(""), "");
    }

    #[test]
    fn sleep_and_wake_are_reported_once() {
        assert_eq!(sleep_transition(false, true), (Some(true), true));
        assert_eq!(sleep_transition(true, true), (None, true));
        assert_eq!(sleep_transition(true, false), (Some(false), false));
        assert_eq!(sleep_transition(false, false), (None, false));
    }

    #[test]
    fn inside_is_half_open() {
        assert!(inside(0., 0., 10., 10.));
        assert!(!inside(10., 5., 10., 10.));
        assert!(!inside(-0.5, 5., 10., 10.));
    }

    fn shape(x: i16, y: i16, width: u16, height: u16) -> ShapeRect {
        ShapeRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn input_shape_scales_and_snaps_outward() {
        // Fractional CSS edges never lose a pixel.
        assert_eq!(
            input_shape(&[[10.4, 20.6, 5.2, 3.0]], 1., (100, 100)),
            vec![shape(10, 20, 6, 4)]
        );
        // GDK scale 2: device pixels are twice the CSS pixels.
        assert_eq!(
            input_shape(&[[10., 20., 5., 3.]], 2., (100, 100)),
            vec![shape(20, 40, 10, 6)]
        );
        // A nonsensical scale is 1.
        assert_eq!(
            input_shape(&[[1., 1., 2., 2.]], 0., (100, 100)),
            vec![shape(1, 1, 2, 2)]
        );
    }

    #[test]
    fn input_shape_clamps_to_the_window_and_drops_the_rest() {
        let rects = [
            [-5., -5., 10., 10.],          // straddles the top-left corner
            [95., 90., 20., 20.],          // straddles the bottom-right corner
            [200., 10., 10., 10.],         // entirely outside
            [10., 10., 0., 10.],           // empty
            [f64::NAN, 10., 10., 10.],     // not finite
            [10., 10., f64::INFINITY, 1.], // not finite
        ];
        assert_eq!(
            input_shape(&rects, 1., (100, 100)),
            vec![shape(0, 0, 5, 5), shape(95, 90, 5, 10)]
        );
        // X coordinates are 16-bit.
        assert_eq!(
            input_shape(&[[0., 0., 1e9, 1.]], 1., (u16::MAX, 10)),
            vec![shape(0, 0, i16::MAX as u16, 1)]
        );
        assert!(input_shape(&[], 1., (100, 100)).is_empty());
    }

    #[test]
    fn merge_drops_contained_and_joins_aligned() {
        // Contained either way round, and duplicates.
        assert_eq!(
            merge_edges(vec![[0, 0, 10, 10], [2, 2, 5, 5], [0, 0, 10, 10]]),
            vec![[0, 0, 10, 10]]
        );
        assert_eq!(
            merge_edges(vec![[2, 2, 5, 5], [0, 0, 10, 10]]),
            vec![[0, 0, 10, 10]]
        );
        // A line of words: same rows, touching.
        assert_eq!(
            merge_edges(vec![[0, 0, 10, 20], [10, 0, 25, 20], [25, 0, 30, 20]]),
            vec![[0, 0, 30, 20]]
        );
        // Stacked in the same columns, overlapping.
        assert_eq!(
            merge_edges(vec![[0, 0, 10, 10], [0, 5, 10, 30]]),
            vec![[0, 0, 10, 30]]
        );
        // A join that makes the result line up with an earlier rectangle.
        assert_eq!(
            merge_edges(vec![[0, 10, 20, 20], [0, 0, 10, 10], [10, 0, 20, 10]]),
            vec![[0, 0, 20, 20]]
        );
    }

    #[test]
    fn merge_keeps_what_does_not_line_up() {
        // Overlapping but misaligned: both stay (X unions them).
        let rects = vec![[0, 0, 10, 10], [5, 5, 15, 15]];
        assert_eq!(merge_edges(rects.clone()), rects);
        // Same rows with a gap: both stay.
        let gap = vec![[0, 0, 10, 10], [11, 0, 20, 10]];
        assert_eq!(merge_edges(gap.clone()), gap);
    }
}
