//! The local first-pass text observer: a platform seam, not a platform.
//!
//! Automatic OCR asks a cheap local engine "what does this frame say?" many times
//! a second, and spends the accurate recogniser only when the answer has stopped
//! changing. That decision is portable and lives in `ui/autoscan.ts`; what is not
//! portable is reading the text at all, and this is where that difference is
//! confined.
//!
//! Every platform answers one of three ways, and all three are honest:
//!
//!  - an `Observation`, with text and geometry in documented units;
//!  - an error, meaning the engine exists but did not answer this time;
//!  - `supported: false`, meaning there is no engine here.
//!
//! The third is a real answer, not a failure to be papered over. Automatic
//! scanning reports itself unavailable on such a platform rather than falling
//! back to sending every captured frame to a remote endpoint, which is what an
//! optimistic stub would quietly turn into.

use crate::{CaptureError, Frame, Result};
use serde::Serialize;
use std::time::Duration;

#[cfg(target_os = "macos")]
mod livetext;
/// Test seam for the main-queue reclamation ordering; see `livetext::AckProbe`.
#[cfg(target_os = "macos")]
#[doc(hidden)]
pub use livetext::AckProbe;
/// Test support, compiled on macOS so the integration tests can reach it.
/// Nothing in the shipping path calls it; release builds strip it.
#[cfg(target_os = "macos")]
pub mod fixture;

mod cache;
pub use cache::CachedObserver;

/// One recognised line.
///
/// Coordinates are **pixels in the observed frame**, top-left origin, in the same
/// space as `FrameInfo.width` and `FrameInfo.height` — that is, already cropped
/// and already scaled by the display's backing factor. They are not desktop
/// points, not normalised, and not relative to the uncropped source. A consumer
/// that wants desktop points adds `FrameInfo.crop_pixels` and divides by
/// `FrameInfo.scale_factor`.
///
/// Engines that answer in their own units convert here rather than leaking them:
/// Apple Live Text reports fractions of the image, and the macOS adapter scales
/// them by the frame's width and height before returning.
#[derive(Debug, Clone, Serialize)]
pub struct TextLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the observer read from one frame.
#[derive(Debug, Clone, Serialize)]
pub struct Observation {
    /// Which engine produced this, for diagnostics.
    pub engine: &'static str,
    /// The lines joined in reading order, which is what settling compares.
    pub text: String,
    pub lines: Vec<TextLine>,
    /// How long the engine took. Automatic scanning is only cheap if this is.
    pub duration_ms: f64,
}

/// Whether this build, on this machine, can observe text at all.
#[derive(Debug, Clone, Serialize)]
pub struct ObserverStatus {
    pub supported: bool,
    pub engine: &'static str,
    /// Oldest OS this engine is known to work on; empty when unsupported.
    pub minimum_os: &'static str,
    /// Whether the engine is reached through private, unpublished API.
    pub private_api: bool,
    /// A sentence fit to put in front of a user.
    pub detail: String,
    /// How many observations have been abandoned and cancelled so far.
    ///
    /// Reported because "the observer is slow" and "the observer is broken" look
    /// identical from the scheduler's side otherwise: one shows as timeouts
    /// climbing while observations still succeed, the other as neither.
    pub timeouts: u32,
}

pub trait TextObserver: Send {
    fn status(&self) -> ObserverStatus;
    /// Read the frame. Must not block longer than `timeout`.
    fn observe(&mut self, frame: &Frame, timeout: Duration) -> Result<Observation>;
    fn close(&mut self) {}
}

