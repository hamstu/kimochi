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
use crate::pixels::{bgra_crop_to_rgba, crop_pixels, unpremultiply};
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
    let pid = w
        .owning_application()
        .map(|a| a.process_id())
        .unwrap_or(0);
    // `process_id` is a pid_t; the wire format has always printed it unsigned-looking
    // decimal, and real pids are never negative.
    SourceId::window(Platform::MacOs, w.window_id(), pid as u32).to_string()
}
fn display_id(d: &SCDisplay) -> String {
    SourceId::display(Platform::MacOs, d.display_id()).to_string()
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
        id: display_id(d),
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
    let Some(parsed) = SourceId::parse(source_id).filter(|p| p.platform() == Platform::MacOs)
    else {
        return Ok(None);
    };
    // CoreGraphics ids are canonical decimal ("01" never named display 1); anything
    // else names no source here.
    let Some(number) = parsed
        .handle_u32()
        .filter(|n| n.to_string() == parsed.handle())
    else {
        return Ok(None);
    };
    let (source, filter) = if let Some(d) = parsed
        .is_display()
        .then(|| c.displays().into_iter().find(|d| d.display_id() == number))
        .flatten()
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
    } else if let Some(w) = parsed
        .is_window()
        .then(|| {
            c.windows().into_iter().find(|w| {
                let pid = w.owning_application().map(|a| a.process_id()).unwrap_or(0);
                // A window number can be reused by another process: the pid must
                // match too, exactly as it did when ids were compared as whole strings.
                w.window_id() == number && parsed.pid() == Some(pid as u32)
            })
        })
        .flatten()
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
