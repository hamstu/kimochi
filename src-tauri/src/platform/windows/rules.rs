//! Pure decisions for the Windows adapter, over plain values only.
//!
//! Nothing in this file touches Win32: every function takes booleans, sizes, strings or
//! style bits that the adapter has already read, so the rules can be unit-tested on any
//! host (`cargo test` on macOS included, by `#[path]`-including this file) and so the
//! *semantic* window rules the plan keeps shared (§3.1: "has title, user-visible, not our
//! own, minimum size") are written once, not re-derived inside an `EnumWindows` callback.
//! The listing rule itself and handle spelling live in `kimochi_capture::win_rules`.
use std::path::{Path, PathBuf};

/// Fullscreen coverage in physical pixels, including windows spanning monitors.
/// A maximized window ending at the work area (above the taskbar) is not fullscreen.
pub fn covers_display(window: kimochi_capture::Rect, display: kimochi_capture::Rect) -> bool {
    window.width > 0.
        && window.height > 0.
        && display.width > 0.
        && display.height > 0.
        && window.x <= display.x
        && window.y <= display.y
        && window.x + window.width >= display.x + display.width
        && window.y + window.height >= display.y + display.height
}

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
    fn fullscreen_covers_physical_monitor_not_just_work_area() {
        use kimochi_capture::Rect;
        let monitor = Rect {
            x: -1920.,
            y: 0.,
            width: 1920.,
            height: 1080.,
        };
        assert!(covers_display(monitor, monitor));
        assert!(covers_display(
            Rect {
                width: 3840.,
                ..monitor
            },
            monitor
        ));
        assert!(!covers_display(
            Rect {
                height: 1040.,
                ..monitor
            },
            monitor
        ));
        assert!(!covers_display(Rect { x: 0., ..monitor }, monitor));
        assert!(!covers_display(
            Rect {
                width: 0.,
                ..monitor
            },
            monitor
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
    fn image_stem_handles_windows_paths_on_any_host() {
        assert_eq!(image_stem(r"C:\Program Files\Foo\Foo.Bar.exe"), "Foo.Bar");
        assert_eq!(image_stem(r"C:\x\notepad.exe"), "notepad");
        assert_eq!(image_stem("kimochi.exe"), "kimochi");
        assert_eq!(image_stem("noext"), "noext");
        assert_eq!(image_stem(".hidden"), ".hidden");
        assert_eq!(image_stem(""), "");
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
