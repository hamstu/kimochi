//! Recorded audio while the game is paused ("Pause the game while reading").
//!
//! A suspended game plays nothing of its own, but the recording keeps running: it would hold the
//! silence of the pause (or a sound buffer the audio system keeps looping), and just after the game
//! is resumed, the stutter of its audio refilling. None of that belongs in a line's clip, and a long
//! pause would push the line's voice out of the ring altogether.
//!
//! So the recording runs on a **game clock**: wall-clock time with every pause cut out.
//! - [`GameClock`] maps a wall-clock time (Unix ms) to game time: the wall time less every paused
//!   stretch before it. Inside a pause, game time stands still. Each pause is widened by a short
//!   guard on both sides (`GUARD_BEFORE_MS`, `GUARD_AFTER_MS`): the cut.
//! - [`Splicer`] stands between the capture and the [`AudioRing`]: audio inside a cut is dropped,
//!   the rest is stamped with game time, so the ring holds the game's audio joined end to end,
//!   with a few milliseconds of fade on each side of a join so it does not click.
//!
//! Everything else that is timed against the recording (a line's arrival, "now", a captured voice's
//! start) goes through the same clock, so a voice interrupted by a pause comes out whole, and a
//! clip asked for during a pause waits for the game to play the rest.
//!
//! Where the pauses come from is the caller's business ([`PauseSpans`]).
use super::ring::AudioRing;

/// How much audio before a pause starts is cut with it: what was stamped just before the suspend
/// may already be the audio system's reaction to it.
pub const GUARD_BEFORE_MS: f64 = 20.0;
/// How much audio after the game is resumed is cut: its sound refilling (a stutter, a stale
/// buffer replayed) before it plays on cleanly. UNVERIFIED per audio API: measured by ear later.
pub const GUARD_AFTER_MS: f64 = 150.0;
/// Fade on each side of a join.
pub const FADE_MS: f64 = 5.0;
/// Audio held back before it reaches the ring, so a pause that starts just after it can still cut
/// the guard before it and fade the join. More than `GUARD_BEFORE_MS + FADE_MS`.
pub const HOLD_MS: f64 = 40.0;
/// Pauses remembered: more than a long session's.
const KEEP_CUTS: usize = 4_096;
/// Chunks this far apart are not contiguous (the capture restarted, a chunk was dropped).
const CONTIGUOUS_MS: f64 = 40.0;

/// One pause of the game, in Unix ms; `end_ms` is `None` while it lasts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PauseSpan {
    pub start_ms: f64,
    pub end_ms: Option<f64>,
}

/// Where the pauses come from.
pub trait PauseSpans: Send + Sync {
    /// Every pause that ended after `since_ms` or still lasts, oldest first.
    fn spans_since(&self, since_ms: f64) -> Vec<PauseSpan>;
}

/// No pauses: the game is never paused (the setting is off, or there is no pausing on this OS).
pub struct NoPauses;

impl PauseSpans for NoPauses {
    fn spans_since(&self, _since_ms: f64) -> Vec<PauseSpan> {
        Vec::new()
    }
}

/// A pause widened by its guards: the wall-clock stretch `[from, to)` cut out of the recording.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Cut {
    /// The pause's own start: which span this is.
    start: f64,
    from: f64,
    to: Option<f64>,
}

/// Wall-clock time to game time, with every pause cut out. See the module.
#[derive(Debug, Clone)]
pub struct GameClock {
    /// By `start`; may overlap (two pauses closer than the guards).
    cuts: Vec<Cut>,
    /// Time cut by pauses forgotten (past `KEEP_CUTS`), all before `folded_until`.
    folded: f64,
    folded_until: f64,
}

impl Default for GameClock {
    fn default() -> Self {
        Self { cuts: Vec::new(), folded: 0.0, folded_until: f64::NEG_INFINITY }
    }
}

