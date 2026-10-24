//! System audio: what the computer is playing, as mono samples stamped with the wall-clock time
//! they played at, kept in an `AudioRing` by the caller.
//!
//! The platform's capture callback runs on the OS's own thread and must not block, so it only
//! downmixes into a lock-free single-producer queue (`Feed`) and stamps each chunk; the caller
//! moves what arrived into its ring with `SystemAudio::drain_into`, from any thread, as often
//! as it likes (latency does not matter, timestamps do). A chunk that does not fit is dropped
//! whole, and the ring fills the time it covered with silence.
//!
//! Backends, each behind `Backend` (what it records from, whether Kimochi's own sounds are left
//! out; dropping it stops it):
//! - macOS: ScreenCaptureKit, under the Screen Recording permission (`macos.rs`).
//! - Windows: WASAPI process loopback of everything but Kimochi's process tree (Windows 10 2004+),
//!   else loopback of the default output device (`windows.rs`).
//! - Linux: a PipeWire capture stream on the default output's monitor (`linux.rs`).
//!
//! Elsewhere `start` reports `unsupported`.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use crate::CaptureError;
use crate::Result;
use std::sync::{Arc, Mutex};

pub mod ring;
pub use ring::{AudioRing, Clip};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Queue room, in mono samples: two seconds at 48 kHz, for a caller that drains every 50ms.
const QUEUE_SAMPLES: usize = 96_000;
const QUEUE_CHUNKS: usize = 1_024;
/// A backend that delivers nothing while nothing plays (WASAPI loopback, a suspended PipeWire
/// sink) is padded with silence once it has been quiet this long…
#[cfg_attr(target_os = "macos", allow(dead_code))]
const PAD_AFTER_MS: f64 = 400.0;
/// …up to this long ago, leaving room for audio that is on its way.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const PAD_LAG_MS: f64 = 200.0;

/// A running platform capture. Dropping it stops the capture.
pub(crate) trait Backend: Send {
    /// What is recorded, for Settings ("Speakers (Realtek Audio)", "PipeWire: Built-in Audio").
    fn source(&self) -> String;
    /// Whether Kimochi's own sounds (its webviews included) are left out of the recording.
    fn excludes_own_audio(&self) -> bool;
}

/// One chunk's stamp; its samples follow it in the sample queue.
#[derive(Debug, Clone, Copy)]
struct Marker {
    wall_ms: f64,
    sample_rate: u32,
    len: usize,
}

/// The producer side, owned by the platform callback.
pub(crate) struct Feed {
    samples: rtrb::Producer<f32>,
    markers: rtrb::Producer<Marker>,
    /// Where the last chunk ended (wall ms) and its rate, for `pad_silence`.
    end: Option<(f64, u32)>,
}

impl Feed {
    /// Queue one chunk of `frames` mono samples (produced by `frame`, in order) that started
    /// playing at `wall_ms`. Returns false when it was dropped for lack of room.
    pub(crate) fn push(&mut self, wall_ms: f64, sample_rate: u32, frames: usize, frame: impl FnMut(usize) -> f32) -> bool {
        if frames == 0 || sample_rate == 0 {
            return true;
        }
        self.end = Some((wall_ms + frames as f64 * 1000.0 / sample_rate as f64, sample_rate));
        if self.markers.slots() == 0 {
            return false;
        }
        let Ok(chunk) = self.samples.write_chunk_uninit(frames) else {
            return false;
        };
        chunk.fill_from_iter((0..frames).map(frame));
        // The marker goes in after its samples, so a consumer that sees it can read them.
        let _ = self.markers.push(Marker { wall_ms, sample_rate, len: frames });
        true
    }

    /// The stream started at `wall_ms` at `sample_rate`: silence is padded from here even when
    /// nothing ever arrives.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(crate) fn begin(&mut self, wall_ms: f64, sample_rate: u32) {
        if self.end.is_none() && sample_rate > 0 {
            self.end = Some((wall_ms, sample_rate));
        }
    }

    /// For a backend that goes quiet by delivering nothing: when nothing has arrived for a while,
    /// queue silence up to shortly before `now_ms`, so the ring keeps up with the clock.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(crate) fn pad_silence(&mut self, now_ms: f64) {
        let Some((end, rate)) = self.end else { return };
        if now_ms - end < PAD_AFTER_MS {
            return;
        }
        let frames = ((now_ms - PAD_LAG_MS - end) * rate as f64 / 1000.0) as usize;
        // In pieces the queue can take.
        let piece = (rate as usize / 4).max(1);
        let mut at = end;
        let mut left = frames;
        while left > 0 {
            let n = left.min(piece);
            if !self.push(at, rate, n, |_| 0.0) {
                return;
            }
            at += n as f64 * 1000.0 / rate as f64;
            left -= n;
        }
    }
}

