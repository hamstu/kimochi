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
                        if let Err(error) = window.show() {
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
                    if let Err(e) = window.hide() {
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
                    let _ = window.show();
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
        self.inner.enumerate()
    }
    fn close(&mut self) {
        self.inner.close();
    }
    fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
        let hidden = hide(&self.app)?;
        // Allow compositor fade-out animations and queued PipeWire buffers to finish.
        if let Some(after) = hidden.after {
            if let Some(wait) = Duration::from_millis(350).checked_sub(after.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        let result = match hidden.after {
            Some(after) => self.inner.capture_after(request, after),
            None => self.inner.capture(request),
        };
        drop(hidden);
        result
    }
    fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
        let hidden = hide(&self.app)?;
        if let Some(after) = hidden.after {
            if let Some(wait) = Duration::from_millis(350).checked_sub(after.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        let result = match hidden.after {
            Some(after) => self.inner.thumbnail_after(source_id, edge, after),
            None => self.inner.thumbnail(source_id, edge),
        };
        drop(hidden);
        result
    }
}