impl GameClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// What to ask a [`PauseSpans`] for: everything since the oldest pause that may still change.
    pub fn since_ms(&self) -> f64 {
        self.cuts.iter().find(|c| c.to.is_none()).or(self.cuts.last()).map_or(f64::NEG_INFINITY, |c| c.start - 1.0)
    }

    /// Take in what the source says now (new pauses, ends of open ones).
    pub fn update(&mut self, spans: &[PauseSpan]) {
        for span in spans {
            if !span.start_ms.is_finite() {
                continue;
            }
            let to = span.end_ms.filter(|e| e.is_finite()).map(|e| e.max(span.start_ms) + GUARD_AFTER_MS);
            match self.cuts.iter_mut().find(|c| c.start == span.start_ms) {
                // An end is never taken back: a pause, once over, stays over.
                Some(cut) => cut.to = cut.to.or(to),
                None => {
                    if span.start_ms <= self.folded_until {
                        continue;
                    }
                    let cut = Cut { start: span.start_ms, from: span.start_ms - GUARD_BEFORE_MS, to };
                    let at = self.cuts.partition_point(|c| c.start < cut.start);
                    self.cuts.insert(at, cut);
                }
            }
        }
        while self.cuts.len() > KEEP_CUTS && self.cuts[0].to.is_some() {
            let old = self.cuts.remove(0);
            let to = old.to.unwrap_or(old.from);
            // Only the part not already folded in (cuts may overlap).
            let from = old.from.max(self.folded_until);
            self.folded += (to - from).max(0.0);
            self.folded_until = self.folded_until.max(to);
        }
    }

    /// Bring the clock up to date with `source`.
    pub fn sync(&mut self, source: &dyn PauseSpans) {
        let spans = source.spans_since(self.since_ms());
        self.update(&spans);
    }

    /// The cuts merged where they overlap, in order: `(from, to)`.
    fn merged(&self) -> impl Iterator<Item = (f64, Option<f64>)> + '_ {
        let mut cuts = self.cuts.iter().map(|c| (c.from.max(self.folded_until), c.to)).peekable();
        std::iter::from_fn(move || {
            let (from, mut to) = cuts.next()?;
            while let Some(&(next_from, next_to)) = cuts.peek() {
                match to {
                    Some(t) if next_from > t => break,
                    Some(t) => to = next_to.map(|n| n.max(t)),
                    None => {}
                }
                cuts.next();
            }
            Some((from, to))
        })
        .filter(|(from, to)| to.is_none_or(|t| t > *from))
    }

    /// Game time at wall-clock `wall_ms`: inside a pause, the moment it started.
    pub fn game_ms(&self, wall_ms: f64) -> f64 {
        let mut cut = if wall_ms <= self.folded_until { 0.0 } else { self.folded };
        for (from, to) in self.merged() {
            if wall_ms <= from {
                break;
            }
            match to {
                Some(to) if wall_ms >= to => cut += to - from,
                _ => return from - cut,
            }
        }
        wall_ms - cut
    }

    /// The wall-clock time at game time `game_ms` (the inverse of `game_ms`): a moment a pause
    /// stood still at is given as the pause's start. For showing game times to a person.
    pub fn wall_ms(&self, game_ms: f64) -> f64 {
        let mut cut = 0.0;
        for (from, to) in self.merged() {
            if from <= self.folded_until {
                continue;
            }
            if game_ms <= from - cut - self.folded {
                break;
            }
            match to {
                Some(to) => cut += to - from,
                None => return from,
            }
        }
        game_ms + cut + if game_ms > self.folded_until - self.folded { self.folded } else { 0.0 }
    }

    /// Whether `wall_ms` falls in a cut (a pause or its guards).
    pub fn paused_at(&self, wall_ms: f64) -> bool {
        self.merged().any(|(from, to)| wall_ms >= from && to.is_none_or(|t| wall_ms < t))
    }

    /// Whether the game is paused now (a pause has no end yet).
    pub fn paused(&self) -> bool {
        self.cuts.iter().any(|c| c.to.is_none())
    }

    /// Paused (cut) time between two wall-clock times.
    pub fn paused_between(&self, from_ms: f64, to_ms: f64) -> f64 {
        (to_ms - from_ms) - (self.game_ms(to_ms) - self.game_ms(from_ms))
    }

    /// The first cut that overlaps `[from_ms, to_ms)`.
    fn first_cut_in(&self, from_ms: f64, to_ms: f64) -> Option<(f64, Option<f64>)> {
        self.merged().find(|(from, to)| *from < to_ms && to.is_none_or(|t| t > from_ms))
    }
}

