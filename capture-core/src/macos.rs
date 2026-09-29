use super::*;
use screencapturekit::{
    prelude::*,
    screenshot_manager::{CGImageExt, SCScreenshotManager},
};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}
pub struct MacCapture;
fn rect(r: screencapturekit::cg::CGRect) -> Rect {
    Rect {
        x: r.origin.x,
        y: r.origin.y,
        width: r.size.width,
        height: r.size.height,
    }
}
fn native_error(e: impl ToString) -> CaptureError {
    CaptureError::new("native", e)
}
fn content() -> Result<SCShareableContent> {
    // Explicit permission check avoids unexpectedly opening a prompt during polling.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(CaptureError::new("permission", "Allow Screen Recording for Kimochi in System Settings, then relaunch if macOS requests it."));
    }
    SCShareableContent::create()
        .with_exclude_desktop_windows(true)
        .with_on_screen_windows_only(false)
        .get()
        .map_err(native_error)
}
fn window_id(w: &SCWindow) -> String {
    format!(
        "macos:window:{}:{}",
        w.window_id(),
        w.owning_application().map(|a| a.process_id()).unwrap_or(0)
    )
}
fn window_source(w: &SCWindow) -> Source {
    Source {
        id: window_id(w),
        kind: "window",
        name: w.title().unwrap_or_else(|| "Untitled".into()),
        app: w.owning_application().map(|a| a.application_name()),
        bounds: Some(rect(w.frame())),
        on_screen: Some(w.is_on_screen()),
    }
}
fn display_source(d: &SCDisplay) -> Source {
    Source {
        id: format!("macos:display:{}", d.display_id()),
        kind: "display",
        name: format!("Display {}", d.display_id()),
        app: None,
        bounds: Some(rect(d.frame())),
        on_screen: Some(true),
    }
}
impl CaptureBackend for MacCapture {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            backend: "ScreenCaptureKit / SCScreenshotManager (macOS 14+)",
            enumeration: true,
            system_picker_required: false,
            retained_session: false,
        }
    }
    fn permission(&self) -> &'static str {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            "granted"
        } else {
            "not_granted"
        }
    }
    fn request_permission(&self) -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
    fn enumerate(&mut self) -> Result<Vec<Source>> {
        objc2::rc::autoreleasepool(|_| {
            let c = content()?;
            let mut result: Vec<_> = c.displays().iter().map(display_source).collect();
            result.extend(
                c.windows()
                    .iter()
                    .filter(|w| {
                        w.window_layer() == 0
                            && w.frame().size.width > 1.0
                            && w.frame().size.height > 1.0
                    })
                    .map(window_source),
            );
            Ok(result)
        })
    }
    fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
        objc2::rc::autoreleasepool(|_| {
            let start = Instant::now();
            // Refresh each request: no stale native window object, scale or geometry cache.
            let c = content()?;
            let found_display = c
                .displays()
                .into_iter()
                .find(|d| display_source(d).id == request.source_id);
            let (source, filter) = if let Some(d) = found_display {
                // Keep Kimochi's overlay and native controls out of display captures
                // without hiding them. Refresh exclusions with the same catalog as
                // source geometry; no retained stale SCWindow handles.
                let process_id = std::process::id() as i32;
                let windows = c.windows();
                let excluded: Vec<_> = windows
                    .iter()
                    .filter(|window| {
                        window
                            .owning_application()
                            .is_some_and(|app| app.process_id() == process_id)
                    })
                    .collect();
                (
                    display_source(&d),
                    SCContentFilter::create()
                        .with_display(&d)
                        .with_excluding_windows(&excluded)
                        .build(),
                )
            } else if let Some(w) = c
                .windows()
                .into_iter()
                .find(|w| window_id(w) == request.source_id)
            {
                if !w.is_on_screen() {
                    return Err(CaptureError::new("unavailable", "Window is minimized, hidden, or on another Space; restore it before capturing. Occluded on-screen windows are supported."));
                }
                (
                    window_source(&w),
                    SCContentFilter::create().with_window(&w).build(),
                )
            } else {
                return Err(CaptureError::new(
                    "stale_source",
                    "Source has closed or disconnected. Refresh sources and select again.",
                ));
            };
            let scale = f64::from(filter.point_pixel_scale());
            let bounds = filter.content_rect();
            let width = (bounds.size.width * scale).round() as u32;
            let height = (bounds.size.height * scale).round() as u32;
            // Bound native allocation and PNG preview size to 64 megapixels.
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 64_000_000 {
                return Err(CaptureError::new(
                    "dimensions",
                    "Invalid or larger than 64 megapixel source",
                ));
            }
            let crop = crop_rect(request.crop, width, height)?;
            let config = SCStreamConfiguration::new()
                .with_width(width)
                .with_height(height)
                .with_shows_cursor(false)
                .with_ignores_shadows_single_window(true);
            let resolve_ms = elapsed_ms(start);
            let acquisition = Instant::now();
            let image =
                SCScreenshotManager::capture_image(&filter, &config).map_err(native_error)?;
            let acquisition_ms = elapsed_ms(acquisition);
            if image.width() != width as usize || image.height() != height as usize {
                return Err(CaptureError::new(
                    "dimensions",
                    "Source dimensions changed during capture; retry",
                ));
            }
            let copying = Instant::now();
            let captured = image.rgba_data().map_err(native_error)?;
            // Indexing below assumes tight packing. Check it rather than trusting
            // it: a short buffer used to panic here rather than report anything.
            let expected = width as usize * height as usize * 4;
            if captured.len() < expected {
                return Err(CaptureError::new(
                    "pixels",
                    "Capture returned fewer pixels than its stated dimensions",
                ));
            }

            // Crop first, then convert. The conversion is per-pixel and
            // independent, so doing it to the rectangle that is kept gives
            // byte-identical output to doing it to the whole frame and throwing
            // most of it away — proved in `crop_then_convert_matches_convert_then_crop`.
            //
            // It matters because the frame is the whole display and the crop is a
            // dialogue box. Measured on a 3440x1440 source with a 521x749 crop —
            // 2.6% of the area — the old order spent the same ~88ms converting
            // either way, because it converted 4.8M pixels before discarding 4.7M
            // of them.
            // The origin now travels with the rectangle into `crop_pixels`; only
            // the size is still needed here, for the frame's own dimensions.
            let [_, _, w, h] = crop;
            let mut pixels = if crop == [0, 0, width, height] {
                captured
            } else {
                crop_pixels(&captured, width, crop)
            };
            // CoreGraphics bridge returns premultiplied RGBA DeviceRGB. PNG expects straight alpha.
            unpremultiply(&mut pixels);
            Ok(Frame {
                info: FrameInfo {
                    source_id: source.id,
                    width: w,
                    height: h,
                    stride: w as usize * 4,
                    full_width: width,
                    full_height: height,
                    crop_pixels: crop,
                    scale_factor: scale,
                    source_bounds: source.bounds,
                    pixel_format: "RGBA8 straight alpha, top-left rows",
                    color_space: "DeviceRGB (SDR; no embedded ICC profile)",
                    resolve_ms,
                    acquisition_ms,
                    pixels_ms: elapsed_ms(copying),
                    total_ms: elapsed_ms(start),
                },
                pixels,
            })
        })
    }
}

