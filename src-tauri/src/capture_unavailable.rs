//! The capture backend used when this OS has none (or it failed to start).
//!
//! Startup must not depend on capture: the reader, dictionary, texthooker and settings
//! work without it. Every capture call answers with the same honest reason, which the
//! UI shows instead of the app refusing to launch.
use kimochi_capture::{
    Capabilities, CaptureBackend, CaptureError, CaptureRequest, Frame, Result, Source,
};

pub struct UnavailableBackend {
    reason: String,
}

impl UnavailableBackend {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    fn error(&self) -> CaptureError {
        CaptureError::new("unsupported", &self.reason)
    }
}

impl CaptureBackend for UnavailableBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            backend: "none",
            enumeration: false,
            system_picker_required: false,
            retained_session: false,
        }
    }

    fn permission(&self) -> &'static str {
        "unsupported"
    }

    fn request_permission(&self) -> bool {
        false
    }

    fn enumerate(&mut self) -> Result<Vec<Source>> {
        Err(self.error())
    }

    fn capture(&mut self, _request: &CaptureRequest) -> Result<Frame> {
        Err(self.error())
    }

    fn thumbnail(&mut self, _source_id: &str, _edge: u32) -> Result<Frame> {
        Err(self.error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_capture_call_reports_the_reason() {
        let mut backend = UnavailableBackend::new("no backend here");
        assert_eq!(backend.permission(), "unsupported");
        assert_eq!(backend.capabilities().backend, "none");
        assert!(!backend.request_permission());
        let e = backend.enumerate().unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("unsupported", "no backend here"));
        let request = CaptureRequest {
            source_id: "macos:display:1".into(),
            crop: None,
        };
        assert_eq!(backend.capture(&request).err().unwrap().code, "unsupported");
        assert_eq!(backend.thumbnail("x", 64).err().unwrap().code, "unsupported");
    }
}
