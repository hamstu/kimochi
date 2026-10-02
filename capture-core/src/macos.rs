//! ScreenCaptureKit backend.
//!
//! A source that is captured is kept running as an `SCStream`, the way OBS's macOS
//! capture does, and each later capture copies that stream's newest frame instead of
//! asking for a new one. Measured on a 3456x2234 display, a one-shot capture paid
//! about 53ms re-listing every window, 41ms for `SCScreenshotManager` to bring up and
//! tear down a capture session, and 19ms redrawing the `CGImage` into RGBA; taking the
//! stream's newest frame and copying it costs about half a millisecond. The stream
//! only delivers frames when the source changes, and stops itself after
//! `STREAM_IDLE` without a capture, so a source nobody reads costs nothing.
//!
//! The one-shot path remains for thumbnails, which are scaled on the GPU rather than
//! captured at full size, and as the fallback when a stream cannot produce a frame.
use super::*;
use screencapturekit::{
    cm::{CMSampleBufferSCExt, SCFrameStatus},
    cv::CVPixelBufferLockFlags,
    prelude::*,
    screenshot_manager::{CGImageExt, SCScreenshotManager},
    stream::ErrorHandler,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// A stream nobody has captured from for this long is stopped.
const STREAM_IDLE: Duration = Duration::from_secs(30);
/// Streams kept at once: the selected source, plus one the user is looking at.
const MAX_STREAMS: usize = 2;
/// A stream's first frame normally arrives ~45ms after it starts.
const FIRST_FRAME_WAIT: Duration = Duration::from_millis(500);
/// Fastest a stream delivers frames. It sends nothing while the source is still, so
/// this only bounds how stale a frame of a moving source can be.
const FRAME_INTERVAL: (i64, i32) = (1, 20);
/// How long the source catalog is trusted before it is listed again; a source missing
/// from it is always looked up afresh, so this only delays noticing a closed window.
const CATALOG_TTL: Duration = Duration::from_secs(2);

pub struct MacCapture {
    catalog: Option<(Instant, SCShareableContent)>,
    streams: HashMap<String, Live>,
}

impl MacCapture {
    pub fn new() -> Self {
        Self {
            catalog: None,
            streams: HashMap::new(),
        }
    }
}

impl Default for MacCapture {
    fn default() -> Self {
        Self::new()
    }
}

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

/// What a source resolves to: its description and the filter that captures it.
struct Resolved {
    source: Source,
    filter: SCContentFilter,
    /// Full-resolution size of the source in pixels.
    width: u32,
    height: u32,
    scale: f64,
}

/// Find a source in the catalog and build its filter.
///
/// A display capture leaves out every window Kimochi owns — the overlay and native
/// controls — by excluding the application rather than its current windows, so a
/// window opened after a display stream starts is left out too.
fn resolve(c: &SCShareableContent, source_id: &str) -> Result<Option<Resolved>> {
    let (source, filter) = if let Some(d) = c
        .displays()
        .into_iter()
        .find(|d| display_source(d).id == source_id)
    {
        let process_id = std::process::id() as i32;
        let apps = c.applications();
        let own: Vec<_> = apps
            .iter()
            .filter(|app| app.process_id() == process_id)
            .collect();
        let filter = if own.is_empty() {
            SCContentFilter::create()
                .with_display(&d)
                .with_excluding_windows(&[])
                .build()
        } else {
            SCContentFilter::create()
                .with_display(&d)
                .with_excluding_applications(&own, &[])
                .build()
        };
        (display_source(&d), filter)
    } else if let Some(w) = c
        .windows()
        .into_iter()
        .find(|w| window_id(w) == source_id)
    {
        if !w.is_on_screen() {
            return Err(CaptureError::new("unavailable", "Window is minimized, hidden, or on another Space; restore it before capturing. Occluded on-screen windows are supported."));
        }
        (
            window_source(&w),
            SCContentFilter::create().with_window(&w).build(),
        )
    } else {
        return Ok(None);
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
    Ok(Some(Resolved {
        source,
        filter,
        width,
        height,
        scale,
    }))
}

fn stale_source() -> CaptureError {
    CaptureError::new(
        "stale_source",
        "Source has closed or disconnected. Refresh sources and select again.",
    )
}

/// What a stream's callbacks share with captures and with its idle timer.
#[derive(Default)]
struct Slot {
    latest: Mutex<Option<CMSampleBuffer>>,
    arrived: Condvar,
    /// The stream reported an error, or was stopped: it will deliver nothing more.
    ended: AtomicBool,
    /// Last `SCFrameStatus` seen, as its raw value; idle frames do not replace
    /// `latest`, but a blank or suspended one means the window has gone away.
    status: AtomicU8,
    used: Mutex<Option<Instant>>,
}

impl Slot {
    fn touch(&self) {
        *self.used.lock().unwrap() = Some(Instant::now());
    }
    fn idle_for(&self) -> Duration {
        self.used
            .lock()
            .unwrap()
            .map_or(Duration::ZERO, |at| at.elapsed())
    }
    fn wait_for_frame(&self, limit: Duration) -> Option<CMSampleBuffer> {
        let latest = self.latest.lock().unwrap();
        let (latest, _) = self
            .arrived
            .wait_timeout_while(latest, limit, |frame| {
                frame.is_none() && !self.ended.load(Ordering::SeqCst)
            })
            .unwrap();
        latest.clone()
    }
}

/// One running stream.
struct Live {
    stream: Arc<SCStream>,
    slot: Arc<Slot>,
    source: Source,
    /// The pixel size the stream was configured for.
    width: u32,
    height: u32,
}

impl Live {
    fn stop(&self) {
        self.slot.ended.store(true, Ordering::SeqCst);
        let _ = self.stream.stop_capture();
    }
}

fn start_stream(resolved: &Resolved) -> Result<Live> {
    let config = SCStreamConfiguration::new()
        .with_width(resolved.width)
        .with_height(resolved.height)
        .with_pixel_format(PixelFormat::BGRA)
        .with_shows_cursor(false)
        .with_ignores_shadows_single_window(true)
        .with_queue_depth(3)
        .with_minimum_frame_interval(&CMTime::new(FRAME_INTERVAL.0, FRAME_INTERVAL.1));
    let slot = Arc::new(Slot::default());
    slot.touch();
    let on_error = slot.clone();
    let mut stream = SCStream::new_with_delegate(
        &resolved.filter,
        &config,
        ErrorHandler::new(move |_| {
            on_error.ended.store(true, Ordering::SeqCst);
            on_error.arrived.notify_all();
        }),
    );
    let output = slot.clone();
    stream.add_output_handler(
        move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
            if kind != SCStreamOutputType::Screen {
                return;
            }
            let status = sample.frame_status();
            if let Some(status) = status {
                output.status.store(status as u8, Ordering::SeqCst);
            }
            // Idle frames repeat the previous image and carry no pixels of their own.
            if status.is_some_and(|s| s != SCFrameStatus::Complete)
                || sample.pixel_buffer().is_none()
            {
                return;
            }
            *output.latest.lock().unwrap() = Some(sample);
            output.arrived.notify_all();
        },
        SCStreamOutputType::Screen,
    );
    stream.start_capture().map_err(native_error)?;
    let stream = Arc::new(stream);

    // Stop the stream once nobody has captured from it for a while. The timer holds
    // the stream itself, so this runs even if the backend is never called again.
    let (timer_stream, timer_slot) = (stream.clone(), slot.clone());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if timer_slot.ended.load(Ordering::SeqCst) {
            return;
        }
        if timer_slot.idle_for() > STREAM_IDLE {
            timer_slot.ended.store(true, Ordering::SeqCst);
            let _ = timer_stream.stop_capture();
            return;
        }
    });
    Ok(Live {
        stream,
        slot,
        source: resolved.source.clone(),
        width: resolved.width,
        height: resolved.height,
    })
}

