//! Which Windows top-level windows are sources, and how Windows handles are spelled in
//! ids: the one copy of these rules, shared by the WGC backend (`windows.rs`) and the
//! app's Windows platform adapter (`src-tauri/src/platform/windows`).
//!
//! Pure functions over plain values (no `windows` crate types), compiled on every OS so
//! the rules are unit-tested on any development machine.

/// `WS_EX_TOOLWINDOW`: palettes and floating tool windows, kept out of the taskbar.
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
/// `WS_EX_APPWINDOW`: forces a window onto the taskbar, even a tool window.
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;

/// Smallest window worth listing, in physical pixels. Same thresholds as the macOS
/// adapter: anything smaller is a toolbar, HUD strip or helper.
pub const MIN_WIDTH: f64 = 80.;
pub const MIN_HEIGHT: f64 = 60.;

/// Window classes that are the shell itself rather than an application window: the
/// desktop (`Progman`, `WorkerW`), the taskbars, and the host of UWP shell surfaces,
/// which are visible, titled and uncloaked while being nothing a reader opened.
pub const SHELL_CLASSES: [&str; 5] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
];

/// The frame that hosts a UWP app. With a title it is the app; untitled it is an empty
/// frame (a suspended or closing app) with nothing to read.
pub const APPLICATION_FRAME_CLASS: &str = "ApplicationFrameWindow";

/// Everything the listing rule needs about one top-level window, already read from
/// Win32 by the caller.
#[derive(Clone, Debug)]
pub struct WindowMeta<'a> {
    /// `IsWindowVisible`.
    pub visible: bool,
    /// `IsIconic`: minimised. Its rectangle is then the iconic placeholder.
    pub iconic: bool,
    /// `DWMWA_CLOAKED != 0`: suspended UWP apps, windows on other virtual desktops.
    pub cloaked: bool,
    /// `GetWindow(GW_OWNER)` is non-null: a dialog, palette or popup of another window.
    pub has_owner: bool,
    /// `WS_EX_TOOLWINDOW` is set.
    pub tool_window: bool,
    /// `WS_EX_APPWINDOW` is set (overrides `tool_window`, as for the taskbar).
    pub app_window: bool,
    /// The window text is not empty or whitespace.
    pub title_nonempty: bool,
    pub class_name: &'a str,
    pub pid: u32,
    /// This process's id: our own windows are never sources.
    pub own_pid: u32,
    /// Visible size (extended frame bounds), physical pixels.
    pub width: f64,
    pub height: f64,
}

impl<'a> WindowMeta<'a> {
    /// Fill `tool_window` / `app_window` from a `GWL_EXSTYLE` value.
    pub fn with_ex_style(mut self, ex_style: u32) -> Self {
        self.tool_window = ex_style & WS_EX_TOOLWINDOW != 0;
        self.app_window = ex_style & WS_EX_APPWINDOW != 0;
        self
    }
}

/// Whether the extended style marks a window as a tool window for the taskbar and
/// Alt+Tab. `WS_EX_APPWINDOW` overrides `WS_EX_TOOLWINDOW` there, so it does here too.
pub fn is_tool_window(ex_style: u32) -> bool {
    ex_style & WS_EX_TOOLWINDOW != 0 && ex_style & WS_EX_APPWINDOW == 0
}

/// Geometry that could be a document rather than a framework surface.
pub fn sized(width: f64, height: f64) -> bool {
    width.is_finite() && height.is_finite() && width >= MIN_WIDTH && height >= MIN_HEIGHT
}

/// A shell surface rather than an application window.
pub fn is_shell_surface(class_name: &str, title_nonempty: bool) -> bool {
    SHELL_CLASSES.contains(&class_name)
        || (class_name == APPLICATION_FRAME_CLASS && !title_nonempty)
}

/// Whether a top-level window belongs in the source list: the windows the taskbar and
/// Alt+Tab would show, minus this app's own, the shell, and anything too small to read.
///
/// The title requirement mirrors the macOS picker: untitled top-level windows are
/// overwhelmingly framework helper surfaces. They remain capturable by id.
///
/// Minimised windows are listed (as off screen, like macOS lists windows on other
/// Spaces); their rectangle is the iconic placeholder, so size is not judged. Callers
/// report such a window with `bounds: None` and `on_screen: Some(false)`.
pub fn listable(w: &WindowMeta<'_>) -> bool {
    if !w.visible || w.cloaked || w.has_owner || w.pid == w.own_pid || !w.title_nonempty {
        return false;
    }
    if is_shell_surface(w.class_name, w.title_nonempty) {
        return false;
    }
    if w.tool_window && !w.app_window {
        return false;
    }
    w.iconic || sized(w.width, w.height)
}

/// An `HWND` or `HMONITOR` as an id handle: upper-case hex with a `0x` prefix. Ids from
/// the picker, the capture backend and `front_window` are compared as strings, so this
/// is the only place the spelling is decided. Handles are pointer-sized, so they never
/// travel as numbers (see `ids.rs`).
pub fn hex_handle(raw: usize) -> String {
    format!("0x{raw:X}")
}

