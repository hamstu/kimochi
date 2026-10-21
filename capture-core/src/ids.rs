//! Source identifiers: one codec for every platform.
//!
//! A source id is an opaque string on the wire (settings, UI, Tauri commands). This
//! module is the only place that knows its shape. Rust code never `strip_prefix`es a
//! platform name and JavaScript never manufactures one: the native side hands the UI
//! complete ids (for example on `DisplayInfo`) and the UI hands them back unchanged.
//!
//! Wire format, kept byte-compatible with what macOS has saved since the first build:
//!
//! ```text
//! {platform}:display:{handle}
//! {platform}:window:{handle}:{pid}
//! ```
//!
//! `platform` is `macos`, `windows`, `x11`, `portal` or `gamescope`. `handle` is whatever the
//! backend needs to find the source again *within one desktop session* (a
//! `CGWindowID`, an `HWND` in hex, an X11 window id, a PipeWire node): it is a string
//! here because handles are pointer-sized on Windows and must never round-trip through
//! a JavaScript number. `pid` is the owning process, used for focus and activation.
use std::fmt;

/// Which operating-system backend minted an id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    MacOs,
    Windows,
    X11,
    Portal,
    /// Gamescope's own PipeWire stream (Steam Deck Gaming Mode), one app at a time.
    Gamescope,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::MacOs => "macos",
            Platform::Windows => "windows",
            Platform::X11 => "x11",
            Platform::Portal => "portal",
            Platform::Gamescope => "gamescope",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "macos" => Platform::MacOs,
            "windows" => Platform::Windows,
            "x11" => Platform::X11,
            "portal" => Platform::Portal,
            "gamescope" => Platform::Gamescope,
            _ => return None,
        })
    }

    /// The backend that this build captures with. Ids from another platform are valid
    /// strings (a settings file can travel between machines) but resolve to nothing.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::MacOs
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            // Linux decides at runtime: a Wayland session captures through the portal,
            // anything else through X11. Read once; the session does not change.
            static LINUX: std::sync::OnceLock<Platform> = std::sync::OnceLock::new();
            *LINUX.get_or_init(|| {
                let session = std::env::var("XDG_SESSION_TYPE").ok();
                let wayland = std::env::var("WAYLAND_DISPLAY").ok();
                #[cfg(target_os = "linux")]
                let gdk_backend = std::env::var("GDK_BACKEND").ok();
                #[cfg(not(target_os = "linux"))]
                let gdk_backend: Option<String> = None;
                #[cfg(target_os = "linux")]
                if crate::linux_x11::gamescope_portal_now() {
                    return if crate::linux_gamescope::available() {
                        Platform::Gamescope
                    } else {
                        Platform::Portal
                    };
                }
                if crate::linux_x11::is_wayland_session(
                    session.as_deref(),
                    wayland.as_deref(),
                    gdk_backend.as_deref(),
                ) {
                    Platform::Portal
                } else {
                    Platform::X11
                }
            })
        }
    }
}

/// A parsed source id.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SourceId {
    Display {
        platform: Platform,
        handle: String,
    },
    Window {
        platform: Platform,
        handle: String,
        pid: Option<u32>,
    },
}

impl SourceId {
    pub fn display(platform: Platform, handle: impl fmt::Display) -> Self {
        SourceId::Display {
            platform,
            handle: handle.to_string(),
        }
    }

    pub fn window(platform: Platform, handle: impl fmt::Display, pid: u32) -> Self {
        SourceId::Window {
            platform,
            handle: handle.to_string(),
            pid: Some(pid),
        }
    }

