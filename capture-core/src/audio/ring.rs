//! The last few seconds of system audio, mono, with a timestamp index so a wall-clock time
//! (a texthooker line's arrival, a card being added) can be turned into a sample position.
//!
//! Samples are appended in chunks, each stamped with the wall-clock time of its first sample.
//! Every chunk leaves a mark `(sample index, wall ms)`; a time maps to a sample by the nearest
//! mark at or before it, extrapolated at the sample rate. Marks absorb the drift between the
//! audio clock and the wall clock, so a long-running buffer stays accurate to a chunk.
//!
//! A chunk that starts noticeably later than the previous one ended (the stream paused, a
//! chunk was dropped) is preceded by silence for the missing time, so sample positions keep
//! matching wall-clock time. A chunk that starts earlier (jitter, a clock step) is appended
//! as it is; its mark is skipped if it would run backwards.
use std::collections::VecDeque;

/// Gaps shorter than this are timing jitter, not missing audio.
const GAP_TOLERANCE_MS: f64 = 40.0;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Mark {
    /// Absolute sample index (counted from the first sample this ring ever held).
    index: u64,
    wall_ms: f64,
}

/// A stretch of audio copied out of the ring.
#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    /// Wall-clock time of `samples[0]`, in Unix milliseconds.
    pub start_ms: f64,
}

impl Clip {
    pub fn duration_ms(&self) -> f64 {
        self.samples.len() as f64 * 1000.0 / self.sample_rate as f64
    }
    pub fn end_ms(&self) -> f64 {
        self.start_ms + self.duration_ms()
    }
}

#[derive(Debug)]
pub struct AudioRing {
    sample_rate: u32,
    capacity: usize,
    samples: VecDeque<f32>,
    /// Absolute index of `samples[0]`.
    first: u64,
    marks: VecDeque<Mark>,
}