/// How samples are stored in an interleaved buffer.
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)] // Each backend uses the formats its platform delivers.
pub(crate) enum SampleFormat {
    F32,
    I16,
    I32,
}

impl SampleFormat {
    pub(crate) fn bytes(self) -> usize {
        match self {
            SampleFormat::I16 => 2,
            SampleFormat::F32 | SampleFormat::I32 => 4,
        }
    }
}

/// Frame `frame` of interleaved little-endian `data` with `channels` channels, as one mono sample.
#[allow(dead_code)]
pub(crate) fn mono_frame(data: &[u8], channels: usize, format: SampleFormat, frame: usize) -> f32 {
    let width = format.bytes();
    let mut sum = 0.0;
    for channel in 0..channels {
        let at = (frame * channels + channel) * width;
        let Some(b) = data.get(at..at + width) else { return 0.0 };
        sum += match format {
            SampleFormat::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            SampleFormat::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
            SampleFormat::I32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        };
    }
    sum / channels.max(1) as f32
}

fn queue() -> (Feed, Drain) {
    let (samples, sample_rx) = rtrb::RingBuffer::new(QUEUE_SAMPLES);
    let (markers, marker_rx) = rtrb::RingBuffer::new(QUEUE_CHUNKS);
    (Feed { samples, markers, end: None }, Drain { samples: sample_rx, markers: marker_rx, scratch: Vec::new() })
}

struct Drain {
    samples: rtrb::Consumer<f32>,
    markers: rtrb::Consumer<Marker>,
    scratch: Vec<f32>,
}

impl Drain {
    fn move_into(&mut self, ring: &mut AudioRing) -> usize {
        let mut moved = 0;
        while let Ok(marker) = self.markers.pop() {
            let Ok(chunk) = self.samples.read_chunk(marker.len) else {
                break;
            };
            let (a, b) = chunk.as_slices();
            self.scratch.clear();
            self.scratch.extend_from_slice(a);
            self.scratch.extend_from_slice(b);
            chunk.commit_all();
            ring.push(marker.wall_ms, marker.sample_rate, &self.scratch);
            moved += marker.len;
        }
        moved
    }
}

/// How a running capture is doing, shared with its callbacks.
#[derive(Default)]
pub(crate) struct Health {
    /// Why the stream stopped, once it has.
    pub(crate) ended: Mutex<Option<String>>,
    pub(crate) dropped_chunks: std::sync::atomic::AtomicU64,
}

impl Health {
    #[allow(dead_code)]
    pub(crate) fn end(&self, why: impl Into<String>) {
        let mut ended = self.ended.lock().unwrap_or_else(|p| p.into_inner());
        if ended.is_none() {
            *ended = Some(why.into());
        }
    }
}

/// A running system-audio capture. Dropping it stops the capture.
pub struct SystemAudio {
    drain: Drain,
    health: Arc<Health>,
    backend: Box<dyn Backend>,
}

impl SystemAudio {
    /// Start capturing what the computer plays. Errors carry a `code`: `permission` (macOS: the
    /// Screen Recording permission is missing), `unavailable` (this computer cannot record its
    /// audio now: no output device, no PipeWire; worth trying again later), `unsupported` (no
    /// backend for this OS), or `native`.
    pub fn start() -> Result<Self> {
        let (feed, drain) = queue();
        let health = Arc::new(Health::default());
        #[cfg(target_os = "macos")]
        let backend: Box<dyn Backend> = Box::new(macos::start(feed, health.clone())?);
        #[cfg(target_os = "windows")]
        let backend: Box<dyn Backend> = Box::new(windows::start(feed, health.clone())?);
        #[cfg(target_os = "linux")]
        let backend: Box<dyn Backend> = Box::new(linux::start(feed, health.clone())?);
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        let backend: Box<dyn Backend> = {
            let _ = feed;
            return Err(CaptureError::new("unsupported", "Recording system audio is not available on this system."));
        };
        Ok(Self { drain, health, backend })
    }

    /// Move the audio that has arrived into `ring`; the number of samples moved.
    pub fn drain_into(&mut self, ring: &mut AudioRing) -> usize {
        self.drain.move_into(ring)
    }

