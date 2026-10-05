//! Pure decisions for the Windows adapter, over plain values only.
//!
//! Nothing in this file touches Win32: every function takes booleans, sizes, strings or
//! style bits that the adapter has already read, so the rules can be unit-tested on any
//! host (`cargo test` on macOS included, by `#[path]`-including this file) and so the
//! *semantic* window rules the plan keeps shared (§3.1: "has title, user-visible, not our
//! own, minimum size") are written once, not re-derived inside an `EnumWindows` callback.
use std::path::{Path, PathBuf};

/// Smallest window a reader could plausibly be reading. Same thresholds as the macOS
/// adapter (`readable_window`): anything smaller is a toolbar, HUD strip or helper.
pub const MIN_WIDTH: f64 = 80.;
pub const MIN_HEIGHT: f64 = 60.;

/// `WS_EX_TOOLWINDOW`.
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
/// `WS_EX_APPWINDOW`.
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;

/// Window classes that are the shell itself rather than an application window: the
/// desktop (`Progman`, `WorkerW`) and the hosts of UWP shell surfaces, which are visible,
/// titled and uncloaked while being nothing a reader opened.
pub const SHELL_CLASSES: [&str; 3] = ["Progman", "WorkerW", "Windows.UI.Core.CoreWindow"];

/// Geometry that could be a document rather than a framework surface.
pub fn sized(width: f64, height: f64) -> bool {
    width.is_finite() && height.is_finite() && width >= MIN_WIDTH && height >= MIN_HEIGHT
}

/// Whether the extended style marks a window as a tool window for the taskbar and
/// Alt+Tab. `WS_EX_APPWINDOW` overrides `WS_EX_TOOLWINDOW` there, so it does here too.
pub fn is_tool_window(ex_style: u32) -> bool {
    ex_style & WS_EX_TOOLWINDOW != 0 && ex_style & WS_EX_APPWINDOW == 0
}

/// On screen as far as a person is concerned: shown, not minimised, not cloaked by DWM
/// (a suspended UWP app or a window on another virtual desktop is "visible" to USER but
/// cloaked), and big enough to be read.
pub fn on_screen(visible: bool, iconic: bool, cloaked: bool, width: f64, height: f64) -> bool {
    visible && !iconic && !cloaked && sized(width, height)
}

/// Could a reader be looking at this window? The shared semantic rule: a non-empty
/// title, visible, uncloaked, at least 80x60, and not a tool window.
///
/// The title requirement mirrors the macOS picker: untitled top-level windows are
/// overwhelmingly framework helper surfaces (IME windows, GPU/broker hosts, splash
/// remnants). They remain capturable by id; they just do not belong in a list.
pub fn readable_window(
    title: &str,
    visible: bool,
    cloaked: bool,
    tool_window: bool,
    width: f64,
    height: f64,
) -> bool {
    !title.trim().is_empty() && visible && !cloaked && !tool_window && sized(width, height)
}

/// Everything the picker knows about one top-level window, already read from Win32.
#[derive(Clone, Debug)]
pub struct WindowFacts<'a> {
    pub title: &'a str,
    pub class: &'a str,
    pub ex_style: u32,
    pub visible: bool,
    pub cloaked: bool,
    /// `GetWindow(GW_OWNER)` is non-null: a dialog, palette or popup of another window.
    pub owned: bool,
    pub pid: u32,
    pub width: f64,
    pub height: f64,
}

/// The source picker's rule: readable, unowned, not ours, not the shell.
///
/// A minimised window is listed (it is still a window the reader can pick and restore),
/// unlike `on_screen`, which is about whether its text can be shown right now. Its
/// extended frame bounds are the restored size only when DWM reports them, so a minimised
/// window whose bounds collapsed to the iconic placeholder fails the size test, which is
/// acceptable: it reappears on the next refresh once restored.
pub fn picker_window_eligible(w: &WindowFacts<'_>, own_pid: u32) -> bool {
    w.pid != own_pid
        && !w.owned
        && !SHELL_CLASSES.contains(&w.class)
        && readable_window(
            w.title,
            w.visible,
            w.cloaked,
            is_tool_window(w.ex_style),
            w.width,
            w.height,
        )
}

