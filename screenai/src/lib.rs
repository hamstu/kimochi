//! Chrome Screen AI as a Kimochi OCR engine.
//!
//! Google's library (`chrome_screen_ai.dll` / `libchromescreenai.so`) is never loaded into
//! Kimochi. The worker binary (`src/main.rs`, feature `worker`) loads it in a process of its own
//! and answers frames over a pipe (`wire`); Kimochi uses `client` to drive it, `proto` to read the
//! answers and `locate` to find a copy. Keeping the library out of process means a crash in it, or
//! a layout change in a future version, fails a scan instead of the app; and on macOS it lets the
//! worker alone opt out of library validation (Google signs the library, not Kimochi's team).
pub mod client;
pub mod locate;
pub mod proto;
pub mod wire;
