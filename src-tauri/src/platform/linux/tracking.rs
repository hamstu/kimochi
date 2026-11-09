//! Compositor window geometry for portal window streams: KWin's script bridge on KDE Plasma
//! (`kwin.rs`), Hyprland's IPC socket (`hyprland.rs`), else nothing. GNOME's Shell extension has
//! its own path (`gnome.rs`). Each backend links a stream to one window and reports it in
//! overlay-local logical pixels; see those modules for the matching rules.
use kimochi_capture::{Frame, Rect};
use serde_json::Value;

use super::{hyprland, kwin};

/// Which backend answers this session (decided by the session, never both).
fn kde() -> bool {
    super::session().compositor.as_deref() == Some("KDE")
}

pub fn available() -> bool {
    if kde() { kwin::available() } else { hyprland::available() }
}
pub fn pointer() -> Option<Value> {
    if kde() { kwin::pointer() } else { hyprland::pointer() }
}
pub fn clear() {
    kwin::clear();
    hyprland::clear();
}
pub fn tracked(source: &str) -> Option<(Rect, bool)> {
    if kde() { kwin::tracked(source) } else { hyprland::tracked(source) }
}
pub fn frame_bounds(source: &str, width: u32, height: u32) -> Option<Rect> {
    if kde() { kwin::frame_bounds(source, width, height) } else { hyprland::frame_bounds(source, width, height) }
}
pub fn enrich(frame: &mut Frame) {
    if kde() { kwin::enrich(frame) } else { hyprland::enrich(frame) }
}
pub fn identity(source: &str) -> Option<Value> {
    if kde() { kwin::identity(source) } else { hyprland::identity(source) }
}
pub fn status(source: &str) -> Value {
    if kde() { kwin::status(source) } else { hyprland::status(source) }
}
pub fn candidates(width: u32, height: u32) -> Result<Value, String> {
    if kde() { kwin::candidates(width, height) } else { hyprland::candidates(width, height) }
}
pub fn link(source: &str, window: &str, width: u32, height: u32) -> Result<(), String> {
    if kde() { kwin::link(source, window, width, height) } else { hyprland::link(source, window, width, height) }
}
/// A linked window's own stream (KWin renders the window alone, as GNOME does), which Kimochi's
/// overlay and pop-ups cannot appear in: no need to hide them for its captures.
pub fn isolated(source: &str) -> bool {
    kde() && source.starts_with("portal:window:") && kwin::linked(source)
}
/// Bring the linked window forward. `None` when this compositor has no way to.
pub fn activate(source: &str) -> Option<Result<(), String>> {
    (kde() && kwin::available()).then(|| kwin::activate(source))
}