/// Why a stream's frame cannot be used, when it cannot.
enum Unusable {
    /// The stream has ended or its source has changed shape: start again.
    Restart,
    /// Nothing has arrived yet.
    NoFrame,
}

/// The newest frame of a running stream, cropped and converted.
fn frame_from_stream(live: &Live, request: &CaptureRequest, start: Instant) -> std::result::Result<Result<Frame>, Unusable> {
    let slot = &live.slot;
    if slot.ended.load(Ordering::SeqCst) {
        return Err(Unusable::Restart);
    }
    let status = slot.status.load(Ordering::SeqCst);
    if live.source.kind == "window"
        && (status == SCFrameStatus::Blank as u8
            || status == SCFrameStatus::Suspended as u8
            || status == SCFrameStatus::Stopped as u8)
    {
        // Minimized, closed or moved to another Space: let a fresh lookup say which.
        return Err(Unusable::Restart);
    }
    let resolve_ms = elapsed_ms(start);
    let acquisition = Instant::now();
    let Some(sample) = slot.wait_for_frame(FIRST_FRAME_WAIT) else {
        return Err(if slot.ended.load(Ordering::SeqCst) {
            Unusable::Restart
        } else {
            Unusable::NoFrame
        });
    };
    let info = sample.frame_info();
    let scale = info
        .as_ref()
        .and_then(|i| i.scale_factor)
        .unwrap_or(1.0);
    let mut bounds = live.source.bounds;
    if live.source.kind == "window" {
        // The frame reports where the window is now, so a moved window needs no
        // catalog lookup; a resized one has been scaled to fit the old size, and
        // needs a stream of the new size instead.
        let Some(on_screen) = info.as_ref().and_then(|i| i.screen_rect) else {
            return Err(Unusable::Restart);
        };
        let width = (on_screen.size.width * scale).round() as u32;
        let height = (on_screen.size.height * scale).round() as u32;
        if width.abs_diff(live.width) > 1 || height.abs_diff(live.height) > 1 {
            return Err(Unusable::Restart);
        }
        bounds = Some(rect(on_screen));
    }
    let Some(buffer) = sample.pixel_buffer() else {
        return Err(Unusable::NoFrame);
    };
    let acquisition_ms = elapsed_ms(acquisition);
    let copying = Instant::now();
    let Ok(guard) = buffer.lock(CVPixelBufferLockFlags::READ_ONLY) else {
        return Err(Unusable::Restart);
    };
    let (width, height, stride) = (guard.width() as u32, guard.height() as u32, guard.bytes_per_row());
    let Some(bytes) = (unsafe { guard.as_slice() }) else {
        return Err(Unusable::Restart);
    };
    if width != live.width || height != live.height || bytes.len() < stride * height as usize {
        return Err(Unusable::Restart);
    }
    let crop = match crop_rect(request.crop, width, height) {
        Ok(crop) => crop,
        Err(error) => return Ok(Err(error)),
    };
    let mut pixels = bgra_crop_to_rgba(bytes, stride, crop);
    unpremultiply(&mut pixels);
    let [_, _, w, h] = crop;
    Ok(Ok(Frame {
        info: FrameInfo {
            source_id: live.source.id.clone(),
            width: w,
            height: h,
            stride: w as usize * 4,
            full_width: width,
            full_height: height,
            crop_pixels: crop,
            scale_factor: scale,
            source_bounds: bounds,
            pixel_format: "RGBA8 straight alpha, top-left rows",
            color_space: "Display native (SDR; no embedded ICC profile)",
            resolve_ms,
            acquisition_ms,
            pixels_ms: elapsed_ms(copying),
            total_ms: elapsed_ms(start),
        },
        pixels,
    }))
}

