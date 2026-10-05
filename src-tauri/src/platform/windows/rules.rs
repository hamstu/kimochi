//! Pure decisions for the Windows adapter, over plain values only.
//!
//! Nothing in this file touches Win32: every function takes booleans, sizes, strings or
//! style bits that the adapter has already read, so the rules can be unit-tested on any
//! host (`cargo test` on macOS included, by `#[path]`-including this file) and so the
//! *semantic* window rules the plan keeps shared (§3.1: "has title, user-visible, not our
//! own, minimum size") are written once, not re-derived inside an `EnumWindows` callback.
//! The listing rule itself and handle spelling live in `kimochi_capture::win_rules`.
use std::path::{Path, PathBuf};

// Which windows are sources and how handles are spelled are capture-core's rules, shared
// with the WGC backend so the picker and `enumerate` cannot disagree.
pub use kimochi_capture::win_rules::{
    hex_handle, is_shell_surface, is_tool_window, listable, parse_hex_handle, sized, WindowMeta,
};

/// On screen as far as a person is concerned: shown, not minimised, not cloaked by DWM
/// (a suspended UWP app or a window on another virtual desktop is "visible" to USER but
/// cloaked), and big enough to be read.
pub fn on_screen(visible: bool, iconic: bool, cloaked: bool, width: f64, height: f64) -> bool {
    visible && !iconic && !cloaked && sized(width, height)
}

/// `C:\Games\Foo\foo.exe` -> `foo`. Written by hand rather than with `Path::file_stem`
/// so that it treats `\` as a separator on every host, which keeps the tests honest
/// when they run on macOS.
pub fn image_stem(path: &str) -> String {
    let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[..dot].to_string(),
        _ => name.to_string(),
    }
}

/// The key name the Go `keytrigger` helper (`keymap_windows.go`) emitted for a virtual-key
/// code. Users' `autoScanSettings.triggerKeys` were written against these strings, so
/// the table is copied verbatim, including its quirks: the low-level hook reports the
/// sided codes (`VK_LSHIFT` = 0xA0), so the left key is plain `shift` and the right one
/// `shift_right`; the Windows key is `cmd`; anything unlisted is `unknown`.
pub fn key_name(vk: u32) -> &'static str {
    match vk {
        0x41..=0x5A => {
            const LETTERS: [&str; 26] = [
                "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p",
                "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
            ];
            LETTERS[(vk - 0x41) as usize]
        }
        0x30..=0x39 => {
            const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
            DIGITS[(vk - 0x30) as usize]
        }
        0x70..=0x7B => {
            const F: [&str; 12] = [
                "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
            ];
            F[(vk - 0x70) as usize]
        }
        0x10 | 0xA0 => "shift",
        0xA1 => "shift_right",
        0x11 | 0xA2 => "ctrl",
        0xA3 => "ctrl_right",
        0x12 | 0xA4 => "alt",
        0xA5 => "alt_right",
        0x5B => "cmd",
        0x5C => "cmd_right",
        0x14 => "capslock",
        0x0D => "return",
        0x09 => "tab",
        0x20 => "space",
        0x08 => "backspace",
        0x1B => "escape",
        0x2E => "delete",
        0x24 => "home",
        0x23 => "end",
        0x21 => "pageup",
        0x22 => "pagedown",
        0x25 => "left",
        0x27 => "right",
        0x28 => "down",
        0x26 => "up",
        0xBD => "minus",
        0xBB => "equals",
        0xDB => "bracket_left",
        0xDD => "bracket_right",
        0xBA => "semicolon",
        0xDE => "quote",
        0xDC => "backslash",
        0xBC => "comma",
        0xBE => "period",
        0xBF => "slash",
        0xC0 => "grave",
        0x60..=0x69 => {
            const PAD: [&str; 10] = [
                "numpad_0", "numpad_1", "numpad_2", "numpad_3", "numpad_4", "numpad_5", "numpad_6",
                "numpad_7", "numpad_8", "numpad_9",
            ];
            PAD[(vk - 0x60) as usize]
        }
        0x6A => "numpad_multiply",
        0x6B => "numpad_add",
        0x6D => "numpad_subtract",
        0x6E => "numpad_decimal",
        0x6F => "numpad_divide",
        _ => "unknown",
    }
}

/// Which native frame edge the pointer is on, mirroring the macOS adapter's
/// `resize_edge` (4-pixel band, corners first).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeEdge {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Left,
    Right,
    Top,
    Bottom,
}

/// `x`/`y` are window-local, in the same unit as `width`/`height`.
pub fn resize_edge(x: f64, y: f64, width: f64, height: f64, resizable: bool) -> Option<ResizeEdge> {
    use ResizeEdge::*;
    if !resizable {
        return None;
    }
    // Restrict this hint to the native frame edge, not a custom DOM resize handle.
    match (x < 4., x >= width - 4., y < 4., y >= height - 4.) {
        (true, _, true, _) => Some(TopLeft),
        (_, true, true, _) => Some(TopRight),
        (true, _, _, true) => Some(BottomLeft),
        (_, true, _, true) => Some(BottomRight),
        (true, _, _, _) => Some(Left),
        (_, true, _, _) => Some(Right),
        (_, _, true, _) => Some(Top),
        (_, _, _, true) => Some(Bottom),
        _ => None,
    }
}

