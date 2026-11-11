//! Wayland capture without the system picker: the compositor's own screencast API, by window
//! identity, the way Windows Graphics Capture takes an HWND and ScreenCaptureKit a window id.
//!
//! **Why.** The ScreenCast portal shows the desktop's own dialog, then hands back an anonymous
//! PipeWire node: nothing says which window it is, where it is, or whether it is in front, so the
//! app guessed by size and asked the reader to click "the matching window" when it could not. A
//! compositor's own API knows all of that, and so does Kimochi when it captures through it.
//!
//! **Drivers** (one per compositor family, chosen once by [`init`]):
//!
//! | Driver | Compositors | Inventory | Capture |
//! |---|---|---|---|
//! | [`mutter`] | GNOME Shell | Kimochi's Shell extension (`MetaWindow` ids) | `org.gnome.Mutter.ScreenCast` `RecordWindow`/`RecordMonitor` → PipeWire |
//! | [`kwin`] | KDE Plasma 6 | `org_kde_plasma_window_management` (uuids) | `zkde_screencast_unstable_v1` → PipeWire |
//! | [`ext`] | Hyprland, Sway, COSMIC, other wlroots-likes | `ext_foreign_toplevel_list_v1` (+ compositor IPC for geometry) | `ext_image_copy_capture_v1` (SHM, in process) |
//!
//! Every driver publishes frames into the same mailbox as the portal ([`Slot`]), so capturing is
//! the same newest-frame copy everywhere. When no driver works (another compositor, KDE without
//! the screencast authorization, GNOME without the extension) the app keeps the portal.
//!
//! **Ids.** `wayland:window:{handle}:{pid}` and `wayland:display:{output}`, through the shared
//! [`SourceId`] codec. `handle` is the compositor's own id (Mutter's window id, KWin's uuid, the
//! ext identifier hex-encoded when it would contain `:`), valid for the session.
//!
//! **Coordinates.** [`NativeWindow::bounds`] and [`NativeOutput::bounds`] are the compositor's
//! global logical coordinates, which is what `Source.bounds` and `FrameInfo.source_bounds` carry.
//! The app maps them onto its layer-shell overlay's output.
//!
//! **Streams.** A source's stream opens on its first capture or thumbnail and stays open while it
//! is used: the reader's source for [`KEEP_CAPTURE`] after its last capture, a picker thumbnail
//! for [`KEEP_THUMBNAIL`]. Captures copy the newest frame, never wait for a new one (except
//! [`CaptureBackend::capture_after`]), so a scan costs one copy.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::{Platform, Rect, Source, SourceId};
use serde::Serialize;

#[cfg(target_os = "linux")]
pub mod ext;
#[cfg(target_os = "linux")]
pub mod kwin;
#[cfg(target_os = "linux")]
pub mod mutter;
#[cfg(target_os = "linux")]
mod backend;
#[cfg(target_os = "linux")]
pub use backend::{activate, driver, driver_name, init, inventory, report, Driver, Feed, NativeCapture, Target};
#[cfg(target_os = "linux")]
pub(crate) use backend::pipewire_feed;

/// How long the reader's source stream stays open after its last capture.
pub const KEEP_CAPTURE: std::time::Duration = std::time::Duration::from_secs(90);
/// How long a stream opened only for a picker thumbnail stays open.
pub const KEEP_THUMBNAIL: std::time::Duration = std::time::Duration::from_secs(6);

/// One top-level window, as the compositor describes it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NativeWindow {
    /// The compositor's own id for the window (never contains `:`).
    pub handle: String,
    pub title: String,
    /// The app's id: its desktop file id where the compositor knows it (`org.gnome.Nautilus`),
    /// else its Wayland `app_id` or X11 class.
    pub app_id: Option<String>,
    /// A human name for the app, when the compositor has one.
    pub app_name: Option<String>,
    pub pid: Option<u32>,
    /// What the window's stream shows, in global logical coordinates, when the compositor says.
    pub bounds: Option<Rect>,
    /// The output (connector name) the window is mostly on.
    pub output: Option<String>,
    pub minimized: bool,
    /// On the current workspace, mapped and not minimized. `None`: the compositor cannot say.
    pub on_screen: Option<bool>,
    pub focused: bool,
    /// A dialog, tooltip, panel or similar that is no capture source on its own.
    pub auxiliary: bool,
}

/// One output (monitor).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NativeOutput {
    /// Connector name (`DP-1`, `eDP-1`, `Virtual-1`), unique for the session.
    pub handle: String,
    /// What to call it: the make and model when known, else the connector.
    pub name: String,
    /// Global logical coordinates.
    pub bounds: Rect,
    /// Physical pixels per logical pixel.
    pub scale: f64,
    pub primary: bool,
}

/// What is on the desktop now. Windows are front to back where the compositor says so.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Inventory {
    pub windows: Vec<NativeWindow>,
    pub outputs: Vec<NativeOutput>,
}

impl Inventory {
    pub fn window(&self, handle: &str) -> Option<&NativeWindow> {
        self.windows.iter().find(|w| w.handle == handle)
    }
    pub fn output(&self, handle: &str) -> Option<&NativeOutput> {
        self.outputs.iter().find(|o| o.handle == handle)
    }
    pub fn focused(&self) -> Option<&NativeWindow> {
        self.windows.iter().find(|w| w.focused)
    }
}

