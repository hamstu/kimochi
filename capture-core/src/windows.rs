//! Windows Graphics Capture backend, through the `windows-capture` crate.
//!
//! Mirrors the ScreenCaptureKit backend's shape (see `macos.rs`): a source that is
//! captured keeps a capture session running, each session publishes its newest frame
//! into a mailbox, and later captures copy that frame instead of starting again. At
//! most `MAX_SESSIONS` run at once (least recently used is stopped first), and a
//! session nobody has captured from for `SESSION_IDLE` stops itself.
//!
//! Coordinates. `Source.bounds` and `FrameInfo.source_bounds` are in the Windows
//! desktop's own space: **physical virtual-screen pixels**, top-left origin, possibly
//! negative. That is what `DWMWA_EXTENDED_FRAME_BOUNDS` and `GetMonitorInfoW` report
//! to a Per-Monitor-V2 DPI aware process, which the app is under tao. Frames are
//! physical pixels too, so `scale_factor` is 1.0 (frame pixels per desktop unit).
//!
//! Window frames. WGC sizes a window's frame like `GetWindowRect`, which on Windows 10
//! and 11 includes the invisible resize borders around the visible frame. Each capture
//! measures both rectangles and cuts the visible one out, so a frame (and every crop
//! reference) is exactly the rectangle `Source.bounds` describes.
//!
//! Consent. WGC needs no OS permission for an unpackaged desktop app. Border removal
//! does (`GraphicsCaptureAccess::RequestAccessAsync(Borderless)`), and is a separate,
//! explicit opt-in; this backend never asks for it and leaves the border setting at
//! the system default. Cursor capture is turned off where the OS allows it.
//!
//! The pure decisions compile on every platform, so they are tested on the macOS
//! development machine too: which windows are listed and how handles are spelled live
//! in `win_rules` (shared with the app's Windows adapter); where the visible rectangle
//! sits in a frame lives at the top of this file.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

#[cfg(target_os = "windows")]
pub use wgc::WgcCapture;

/// The file stem of a process image path: `C:\Games\vn.exe` -> `vn`.
pub(crate) fn image_stem(path: &str) -> Option<String> {
    let file = path.rsplit(['\\', '/']).next()?;
    let stem = match file.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => file,
    };
    (!stem.is_empty()).then(|| stem.to_string())
}

/// A Win32 `RECT`, as plain values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PxRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl PxRect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    pub fn to_rect(self) -> crate::Rect {
        crate::Rect {
            x: f64::from(self.left),
            y: f64::from(self.top),
            width: f64::from(self.width()),
            height: f64::from(self.height()),
        }
    }
}

/// Where the visible frame of a window sits in a captured frame, as `[x, y, w, h]`.
///
/// `outer` is `GetWindowRect` (invisible borders included) and `visible` is
/// `DWMWA_EXTENDED_FRAME_BOUNDS`. A frame the size of `outer` has the visible
/// rectangle at their offset; a frame already the size of `visible` is all visible.
/// `None` means the frame matches neither, which happens for the frame or two after a
/// resize, before a frame of the new size arrives.
pub(crate) fn visible_region(
    frame_width: u32,
    frame_height: u32,
    outer: PxRect,
    visible: PxRect,
) -> Option<[u32; 4]> {
    let near = |frame: u32, size: i32| size > 0 && (i64::from(frame) - i64::from(size)).abs() <= 1;
    if near(frame_width, outer.width()) && near(frame_height, outer.height()) {
        let x = (visible.left - outer.left).max(0) as u32;
        let y = (visible.top - outer.top).max(0) as u32;
        let width = (visible.width().max(0) as u32).min(frame_width.saturating_sub(x));
        let height = (visible.height().max(0) as u32).min(frame_height.saturating_sub(y));
        return (width > 0 && height > 0).then_some([x, y, width, height]);
    }
    if near(frame_width, visible.width()) && near(frame_height, visible.height()) {
        return Some([0, 0, frame_width, frame_height]);
    }
    None
}