/// A single screenshot, sized `width` x `height` (the GPU scales it when that is
/// smaller than the source), cropped and converted.
fn one_shot(
    resolved: &Resolved,
    width: u32,
    height: u32,
    crop: Option<Crop>,
    start: Instant,
) -> Result<Frame> {
    let crop = crop_rect(crop, width, height)?;
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_shows_cursor(false)
        .with_ignores_shadows_single_window(true);
    let resolve_ms = elapsed_ms(start);
    let acquisition = Instant::now();
    let image =
        SCScreenshotManager::capture_image(&resolved.filter, &config).map_err(native_error)?;
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
    // Crop first, then convert: the conversion is per-pixel, so converting only the
    // rectangle kept is byte-identical and, for a dialogue box on a whole display,
    // a fraction of the work. Proved in `crop_then_convert_matches_convert_then_crop`.
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
            source_id: resolved.source.id.clone(),
            width: w,
            height: h,
            stride: w as usize * 4,
            full_width: width,
            full_height: height,
            crop_pixels: crop,
            scale_factor: resolved.scale * f64::from(width) / f64::from(resolved.width),
            source_bounds: resolved.source.bounds,
            pixel_format: "RGBA8 straight alpha, top-left rows",
            color_space: "DeviceRGB (SDR; no embedded ICC profile)",
            resolve_ms,
            acquisition_ms,
            pixels_ms: elapsed_ms(copying),
            total_ms: elapsed_ms(start),
        },
        pixels,
    })
}