/// The id of a window source.
pub fn window_source_id(window: &NativeWindow) -> String {
    SourceId::Window {
        platform: Platform::Wayland,
        handle: window.handle.clone(),
        pid: window.pid,
    }
    .to_string()
}

/// The id of an output source.
pub fn output_source_id(output: &NativeOutput) -> String {
    SourceId::display(Platform::Wayland, &output.handle).to_string()
}

/// Whether `id` is a native Wayland source (either kind).
pub fn is_native_id(id: &str) -> bool {
    SourceId::parse(id).is_some_and(|id| id.platform() == Platform::Wayland)
}

/// The window handle a native window id names.
pub fn window_handle(id: &str) -> Option<String> {
    SourceId::parse(id)
        .filter(|id| id.platform() == Platform::Wayland && id.is_window())
        .map(|id| id.handle().to_string())
}

/// The output handle a native display id names.
pub fn output_handle(id: &str) -> Option<String> {
    SourceId::parse(id)
        .filter(|id| id.platform() == Platform::Wayland && id.is_display())
        .map(|id| id.handle().to_string())
}

/// A handle safe for the id codec: unchanged when it has no `:` and is not empty, else `x`
/// followed by its bytes in hex. Drivers whose ids are arbitrary strings (ext identifiers)
/// pass them through this; [`decode_handle`] reverses it.
pub fn encode_handle(raw: &str) -> String {
    if !raw.is_empty() && !raw.contains(':') && !raw.starts_with('x') {
        raw.to_string()
    } else {
        let mut out = String::with_capacity(1 + raw.len() * 2);
        out.push('x');
        for b in raw.bytes() {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }
}

pub fn decode_handle(handle: &str) -> Option<String> {
    let Some(hex) = handle.strip_prefix('x') else {
        return Some(handle.to_string());
    };
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

/// The catalog the picker shows: outputs, then the windows a reader would pick (not our own,
/// not dialogs and panels). Front-to-back order is kept; the app sorts for display.
pub fn sources(inventory: &Inventory, own_pid: u32) -> Vec<Source> {
    let displays = inventory.outputs.iter().map(|o| Source {
        id: output_source_id(o),
        kind: "display",
        name: o.name.clone(),
        app: None,
        bounds: Some(o.bounds),
        on_screen: Some(true),
    });
    let windows = inventory
        .windows
        .iter()
        .filter(|w| !w.auxiliary && w.pid != Some(own_pid))
        .map(|w| Source {
            id: window_source_id(w),
            kind: "window",
            name: if w.title.trim().is_empty() {
                w.app_name.clone().or_else(|| w.app_id.clone()).unwrap_or_else(|| "Window".into())
            } else {
                w.title.clone()
            },
            app: w.app_name.clone().or_else(|| w.app_id.clone()),
            bounds: w.bounds,
            on_screen: w.on_screen,
        });
    displays.chain(windows).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(handle: &str, pid: u32) -> NativeWindow {
        NativeWindow {
            handle: handle.into(),
            title: "Game".into(),
            app_id: Some("org.example.Game".into()),
            app_name: Some("Game".into()),
            pid: Some(pid),
            bounds: Some(Rect { x: 10.0, y: 20.0, width: 640.0, height: 480.0 }),
            output: Some("DP-1".into()),
            minimized: false,
            on_screen: Some(true),
            focused: false,
            auxiliary: false,
        }
    }

    #[test]
    fn ids_round_trip_through_the_codec() {
        let w = window("123456", 42);
        let id = window_source_id(&w);
        assert_eq!(id, "wayland:window:123456:42");
        assert!(is_native_id(&id));
        assert_eq!(window_handle(&id).as_deref(), Some("123456"));
        assert_eq!(output_handle(&id), None);
        let o = NativeOutput {
            handle: "DP-1".into(),
            name: "Dell".into(),
            bounds: Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 },
            scale: 1.0,
            primary: true,
        };
        assert_eq!(output_source_id(&o), "wayland:display:DP-1");
        assert_eq!(output_handle("wayland:display:DP-1").as_deref(), Some("DP-1"));
        assert!(!is_native_id("portal:window:7"));
    }

    #[test]
    fn handles_with_colons_are_encoded_reversibly() {
        for raw in ["abc", "a:b", "", "x12", "0xaaaa:1", "日本"] {
            let enc = encode_handle(raw);
            assert!(!enc.contains(':') && !enc.is_empty(), "{raw} → {enc}");
            assert_eq!(decode_handle(&enc).as_deref(), Some(raw));
        }
        assert_eq!(encode_handle("{1c2f-aa}"), "{1c2f-aa}");
    }

    #[test]
    fn catalog_skips_own_and_auxiliary_windows() {
        let mut aux = window("2", 7);
        aux.auxiliary = true;
        let mut untitled = window("3", 8);
        untitled.title = " ".into();
        let inv = Inventory { windows: vec![window("1", 99), aux, untitled, window("4", 9)], outputs: vec![] };
        let s = sources(&inv, 99);
        let ids: Vec<_> = s.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["wayland:window:3:8", "wayland:window:4:9"]);
        assert_eq!(s[0].name, "Game");
        assert_eq!(s[0].app.as_deref(), Some("Game"));
    }
}