/// The inverse of `hex_handle`. Accepts either case of digits and prefix; requires the
/// prefix; rejects zero, which is never a live handle.
pub fn parse_hex_handle(s: &str) -> Option<usize> {
    let digits = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if digits.is_empty() || digits.len() > 16 {
        return None;
    }
    usize::from_str_radix(digits, 16).ok().filter(|&v| v != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta<'a>() -> WindowMeta<'a> {
        WindowMeta {
            visible: true,
            iconic: false,
            cloaked: false,
            has_owner: false,
            tool_window: false,
            app_window: false,
            title_nonempty: true,
            class_name: "VNWindowClass",
            pid: 4242,
            own_pid: 1,
            width: 1280.,
            height: 720.,
        }
    }

    #[test]
    fn an_ordinary_app_window_is_listed() {
        assert!(listable(&meta()));
        assert!(listable(&WindowMeta {
            width: 80.,
            height: 60.,
            ..meta()
        }));
    }

    #[test]
    fn hidden_untitled_owned_cloaked_and_own_windows_are_not() {
        let cases: [(&str, WindowMeta); 5] = [
            (
                "invisible",
                WindowMeta {
                    visible: false,
                    ..meta()
                },
            ),
            (
                "untitled",
                WindowMeta {
                    title_nonempty: false,
                    ..meta()
                },
            ),
            (
                "owned",
                WindowMeta {
                    has_owner: true,
                    ..meta()
                },
            ),
            (
                "cloaked",
                WindowMeta {
                    cloaked: true,
                    ..meta()
                },
            ),
            ("ours", WindowMeta { pid: 1, ..meta() }),
        ];
        for (label, w) in cases {
            assert!(!listable(&w), "{label}");
        }
    }

    #[test]
    fn shell_surfaces_are_not_listed() {
        for class in SHELL_CLASSES {
            assert!(
                !listable(&WindowMeta {
                    class_name: class,
                    ..meta()
                }),
                "{class}"
            );
        }
        let frame = WindowMeta {
            class_name: APPLICATION_FRAME_CLASS,
            ..meta()
        };
        assert!(listable(&frame), "a titled UWP frame is the app");
        assert!(!listable(&WindowMeta {
            title_nonempty: false,
            ..frame
        }));
        assert!(is_shell_surface(APPLICATION_FRAME_CLASS, false));
        assert!(!is_shell_surface(APPLICATION_FRAME_CLASS, true));
    }

    #[test]
    fn tool_windows_need_app_window_to_be_listed() {
        assert!(!listable(&meta().with_ex_style(WS_EX_TOOLWINDOW)));
        assert!(listable(
            &meta().with_ex_style(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW)
        ));
        assert!(is_tool_window(WS_EX_TOOLWINDOW));
        assert!(!is_tool_window(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW));
        assert!(!is_tool_window(0));
    }

    #[test]
    fn tiny_windows_are_skipped_unless_minimized() {
        assert!(!listable(&WindowMeta {
            width: 79.,
            ..meta()
        }));
        assert!(!listable(&WindowMeta {
            height: 59.,
            ..meta()
        }));
        assert!(!listable(&WindowMeta {
            width: f64::NAN,
            ..meta()
        }));
        assert!(!listable(&WindowMeta {
            height: f64::INFINITY,
            ..meta()
        }));
        // The iconic placeholder rectangle is tiny; that is not the window's size.
        let iconic = WindowMeta {
            iconic: true,
            width: 160.,
            height: 28.,
            ..meta()
        };
        assert!(listable(&iconic));
        // Minimised does not excuse a missing title.
        assert!(!listable(&WindowMeta {
            title_nonempty: false,
            ..iconic
        }));
    }

    #[test]
    fn handles_round_trip_through_hex_ids() {
        for raw in [0x1A0B2C_usize, 1, 0x10001, usize::MAX] {
            let s = hex_handle(raw);
            assert!(s.starts_with("0x"));
            assert_eq!(parse_hex_handle(&s), Some(raw));
        }
        assert_eq!(hex_handle(0x001A_0B2C), "0x1A0B2C");
        assert_eq!(hex_handle(0x10001), "0x10001");
        assert_eq!(parse_hex_handle("0xa0b2c"), Some(0xA0B2C));
        assert_eq!(parse_hex_handle("0X000A0B2C"), Some(0xA0B2C));
        let id = crate::SourceId::window(crate::Platform::Windows, hex_handle(0x1A0B2C), 4242);
        assert_eq!(id.to_string(), "windows:window:0x1A0B2C:4242");
        assert_eq!(
            crate::SourceId::display(crate::Platform::Windows, hex_handle(0x10001)).to_string(),
            "windows:display:0x10001"
        );
        for bad in [
            "",
            "0x",
            "1A0B2C",
            "0xZZ",
            "0xnothex",
            "0x0",
            "0x11112222333344445",
        ] {
            assert_eq!(parse_hex_handle(bad), None, "{bad:?}");
        }
    }
}
