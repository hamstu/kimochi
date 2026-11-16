//! "Pause the game while reading": while the reader is busy with the overlay (a lookup, controller
//! navigation, the region editor), the game's processes are suspended, and resumed when they are
//! done. Opt-in, machine-local, off by default.
//!
//! - [`backend`]: the contract every OS implements, and a fake for tests.
//! - [`guard`]: the separate process that owns every pause and resumes on its own when the app dies.
//! - [`journal`]: what is suspended, on disk, for recovery after a crash of both.
//! - [`target`]: which game the current selection is.
//! - `platform`: the per-OS backends.
// Skeleton: the hold manager and its wiring land next.
#![allow(dead_code, unused_imports)]
pub mod backend;
pub mod guard;
pub mod journal;
mod platform;
pub mod target;

pub use platform::{backend as platform_backend, capability};