/// The system cursors a CSS `cursor` value maps to. Windows has no open/closed hand, so
/// `grab` is the link hand and `grabbing` the four-way move cursor, which is what
/// Chromium itself falls back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Arrow,
    Hand,
    Move,
    Cross,
    No,
    IBeam,
    SizeWE,
    SizeNS,
    SizeNWSE,
    SizeNESW,
    Wait,
    AppStarting,
    Help,
}

pub fn cursor_shape(kind: &str, edge: Option<ResizeEdge>) -> CursorShape {
    use CursorShape::*;
    if let Some(edge) = edge {
        return match edge {
            ResizeEdge::TopLeft | ResizeEdge::BottomRight => SizeNWSE,
            ResizeEdge::TopRight | ResizeEdge::BottomLeft => SizeNESW,
            ResizeEdge::Left | ResizeEdge::Right => SizeWE,
            ResizeEdge::Top | ResizeEdge::Bottom => SizeNS,
        };
    }
    match kind {
        "pointer" | "grab" => Hand,
        "grabbing" | "move" | "all-scroll" => Move,
        "crosshair" => Cross,
        "not-allowed" | "no-drop" => No,
        "text" | "vertical-text" => IBeam,
        "col-resize" | "ew-resize" | "e-resize" | "w-resize" => SizeWE,
        "row-resize" | "ns-resize" | "n-resize" | "s-resize" => SizeNS,
        "nwse-resize" | "nw-resize" | "se-resize" => SizeNWSE,
        "nesw-resize" | "ne-resize" | "sw-resize" => SizeNESW,
        "wait" => Wait,
        "progress" => AppStarting,
        "help" => Help,
        _ => Arrow,
    }
}

/// Extensions that are real binaries, tried first in every PATH directory.
const BINARY_EXTENSIONS: [&str; 2] = ["exe", "com"];
/// Script shims (npm's `foo.cmd`), used only when no binary exists anywhere on PATH.
const SHIM_EXTENSIONS: [&str; 2] = ["cmd", "bat"];

