//! Game pause backend for this OS. Stub: refuses every pause as unsupported until the real
//! backend lands. See `super::super::backend::Backend` for the contract.
use super::super::backend::{Backend, Unsupported};

/// Flip to `true` once `backend()` returns a working implementation.
pub const SUPPORTED: bool = false;

pub fn backend() -> Box<dyn Backend> {
    Box::new(Unsupported)
}