/// Join lines into the string the settling policy compares.
///
/// Newlines rather than spaces, and no other reflowing: normalisation belongs to
/// the policy, which folds whitespace anyway, and a reader of the diagnostics
/// should see the lines the engine actually returned.
pub fn join_lines(lines: &[TextLine]) -> String {
    lines
        .iter()
        .map(|line| line.text.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The answer on a platform with no local observer.
///
/// It never succeeds and never pretends to. Automatic scanning surfaces this to
/// the user as "unavailable here" and keeps manual scanning working.
pub struct UnsupportedObserver {
    detail: &'static str,
}

impl UnsupportedObserver {
    pub fn new(detail: &'static str) -> Self {
        Self { detail }
    }
}

impl TextObserver for UnsupportedObserver {
    fn status(&self) -> ObserverStatus {
        ObserverStatus {
            supported: false,
            engine: "none",
            minimum_os: "",
            private_api: false,
            detail: self.detail.to_string(),
            timeouts: 0,
        }
    }

    fn observe(&mut self, _frame: &Frame, _timeout: Duration) -> Result<Observation> {
        Err(CaptureError::new("unsupported", self.detail))
    }
}

/// Why Windows has no observer yet, in the words the user will see.
///
/// The eventual adapter is Meiki (`meikiocr`), which GSM uses on Windows and
/// Linux. Two things have to be settled before it can land here, and neither is
/// a line of glue code:
///
///  - GSM runs Meiki in **detection-only** mode on Windows: it returns boxes, not
///    words. That is not interchangeable with the text this trait promises, so
///    the adapter must either run Meiki's recognition head or the settling policy
///    must gain a boxes-plus-content path. Box geometry alone cannot tell a new
///    sentence in the same dialogue box from the old one — the blind spot
///    documented in GSM_AUTO_OCR_RESEARCH.md that this pipeline exists to avoid.
///  - Meiki is Python with ONNX Runtime and downloaded model weights. Shipping it
///    means either a Python sidecar or an ONNX runtime bound directly from Rust,
///    plus model licensing checked per artifact.
pub const WINDOWS_DETAIL: &str = "Automatic scanning needs a local text observer, and there is not one on Windows yet: a local MeikiOCR observer is planned. Manual scanning works normally.";

pub const OTHER_DETAIL: &str = "Automatic scanning needs a local text observer, which this platform does not have. Manual scanning works normally.";

/// The observer for the platform this was built for.
///
/// Infallible on purpose: "there is no observer here" is an answer this returns,
/// not an error it fails with, so the caller always has something to report.
pub fn platform_observer() -> Box<dyn TextObserver> {
    #[cfg(target_os = "macos")]
    {
        Box::new(livetext::LiveTextObserver::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(UnsupportedObserver::new(WINDOWS_DETAIL))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(UnsupportedObserver::new(OTHER_DETAIL))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FrameInfo;

    fn frame() -> Frame {
        Frame {
            info: FrameInfo {
                source_id: "test".into(),
                width: 2,
                height: 2,
                stride: 8,
                full_width: 2,
                full_height: 2,
                crop_pixels: [0, 0, 2, 2],
                scale_factor: 1.0,
                source_bounds: None,
                pixel_format: "rgba8",
                color_space: "srgb",
                resolve_ms: 0.0,
                acquisition_ms: 0.0,
                pixels_ms: 0.0,
                total_ms: 0.0,
            },
            pixels: vec![0; 16],
        }
    }

    fn line(text: &str) -> TextLine {
        TextLine {
            text: text.into(),
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }

    #[test]
    fn an_unsupported_observer_fails_every_time_and_says_why() {
        let mut observer = UnsupportedObserver::new(WINDOWS_DETAIL);
        let status = observer.status();
        assert!(!status.supported);
        assert_eq!(status.engine, "none");

        let error = observer
            .observe(&frame(), Duration::from_millis(10))
            .unwrap_err();
        assert_eq!(error.code, "unsupported");
        assert!(error.message.contains("Manual scanning works normally"));
    }

    #[test]
    fn every_platform_has_an_observer_to_report_on() {
        let status = platform_observer().status();
        if cfg!(target_os = "macos") {
            assert_eq!(status.engine, "apple-live-text");
            assert!(
                status.private_api,
                "the maintenance assumption is disclosed"
            );
            assert_eq!(status.minimum_os, "macOS 13");
        } else {
            assert!(!status.supported);
            assert!(!status.detail.is_empty());
        }
    }

    #[test]
    fn lines_join_in_reading_order_and_blank_lines_are_dropped() {
        assert_eq!(
            join_lines(&[line("一行目"), line("  "), line(" 二行目 ")]),
            "一行目\n二行目"
        );
        assert_eq!(join_lines(&[]), "");
    }

    #[test]
    fn cache_reuses_only_identical_pixels_and_geometry_without_hiding_changes() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct NoisyObserver(Arc<AtomicUsize>);
        impl TextObserver for NoisyObserver {
            fn status(&self) -> ObserverStatus {
                UnsupportedObserver::new("test").status()
            }
            fn observe(&mut self, _: &Frame, _: Duration) -> Result<Observation> {
                let call = self.0.fetch_add(1, Ordering::SeqCst);
                Ok(Observation {
                    engine: "test",
                    text: format!("reading-{call}"),
                    lines: vec![],
                    duration_ms: 10.0,
                })
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let mut observer = CachedObserver::new(Box::new(NoisyObserver(calls.clone())));
        let mut image = frame();
        let read = observer.observe(&image, Duration::from_secs(1)).unwrap();
        for _ in 0..20 {
            let next = observer.observe(&image, Duration::from_secs(1)).unwrap();
            assert_eq!(read.text, next.text);
            assert_eq!(next.duration_ms, 0.0);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        image.pixels[0] = 1; // Even a one-byte glyph edit must cause a fresh read.
        assert_ne!(
            observer
                .observe(&image, Duration::from_secs(1))
                .unwrap()
                .text,
            read.text
        );
        image.info.source_id = "other-source".into();
        observer.observe(&image, Duration::from_secs(1)).unwrap();
        image.info.crop_pixels[0] = 1;
        observer.observe(&image, Duration::from_secs(1)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }
}