#[cfg(target_os = "windows")]
mod wgc {
    use super::{image_stem, visible_region, PxRect};
    use crate::win_rules::{hex_handle, listable, parse_hex_handle, WindowMeta};
    use crate::pixels::{bgra_crop_to_rgba, box_downscale, crop_pixels, fit_within, unpremultiply};
    use crate::{
        crop_rect, elapsed_ms, Capabilities, CaptureBackend, CaptureError, CaptureRequest, Crop,
        Frame, FrameInfo, Platform, Rect, Result, Source, SourceId,
    };
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use ::windows::core::{BOOL, PWSTR};
    use ::windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, TRUE};
    use ::windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use ::windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
    use ::windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
    };
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame as WgcFrame;
    use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    /// A session nobody has captured from for this long is stopped.
    const SESSION_IDLE: Duration = Duration::from_secs(30);
    /// Sessions kept at once: the selected source, plus one the user is looking at.
    const MAX_SESSIONS: usize = 2;
    /// WGC delivers a session's first frame as soon as it starts.
    const FIRST_FRAME_WAIT: Duration = Duration::from_millis(500);
    /// Fastest a session delivers frames (20 per second, as on macOS). WGC sends
    /// nothing while the source is still, so this only bounds staleness.
    const FRAME_INTERVAL: Duration = Duration::from_millis(50);
    /// Bound allocation and PNG preview size, as macOS does.
    const MAX_PIXELS: u64 = 64_000_000;

    const PIXEL_FORMAT: &str = "RGBA8 straight alpha, top-left rows";
    const COLOR_SPACE: &str = "Display native (SDR; no embedded ICC profile)";

    fn native_error(e: impl ToString) -> CaptureError {
        CaptureError::new("native", e)
    }
    fn stale_source() -> CaptureError {
        CaptureError::new(
            "stale_source",
            "Source has closed or disconnected. Refresh sources and select again.",
        )
    }
    /// Same code and wording family as macOS's minimized/off-Space window, so the app
    /// reports it the same way ("gone:").
    fn minimized() -> CaptureError {
        CaptureError::new(
            "unavailable",
            "Window is minimized; restore it before capturing. Occluded on-screen windows are supported.",
        )
    }

    // ----- Win32 lookups -------------------------------------------------------------

    fn hwnd(raw: usize) -> HWND {
        HWND(raw as *mut c_void)
    }
    fn px(r: RECT) -> PxRect {
        PxRect {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }
    fn window_pid(h: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        pid
    }
    fn window_text(h: HWND) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.clamp(0, buf.len() as i32) as usize])
    }
    fn class_name(h: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.clamp(0, buf.len() as i32) as usize])
    }
    /// `GetWindowRect`: invisible resize borders included.
    fn outer_rect(h: HWND) -> Option<PxRect> {
        let mut r = RECT::default();
        unsafe { GetWindowRect(h, &mut r) }.ok()?;
        Some(px(r))
    }
    /// `DWMWA_EXTENDED_FRAME_BOUNDS`: the visible frame, always physical pixels.
    fn visible_rect(h: HWND) -> Option<PxRect> {
        let mut r = RECT::default();
        unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut RECT as *mut c_void,
                std::mem::size_of::<RECT>() as u32,
            )
        }
        .ok()?;
        Some(px(r))
    }
    fn is_cloaked(h: HWND) -> bool {
        let mut cloaked = 0u32;
        unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .is_ok()
            && cloaked != 0
    }
    fn has_owner(h: HWND) -> bool {
        unsafe { GetWindow(h, GW_OWNER) }.is_ok_and(|owner| !owner.is_invalid())
    }
    fn process_stem(pid: u32) -> Option<String> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let named = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        };
        let _ = unsafe { CloseHandle(process) };
        named.ok()?;
        image_stem(&String::from_utf16_lossy(&buf[..size as usize]))
    }

    unsafe extern "system" fn collect_window(h: HWND, data: LPARAM) -> BOOL {
        let found = unsafe { &mut *(data.0 as *mut Vec<usize>) };
        found.push(h.0 as usize);
        TRUE
    }
    /// Every top-level window, front to back.
    fn top_level_windows() -> Result<Vec<usize>> {
        let mut found: Vec<usize> = Vec::new();
        unsafe {
            EnumWindows(
                Some(collect_window),
                LPARAM(&mut found as *mut Vec<usize> as isize),
            )
        }
        .map_err(native_error)?;
        Ok(found)
    }

    fn monitors() -> Result<Vec<usize>> {
        Ok(Monitor::enumerate()
            .map_err(native_error)?
            .iter()
            .map(|m| m.as_raw_hmonitor() as usize)
            .collect())
    }
    /// The monitor's rectangle in physical virtual-screen pixels.
    fn monitor_rect(raw: usize) -> Option<PxRect> {
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetMonitorInfoW(HMONITOR(raw as *mut c_void), &mut info) }
            .as_bool()
            .then(|| px(info.rcMonitor))
    }

    fn window_source(raw: usize, own_pid: u32) -> Option<Source> {
        let h = hwnd(raw);
        let visible = unsafe { IsWindowVisible(h) }.as_bool();
        if !visible {
            return None;
        }
        let title = window_text(h);
        let class = class_name(h);
        let minimized = unsafe { IsIconic(h) }.as_bool();
        let bounds = visible_rect(h).or_else(|| outer_rect(h))?;
        let pid = window_pid(h);
        let meta = WindowMeta {
            visible,
            iconic: minimized,
            cloaked: is_cloaked(h),
            has_owner: has_owner(h),
            tool_window: false,
            app_window: false,
            title_nonempty: !title.trim().is_empty(),
            class_name: &class,
            pid,
            own_pid,
            width: f64::from(bounds.width()),
            height: f64::from(bounds.height()),
        }
        .with_ex_style(unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32);
        if !listable(&meta) {
            return None;
        }
        Some(Source {
            id: SourceId::window(Platform::Windows, hex_handle(raw), pid).to_string(),
            kind: "window",
            name: title,
            app: process_stem(pid),
            // A minimized window's rectangle is the iconic placeholder, not where it
            // will be: say nothing rather than something wrong.
            bounds: (!minimized).then(|| bounds.to_rect()),
            on_screen: Some(!minimized),
        })
    }

    fn display_source(index: usize, raw: usize) -> Option<Source> {
        let bounds = monitor_rect(raw)?;
        let name = Monitor::from_raw_hmonitor(raw as *mut c_void)
            .name()
            .ok()
            .filter(|n| !n.trim().is_empty());
        Some(Source {
            id: SourceId::display(Platform::Windows, hex_handle(raw)).to_string(),
            kind: "display",
            name: match name {
                Some(n) => format!("Display {} ({n})", index + 1),
                None => format!("Display {}", index + 1),
            },
            app: None,
            bounds: Some(bounds.to_rect()),
            on_screen: Some(true),
        })
    }

    // ----- Targets ------------------------------------------------------------------

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Target {
        Window { hwnd: usize, pid: u32 },
        Display { hmonitor: usize },
    }

    fn parse_target(id: &str) -> Result<Target> {
        let parsed = SourceId::parse(id)
            .filter(|p| p.platform() == Platform::Windows)
            .ok_or_else(stale_source)?;
        let raw = parse_hex_handle(parsed.handle()).ok_or_else(stale_source)?;
        Ok(match parsed {
            SourceId::Display { .. } => Target::Display { hmonitor: raw },
            SourceId::Window { pid, .. } => Target::Window {
                hwnd: raw,
                pid: pid.ok_or_else(stale_source)?,
            },
        })
    }

    /// Whether the target still exists and can deliver pixels now.
    ///
    /// Handles are reused: a window id names the window only while the same process
    /// still owns that `HWND`, and a display id only while that monitor is attached.
    fn check_target(target: Target) -> Result<()> {
        match target {
            Target::Window { hwnd: raw, pid } => {
                let h = hwnd(raw);
                if !unsafe { IsWindow(Some(h)) }.as_bool() || window_pid(h) != pid {
                    return Err(stale_source());
                }
                if unsafe { IsIconic(h) }.as_bool() {
                    return Err(minimized());
                }
                // On another virtual desktop: Windows Graphics Capture would wait out its
                // timeout for frames DWM is not composing.
                if is_cloaked(h) {
                    return Err(CaptureError::new(
                        "unavailable",
                        "Window is on another desktop; switch to that desktop to read it.",
                    ));
                }
            }
            Target::Display { hmonitor } => {
                if !monitors()?.contains(&hmonitor) {
                    return Err(stale_source());
                }
            }
        }
        Ok(())
    }

    // ----- Sessions -----------------------------------------------------------------

    /// One frame, already converted to tightly packed RGBA (still premultiplied).
    struct LatestFrame {
        pixels: Vec<u8>,
        width: u32,
        height: u32,
        /// Increases by one per frame; the first is 1.
        generation: u64,
    }

    /// What a session's handler shares with captures and with its idle timer.
    #[derive(Default)]
    struct Slot {
        latest: Mutex<Option<Arc<LatestFrame>>>,
        arrived: Condvar,
        generation: AtomicU64,
        /// The session has stopped, failed, or its item closed: nothing more comes.
        ended: AtomicBool,
        /// The item itself closed (window destroyed, monitor detached).
        closed: AtomicBool,
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
        fn end(&self) {
            self.ended.store(true, Ordering::SeqCst);
            self.arrived.notify_all();
        }
        /// The newest frame newer than generation `after`, waiting up to `limit`.
        fn wait_newer(&self, after: u64, limit: Duration) -> Option<Arc<LatestFrame>> {
            let latest = self.latest.lock().unwrap();
            let (latest, _) = self
                .arrived
                .wait_timeout_while(latest, limit, |frame| {
                    frame.as_ref().is_none_or(|f| f.generation <= after)
                        && !self.ended.load(Ordering::SeqCst)
                })
                .unwrap();
            latest.clone().filter(|f| f.generation > after)
        }
        fn current(&self) -> Option<Arc<LatestFrame>> {
            self.latest.lock().unwrap().clone()
        }
    }

    /// Runs on the session's own thread (windows-capture's message loop).
    struct Handler {
        slot: Arc<Slot>,
    }

    impl GraphicsCaptureApiHandler for Handler {
        type Flags = Arc<Slot>;
        type Error = String;

        fn new(ctx: Context<Self::Flags>) -> std::result::Result<Self, Self::Error> {
            Ok(Self { slot: ctx.flags })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut WgcFrame,
            _control: InternalCaptureControl,
        ) -> std::result::Result<(), Self::Error> {
            let (width, height) = (frame.width(), frame.height());
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
                return Ok(());
            }
            let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
            // Mapped staging textures pad rows to the driver's pitch.
            let stride = buffer.row_pitch() as usize;
            let raw = buffer.as_raw_buffer();
            let row_bytes = width as usize * 4;
            if stride < row_bytes || raw.len() < stride * (height as usize - 1) + row_bytes {
                return Ok(());
            }
            let pixels = bgra_crop_to_rgba(raw, stride, [0, 0, width, height]);
            let generation = self.slot.generation.fetch_add(1, Ordering::SeqCst) + 1;
            *self.slot.latest.lock().unwrap() = Some(Arc::new(LatestFrame {
                pixels,
                width,
                height,
                generation,
            }));
            self.slot.arrived.notify_all();
            Ok(())
        }

        fn on_closed(&mut self) -> std::result::Result<(), Self::Error> {
            self.slot.closed.store(true, Ordering::SeqCst);
            self.slot.end();
            Ok(())
        }
    }

    type Control = CaptureControl<Handler, String>;

    /// One running capture session.
    struct Session {
        slot: Arc<Slot>,
        control: Arc<Mutex<Option<Control>>>,
    }

    impl Session {
        fn alive(&self) -> bool {
            !self.slot.ended.load(Ordering::SeqCst)
                && self
                    .control
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|c| !c.is_finished())
        }
        fn stop(&self) {
            stop_control(&self.slot, &self.control);
        }
    }

    fn stop_control(slot: &Slot, control: &Mutex<Option<Control>>) {
        slot.end();
        // Take it out first: `stop` joins the session thread.
        let taken = control.lock().unwrap().take();
        if let Some(control) = taken {
            let _ = control.stop();
        }
    }

    fn start_session(target: Target) -> Result<Session> {
        let slot = Arc::new(Slot::default());
        slot.touch();
        // Older Windows 10 builds lack these properties; the library refuses a
        // non-default setting it cannot apply, so ask before setting either.
        let cursor = if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
            CursorCaptureSettings::WithoutCursor
        } else {
            CursorCaptureSettings::Default
        };
        let interval =
            if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
                MinimumUpdateIntervalSettings::Custom(FRAME_INTERVAL)
            } else {
                MinimumUpdateIntervalSettings::Default
            };
        // The border stays at the system default: turning it off needs the user's
        // explicit Borderless consent, which is a separate opt-in (plan, Phase 2).
        let control = match target {
            Target::Window { hwnd: raw, .. } => Handler::start_free_threaded(Settings::new(
                Window::from_raw_hwnd(raw as *mut c_void),
                cursor,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                slot.clone(),
            )),
            Target::Display { hmonitor } => Handler::start_free_threaded(Settings::new(
                Monitor::from_raw_hmonitor(hmonitor as *mut c_void),
                cursor,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                slot.clone(),
            )),
        }
        .map_err(native_error)?;
        let control = Arc::new(Mutex::new(Some(control)));

        // Stop the session once nobody has captured from it for a while, or reap it
        // once it has ended on its own (closed item, lost device). The timer holds the
        // session itself, so this runs even if the backend is never called again.
        let (timer_slot, timer_control) = (slot.clone(), control.clone());
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let finished = timer_control
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|c| c.is_finished());
            if finished
                || timer_slot.ended.load(Ordering::SeqCst)
                || timer_slot.idle_for() > SESSION_IDLE
            {
                stop_control(&timer_slot, &timer_control);
                return;
            }
        });
        Ok(Session { slot, control })
    }

    /// The newest frame and the part of it that is the source, with its bounds.
    struct Located {
        frame: Arc<LatestFrame>,
        /// `[x, y, w, h]` of the visible source inside `frame`.
        region: [u32; 4],
        bounds: Option<Rect>,
    }

    fn locate(target: Target, slot: &Slot, frame: Arc<LatestFrame>) -> Located {
        match target {
            Target::Display { hmonitor } => Located {
                region: [0, 0, frame.width, frame.height],
                bounds: monitor_rect(hmonitor).map(PxRect::to_rect),
                frame,
            },
            Target::Window { hwnd: raw, .. } => {
                let h = hwnd(raw);
                let mut frame = frame;
                for attempt in 0..2 {
                    let (Some(outer), Some(visible)) = (outer_rect(h), visible_rect(h)) else {
                        break;
                    };
                    if let Some(region) = visible_region(frame.width, frame.height, outer, visible)
                    {
                        return Located {
                            frame,
                            region,
                            bounds: Some(visible.to_rect()),
                        };
                    }
                    // Just resized: the newest frame predates the new size. WGC
                    // recreates its pool and sends one of the new size; wait once.
                    if attempt == 0 {
                        match slot.wait_newer(frame.generation, FIRST_FRAME_WAIT) {
                            Some(newer) => frame = newer,
                            None => break,
                        }
                    }
                }
                // Best effort: the whole frame, labelled with where the window is.
                Located {
                    region: [0, 0, frame.width, frame.height],
                    bounds: visible_rect(h)
                        .or_else(|| outer_rect(h))
                        .map(PxRect::to_rect),
                    frame,
                }
            }
        }
    }

    struct Timings {
        start: Instant,
        resolve_ms: f64,
        acquisition_ms: f64,
    }

    /// Crop (relative to the visible source), optionally shrink so the longest edge
    /// is at most `edge`, and convert to straight alpha.
    fn compose(
        source_id: &str,
        located: &Located,
        crop: Option<Crop>,
        edge: Option<u32>,
        timings: Timings,
    ) -> Result<Frame> {
        let [rx, ry, rw, rh] = located.region;
        if rw == 0 || rh == 0 || u64::from(rw) * u64::from(rh) > MAX_PIXELS {
            return Err(CaptureError::new(
                "dimensions",
                "Invalid or larger than 64 megapixel source",
            ));
        }
        let crop = crop_rect(crop, rw, rh)?;
        let copying = Instant::now();
        let frame = &located.frame;
        let absolute = [rx + crop[0], ry + crop[1], crop[2], crop[3]];
        let mut pixels = if absolute == [0, 0, frame.width, frame.height] {
            frame.pixels.clone()
        } else {
            crop_pixels(&frame.pixels, frame.width, absolute)
        };
        let (mut info_crop, mut full, mut scale) = (crop, (rw, rh), 1.0);
        if let Some(edge) = edge {
            let (w, h) = fit_within(crop[2], crop[3], edge);
            if (w, h) != (crop[2], crop[3]) {
                // Average premultiplied pixels, then unpremultiply: the right order.
                pixels = box_downscale(&pixels, crop[2], crop[3], w, h);
            }
            scale = f64::from(w) / f64::from(rw);
            info_crop = [0, 0, w, h];
            full = (w, h);
        }
        // WGC's BGRA8 surfaces are premultiplied. PNG and OCR expect straight alpha.
        unpremultiply(&mut pixels);
        let [_, _, w, h] = info_crop;
        Ok(Frame {
            info: FrameInfo {
                source_id: source_id.to_string(),
                width: w,
                height: h,
                stride: w as usize * 4,
                full_width: full.0,
                full_height: full.1,
                crop_pixels: info_crop,
                scale_factor: scale,
                source_bounds: located.bounds,
                pixel_format: PIXEL_FORMAT,
                color_space: COLOR_SPACE,
                resolve_ms: timings.resolve_ms,
                acquisition_ms: timings.acquisition_ms,
                pixels_ms: elapsed_ms(copying),
                total_ms: elapsed_ms(timings.start),
            },
            pixels,
        })
    }

    fn no_frame(target: Target, slot: &Slot) -> CaptureError {
        if slot.closed.load(Ordering::SeqCst) {
            return stale_source();
        }
        match target {
            Target::Window { .. } => CaptureError::new(
                "unavailable",
                "Window produced no image; it may be hidden or on another desktop. Bring it into view before capturing.",
            ),
            Target::Display { .. } => native_error("Display produced no image in time; retry"),
        }
    }

    pub struct WgcCapture {
        sessions: HashMap<String, Session>,
    }

    impl WgcCapture {
        pub fn new() -> Self {
            Self {
                sessions: HashMap::new(),
            }
        }

        fn drop_session(&mut self, source_id: &str) {
            if let Some(session) = self.sessions.remove(source_id) {
                session.stop();
            }
        }

        /// Make room for one more session, stopping the one used longest ago.
        fn evict_for_new_session(&mut self) {
            let dead: Vec<_> = self
                .sessions
                .iter()
                .filter(|(_, s)| !s.alive())
                .map(|(id, _)| id.clone())
                .collect();
            for id in dead {
                self.drop_session(&id);
            }
            while self.sessions.len() >= MAX_SESSIONS {
                let oldest = self
                    .sessions
                    .iter()
                    .max_by_key(|(_, s)| s.slot.idle_for())
                    .map(|(id, _)| id.clone());
                match oldest {
                    Some(id) => self.drop_session(&id),
                    None => break,
                }
            }
        }

        /// The running session for a source, started (or restarted) if need be.
        fn session(&mut self, source_id: &str, target: Target) -> Result<Arc<Slot>> {
            if self.sessions.get(source_id).is_some_and(|s| !s.alive()) {
                self.drop_session(source_id);
            }
            if !self.sessions.contains_key(source_id) {
                self.evict_for_new_session();
                let session = start_session(target)?;
                self.sessions.insert(source_id.to_string(), session);
            }
            let slot = self.sessions[source_id].slot.clone();
            slot.touch();
            Ok(slot)
        }
    }

    impl Default for WgcCapture {
        fn default() -> Self {
            Self::new()
        }
    }

    impl CaptureBackend for WgcCapture {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                backend: "windows-graphics-capture",
                enumeration: true,
                system_picker_required: false,
                retained_session: true,
            }
        }
        fn permission(&self) -> &'static str {
            // Desktop apps need no OS consent for WGC capture.
            "granted"
        }
        fn request_permission(&self) -> bool {
            true
        }
        fn enumerate(&mut self) -> Result<Vec<Source>> {
            let own_pid = std::process::id();
            let mut result: Vec<_> = monitors()?
                .into_iter()
                .enumerate()
                .filter_map(|(i, raw)| display_source(i, raw))
                .collect();
            result.extend(
                top_level_windows()?
                    .into_iter()
                    .filter_map(|raw| window_source(raw, own_pid)),
            );
            Ok(result)
        }
        fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
            let start = Instant::now();
            let target = parse_target(&request.source_id)?;
            // A minimized window keeps its session (and last frame) so restoring it
            // resumes at once, but reports itself unavailable meanwhile, as macOS does.
            if let Err(error) = check_target(target) {
                if error.code == "stale_source" {
                    self.drop_session(&request.source_id);
                }
                return Err(error);
            }
            let slot = self.session(&request.source_id, target)?;
            let resolve_ms = elapsed_ms(start);
            let acquisition = Instant::now();
            let frame = slot
                .wait_newer(0, FIRST_FRAME_WAIT)
                .ok_or_else(|| no_frame(target, &slot))?;
            let located = locate(target, &slot, frame);
            compose(
                &request.source_id,
                &located,
                request.crop,
                None,
                Timings {
                    start,
                    resolve_ms,
                    acquisition_ms: elapsed_ms(acquisition),
                },
            )
        }
        fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
            let start = Instant::now();
            let target = parse_target(source_id)?;
            check_target(target)?;
            let resolve_ms = elapsed_ms(start);
            let acquisition = Instant::now();
            // Reuse a running session's frame without touching it: a thumbnail must
            // not keep a session alive, nor evict the one the user selected.
            let running = self
                .sessions
                .get(source_id)
                .filter(|s| s.alive())
                .and_then(|s| s.slot.current().map(|f| (s.slot.clone(), f)));
            let located = match running {
                Some((slot, frame)) => locate(target, &slot, frame),
                None => {
                    let session = start_session(target)?;
                    let frame = session.slot.wait_newer(0, FIRST_FRAME_WAIT);
                    let located = frame.map(|f| locate(target, &session.slot, f));
                    let error = located.is_none().then(|| no_frame(target, &session.slot));
                    session.stop();
                    match (located, error) {
                        (Some(located), _) => located,
                        (None, error) => return Err(error.unwrap_or_else(stale_source)),
                    }
                }
            };
            compose(
                source_id,
                &located,
                None,
                Some(edge.max(1)),
                Timings {
                    start,
                    resolve_ms,
                    acquisition_ms: elapsed_ms(acquisition),
                },
            )
        }
        fn close(&mut self) {
            for (_, session) in self.sessions.drain() {
                session.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_image_stems() {
        assert_eq!(image_stem(r"C:\Games\Novel\vn.exe").as_deref(), Some("vn"));
        assert_eq!(
            image_stem(r"C:\Program Files\App\my.app.exe").as_deref(),
            Some("my.app")
        );
        assert_eq!(image_stem("noext").as_deref(), Some("noext"));
        assert_eq!(image_stem(r"C:\dir\.hidden").as_deref(), Some(".hidden"));
        assert_eq!(image_stem(r"C:\dir\"), None);
    }

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn a_frame_with_invisible_borders_is_cut_to_the_visible_rect() {
        // Windows 10/11: 7px invisible borders left, right and bottom; none on top.
        let outer = rect(93, 50, 1307, 777);
        let visible = rect(100, 50, 1300, 770);
        assert_eq!(
            visible_region(1214, 727, outer, visible),
            Some([7, 0, 1200, 720])
        );
    }

    #[test]
    fn negative_origins_on_a_left_monitor_keep_the_same_offsets() {
        let outer = rect(-1927, -10, -713, 717);
        let visible = rect(-1920, -10, -720, 710);
        assert_eq!(
            visible_region(1214, 727, outer, visible),
            Some([7, 0, 1200, 720])
        );
    }

    #[test]
    fn a_frame_already_the_visible_size_is_used_whole() {
        let outer = rect(93, 50, 1307, 777);
        let visible = rect(100, 50, 1300, 770);
        assert_eq!(
            visible_region(1200, 720, outer, visible),
            Some([0, 0, 1200, 720])
        );
        // Borderless windows: both rectangles agree.
        let same = rect(0, 0, 800, 600);
        assert_eq!(visible_region(800, 600, same, same), Some([0, 0, 800, 600]));
    }

    #[test]
    fn a_stale_frame_from_before_a_resize_matches_nothing() {
        let outer = rect(93, 50, 1607, 977);
        let visible = rect(100, 50, 1600, 970);
        assert_eq!(visible_region(1214, 727, outer, visible), None);
    }

    #[test]
    fn the_visible_region_never_reaches_outside_the_frame() {
        // Off-by-one frame (rounding at fractional DPI) still yields an in-bounds rect.
        let outer = rect(0, 0, 1214, 727);
        let visible = rect(7, 0, 1207, 720);
        let [x, y, w, h] = visible_region(1213, 726, outer, visible).unwrap();
        assert!(x + w <= 1213 && y + h <= 726);
    }
}