/// Between the capture and the ring: drops what was recorded while the game was paused, stamps
/// the rest with game time, and fades the joins. See the module.
#[derive(Debug, Default)]
pub struct Splicer {
    /// The newest audio, not yet in the ring (`HOLD_MS` of it), starting at wall `held_wall`.
    held: Vec<f32>,
    held_wall: f64,
    rate: u32,
    /// Samples after a join still to fade in: how many have been faded, while fewer than a fade.
    fading_in: Option<usize>,
}

impl Splicer {
    pub fn new() -> Self {
        Self::default()
    }

    fn ms_to_samples(&self, ms: f64) -> usize {
        (ms * self.rate as f64 / 1000.0).round().max(0.0) as usize
    }

    fn held_end(&self) -> f64 {
        self.held_wall + self.held.len() as f64 * 1000.0 / self.rate.max(1) as f64
    }

    /// Mono `samples` that played from wall-clock `wall_ms` on: what is not in a cut goes to
    /// `ring` stamped with game time, but for the newest `HOLD_MS`, kept back until more comes.
    pub fn push(&mut self, clock: &GameClock, ring: &mut AudioRing, wall_ms: f64, rate: u32, samples: &[f32]) {
        if samples.is_empty() || rate == 0 || !wall_ms.is_finite() {
            return;
        }
        if rate != self.rate || (!self.held.is_empty() && (wall_ms - self.held_end()).abs() > CONTIGUOUS_MS) {
            self.flush(clock, ring);
            self.rate = rate;
        }
        if self.held.is_empty() {
            self.held_wall = wall_ms;
        }
        self.held.extend_from_slice(samples);
        self.settle(clock, ring, self.ms_to_samples(HOLD_MS));
    }

    /// Everything held goes to the ring now (the capture stopped).
    pub fn flush(&mut self, clock: &GameClock, ring: &mut AudioRing) {
        self.settle(clock, ring, 0);
        self.held.clear();
    }

    /// Cut what falls in a pause, and pass all but the newest `keep` samples on to the ring.
    fn settle(&mut self, clock: &GameClock, ring: &mut AudioRing, keep: usize) {
        let rate = self.rate.max(1) as f64;
        loop {
            if self.held.is_empty() {
                return;
            }
            let Some((from, to)) = clock.first_cut_in(self.held_wall, self.held_end()) else {
                let release = self.held.len().saturating_sub(keep);
                self.release(clock, ring, release);
                return;
            };
            // Up to the cut: the game's audio, faded out into the join.
            let before = (((from - self.held_wall) * rate / 1000.0).floor().max(0.0) as usize).min(self.held.len());
            let fade = self.ms_to_samples(FADE_MS).min(before);
            for i in 0..fade {
                self.held[before - fade + i] *= (fade - i) as f32 / (fade + 1) as f32;
            }
            self.release(clock, ring, before);
            // From the cut on: dropped, up to its end once it has one.
            let Some(to) = to else {
                self.held_wall = self.held_end();
                self.held.clear();
                self.fading_in = Some(0);
                return;
            };
            let gone = (((to - self.held_wall) * rate / 1000.0).ceil().max(0.0) as usize).min(self.held.len());
            if gone > 0 || self.held_end() > to {
                self.fading_in = Some(0);
            }
            self.held.drain(..gone);
            self.held_wall += gone as f64 * 1000.0 / rate;
            if self.held.is_empty() {
                // The rest of the chunk was in the cut; the next one starts after it.
                return;
            }
        }
    }

