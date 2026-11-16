//! "Pause the game while reading": while the reader is busy with the overlay (a lookup, controller
//! navigation, the region editor), the game's processes are suspended, and resumed when they are
//! done. Opt-in, machine-local, off by default.
//!
//! - [`manager`]: holds by reason, the state machine and pause spans (no I/O; tested on a fake).
//! - [`app`]: the manager's thread in the app, its events, and the pause-span API.
//! - [`backend`]: the contract every OS implements, and a fake for tests.
//! - [`guard`]: the separate process that owns every pause and resumes on its own when the app dies.
//! - [`journal`]: what is suspended, on disk, for recovery after a crash of both.
//! - [`target`]: which game the current selection is.
//! - `platform`: the per-OS backends.
pub mod app;
pub mod backend;
pub mod guard;
pub mod journal;
pub mod manager;
mod platform;
pub mod target;

// The pause-span API (sentence audio cuts pauses out of recordings) and the triggers' entry points.
#[allow(unused_imports)]
pub use app::{paused, send, spans_since, wait_until_resumed, EVENT_NOTICE, EVENT_SPAN, EVENT_STATUS, SETTING};
#[allow(unused_imports)]
pub use manager::{Input, PauseSpan, Reason};
