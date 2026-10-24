//! Cutting a line's window down to its voice: which speech to keep, padding and fades.
//! Times here are milliseconds from the start of the window.

/// Pauses shorter than this are inside one line's delivery.
const JOIN_GAP_MS: f64 = 600.0;
/// Detections shorter than this are clicks, not speech.
const MIN_BLIP_MS: f64 = 100.0;
/// Speech (after joining) shorter than this is a footstep or a breath.
const MIN_SPEECH_MS: f64 = 200.0;
/// Speech that starts this close to the window's start began before it.
const CUT_OFF_MS: f64 = 30.0;
/// Kept around the voice so its first and last syllables are whole.
pub const PAD_BEFORE_MS: f64 = 150.0;
pub const PAD_AFTER_MS: f64 = 300.0;
pub const FADE_MS: f64 = 50.0;

/// One stretch of speech, in ms from the window's start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

/// The part of a window that is the line's voice, before padding: from the first speech that
/// belongs to the line to the last speech in the window. `anchor` is the line's arrival (ms
/// from the window's start). None when there is no speech to keep.
///
/// Speech already under way when the window opens, and over before the line arrived, is the
/// previous line's voice running on, and is left out.
pub fn voice(spans: &[Span], anchor: f64) -> Option<Span> {
    let mut joined: Vec<Span> = Vec::new();
    // The previous line's voice: speech from the window's start (and whatever follows it
    // closely) that is over before the line arrived.
    let mut tail_reaches = CUT_OFF_MS;
    let mut in_tail = true;
    for span in spans.iter().filter(|s| s.end - s.start >= MIN_BLIP_MS) {
        if in_tail && span.start <= tail_reaches && span.end < anchor {
            tail_reaches = span.end + JOIN_GAP_MS;
            continue;
        }
        in_tail = false;
        match joined.last_mut() {
            Some(last) if span.start - last.end <= JOIN_GAP_MS => last.end = last.end.max(span.end),
            _ => joined.push(*span),
        }
    }
    joined.retain(|s| s.end - s.start >= MIN_SPEECH_MS);
    Some(Span { start: joined.first()?.start, end: joined.last()?.end })
}

/// The cut, in ms from the window's start: the voice padded (or the whole window when there is
/// none), moved by the user's offsets, and kept inside `0..length`.
pub fn cut(voice: Option<Span>, length: f64, start_offset: f64, end_offset: f64) -> Span {
    let base = voice.map_or(Span { start: 0.0, end: length }, |v| Span {
        start: v.start - PAD_BEFORE_MS,
        end: v.end + PAD_AFTER_MS,
    });
    let start = (base.start + start_offset).clamp(0.0, length);
    let end = (base.end + end_offset).clamp(start, length);
    Span { start, end }
}

/// Fade the first and last `FADE_MS` in and out, so the cut does not click.
pub fn fade(samples: &mut [f32], sample_rate: u32) {
    let n = ((FADE_MS * sample_rate as f64 / 1000.0) as usize).min(samples.len() / 2);
    let len = samples.len();
    for i in 0..n {
        let gain = i as f32 / n as f32;
        samples[i] *= gain;
        samples[len - 1 - i] *= gain;
    }
}

/// Speech spans from per-frame speech probabilities (Silero's hysteresis): speech starts at a
/// frame at or above `on`, and ends after `min_silence_ms` below `off`.
pub fn spans_from_probabilities(probabilities: &[f32], frame_ms: f64, on: f32, off: f32, min_silence_ms: f64) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut start: Option<f64> = None;
    let mut quiet_since: Option<f64> = None;
    for (i, &p) in probabilities.iter().enumerate() {
        let t = i as f64 * frame_ms;
        match start {
            None if p >= on => {
                start = Some(t);
                quiet_since = None;
            }
            Some(s) => {
                if p >= off {
                    quiet_since = None;
                } else {
                    let since = *quiet_since.get_or_insert(t);
                    if t + frame_ms - since >= min_silence_ms {
                        spans.push(Span { start: s, end: since });
                        start = None;
                        quiet_since = None;
                    }
                }
            }
            None => {}
        }
    }
    if let Some(s) = start {
        spans.push(Span { start: s, end: quiet_since.unwrap_or(probabilities.len() as f64 * frame_ms) });
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(start: f64, end: f64) -> Span {
        Span { start, end }
    }

    #[test]
    fn the_voice_runs_from_the_first_to_the_last_speech_in_the_window() {
        let spans = [span(400.0, 1_500.0), span(1_900.0, 3_000.0), span(4_000.0, 5_200.0)];
        assert_eq!(voice(&spans, 300.0), Some(span(400.0, 5_200.0)));
    }

    #[test]
    fn the_previous_lines_voice_running_on_is_left_out() {
        // Speech from the window's start until 250ms, the line arriving at 300ms.
        let spans = [span(0.0, 250.0), span(600.0, 2_000.0)];
        assert_eq!(voice(&spans, 300.0), Some(span(600.0, 2_000.0)));
        // But speech under way at the start that carries on past the arrival is the line's own
        // (an OCR'd line arrives after its voice began).
        let spans = [span(0.0, 1_800.0)];
        assert_eq!(voice(&spans, 1_500.0), Some(span(0.0, 1_800.0)));
    }

    #[test]
    fn short_noises_and_short_pauses_are_not_speech_boundaries() {
        let spans = [span(100.0, 150.0), span(500.0, 900.0), span(1_200.0, 1_300.0), span(5_000.0, 5_050.0)];
        assert_eq!(voice(&spans, 0.0), Some(span(500.0, 1_300.0)));
        assert_eq!(voice(&[span(100.0, 150.0)], 0.0), None);
        assert_eq!(voice(&[], 0.0), None);
    }

    #[test]
    fn the_cut_pads_the_voice_applies_offsets_and_stays_in_the_window() {
        let v = Some(span(1_000.0, 2_000.0));
        assert_eq!(cut(v, 10_000.0, 0.0, 0.0), span(850.0, 2_300.0));
        assert_eq!(cut(v, 10_000.0, -500.0, 1_000.0), span(350.0, 3_300.0));
        assert_eq!(cut(Some(span(50.0, 9_900.0)), 10_000.0, 0.0, 0.0), span(0.0, 10_000.0));
        assert_eq!(cut(None, 4_000.0, 200.0, -200.0), span(200.0, 3_800.0), "no voice: the whole window");
        assert_eq!(cut(v, 10_000.0, 0.0, -5_000.0), span(850.0, 850.0), "never ends before it starts");
    }

    #[test]
    fn fades_reach_silence_at_both_ends() {
        let mut samples = vec![1.0; 1_000];
        fade(&mut samples, 1_000);
        assert_eq!((samples[0], samples[999]), (0.0, 0.0));
        assert!(samples[25] > 0.4 && samples[25] < 0.6);
        assert_eq!(samples[500], 1.0);
        let mut tiny = vec![1.0; 3];
        fade(&mut tiny, 48_000);
        assert_eq!(tiny[1], 1.0);
    }

    #[test]
    fn probabilities_become_spans_with_hysteresis() {
        // 10ms frames: speech at frames 2..6 (with a dip to 0.4, above `off`), then silence.
        let p = [0.1, 0.1, 0.9, 0.8, 0.4, 0.7, 0.2, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9];
        let spans = spans_from_probabilities(&p, 10.0, 0.5, 0.35, 30.0);
        assert_eq!(spans, vec![span(20.0, 60.0), span(110.0, 130.0)]);
    }
}
