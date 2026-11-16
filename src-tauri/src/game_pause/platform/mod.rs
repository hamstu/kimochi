//! The per-OS backends. Each file exports `backend()` and `SUPPORTED`; everything OS-specific about
//! pausing a game lives behind [`super::backend::Backend`] in these files.
use super::backend::{Backend, Capability};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as imp;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as imp;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod imp {
    pub const SUPPORTED: bool = false;
    pub fn backend() -> Box<dyn super::Backend> {
        Box::new(super::super::backend::Unsupported)
    }
}

/// This OS's backend. Cheap to call; each call returns a fresh value (the guard keeps one).
pub fn backend() -> Box<dyn Backend> {
    imp::backend()
}

/// Whether this build can pause games at all (the settings row says so when not).
pub fn capability() -> Capability {
    let backend = imp::backend();
    Capability {
        supported: imp::SUPPORTED,
        backend: backend.name().into(),
        note: (!imp::SUPPORTED).then(|| "Not available on this system yet".into()),
    }
}