    /// The oldest `n` held samples to the ring, faded in after a join.
    fn release(&mut self, clock: &GameClock, ring: &mut AudioRing, n: usize) {
        if n == 0 {
            return;
        }
        let fade = self.ms_to_samples(FADE_MS).max(1);
        if let Some(done) = self.fading_in {
            let count = (fade - done.min(fade)).min(n);
            for (i, sample) in self.held.iter_mut().take(count).enumerate() {
                *sample *= (done + i + 1) as f32 / (fade + 1) as f32;
            }
            self.fading_in = (done + count < fade).then_some(done + count);
        }
        ring.push(clock.game_ms(self.held_wall), self.rate, &self.held[..n]);
        self.held.drain(..n);
        self.held_wall += n as f64 * 1000.0 / self.rate.max(1) as f64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 1000; // a sample a millisecond

    fn span(start: f64, end: Option<f64>) -> PauseSpan {
        PauseSpan { start_ms: start, end_ms: end }
    }

    fn clock(spans: &[PauseSpan]) -> GameClock {
        let mut clock = GameClock::new();
        clock.update(spans);
        clock
    }

    /// Feeds `[from, to)` wall ms in 10 ms chunks whose samples are their own wall times.
    fn feed(splicer: &mut Splicer, clock: &GameClock, ring: &mut AudioRing, from: f64, to: f64) {
        let mut t = from;
        while t < to {
            let n = (to - t).min(10.0) as usize;
            let chunk: Vec<f32> = (0..n).map(|i| (t + i as f64) as f32).collect();
            splicer.push(clock, ring, t, RATE, &chunk);
            t += n as f64;
        }
    }

    #[test]
    fn with_no_pauses_game_time_is_wall_time() {
        let clock = clock(&[]);
        assert_eq!(clock.game_ms(1_234.5), 1_234.5);
        assert!(!clock.paused() && !clock.paused_at(10.0));
        assert_eq!(clock.paused_between(0.0, 10_000.0), 0.0);
    }

    #[test]
    fn a_pause_stops_game_time_and_later_times_move_back_by_it() {
        let clock = clock(&[span(1_000.0, Some(3_000.0))]);
        let (from, to) = (1_000.0 - GUARD_BEFORE_MS, 3_000.0 + GUARD_AFTER_MS);
        assert_eq!(clock.game_ms(500.0), 500.0);
        assert_eq!(clock.game_ms(from), from);
        assert_eq!(clock.game_ms(2_000.0), from, "standing still inside");
        assert_eq!(clock.game_ms(to), from);
        assert_eq!(clock.game_ms(to + 100.0), from + 100.0);
        assert_eq!(clock.paused_between(0.0, 10_000.0), to - from);
        assert!(clock.paused_at(2_000.0) && !clock.paused_at(to) && !clock.paused());
    }

    #[test]
    fn an_open_pause_holds_game_time_until_it_ends() {
        let mut clock = clock(&[span(1_000.0, None)]);
        assert!(clock.paused());
        let held = clock.game_ms(1_000.0);
        assert_eq!(clock.game_ms(60_000.0), held, "now, during a pause, is the moment it began");
        clock.update(&[span(1_000.0, Some(5_000.0))]);
        assert!(!clock.paused());
        assert_eq!(clock.game_ms(6_000.0), 6_000.0 - (4_000.0 + GUARD_BEFORE_MS + GUARD_AFTER_MS));
        // A source that repeats the open span later does not undo the end.
        clock.update(&[span(1_000.0, None)]);
        assert!(!clock.paused());
    }

    #[test]
    fn many_pauses_add_up_and_overlapping_guards_are_cut_once() {
        let clock = clock(&[span(1_000.0, Some(2_000.0)), span(2_100.0, Some(2_500.0)), span(5_000.0, Some(6_000.0))]);
        // The first two overlap through the first's guard after: one cut from 980 to 2_650.
        let first = 2_650.0 - 980.0;
        let second = 6_150.0 - 4_980.0;
        assert_eq!(clock.game_ms(2_200.0), 980.0);
        assert_eq!(clock.game_ms(3_000.0), 3_000.0 - first);
        assert_eq!(clock.game_ms(7_000.0), 7_000.0 - first - second);
        // Spans arrive in any order.
        let shuffled = super::tests::clock(&[
            span(5_000.0, Some(6_000.0)),
            span(1_000.0, Some(2_000.0)),
            span(2_100.0, Some(2_500.0)),
        ]);
        assert_eq!(shuffled.game_ms(7_000.0), clock.game_ms(7_000.0));
    }

    #[test]
    fn game_times_map_back_to_wall_clock_times() {
        let clock = clock(&[span(1_000.0, Some(2_000.0)), span(5_000.0, Some(6_000.0)), span(9_000.0, None)]);
        for wall in [0.0, 500.0, 2_500.0, 4_000.0, 7_000.0, 8_000.0] {
            assert_eq!(clock.wall_ms(clock.game_ms(wall)), wall, "{wall}");
        }
        assert_eq!(clock.wall_ms(clock.game_ms(1_500.0)), 1_000.0 - GUARD_BEFORE_MS, "a pause shows as its start");
        assert_eq!(clock.wall_ms(clock.game_ms(20_000.0)), 9_000.0 - GUARD_BEFORE_MS, "so does an open one");
    }

    #[test]
    fn game_time_never_runs_backwards() {
        let clock = clock(&[span(1_000.0, Some(2_000.0)), span(1_900.0, Some(4_000.0)), span(4_100.0, None)]);
        let mut last = f64::NEG_INFINITY;
        for t in (0..10_000).map(|t| t as f64) {
            let g = clock.game_ms(t);
            assert!(g >= last, "{t}: {g} < {last}");
            last = g;
        }
    }

    #[test]
    fn forgotten_pauses_still_count_for_later_times() {
        let mut clock = GameClock::new();
        let spans: Vec<PauseSpan> =
            (0..KEEP_CUTS + 10).map(|i| span(i as f64 * 1_000.0, Some(i as f64 * 1_000.0 + 100.0))).collect();
        clock.update(&spans);
        assert_eq!(clock.cuts.len(), KEEP_CUTS);
        let each = 100.0 + GUARD_BEFORE_MS + GUARD_AFTER_MS;
        let late = (KEEP_CUTS + 20) as f64 * 1_000.0;
        assert!((clock.game_ms(late) - (late - each * (KEEP_CUTS + 10) as f64)).abs() < 1e-6);
        assert_eq!(clock.since_ms(), clock.cuts.last().unwrap().start - 1.0);
    }

    struct Fixed(Vec<PauseSpan>);
    impl PauseSpans for Fixed {
        fn spans_since(&self, since: f64) -> Vec<PauseSpan> {
            self.0.iter().filter(|s| s.end_ms.is_none_or(|e| e > since)).copied().collect()
        }
    }

    #[test]
    fn a_clock_syncs_from_its_source() {
        let mut clock = GameClock::new();
        clock.sync(&NoPauses);
        assert_eq!(clock.game_ms(5.0), 5.0);
        clock.sync(&Fixed(vec![span(1_000.0, None)]));
        assert!(clock.paused());
        assert_eq!(clock.since_ms(), 999.0, "asks from the open pause on");
        clock.sync(&Fixed(vec![span(1_000.0, Some(2_000.0)), span(3_000.0, None)]));
        assert!(clock.paused());
        assert_eq!(clock.game_ms(2_500.0), 2_500.0 - (1_000.0 + GUARD_BEFORE_MS + GUARD_AFTER_MS));
    }

    #[test]
    fn with_no_pauses_the_ring_gets_everything_but_the_newest_bit() {
        let clock = clock(&[]);
        let (mut splicer, mut ring) = (Splicer::new(), AudioRing::new(RATE, 60.0));
        feed(&mut splicer, &clock, &mut ring, 1_000.0, 2_000.0);
        assert_eq!(ring.start_ms(), Some(1_000.0));
        assert_eq!(ring.end_ms(), Some(2_000.0 - HOLD_MS));
        splicer.flush(&clock, &mut ring);
        assert_eq!(ring.end_ms(), Some(2_000.0));
        let clip = ring.snapshot(1_000.0, 2_000.0).unwrap();
        assert!(clip.samples.iter().enumerate().all(|(i, &s)| s == 1_000.0 + i as f32), "untouched");
    }

    /// A recording with a pause: what played before, the pause (a looping buffer, `-1`), what played after.
    fn record_with(spans: &[PauseSpan], until: f64) -> (GameClock, AudioRing) {
        let clock = clock(spans);
        let (mut splicer, mut ring) = (Splicer::new(), AudioRing::new(RATE, 60.0));
        feed(&mut splicer, &clock, &mut ring, 0.0, until);
        splicer.flush(&clock, &mut ring);
        (clock, ring)
    }

    #[test]
    fn audio_from_a_pause_and_its_guards_is_cut_and_the_rest_joined() {
        let (clock, ring) = record_with(&[span(1_000.0, Some(31_000.0))], 33_000.0);
        let cut = 30_000.0 + GUARD_BEFORE_MS + GUARD_AFTER_MS;
        assert_eq!(ring.len() as f64, 33_000.0 - cut, "no silence for the pause, nothing of it kept");
        // Game time is contiguous: the join is at the pause's game time.
        let join = clock.game_ms(1_000.0);
        let clip = ring.snapshot(join - 50.0, join + 50.0).unwrap();
        let (before, after) = clip.samples.split_at(50);
        assert_eq!(*before.first().unwrap(), join as f32 - 50.0);
        assert_eq!(after[after.len() - 1], (31_000.0 + GUARD_AFTER_MS) as f32 + 49.0);
        // Exactly what played outside the cut, in order (the joins faded).
        let kept: Vec<f64> = (0..33_000)
            .map(|t| t as f64)
            .filter(|&t| t < 1_000.0 - GUARD_BEFORE_MS || t >= 31_000.0 + GUARD_AFTER_MS)
            .collect();
        let held = ring.read_from(0).1;
        assert_eq!(held.len(), kept.len());
        for (s, t) in held.iter().zip(&kept) {
            let gain = *s as f64 / t.max(1.0);
            assert!((*t == 0.0 && *s == 0.0) || (gain > 0.0 && gain <= 1.0), "{t}: {s}");
        }
    }

    #[test]
    fn the_join_fades_out_and_back_in() {
        let (clock, ring) = record_with(&[span(1_000.0, Some(2_000.0))], 3_000.0);
        let join = clock.game_ms(1_000.0);
        let clip = ring.snapshot(join - 10.0, join + 10.0).unwrap();
        let fade = FADE_MS as usize;
        let expect = |i: usize| {
            let wall = if i < 10 { join - 10.0 + i as f64 } else { 2_000.0 + GUARD_AFTER_MS + (i - 10) as f64 };
            wall as f32
        };
        for (i, &s) in clip.samples.iter().enumerate() {
            let gain = s / expect(i);
            if i < 10 - fade || i >= 10 + fade {
                assert_eq!(gain, 1.0, "sample {i} untouched");
            } else {
                assert!(gain > 0.0 && gain < 1.0, "sample {i} faded: {gain}");
            }
        }
        // Fading down to the join, up from it.
        assert!(clip.samples[9] / expect(9) < clip.samples[10 - fade] / expect(10 - fade));
        assert!(clip.samples[10] / expect(10) < clip.samples[10 + fade - 1] / expect(10 + fade - 1));
    }

    #[test]
    fn a_pause_that_opens_after_audio_arrived_still_cuts_its_guard() {
        // The pause becomes known only after the audio just before it was pushed.
        let mut clock = GameClock::new();
        let (mut splicer, mut ring) = (Splicer::new(), AudioRing::new(RATE, 60.0));
        feed(&mut splicer, &clock, &mut ring, 0.0, 1_000.0);
        clock.update(&[span(1_000.0, None)]);
        feed(&mut splicer, &clock, &mut ring, 1_000.0, 5_000.0);
        assert_eq!(ring.end_ms(), Some(1_000.0 - GUARD_BEFORE_MS), "up to the guard, nothing of the pause");
        clock.update(&[span(1_000.0, Some(5_000.0))]);
        feed(&mut splicer, &clock, &mut ring, 5_000.0, 6_000.0);
        splicer.flush(&clock, &mut ring);
        assert_eq!(ring.len() as f64, 6_000.0 - (4_000.0 + GUARD_BEFORE_MS + GUARD_AFTER_MS));
        assert_eq!(ring.end_ms(), Some(clock.game_ms(6_000.0)));
    }

    #[test]
    fn a_voice_cut_by_pauses_comes_out_whole() {
        // A voice from 1_000 to 4_000 wall (values 1.0), two pauses inside it, quiet around it.
        let spans = [span(1_500.0, Some(9_000.0)), span(10_000.0, Some(40_000.0))];
        let clock = clock(&spans);
        let voice = |t: f64| {
            (1_000.0..1_500.0).contains(&t) || (9_000.0..10_000.0).contains(&t) || (40_000.0..41_500.0).contains(&t)
        };
        let (mut splicer, mut ring) = (Splicer::new(), AudioRing::new(RATE, 30.0));
        let mut t = 0.0;
        while t < 45_000.0 {
            let chunk: Vec<f32> = (0..10).map(|i| if voice(t + i as f64) { 1.0 } else { 0.0 }).collect();
            splicer.push(&clock, &mut ring, t, RATE, &chunk);
            t += 10.0;
        }
        splicer.flush(&clock, &mut ring);
        // In game time the voice is one stretch, 3 s less what the guards took.
        let (from, to) = (clock.game_ms(1_000.0), clock.game_ms(41_500.0));
        let clip = ring.snapshot(from, to).unwrap();
        let guards = 2.0 * (GUARD_BEFORE_MS + GUARD_AFTER_MS);
        assert!((clip.duration_ms() - (3_000.0 - guards)).abs() <= 1.0, "{}", clip.duration_ms());
        let loud = clip.samples.iter().filter(|&&s| s == 1.0).count() as f64;
        assert!(loud >= 3_000.0 - guards - 4.0 * FADE_MS - 2.0, "{loud}");
        // The 30-second ring still holds it, though 37 s of wall time went by in pauses.
        assert!(ring.start_ms().unwrap() <= from);
    }

    #[test]
    fn a_pause_at_the_very_start_or_end_of_the_recording() {
        let (_, ring) = record_with(&[span(0.0, Some(1_000.0))], 2_000.0);
        assert_eq!(ring.len() as f64, 2_000.0 - 1_000.0 - GUARD_AFTER_MS);
        let (_, ring) = record_with(&[span(1_000.0, None)], 2_000.0);
        assert_eq!(ring.len() as f64, 1_000.0 - GUARD_BEFORE_MS);
    }

    #[test]
    fn a_chunk_that_spans_a_whole_pause_loses_only_the_pause() {
        let clock = clock(&[span(1_000.0, Some(1_100.0))]);
        let (mut splicer, mut ring) = (Splicer::new(), AudioRing::new(RATE, 60.0));
        let chunk: Vec<f32> = (0..2_000).map(|i| i as f32).collect();
        splicer.push(&clock, &mut ring, 0.0, RATE, &chunk);
        splicer.flush(&clock, &mut ring);
        assert_eq!(ring.len() as f64, 2_000.0 - (100.0 + GUARD_BEFORE_MS + GUARD_AFTER_MS));
    }

    #[test]
    fn a_new_rate_or_a_break_in_the_stream_flushes_what_is_held() {
        let clock = clock(&[]);
        let (mut splicer, mut ring) = (Splicer::new(), AudioRing::new(RATE, 60.0));
        feed(&mut splicer, &clock, &mut ring, 0.0, 100.0);
        splicer.push(&clock, &mut ring, 5_000.0, RATE, &[9.0; 100]);
        assert!(ring.snapshot(50.0, 100.0).is_some(), "the old stream's tail went in whole");
        splicer.push(&clock, &mut ring, 5_100.0, 2 * RATE, &[1.0; 200]);
        assert_eq!(ring.sample_rate(), 2 * RATE);
    }
}
