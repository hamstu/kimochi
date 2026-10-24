//! System audio: what the computer is playing, as mono samples stamped with the wall-clock time
//! they played at, kept in an `AudioRing` by the caller.
//!
//! The platform's capture callback runs on the OS's own thread and must not block, so it only
//! downmixes into a lock-free single-producer queue (`Feed`) and stamps each chunk; the caller
//! moves what arrived into its ring with `SystemAudio::drain_into`, from any thread, as often
//! as it likes (latency does not matter, timestamps do). A chunk that does not fit is dropped
//! whole, and the ring fills the time it covered with silence.
//!
//! Backends: macOS (ScreenCaptureKit, under the Screen Recording permission). Windows (WASAPI
//! loopback) and Linux (a PipeWire monitor stream) are not written yet: `start` reports
//! `unsupported` there.
#[cfg(not(target_os = "macos"))]
use crate::CaptureError;
use crate::Result;
use std::sync::{Arc, Mutex};

pub mod ring;
pub use ring::{AudioRing, Clip};

#[cfg(target_os = "macos")]
mod macos;

/// Queue room, in mono samples: two seconds at 48 kHz, for a caller that drains every 50ms.
const QUEUE_SAMPLES: usize = 96_000;
const QUEUE_CHUNKS: usize = 1_024;

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
}

impl Feed {
    /// Queue one chunk of `frames` mono samples (produced by `frame`, in order) that started
    /// playing at `wall_ms`. Returns false when it was dropped for lack of room.
    pub(crate) fn push(&mut self, wall_ms: f64, sample_rate: u32, frames: usize, frame: impl FnMut(usize) -> f32) -> bool {
        if frames == 0 {
            return true;
        }
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
}

fn queue() -> (Feed, Drain) {
    let (samples, sample_rx) = rtrb::RingBuffer::new(QUEUE_SAMPLES);
    let (markers, marker_rx) = rtrb::RingBuffer::new(QUEUE_CHUNKS);
    (Feed { samples, markers }, Drain { samples: sample_rx, markers: marker_rx, scratch: Vec::new() })
}

struct Drain {
    samples: rtrb::Consumer<f32>,
    markers: rtrb::Consumer<Marker>,
    scratch: Vec<f32>,
}

impl Drain {
    fn into_ring(&mut self, ring: &mut AudioRing) -> usize {
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

/// A running system-audio capture. Dropping it stops the capture.
pub struct SystemAudio {
    drain: Drain,
    health: Arc<Health>,
    #[cfg(target_os = "macos")]
    _stream: macos::Stream,
}

impl SystemAudio {
    /// Start capturing what the computer plays. Errors carry a `code`: `permission` (macOS: the
    /// Screen Recording permission is missing), `unsupported` (no backend for this OS yet), or
    /// `native`.
    pub fn start() -> Result<Self> {
        let (feed, drain) = queue();
        let health = Arc::new(Health::default());
        #[cfg(target_os = "macos")]
        {
            let stream = macos::start(feed, health.clone())?;
            Ok(Self { drain, health, _stream: stream })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (feed, drain, health);
            Err(CaptureError::new(
                "unsupported",
                "Recording system audio is not available on this system yet.",
            ))
        }
    }

    /// Move the audio that has arrived into `ring`; the number of samples moved.
    pub fn drain_into(&mut self, ring: &mut AudioRing) -> usize {
        self.drain.into_ring(ring)
    }

    /// Why the capture stopped, once it has (the stream must then be started again).
    pub fn ended(&self) -> Option<String> {
        self.health.ended.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Chunks dropped because the queue was full (the caller drained too rarely).
    pub fn dropped_chunks(&self) -> u64 {
        self.health.dropped_chunks.load(std::sync::atomic::Ordering::Relaxed)
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
        assert_eq!(drain.into_ring(&mut ring), 200);
        assert_eq!(drain.into_ring(&mut ring), 0, "nothing new");
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
        drain.into_ring(&mut ring);
        assert!(feed.push(t + 10_000.0, 1_000, 10_000, |_| 1.0));
        drain.into_ring(&mut ring);
        let gap = ring.snapshot(dropped_at + 10.0, dropped_at + 20.0).unwrap();
        assert!(gap.samples.iter().all(|&s| s == 0.0));
        assert_eq!(ring.end_ms(), Some(t + 20_000.0));
    }
}