/// The wire form of a window or monitor handle: upper-case hex with a `0x` prefix,
/// byte-identical to capture-core's `windows::hex_handle`, because ids from the picker,
/// the capture backend and `front_window` are compared as strings.
///
/// Handles are pointer-sized and must never round-trip through a JavaScript number, so
/// the id carries them as a string (see `kimochi_capture::ids`).
pub fn format_handle(raw: usize) -> String {
    format!("0x{raw:X}")
}

/// Inverse of `format_handle`. Accepts either case and an optional `0x`/`0X` prefix (ids
/// written by hand or by another tool), rejects zero, which is never a live handle.
pub fn parse_handle(s: &str) -> Option<usize> {
    let digits = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if digits.is_empty() {
        return None;
    }
    usize::from_str_radix(digits, 16).ok().filter(|v| *v != 0)
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
    fn a_titled_visible_window_of_reading_size_is_readable() {
        assert!(readable_window("Game", true, false, false, 1280., 720.));
        assert!(readable_window("Game", true, false, false, 80., 60.));
    }

    #[test]
    fn untitled_hidden_cloaked_tool_or_tiny_windows_are_not() {
        assert!(!readable_window("", true, false, false, 1280., 720.));
        assert!(!readable_window("   ", true, false, false, 1280., 720.));
        assert!(!readable_window("Game", false, false, false, 1280., 720.));
        assert!(!readable_window("Game", true, true, false, 1280., 720.));
        assert!(!readable_window("Game", true, false, true, 1280., 720.));
        assert!(!readable_window("Game", true, false, false, 79., 720.));
        assert!(!readable_window("Game", true, false, false, 1280., 59.));
        assert!(!readable_window("Game", true, false, false, f64::NAN, 720.));
        assert!(!readable_window(
            "Game",
            true,
            false,
            false,
            1280.,
            f64::INFINITY
        ));
    }

    #[test]
    fn app_window_overrides_tool_window() {
        assert!(is_tool_window(WS_EX_TOOLWINDOW));
        assert!(!is_tool_window(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW));
        assert!(!is_tool_window(0));
    }

    fn facts<'a>(title: &'a str, class: &'a str) -> WindowFacts<'a> {
        WindowFacts {
            title,
            class,
            ex_style: 0,
            visible: true,
            cloaked: false,
            owned: false,
            pid: 2,
            width: 800.,
            height: 600.,
        }
    }

    #[test]
    fn picker_keeps_normal_windows_and_rejects_ours_owned_and_shell() {
        assert!(picker_window_eligible(&facts("Notepad", "Notepad"), 1));
        assert!(!picker_window_eligible(&facts("Notepad", "Notepad"), 2));
        assert!(!picker_window_eligible(
            &WindowFacts {
                owned: true,
                ..facts("Find", "#32770")
            },
            1
        ));
        for class in SHELL_CLASSES {
            assert!(!picker_window_eligible(&facts("Program Manager", class), 1));
        }
        assert!(!picker_window_eligible(
            &WindowFacts {
                ex_style: WS_EX_TOOLWINDOW,
                ..facts("Palette", "X")
            },
            1
        ));
        assert!(picker_window_eligible(
            &WindowFacts {
                ex_style: WS_EX_TOOLWINDOW | WS_EX_APPWINDOW,
                ..facts("Launcher", "X")
            },
            1
        ));
    }

    #[test]
    fn on_screen_excludes_minimised_and_cloaked() {
        assert!(on_screen(true, false, false, 800., 600.));
        assert!(!on_screen(true, true, false, 800., 600.));
        assert!(!on_screen(true, false, true, 800., 600.));
        assert!(!on_screen(false, false, false, 800., 600.));
    }

    #[test]
    fn handles_round_trip_as_capture_core_hex() {
        assert_eq!(format_handle(0x001A_0B2C), "0x1A0B2C");
        assert_eq!(format_handle(0x10001), "0x10001");
        assert_eq!(parse_handle("0xa0b2c"), Some(0xA0B2C));
        assert_eq!(parse_handle("0x000A0B2C"), Some(0xA0B2C));
        assert_eq!(parse_handle("A0B2C"), Some(0xA0B2C));
        assert_eq!(parse_handle(&format_handle(usize::MAX)), Some(usize::MAX));
        assert_eq!(parse_handle("0x0"), None);
        assert_eq!(parse_handle("0x"), None);
        assert_eq!(parse_handle(""), None);
        assert_eq!(parse_handle("0xnothex"), None);
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
