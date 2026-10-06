//! Synchronous, UI-independent capture API. Call on a worker, never the UI thread.
//! Frames own their bytes; dropping a frame releases them. A backend may keep a
//! source's capture session running between calls, so later captures are a copy.
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacCapture;
// Compiled everywhere so its pure catalog logic is tested on every machine; the
// WGC backend inside it is Windows-only. Inside, the `windows` crate is `::windows`.
mod windows;
#[cfg(target_os = "windows")]
pub use windows::WgcCapture;
// Compiled everywhere for the same reason; the X11 backend and the shared X11 desktop
// queries inside it are Linux-only.
mod linux_x11;
#[cfg(target_os = "linux")]
pub use linux_x11::{desktop as x11, X11Capture};
pub use linux_x11::{is_wayland_session, wayland_session_now};
// Wayland: xdg-desktop-portal ScreenCast + PipeWire. Its ids, stride-aware conversion
// and restore-token store compile everywhere; the backend is Linux-only.
mod linux_portal;
#[cfg(target_os = "linux")]
pub use linux_portal::PortalCapture;
pub use linux_portal::{set_portal_token_store, MemoryTokenStore, TokenStore, PICKER_TIMEOUT};

pub mod hash;
pub mod ids;
pub mod pixels;
pub mod text;
pub mod win_rules;
pub use hash::{dhash_rgba, hamming};
pub use ids::{Platform, SourceId};
pub use text::{platform_observer, Observation, ObserverStatus, TextLine, TextObserver};

#[derive(Debug, Clone, Serialize)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
}
impl CaptureError {
    pub fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}
pub type Result<T> = std::result::Result<T, CaptureError>;
#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub backend: &'static str,
    pub enumeration: bool,
    pub system_picker_required: bool,
    pub retained_session: bool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Serialize)]
pub struct Source {
    /// Opaque and backend-specific. Session-scoped; never persist across app launches.
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub app: Option<String>,
    /// The platform's global desktop coordinates, top-left origin. Can be negative.
    /// macOS: desktop points. Windows: physical virtual-screen pixels (the app is
    /// Per-Monitor-V2 DPI aware under tao), the visible frame without the invisible
    /// resize borders. X11: desktop units (root pixels / GDK scale), the client area.
    /// Other backends may not disclose global coordinates (e.g. Wayland).
    pub bounds: Option<Rect>,
    pub on_screen: Option<bool>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Crop {
    /// Integer pixels in a saved full-frame reference. Source-relative, top-left.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub reference_width: u32,
    pub reference_height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRequest {
    pub source_id: String,
    pub crop: Option<Crop>,
}
#[derive(Debug, Clone, Serialize)]
pub struct FrameInfo {
    pub source_id: String,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub full_width: u32,
    pub full_height: u32,
    pub crop_pixels: [u32; 4],
    pub scale_factor: f64,
    pub source_bounds: Option<Rect>,
    pub pixel_format: &'static str,
    pub color_space: &'static str,
    pub resolve_ms: f64,
    pub acquisition_ms: f64,
    pub pixels_ms: f64,
    pub total_ms: f64,
}
pub struct Frame {
    pub info: FrameInfo,
    pub pixels: Vec<u8>,
}
impl Frame {
    /// Preview adapter; OCR should borrow `pixels` directly, avoiding PNG entirely.
    pub fn png(&self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, self.info.width, self.info.height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder
                .write_header()
                .map_err(|e| CaptureError::new("encode", e))?;
            writer
                .write_image_data(&self.pixels)
                .map_err(|e| CaptureError::new("encode", e))?;
        }
        Ok(bytes)
    }
}
/// Platform implementations may retain a consent/session handle internally.
/// Picker-based backends (`system_picker_required`, the Wayland portal) open the system
/// picker from `request_permission` and list only what the user shared; they never
/// invent an inventory.
pub trait CaptureBackend: Send {
    fn capabilities(&self) -> Capabilities;
    fn permission(&self) -> &'static str;
    fn request_permission(&self) -> bool;
    fn enumerate(&mut self) -> Result<Vec<Source>>;
    fn capture(&mut self, request: &CaptureRequest) -> Result<Frame>;
    /// The whole source, scaled so its longest edge is at most `edge` pixels. Backends
    /// that can scale while capturing should, rather than capture full size and shrink.
    fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
        let _ = edge;
        self.capture(&CaptureRequest {
            source_id: source_id.to_string(),
            crop: None,
        })
    }
    fn close(&mut self) {}
}
pub fn platform_backend() -> Result<Box<dyn CaptureBackend>> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(MacCapture::new()))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(Box::new(WgcCapture::new()))
    }
    #[cfg(target_os = "linux")]
    {
        if wayland_session_now() {
            Ok(Box::new(PortalCapture::new()))
        } else {
            Ok(Box::new(X11Capture::connect()?))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err(CaptureError::new(
            "unsupported",
            "No capture backend exists for this platform",
        ))
    }
}
pub fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Validate first, scale edges (floor start, ceil end), then crop in owned Rust memory.
pub fn crop_rect(crop: Option<Crop>, width: u32, height: u32) -> Result<[u32; 4]> {
    let Some(c) = crop else {
        return Ok([0, 0, width, height]);
    };
    if c.reference_width == 0
        || c.reference_height == 0
        || c.width == 0
        || c.height == 0
        || c.x
            .checked_add(c.width)
            .is_none_or(|v| v > c.reference_width)
        || c.y
            .checked_add(c.height)
            .is_none_or(|v| v > c.reference_height)
    {
        return Err(CaptureError::new(
            "invalid_crop",
            "Crop must be nonempty and inside its reference image",
        ));
    }
    let x = u64::from(c.x) * u64::from(width) / u64::from(c.reference_width);
    let y = u64::from(c.y) * u64::from(height) / u64::from(c.reference_height);
    let right =
        (u64::from(c.x + c.width) * u64::from(width)).div_ceil(u64::from(c.reference_width));
    let bottom =
        (u64::from(c.y + c.height) * u64::from(height)).div_ceil(u64::from(c.reference_height));
    Ok([x as u32, y as u32, (right - x) as u32, (bottom - y) as u32])
}


#[cfg(target_os = "linux")]
pub use linux_portal::last_portal_pick_error;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retina_reference_scaling() {
        assert_eq!(
            crop_rect(
                Some(Crop {
                    x: 10,
                    y: 20,
                    width: 100,
                    height: 50,
                    reference_width: 500,
                    reference_height: 400
                }),
                1000,
                800
            )
            .unwrap(),
            [20, 40, 200, 100]
        );
    }
    #[test]
    fn rejects_overflow_and_outside_crop() {
        for x in [450, u32::MAX] {
            assert!(crop_rect(
                Some(Crop {
                    x,
                    y: 0,
                    width: 100,
                    height: 50,
                    reference_width: 500,
                    reference_height: 400
                }),
                1000,
                800
            )
            .is_err());
        }
    }
    #[test]
    fn fractional_edges_include_requested_pixels() {
        assert_eq!(
            crop_rect(
                Some(Crop {
                    x: 1,
                    y: 1,
                    width: 1,
                    height: 1,
                    reference_width: 3,
                    reference_height: 3
                }),
                5,
                5
            )
            .unwrap(),
            [1, 1, 3, 3]
        );
    }
}