impl MacCapture {
    /// The catalog, listed again only when it is older than `CATALOG_TTL` or `fresh`.
    fn catalog(&mut self, fresh: bool) -> Result<&SCShareableContent> {
        let stale = self
            .catalog
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > CATALOG_TTL);
        if fresh || stale {
            self.catalog = Some((Instant::now(), content()?));
        }
        Ok(&self.catalog.as_ref().unwrap().1)
    }

    /// Resolve a source from the cached catalog, listing again before reporting it
    /// missing or off screen: the cache may predate the window opening or returning.
    fn resolve(&mut self, source_id: &str) -> Result<Resolved> {
        let cached = self.catalog.is_some();
        if cached {
            if let Ok(Some(found)) = resolve(self.catalog(false)?, source_id) {
                return Ok(found);
            }
        }
        resolve(self.catalog(true)?, source_id)?.ok_or_else(stale_source)
    }

    fn drop_stream(&mut self, source_id: &str) {
        if let Some(live) = self.streams.remove(source_id) {
            live.stop();
        }
    }

    /// Make room for one more stream, stopping the one used longest ago.
    fn evict_for_new_stream(&mut self) {
        self.streams
            .retain(|_, live| !live.slot.ended.load(Ordering::SeqCst));
        while self.streams.len() >= MAX_STREAMS {
            let oldest = self
                .streams
                .iter()
                .max_by_key(|(_, live)| live.slot.idle_for())
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => self.drop_stream(&id),
                None => break,
            }
        }
    }
}

impl CaptureBackend for MacCapture {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            backend: "ScreenCaptureKit / SCStream, SCScreenshotManager fallback (macOS 14+)",
            enumeration: true,
            system_picker_required: false,
            retained_session: true,
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
            let c = self.catalog(true)?;
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
            if let Some(live) = self.streams.get(&request.source_id) {
                live.slot.touch();
                match frame_from_stream(live, request, start) {
                    Ok(result) => return result,
                    Err(Unusable::NoFrame) => {}
                    Err(Unusable::Restart) => self.drop_stream(&request.source_id),
                }
            }
            let resolved = self.resolve(&request.source_id)?;
            if !self.streams.contains_key(&request.source_id) {
                self.evict_for_new_stream();
                if let Ok(live) = start_stream(&resolved) {
                    self.streams.insert(request.source_id.clone(), live);
                }
            }
            if let Some(live) = self.streams.get(&request.source_id) {
                if let Ok(result) = frame_from_stream(live, request, start) {
                    return result;
                }
            }
            // No stream, or it produced nothing usable in time: capture once.
            one_shot(&resolved, resolved.width, resolved.height, request.crop, start)
        })
    }
    fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
        objc2::rc::autoreleasepool(|_| {
            let start = Instant::now();
            let resolved = self.resolve(source_id)?;
            let longest = resolved.width.max(resolved.height);
            let (width, height) = if longest <= edge {
                (resolved.width, resolved.height)
            } else {
                (
                    (u64::from(resolved.width) * u64::from(edge) / u64::from(longest)).max(1) as u32,
                    (u64::from(resolved.height) * u64::from(edge) / u64::from(longest)).max(1) as u32,
                )
            };
            one_shot(&resolved, width, height, None, start)
        })
    }
    fn close(&mut self) {
        for (_, live) in self.streams.drain() {
            live.stop();
        }
    }
}

/// Copy a rectangle out of a BGRA buffer with `stride` bytes per row, as RGBA.
fn bgra_crop_to_rgba(source: &[u8], stride: usize, crop: [u32; 4]) -> Vec<u8> {
    let [x, y, w, h] = crop;
    let row_bytes = w as usize * 4;
    let mut out = vec![0u8; row_bytes * h as usize];
    for (row, target) in (y..y + h).zip(out.chunks_exact_mut(row_bytes)) {
        let from = row as usize * stride + x as usize * 4;
        for (p, q) in source[from..from + row_bytes]
            .chunks_exact(4)
            .zip(target.chunks_exact_mut(4))
        {
            // One word per pixel: swap the red and blue bytes, keep green and alpha.
            let v = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
            let swapped = (v & 0xFF00_FF00) | ((v >> 16) & 0xFF) | ((v & 0xFF) << 16);
            q.copy_from_slice(&swapped.to_le_bytes());
        }
    }
    out
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

    /// Stream frames arrive BGRA with padded rows; the copy honours the stride,
    /// swaps red and blue, and takes exactly the rectangle asked for.
    #[test]
    fn stream_frames_are_cropped_through_their_stride_into_rgba() {
        let (width, height, stride) = (5usize, 4usize, 32usize);
        let mut source = vec![0xEEu8; stride * height];
        for y in 0..height {
            for x in 0..width {
                let i = y * stride + x * 4;
                source[i..i + 4].copy_from_slice(&[x as u8, y as u8, 200, 255]);
            }
        }
        let out = bgra_crop_to_rgba(&source, stride, [1, 2, 3, 2]);
        assert_eq!(out.len(), 3 * 2 * 4);
        for row in 0..2usize {
            for column in 0..3usize {
                let i = (row * 3 + column) * 4;
                assert_eq!(&out[i..i + 4], &[200, 2 + row as u8, 1 + column as u8, 255]);
            }
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
