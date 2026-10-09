//! Linux has no portable capture-exclusion flag. Suppress annotation surfaces while acquiring pixels.
use kimochi_capture::{
    Capabilities, CaptureBackend, CaptureError, CaptureRequest, Frame, Result, Source,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

static SUPPRESSED: AtomicBool = AtomicBool::new(false);
static LAST_HIDE: Mutex<Option<Instant>> = Mutex::new(None);
/// Also fence captures when the user/region scheduler has just hidden annotations.
pub fn mark_hidden() {
    *LAST_HIDE.lock().unwrap() = Some(Instant::now());
}

pub fn suppressed() -> bool {
    SUPPRESSED.load(Ordering::SeqCst)
}
const LABELS: [&str; 3] = ["overlay", "popup-host", "reader-popup"];
pub fn annotation_window(label: &str) -> bool {
    LABELS.contains(&label)
}

struct Hidden {
    app: AppHandle,
    visible: Vec<String>,
    after: Option<Instant>,
}
impl Drop for Hidden {
    fn drop(&mut self) {
        let app = self.app.clone();
        let visible = self.visible.clone();
        let (tx, rx) = mpsc::channel();
        if self
            .app
            .run_on_main_thread(move || {
                SUPPRESSED.store(false, Ordering::SeqCst);
                for label in visible {
                    if label == "overlay"
                        && app.try_state::<crate::state::Shared>().is_some_and(|s| {
                            !s.view.lock().unwrap().overlay_visible && !super::region_editing()
                        })
                    {
                        continue;
                    }
                    if let Some(window) = app.get_webview_window(&label) {
                        if let Err(error) = super::gamescope::show(&window) {
                            eprintln!("Capture overlay restore ({label}): {error}");
                        }
                    }
                }
                let _ = tx.send(());
            })
            .is_ok()
        {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }
}

fn hide(app: &AppHandle) -> Result<Hidden> {
    if super::region_editing() {
        return Err(CaptureError::new(
            "busy",
            "Finish crop editing before capturing",
        ));
    }
    let handle = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        SUPPRESSED.store(true, Ordering::SeqCst);
        let mut visible = Vec::new();
        let mut error = None;
        for label in LABELS {
            if let Some(window) = handle.get_webview_window(label) {
                if window.is_visible().unwrap_or(false) {
                    if visible.is_empty() {
                        mark_hidden();
                    }
                    visible.push(label.to_string());
                    if let Err(e) = super::gamescope::hide(&window) {
                        error = Some(e.to_string());
                        break;
                    }
                }
            }
        }
        let after = *LAST_HIDE.lock().unwrap();
        if let Err(unsent) = tx.send((visible, error, after)) {
            // The caller timed out; do not hide surfaces after it has already returned.
            SUPPRESSED.store(false, Ordering::SeqCst);
            let (visible, _, _) = unsent.0;
            for label in visible {
                if let Some(window) = handle.get_webview_window(&label) {
                    let _ = super::gamescope::show(&window);
                }
            }
        }
    })
    .map_err(|e| CaptureError::new("native", e.to_string()))?;
    let (visible, error, after) = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| CaptureError::new("native", format!("Overlay hide did not complete: {e}")))?;
    let guard = Hidden {
        app: app.clone(),
        visible,
        after,
    };
    if let Some(error) = error {
        return Err(CaptureError::new("native", error));
    }
    Ok(guard)
}

struct Protected {
    app: AppHandle,
    inner: Box<dyn CaptureBackend>,
}
pub fn protect(app: AppHandle, inner: Box<dyn CaptureBackend>) -> Box<dyn CaptureBackend> {
    Box::new(Protected { app, inner })
}
impl CaptureBackend for Protected {
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    fn permission(&self) -> &'static str {
        self.inner.permission()
    }
    fn request_permission(&self) -> bool {
        self.inner.request_permission()
    }
    fn enumerate(&mut self) -> Result<Vec<Source>> {
        let mut sources=self.inner.enumerate()?;
        for source in &mut sources {super::gnome::decorate_source(source);}
        Ok(sources)
    }
    fn close(&mut self) {
        self.inner.close();
    }
    fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
        // Gamescope's public portal stream contains the base scene, without its
        // external layer overlays (measured on SteamOS 3.8.16 / 3.16.23.4). This
        // does not exclude ordinary Kimochi windows, so keep the capability false.
        if super::gamescope::scene_capture() && request.source_id.starts_with("portal:")
        {
            if super::region_editing() {
                return Err(CaptureError::new("busy", "Finish crop editing before capturing"));
            }
            return self.inner.capture(request);
        }
        let mut before = super::gnome::tracked_bounds(&request.source_id);
        let _gnome = super::gnome::suppress().map_err(|e| CaptureError::new("native", e))?;
        let hidden = hide(&self.app)?;
        // Allow compositor fade-out animations and queued PipeWire buffers to finish.
        if let Some(after) = hidden.after {
            if let Some(wait) = Duration::from_millis(350).checked_sub(after.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        let mut result = match hidden.after {
            Some(after) => self.inner.capture_after(request, after),
            None => self.inner.capture(request),
        };
        if before.is_none() {
            if let Ok(frame) = &result {
                before = super::gnome::match_window(&request.source_id, frame.info.full_width, frame.info.full_height);
            }
        }
        if let (Some(before), Some(after), Ok(frame)) = (before, result.as_ref().ok().and_then(|frame| super::gnome::tracked_frame_bounds(&request.source_id, frame.info.full_width, frame.info.full_height)), result.as_mut()) {
            if before.width == after.width && before.height == after.height {
                let sx = f64::from(frame.info.full_width) / after.width;
                let sy = f64::from(frame.info.full_height) / after.height;
                if sx > 0. && (sx - sy).abs() < 0.02 {
                    frame.info.source_bounds = Some(after);
                    frame.info.scale_factor = sx;
                }
            }
        }
        if result.is_ok(){if let Some(service)=self.app.try_state::<crate::state::Shared>(){super::gnome::refresh_identity(&service,&request.source_id);}}
        drop(hidden);
        result
    }
    // Picker/sidebar images never enter OCR or the observer. They may include
    // annotations, but must not disturb what the user is reading.
    fn preview(&mut self, request: &CaptureRequest) -> Result<Frame> {
        self.inner.capture(request)
    }
    fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
        self.inner.thumbnail(source_id, edge)
    }
}