    /// `None` for anything that is not a well-formed id. Callers must treat that as
    /// "unknown source", never as "a display" (see `source_focus`).
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.splitn(4, ':');
        let platform = Platform::parse(parts.next()?)?;
        let kind = parts.next()?;
        let handle = parts.next().filter(|h| !h.is_empty())?;
        match kind {
            "display" => {
                if parts.next().is_some() {
                    return None;
                }
                Some(SourceId::Display {
                    platform,
                    handle: handle.to_string(),
                })
            }
            "window" => {
                let pid = match parts.next() {
                    Some(p) if !p.is_empty() => Some(p.parse().ok()?),
                    Some(_) => return None,
                    None => None,
                };
                Some(SourceId::Window {
                    platform,
                    handle: handle.to_string(),
                    pid,
                })
            }
            _ => None,
        }
    }

    pub fn platform(&self) -> Platform {
        match self {
            SourceId::Display { platform, .. } | SourceId::Window { platform, .. } => *platform,
        }
    }

    pub fn is_window(&self) -> bool {
        matches!(self, SourceId::Window { .. })
    }

    pub fn is_display(&self) -> bool {
        matches!(self, SourceId::Display { .. })
    }

    /// The raw handle string.
    pub fn handle(&self) -> &str {
        match self {
            SourceId::Display { handle, .. } | SourceId::Window { handle, .. } => handle,
        }
    }

    /// The handle as a number, for backends whose handles are decimal integers
    /// (CoreGraphics window and display ids, X11 window ids).
    pub fn handle_u32(&self) -> Option<u32> {
        self.handle().parse().ok()
    }

    /// The owning process of a window source.
    pub fn pid(&self) -> Option<u32> {
        match self {
            SourceId::Window { pid, .. } => *pid,
            SourceId::Display { .. } => None,
        }
    }

    /// Whether this build's backend can resolve the id.
    pub fn is_local(&self) -> bool {
        self.platform() == Platform::current()
    }
}

impl fmt::Display for SourceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceId::Display { platform, handle } => {
                write!(f, "{}:display:{handle}", platform.as_str())
            }
            SourceId::Window {
                platform,
                handle,
                pid: Some(pid),
            } => write!(f, "{}:window:{handle}:{pid}", platform.as_str()),
            SourceId::Window {
                platform,
                handle,
                pid: None,
            } => write!(f, "{}:window:{handle}", platform.as_str()),
        }
    }
}

/// Convenience: the window handle of a *local* window id, as the number the macOS and
/// X11 backends use. This is what the old `window_id_of` did with `strip_prefix`.
pub fn local_window_number(id: &str) -> Option<u32> {
    let parsed = SourceId::parse(id)?;
    (parsed.is_window() && parsed.is_local())
        .then(|| parsed.handle_u32())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_wire_format_round_trips() {
        for s in ["macos:display:1", "macos:window:15970:56963"] {
            assert_eq!(SourceId::parse(s).unwrap().to_string(), s);
        }
    }

    #[test]
    fn windows_handles_are_strings_not_numbers() {
        let id = SourceId::window(Platform::Windows, "0x000A0B2C", 4242);
        assert_eq!(id.to_string(), "windows:window:0x000A0B2C:4242");
        let back = SourceId::parse("windows:window:0x000A0B2C:4242").unwrap();
        assert_eq!(back.handle(), "0x000A0B2C");
        assert_eq!(back.handle_u32(), None);
        assert_eq!(back.pid(), Some(4242));
    }

    #[test]
    fn malformed_ids_are_unknown_not_displays() {
        for s in [
            "",
            "macos",
            "macos:display",
            "macos:display:",
            "macos:window:",
            "macos:window:1:not-a-pid",
            "macos:display:1:extra",
            "amiga:display:1",
            "macos:screen:1",
        ] {
            assert_eq!(SourceId::parse(s), None, "{s:?}");
        }
        // Digits are only required where a backend requires them: the parser is
        // platform-agnostic, the backend checks `handle_u32`.
        let odd = SourceId::parse("macos:window:not-a-number:1").unwrap();
        assert_eq!(odd.handle_u32(), None);
        assert_eq!(local_window_number("macos:window:not-a-number:1"), None);
    }

    #[test]
    fn window_number_helper_matches_old_window_id_of() {
        let expect = if Platform::current() == Platform::MacOs {
            Some(15970)
        } else {
            None
        };
        assert_eq!(local_window_number("macos:window:15970:56963"), expect);
        assert_eq!(local_window_number("macos:display:1"), None);
        assert_eq!(local_window_number("macos:window:"), None);
        assert_eq!(local_window_number("macos:window:not-a-number:1"), None);
    }

    #[test]
    fn pid_is_optional_on_window_ids() {
        let id = SourceId::parse("x11:window:0x3a00004").unwrap();
        assert!(id.is_window());
        assert_eq!(id.pid(), None);
        assert_eq!(id.to_string(), "x11:window:0x3a00004");
    }
}