impl AudioRing {
    /// A ring holding `seconds` of audio at `sample_rate` (the rate may change later: see `push`).
    pub fn new(sample_rate: u32, seconds: f64) -> Self {
        let sample_rate = sample_rate.max(1);
        let capacity = ((seconds.max(0.1) * sample_rate as f64) as usize).max(1);
        Self {
            sample_rate,
            capacity,
            samples: VecDeque::with_capacity(capacity),
            first: 0,
            marks: VecDeque::new(),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn seconds(&self) -> f64 {
        self.capacity as f64 / self.sample_rate as f64
    }

    /// Keep `seconds` of audio from now on, dropping the oldest if that is less than held.
    pub fn set_seconds(&mut self, seconds: f64) {
        self.capacity = ((seconds.max(0.1) * self.sample_rate as f64) as usize).max(1);
        self.trim();
    }

    pub fn clear(&mut self) {
        self.first += self.samples.len() as u64;
        self.samples.clear();
        self.marks.clear();
    }

    fn end(&self) -> u64 {
        self.first + self.samples.len() as u64
    }

    /// Append mono `samples` whose first sample played at `wall_ms`. A different `sample_rate`
    /// than the ring's starts the ring afresh at the new rate.
    pub fn push(&mut self, wall_ms: f64, sample_rate: u32, samples: &[f32]) {
        if samples.is_empty() || !wall_ms.is_finite() {
            return;
        }
        if sample_rate != self.sample_rate && sample_rate > 0 {
            let seconds = self.seconds();
            self.clear();
            self.sample_rate = sample_rate;
            self.capacity = ((seconds * sample_rate as f64) as usize).max(1);
        }
        if let Some(expected) = self.end_ms() {
            let gap = wall_ms - expected;
            if gap > self.seconds() * 1000.0 {
                // Nothing of what is held would survive the silence.
                self.clear();
            } else if gap > GAP_TOLERANCE_MS {
                let missing = (gap * self.sample_rate as f64 / 1000.0).round() as usize;
                let start = self.end();
                self.samples.extend(std::iter::repeat_n(0.0, missing));
                // The silence starts where the audio stopped.
                self.marks.push_back(Mark { index: start, wall_ms: expected });
            }
        }
        let mark = Mark { index: self.end(), wall_ms };
        if self.marks.back().is_none_or(|last| wall_ms > last.wall_ms) {
            self.marks.push_back(mark);
        }
        self.samples.extend(samples.iter().copied());
        self.trim();
    }

    fn trim(&mut self) {
        let excess = self.samples.len().saturating_sub(self.capacity);
        if excess > 0 {
            self.samples.drain(..excess);
            self.first += excess as u64;
        }
        // Keep the newest mark at or before `first`: times inside the ring extrapolate from it.
        while self.marks.len() > 1 && self.marks[1].index <= self.first {
            self.marks.pop_front();
        }
    }

    /// The mark a time (or an index) is measured from: the newest one not after it, or the
    /// oldest one for anything before every mark.
    fn mark_for(&self, at: impl Fn(&Mark) -> bool) -> Option<Mark> {
        let after = self.marks.partition_point(at);
        self.marks.get(after.saturating_sub(1)).copied()
    }

    /// The (fractional) absolute sample index that played at `wall_ms`.
    fn index_at(&self, wall_ms: f64) -> Option<f64> {
        let mark = self.mark_for(|m| m.wall_ms <= wall_ms)?;
        Some(mark.index as f64 + (wall_ms - mark.wall_ms) * self.sample_rate as f64 / 1000.0)
    }

    /// When the sample at absolute `index` played.
    fn wall_at(&self, index: u64) -> Option<f64> {
        let mark = self.mark_for(|m| m.index <= index)?;
        Some(mark.wall_ms + (index as f64 - mark.index as f64) * 1000.0 / self.sample_rate as f64)
    }

    /// Wall-clock time of the oldest sample held.
    pub fn start_ms(&self) -> Option<f64> {
        if self.samples.is_empty() {
            return None;
        }
        self.wall_at(self.first)
    }

    /// Wall-clock time just after the newest sample held.
    pub fn end_ms(&self) -> Option<f64> {
        if self.samples.is_empty() {
            return None;
        }
        self.wall_at(self.end())
    }

    /// The absolute index of the oldest sample held. Indices count every sample the ring ever
    /// held, so they only grow (a `clear` moves past what was dropped).
    pub fn first_index(&self) -> u64 {
        self.first
    }

    /// The absolute index the next sample will have.
    pub fn end_index(&self) -> u64 {
        self.end()
    }

    /// The samples from absolute `index` (or the oldest held, when that is later) to the newest,
    /// and the index they start at: for a reader that follows the ring as it fills.
    pub fn read_from(&self, index: u64) -> (u64, Vec<f32>) {
        let start = index.clamp(self.first, self.end());
        let samples = self.samples.range((start - self.first) as usize..).copied().collect();
        (start, samples)
    }

    /// When the sample at absolute `index` played, in Unix ms.
    pub fn wall_ms_at(&self, index: u64) -> Option<f64> {
        self.wall_at(index)
    }

    /// The audio that played between `from_ms` and `to_ms`, cut to what the ring holds; `None`
    /// when none of it is held.
    pub fn snapshot(&self, from_ms: f64, to_ms: f64) -> Option<Clip> {
        if self.samples.is_empty() || to_ms.partial_cmp(&from_ms) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        let from = self.index_at(from_ms)?.round().max(self.first as f64) as u64;
        let to = self.index_at(to_ms)?.round().min(self.end() as f64).max(0.0) as u64;
        if to <= from {
            return None;
        }
        let (a, b) = ((from - self.first) as usize, (to - self.first) as usize);
        Some(Clip {
            samples: self.samples.range(a..b).copied().collect(),
            sample_rate: self.sample_rate,
            start_ms: self.wall_at(from)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 1000; // one sample per millisecond keeps the arithmetic readable

    /// `n` samples whose values are their own wall-clock times (in ms since `t0`).
    fn ramp(t0: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (t0 + i as f64) as f32).collect()
    }

    #[test]
    fn a_wall_clock_time_maps_to_the_sample_that_played_then() {
        let mut ring = AudioRing::new(RATE, 10.0);
        for chunk in 0..5 {
            let t0 = 1_000.0 + chunk as f64 * 100.0;
            ring.push(t0, RATE, &ramp(t0, 100));
        }
        assert_eq!(ring.start_ms(), Some(1_000.0));
        assert_eq!(ring.end_ms(), Some(1_500.0));
        let clip = ring.snapshot(1_250.0, 1_260.0).unwrap();
        assert_eq!(clip.start_ms, 1_250.0);
        assert_eq!(clip.samples, ramp(1_250.0, 10));
    }

    #[test]
    fn a_reader_follows_the_ring_by_absolute_index() {
        let mut ring = AudioRing::new(RATE, 0.3);
        ring.push(1_000.0, RATE, &ramp(1_000.0, 200));
        let (start, first) = ring.read_from(0);
        assert_eq!((start, first.len()), (0, 200));
        ring.push(1_200.0, RATE, &ramp(1_200.0, 200));
        // 100 samples fell out of the 300-sample ring before the reader came back.
        assert_eq!((ring.first_index(), ring.end_index()), (100, 400));
        let (start, next) = ring.read_from(200);
        assert_eq!((start, next), (200, ramp(1_200.0, 200)));
        assert_eq!(ring.read_from(50).0, 100, "what was dropped is skipped");
        assert_eq!(ring.wall_ms_at(250), Some(1_250.0));
        ring.clear();
        assert_eq!(ring.read_from(400), (400, vec![]));
    }

    #[test]
    fn a_request_is_cut_to_what_the_ring_holds() {
        let mut ring = AudioRing::new(RATE, 10.0);
        ring.push(1_000.0, RATE, &ramp(1_000.0, 500));
        let clip = ring.snapshot(0.0, 99_999.0).unwrap();
        assert_eq!((clip.start_ms, clip.end_ms()), (1_000.0, 1_500.0));
        assert!(ring.snapshot(2_000.0, 3_000.0).is_none(), "after the newest sample");
        assert!(ring.snapshot(0.0, 900.0).is_none(), "before the oldest sample");
        assert!(ring.snapshot(1_200.0, 1_200.0).is_none(), "an empty range");
        assert!(AudioRing::new(RATE, 1.0).snapshot(0.0, 1.0).is_none(), "an empty ring");
    }

    #[test]
    fn the_oldest_audio_is_dropped_at_capacity_and_times_stay_right() {
        let mut ring = AudioRing::new(RATE, 1.0);
        for chunk in 0..30 {
            let t0 = chunk as f64 * 100.0;
            ring.push(t0, RATE, &ramp(t0, 100));
        }
        assert_eq!(ring.len(), 1_000);
        assert_eq!(ring.start_ms(), Some(2_000.0));
        assert_eq!(ring.end_ms(), Some(3_000.0));
        assert_eq!(ring.snapshot(2_500.0, 2_503.0).unwrap().samples, ramp(2_500.0, 3));
        assert!(ring.marks.len() <= 11, "old marks are let go: {}", ring.marks.len());
    }

    #[test]
    fn a_pause_in_delivery_is_filled_with_silence_of_the_same_length() {
        let mut ring = AudioRing::new(RATE, 10.0);
        ring.push(1_000.0, RATE, &ramp(1_000.0, 100));
        // Nothing arrives for 400ms.
        ring.push(1_500.0, RATE, &ramp(1_500.0, 100));
        assert_eq!(ring.len(), 600);
        let gap = ring.snapshot(1_100.0, 1_500.0).unwrap();
        assert!(gap.samples.iter().all(|&s| s == 0.0));
        assert_eq!(ring.snapshot(1_550.0, 1_552.0).unwrap().samples, ramp(1_550.0, 2));
    }

    #[test]
    fn jitter_is_not_mistaken_for_a_gap_and_marks_absorb_drift() {
        let mut ring = AudioRing::new(RATE, 10.0);
        // The audio clock runs 1% slow against the wall clock: each 100-sample chunk is
        // stamped 101ms after the last, a 1ms gap well inside the tolerance.
        for chunk in 0..50 {
            let t0 = chunk as f64 * 101.0;
            ring.push(t0, RATE, &vec![chunk as f32; 100]);
        }
        assert_eq!(ring.len(), 5_000, "no silence was inserted");
        // A time late in the buffer still lands in the chunk stamped for it.
        let clip = ring.snapshot(40.0 * 101.0 + 10.0, 40.0 * 101.0 + 20.0).unwrap();
        assert!(clip.samples.iter().all(|&s| s == 40.0), "{:?}", clip.samples);
        // A chunk stamped before the last mark (a clock step) is appended without a mark.
        let marks = ring.marks.len();
        ring.push(49.0 * 101.0 - 10.0, RATE, &[7.0; 10]);
        assert_eq!((ring.len(), ring.marks.len()), (5_010, marks));
    }

    #[test]
    fn a_silence_longer_than_the_ring_starts_it_afresh() {
        let mut ring = AudioRing::new(RATE, 1.0);
        ring.push(0.0, RATE, &ramp(0.0, 500));
        ring.push(60_000.0, RATE, &ramp(60_000.0, 100));
        assert_eq!(ring.len(), 100);
        assert_eq!(ring.start_ms(), Some(60_000.0));
    }

    #[test]
    fn a_new_sample_rate_starts_the_ring_afresh_with_the_same_length() {
        let mut ring = AudioRing::new(RATE, 2.0);
        ring.push(0.0, RATE, &ramp(0.0, 500));
        ring.push(500.0, 2 * RATE, &[1.0; 100]);
        assert_eq!((ring.sample_rate(), ring.len()), (2 * RATE, 100));
        assert_eq!(ring.end_ms(), Some(550.0));
        assert!((ring.seconds() - 2.0).abs() < 1e-9);
    }

    #[test]
    fn shortening_the_ring_drops_the_oldest_audio() {
        let mut ring = AudioRing::new(RATE, 10.0);
        ring.push(0.0, RATE, &ramp(0.0, 5_000));
        ring.set_seconds(1.0);
        assert_eq!(ring.start_ms(), Some(4_000.0));
        assert_eq!(ring.snapshot(4_100.0, 4_101.0).unwrap().samples, vec![4_100.0]);
    }
}