/// Resolve a CLI name the way a person typing it would expect, but preferring a real
/// binary over a script shim anywhere on PATH.
///
/// `cmd.exe` would take the first PATH directory with *any* `PATHEXT` match, which for
/// tools installed both natively and through npm finds the `.cmd` shim. A shim has to
/// run under `cmd.exe /c`, and killing that `cmd.exe` leaves the real process behind,
/// so two passes: binaries across all of PATH first, shims second.
///
/// A program with a directory component or an explicit extension is taken as given
/// (with the binary extensions tried if it has no extension).
pub fn resolve_program(
    program: &str,
    path_dirs: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let has_dir = program.contains(['\\', '/']);
    let has_ext = image_stem(program) != program.rsplit(['\\', '/']).next().unwrap_or(program);
    if has_dir {
        let given = PathBuf::from(program);
        if has_ext {
            return exists(&given).then_some(given);
        }
        return BINARY_EXTENSIONS
            .iter()
            .chain(SHIM_EXTENSIONS.iter())
            .map(|ext| PathBuf::from(format!("{program}.{ext}")))
            .find(|p| exists(p));
    }
    if has_ext {
        return path_dirs
            .iter()
            .map(|d| d.join(program))
            .find(|p| exists(p));
    }
    for exts in [&BINARY_EXTENSIONS, &SHIM_EXTENSIONS] {
        for dir in path_dirs {
            for ext in exts.iter() {
                let candidate = dir.join(format!("{program}.{ext}"));
                if exists(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// One `WM_POWERBROADCAST` event, reduced to what `observe_workspace` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
    Suspend,
    /// `PBT_APMRESUMEAUTOMATIC`: sent on every resume.
    ResumeAutomatic,
    /// `PBT_APMRESUMESUSPEND`: sent *as well*, after the automatic one, when the resume
    /// was caused by user input.
    ResumeSuspend,
}

/// Whether to report sleep or wake for a power event, given whether a suspend has been
/// reported and not yet matched by a wake. Returns `(report, now_suspended)` where
/// `report` is `Some(true)` for sleep, `Some(false)` for wake.
///
/// Windows sends two resume events for a user-initiated wake; reporting both would tell
/// the app it woke twice. The first resume after a suspend is the wake; a lone
/// `ResumeAutomatic` (suspend missed, e.g. registered mid-sleep) still counts.
pub fn power_transition(suspended: bool, event: PowerEvent) -> (Option<bool>, bool) {
    match event {
        PowerEvent::Suspend => (Some(true), true),
        PowerEvent::ResumeAutomatic | PowerEvent::ResumeSuspend if suspended => {
            (Some(false), false)
        }
        PowerEvent::ResumeAutomatic => (Some(false), false),
        PowerEvent::ResumeSuspend => (None, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_screen_excludes_minimised_and_cloaked() {
        assert!(on_screen(true, false, false, 800., 600.));
        assert!(!on_screen(true, true, false, 800., 600.));
        assert!(!on_screen(true, false, true, 800., 600.));
        assert!(!on_screen(false, false, false, 800., 600.));
    }

    #[test]
    fn image_stem_handles_windows_paths_on_any_host() {
        assert_eq!(image_stem(r"C:\Program Files\Foo\Foo.Bar.exe"), "Foo.Bar");
        assert_eq!(image_stem(r"C:\x\notepad.exe"), "notepad");
        assert_eq!(image_stem("kimochi.exe"), "kimochi");
        assert_eq!(image_stem("noext"), "noext");
        assert_eq!(image_stem(".hidden"), ".hidden");
        assert_eq!(image_stem(""), "");
    }

    #[test]
    fn key_names_match_the_go_keytrigger_table() {
        assert_eq!(key_name(0x41), "a");
        assert_eq!(key_name(0x5A), "z");
        assert_eq!(key_name(0x30), "0");
        assert_eq!(key_name(0x7B), "f12");
        assert_eq!(key_name(0xA0), "shift");
        assert_eq!(key_name(0xA1), "shift_right");
        assert_eq!(key_name(0xA2), "ctrl");
        assert_eq!(key_name(0xA4), "alt");
        assert_eq!(key_name(0x5B), "cmd");
        assert_eq!(key_name(0x0D), "return");
        assert_eq!(key_name(0x20), "space");
        assert_eq!(key_name(0x69), "numpad_9");
        assert_eq!(key_name(0xC0), "grave");
        assert_eq!(key_name(0x7C), "unknown"); // F13 was never mapped
        assert_eq!(key_name(0xFF), "unknown");
    }

    #[test]
    fn resize_edge_only_on_resizable_frame_edges() {
        assert_eq!(resize_edge(1., 1., 100., 100., false), None);
        assert_eq!(resize_edge(50., 50., 100., 100., true), None);
        assert_eq!(
            resize_edge(1., 1., 100., 100., true),
            Some(ResizeEdge::TopLeft)
        );
        assert_eq!(
            resize_edge(99., 50., 100., 100., true),
            Some(ResizeEdge::Right)
        );
        assert_eq!(
            cursor_shape("text", resize_edge(99., 99., 100., 100., true)),
            CursorShape::SizeNWSE
        );
    }

    #[test]
    fn css_cursors_map_to_system_cursors() {
        assert_eq!(cursor_shape("pointer", None), CursorShape::Hand);
        assert_eq!(cursor_shape("text", None), CursorShape::IBeam);
        assert_eq!(cursor_shape("col-resize", None), CursorShape::SizeWE);
        assert_eq!(cursor_shape("row-resize", None), CursorShape::SizeNS);
        assert_eq!(cursor_shape("whatever", None), CursorShape::Arrow);
    }

    #[test]
    fn real_binaries_win_over_earlier_shims() {
        let dirs = vec![PathBuf::from("/npm"), PathBuf::from("/local")];
        let have = |p: &Path| {
            matches!(
                p.to_str().unwrap(),
                "/npm/claude.cmd" | "/local/claude.exe" | "/npm/codex.cmd" | "/bin/tool.exe"
            )
        };
        assert_eq!(
            resolve_program("claude", &dirs, have),
            Some(PathBuf::from("/local/claude.exe"))
        );
        assert_eq!(
            resolve_program("codex", &dirs, have),
            Some(PathBuf::from("/npm/codex.cmd"))
        );
        assert_eq!(resolve_program("missing", &dirs, have), None);
        assert_eq!(
            resolve_program("/bin/tool", &dirs, have),
            Some(PathBuf::from("/bin/tool.exe"))
        );
        assert_eq!(
            resolve_program("/bin/tool.exe", &dirs, have),
            Some(PathBuf::from("/bin/tool.exe"))
        );
        assert_eq!(
            resolve_program("claude.cmd", &dirs, have),
            Some(PathBuf::from("/npm/claude.cmd"))
        );
    }

    #[test]
    fn a_user_initiated_resume_is_one_wake() {
        let (sleep, s) = power_transition(false, PowerEvent::Suspend);
        assert_eq!((sleep, s), (Some(true), true));
        let (wake, s) = power_transition(s, PowerEvent::ResumeAutomatic);
        assert_eq!((wake, s), (Some(false), false));
        assert_eq!(
            power_transition(s, PowerEvent::ResumeSuspend),
            (None, false)
        );
        // Suspend missed: the automatic resume still reports a wake.
        assert_eq!(
            power_transition(false, PowerEvent::ResumeAutomatic),
            (Some(false), false)
        );
    }
}