    /// Why the capture stopped, once it has (the stream must then be started again).
    pub fn ended(&self) -> Option<String> {
        self.health.ended.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Chunks dropped because the queue was full (the caller drained too rarely).
    pub fn dropped_chunks(&self) -> u64 {
        self.health.dropped_chunks.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// What is being recorded.
    pub fn source(&self) -> String {
        self.backend.source()
    }

    /// Whether Kimochi's own sounds are left out of the recording.
    pub fn excludes_own_audio(&self) -> bool {
        self.backend.excludes_own_audio()
    }
}

/// Wall-clock now, in Unix milliseconds: the time base of every stamp.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_chunks_reach_the_ring_with_their_stamps() {
        let (mut feed, mut drain) = queue();
        assert!(feed.push(1_000.0, 1_000, 100, |i| i as f32));
        assert!(feed.push(1_100.0, 1_000, 100, |i| 100.0 + i as f32));
        let mut ring = AudioRing::new(1_000, 10.0);
        assert_eq!(drain.move_into(&mut ring), 200);
        assert_eq!(drain.move_into(&mut ring), 0, "nothing new");
        let clip = ring.snapshot(1_150.0, 1_152.0).unwrap();
        assert_eq!(clip.samples, vec![150.0, 151.0]);
    }

    #[test]
    fn a_chunk_that_does_not_fit_is_dropped_whole_and_its_time_becomes_silence() {
        let (mut feed, mut drain) = queue();
        let mut ring = AudioRing::new(1_000, 1_000.0);
        let mut t = 0.0;
        // Fill the queue without draining.
        while feed.push(t, 1_000, 10_000, |_| 1.0) {
            t += 10_000.0;
        }
        let dropped_at = t;
        drain.move_into(&mut ring);
        assert!(feed.push(t + 10_000.0, 1_000, 10_000, |_| 1.0));
        drain.move_into(&mut ring);
        let gap = ring.snapshot(dropped_at + 10.0, dropped_at + 20.0).unwrap();
        assert!(gap.samples.iter().all(|&s| s == 0.0));
        assert_eq!(ring.end_ms(), Some(t + 20_000.0));
    }

    #[test]
    fn a_backend_gone_quiet_is_padded_with_silence_behind_the_clock() {
        let (mut feed, mut drain) = queue();
        feed.pad_silence(5_000.0);
        assert!(drain.markers.is_empty(), "nothing to pad before any audio");
        let mut ring = AudioRing::new(1_000, 10.0);
        let (mut quiet, mut quiet_drain) = queue();
        quiet.begin(0.0, 1_000);
        quiet.pad_silence(1_000.0);
        quiet_drain.move_into(&mut ring);
        assert_eq!(ring.end_ms(), Some(800.0), "a stream silent from the start is padded too");
        ring.clear();
        feed.push(1_000.0, 1_000, 100, |_| 1.0);
        drain.move_into(&mut ring);
        feed.pad_silence(1_300.0);
        assert!(drain.markers.is_empty(), "too soon");
        feed.pad_silence(3_100.0);
        drain.move_into(&mut ring);
        assert_eq!(ring.end_ms(), Some(2_900.0), "padded to 200ms before now");
        assert!(ring.snapshot(1_100.0, 2_900.0).unwrap().samples.iter().all(|&s| s == 0.0));
        // Audio arriving afterwards lands at its own time.
        feed.push(3_050.0, 1_000, 10, |_| 0.5);
        drain.move_into(&mut ring);
        assert_eq!(ring.snapshot(3_052.0, 3_053.0).unwrap().samples, vec![0.5]);
    }

    #[test]
    fn interleaved_frames_are_mixed_to_mono() {
        let f32s: Vec<u8> = [0.5f32, -0.5, 1.0, 0.0].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(mono_frame(&f32s, 2, SampleFormat::F32, 0), 0.0);
        assert_eq!(mono_frame(&f32s, 2, SampleFormat::F32, 1), 0.5);
        assert_eq!(mono_frame(&f32s, 2, SampleFormat::F32, 2), 0.0, "past the end reads as silence");
        let i16s: Vec<u8> = [16_384i16, 16_384].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(mono_frame(&i16s, 2, SampleFormat::I16, 0), 0.5);
        let i32s: Vec<u8> = (-1_073_741_824i32).to_le_bytes().to_vec();
        assert_eq!(mono_frame(&i32s, 1, SampleFormat::I32, 0), -0.5);
    }
}
