//! Sentence audio's ears: from recorded system audio to the clip of each line's voice.
//!
//! - `vad`: Silero, which hears where speech is (compiled in, 2 MB).
//! - `sense_voice`, `fbank`: SenseVoice-Small, which hears what was said (downloaded on demand).
//! - `matching`: lines up a line's text with what was heard, to the character.
//! - `listener`: the whole loop. It follows the recording, cuts speech into utterances,
//!   transcribes each one once, and decides for every line what its voice was: matched by
//!   its words, placed by timing alone when there is no model or no match, or none at all.
//! - `timeline`, `trim`, `encode`: the lines, cutting and padding, MP3.
//!
//! The app (`src-tauri/src/sentence_audio`) and the lab (`src/bin/speech-lab.rs`) drive the same
//! listener, so what the lab measures is what the app does.
pub mod clips;
pub mod encode;
pub mod fbank;
pub mod listener;
pub mod matching;
pub mod readings;
pub mod sense_voice;
pub mod timeline;
pub mod trim;
pub mod vad;
pub mod wav;

pub use kimochi_capture::audio::{now_ms, AudioRing, Clip};
