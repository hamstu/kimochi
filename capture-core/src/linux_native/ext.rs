//! The `ext` driver. See the table in `mod.rs`.
use super::Driver;

pub fn probe() -> std::result::Result<Box<dyn Driver>, String> {
    Err("not implemented yet".into())
}