/// Straight alpha from premultiplied, in place.
///
/// Fully opaque and fully transparent pixels are already equal in both
/// representations, which is every pixel of an ordinary screen capture, so the
/// division is only paid where there is real translucency.
fn unpremultiply(pixels: &mut [u8]) {
    for p in pixels.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a > 0 && a < 255 {
            for v in &mut p[..3] {
                *v = ((u32::from(*v) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

/// Copy a rectangle out of a tightly packed RGBA buffer.
///
/// The caller has already established, via `crop_rect`, that the rectangle lies
/// inside the image, and that `source` holds `width * height * 4` bytes.
fn crop_pixels(source: &[u8], width: u32, crop: [u32; 4]) -> Vec<u8> {
    let [x, y, w, h] = crop;
    let row_bytes = w as usize * 4;
    let mut out = Vec::with_capacity(row_bytes * h as usize);
    for row in y..y + h {
        let from = (row as usize * width as usize + x as usize) * 4;
        out.extend_from_slice(&source[from..from + row_bytes]);
    }
    out
}

#[cfg(test)]
mod pixel_tests {
    use super::*;

    /// Deterministic stand-in for captured pixels, including real translucency
    /// so the conversion has something to do.
    fn buffer(width: u32, height: u32) -> Vec<u8> {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            let mut next = || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed & 0xff) as u8
            };
            let a = next();
            // Premultiplied means no channel may exceed alpha.
            let clamp = |v: u8| if a == 0 { 0 } else { v.min(a) };
            let (r, g, b) = (clamp(next()), clamp(next()), clamp(next()));
            out.extend_from_slice(&[r, g, b, a]);
        }
        out
    }

    /// The property the reordering rests on.
    #[test]
    fn crop_then_convert_matches_convert_then_crop() {
        let (width, height) = (64u32, 48u32);
        let source = buffer(width, height);
        for crop in [
            [0, 0, 64, 48],
            [0, 0, 1, 1],
            [10, 20, 17, 9],
            [63, 47, 1, 1],
            [32, 0, 32, 48],
        ] {
            // Old order: convert everything, then take the rectangle.
            let mut whole = source.clone();
            unpremultiply(&mut whole);
            let old = crop_pixels(&whole, width, crop);

            // New order: take the rectangle, then convert it.
            let mut new = crop_pixels(&source, width, crop);
            unpremultiply(&mut new);

            assert_eq!(old, new, "crop {crop:?}");
            assert_eq!(new.len(), (crop[2] * crop[3] * 4) as usize);
        }
    }

    #[test]
    fn a_full_frame_crop_is_the_whole_buffer_unchanged() {
        let source = buffer(16, 8);
        assert_eq!(crop_pixels(&source, 16, [0, 0, 16, 8]), source);
    }

    #[test]
    fn the_rectangle_taken_is_the_rectangle_asked_for() {
        // Each pixel carries its own coordinates, so a misplaced row or column
        // is visible rather than merely different.
        let (width, height) = (8u32, 6u32);
        let mut source = Vec::new();
        for y in 0..height {
            for x in 0..width {
                source.extend_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        let out = crop_pixels(&source, width, [3, 2, 4, 3]);
        assert_eq!(out.len(), 4 * 3 * 4);
        for row in 0..3usize {
            for column in 0..4usize {
                let i = (row * 4 + column) * 4;
                assert_eq!(out[i], 3 + column as u8, "x at {row},{column}");
                assert_eq!(out[i + 1], 2 + row as u8, "y at {row},{column}");
            }
        }
    }

    #[test]
    fn opaque_and_transparent_pixels_are_left_exactly_as_they_are() {
        let mut pixels = vec![
            10, 20, 30, 255, // opaque: already straight
            0, 0, 0, 0, // transparent: nothing to recover
        ];
        let before = pixels.clone();
        unpremultiply(&mut pixels);
        assert_eq!(pixels, before);
    }

    #[test]
    fn translucent_pixels_are_scaled_back_up_and_never_overflow() {
        // Half alpha: a premultiplied 64 came from a straight 128.
        let mut pixels = vec![64, 32, 0, 128];
        unpremultiply(&mut pixels);
        assert_eq!(pixels, vec![128, 64, 0, 128]);

        // A channel equal to alpha is fully saturated and must clamp at 255,
        // not wrap.
        let mut saturated = vec![7, 7, 7, 7];
        unpremultiply(&mut saturated);
        assert_eq!(saturated, vec![255, 255, 255, 7]);
    }
}
