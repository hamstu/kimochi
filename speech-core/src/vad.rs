//! Silero VAD v5 (https://github.com/snakers4/silero-vad, MIT), on the ONNX Runtime the app
//! already ships for MeikiOCR. The model (2.3 MB) is compiled in. It scores each 32ms of 16 kHz
//! audio for speech; `trim::spans_from_probabilities` turns the scores into spans with the
//! thresholds Silero's own `get_speech_timestamps` uses.
//!
//! `Vad::speech` scores a whole clip at once; `Stream` scores audio as it arrives, for the
//! listener (`listener`), keeping the model's state between calls.
use super::trim::{spans_from_probabilities, Span};
use ort::{session::Session, value::Tensor};

const MODEL: &[u8] = include_bytes!("../../src-tauri/resources/silero-vad/silero_vad.onnx");
pub const RATE: u32 = 16_000;
pub const FRAME: usize = 512;
/// One frame, in milliseconds.
pub const FRAME_MS: f64 = FRAME as f64 * 1000.0 / RATE as f64;
/// v5 reads each frame with the 64 samples before it.
const CONTEXT: usize = 64;
pub const ON: f32 = 0.5;
pub const OFF: f32 = 0.35;
const MIN_SILENCE_MS: f64 = 100.0;

pub struct Vad {
    session: Session,
}

fn error(e: impl std::fmt::Display) -> String {
    format!("speech detection: {e}")
}

impl Vad {
    /// The ONNX Runtime must be initialised first (`meiki_ocr::onnx_runtime`).
    pub fn new() -> Result<Self, String> {
        let session = Session::builder()
            .and_then(|b| b.with_intra_threads(1))
            .and_then(|b| b.commit_from_memory(MODEL))
            .map_err(error)?;
        Ok(Self { session })
    }

    /// Speech in `samples` (mono, any rate), in ms from their start.
    pub fn speech(&mut self, samples: &[f32], sample_rate: u32) -> Result<Vec<Span>, String> {
        let mut audio = to_16k(samples, sample_rate);
        // Silero misses speech far below full scale (a quiet game, a monitor taken after the
        // output's volume): it hears a copy brought up to half scale, up to +60 dB.
        let gain = super::trim::gain_to(&audio, 0.5, 1_000.0);
        audio.iter_mut().for_each(|s| *s *= gain);
        let mut stream = Scorer::default();
        let probabilities = audio
            .chunks(FRAME)
            .map(|frame| stream.score(&mut self.session, frame))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(spans_from_probabilities(
            &probabilities,
            FRAME_MS,
            ON,
            OFF,
            MIN_SILENCE_MS,
        ))
    }
}

/// Silero's state between frames: the recurrent state and the last 64 samples.
struct Scorer {
    state: Vec<f32>,
    input: Vec<f32>,
}

impl Default for Scorer {
    fn default() -> Self {
        Self {
            state: vec![0f32; 2 * 128],
            input: vec![0f32; CONTEXT + FRAME],
        }
    }
}

impl Scorer {
    /// The speech probability of one frame (zero-padded when short), read with the 64 samples
    /// before it.
    fn score(&mut self, session: &mut Session, frame: &[f32]) -> Result<f32, String> {
        self.input.copy_within(FRAME.., 0);
        self.input[CONTEXT..CONTEXT + frame.len()].copy_from_slice(frame);
        self.input[CONTEXT + frame.len()..].fill(0.0);
        let outputs = session
            .run(ort::inputs![
                "input" => Tensor::from_array(([1usize, CONTEXT + FRAME], self.input.clone())).map_err(error)?,
                "state" => Tensor::from_array(([2usize, 1, 128], self.state.clone())).map_err(error)?,
                "sr" => Tensor::from_array(((), vec![RATE as i64])).map_err(error)?,
            ])
            .map_err(error)?;
        let (_, p) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(error)?;
        let p = p.first().copied().unwrap_or(0.0);
        let (_, next) = outputs["stateN"]
            .try_extract_tensor::<f32>()
            .map_err(error)?;
        self.state.copy_from_slice(next);
        Ok(p)
    }
}

/// Silero over audio as it arrives: 16 kHz samples in, one probability per `FRAME` out.
///
/// Quiet audio is brought up before scoring, as `Vad::speech` does, by the loudest frame of the
/// last `HOLD_FRAMES` (about 30 s): steady while someone speaks, and never lifting a stretch of
/// near-silence into "speech".
pub struct Stream {
    vad: Vad,
    scorer: Scorer,
    pending: Vec<f32>,
    peaks: std::collections::VecDeque<f32>,
}

const HOLD_FRAMES: usize = 940;

impl Stream {
    pub fn new(vad: Vad) -> Self {
        Self {
            vad,
            scorer: Scorer::default(),
            pending: Vec::new(),
            peaks: Default::default(),
        }
    }

    /// Score `samples` (16 kHz mono), with whatever was left over from the last call: for each
    /// whole frame, its speech probability and its loudness (RMS, before any gain).
    pub fn push(&mut self, samples: &[f32]) -> Result<Vec<(f32, f32)>, String> {
        self.pending.extend_from_slice(samples);
        let whole = self.pending.len() / FRAME * FRAME;
        let mut out = Vec::with_capacity(whole / FRAME);
        let mut frame = [0f32; FRAME];
        for chunk in self.pending[..whole].chunks_exact(FRAME) {
            let peak = chunk.iter().fold(0f32, |m, s| m.max(s.abs()));
            self.peaks.push_back(peak);
            if self.peaks.len() > HOLD_FRAMES {
                self.peaks.pop_front();
            }
            let held = self.peaks.iter().fold(0f32, |m, p| m.max(*p));
            let gain = if held < 1e-5 {
                1.0
            } else {
                (0.5 / held).clamp(1.0, 1_000.0)
            };
            for (out, s) in frame.iter_mut().zip(chunk) {
                *out = s * gain;
            }
            let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / FRAME as f32).sqrt();
            out.push((self.scorer.score(&mut self.vad.session, &frame)?, rms));
        }
        self.pending.drain(..whole);
        Ok(out)
    }

    /// 16 kHz samples held back until they make a whole frame.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// Forget the audio heard so far (a gap in the recording, or a fresh start).
    pub fn reset(&mut self) {
        self.scorer = Scorer::default();
        self.pending.clear();
        self.peaks.clear();
    }
}

/// Mono audio at 16 kHz: averaged down by a whole factor (48 kHz, 32 kHz), else interpolated.
pub fn to_16k(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if sample_rate == RATE || sample_rate == 0 || samples.is_empty() {
        return samples.to_vec();
    }
    if sample_rate.is_multiple_of(RATE) {
        let k = (sample_rate / RATE) as usize;
        return samples
            .chunks(k)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect();
    }
    let step = sample_rate as f64 / RATE as f64;
    let n = (samples.len() as f64 / step) as usize;
    (0..n)
        .map(|i| {
            let at = i as f64 * step;
            let (j, f) = (at as usize, (at.fract()) as f32);
            let a = samples[j];
            let b = samples.get(j + 1).copied().unwrap_or(a);
            a + (b - a) * f
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_is_brought_to_16k() {
        let samples: Vec<f32> = (0..48).map(|i| i as f32).collect();
        assert_eq!(
            to_16k(&samples, 48_000),
            (0..16).map(|i| 3.0 * i as f32 + 1.0).collect::<Vec<_>>()
        );
        assert_eq!(to_16k(&samples, 44_100).len(), 17);
        assert_eq!(to_16k(&samples, 16_000), samples);
    }

    /// Silero on real speech, opt-in: `KIMOCHI_ORT=…/libonnxruntime.dylib KIMOCHI_SPEECH_WAV=x.wav
    /// cargo test --manifest-path speech-core/Cargo.toml silero_finds -- --ignored`, with a mono 16-bit WAV of speech
    /// (`say -v Kyoko -o x.wav --data-format=LEI16@48000 "今日はいい天気ですね。"`). The speech is
    /// put between 1.5 s of silence before and 2 s of quiet noise after, and must be found there.
    #[test]
    #[ignore]
    fn silero_finds_the_speech_between_silence_and_noise() {
        let ort_path = std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT");
        ort::init_from(ort_path).commit().unwrap();
        let wav = std::fs::read(std::env::var("KIMOCHI_SPEECH_WAV").expect("KIMOCHI_SPEECH_WAV"))
            .unwrap();
        let data = wav
            .windows(4)
            .position(|w| w == b"data")
            .expect("data chunk")
            + 8;
        let fmt = wav
            .windows(4)
            .position(|w| w == b"fmt ")
            .expect("fmt chunk")
            + 8;
        let rate = u32::from_le_bytes(wav[fmt + 4..fmt + 8].try_into().unwrap());
        let speech: Vec<f32> = wav[data..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        let speech_ms = speech.len() as f64 * 1000.0 / rate as f64;
        let mut audio = vec![0.0; rate as usize * 3 / 2];
        audio.extend_from_slice(&speech);
        let mut seed = 1u32;
        audio.extend((0..rate * 2).map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1 << 24) as f32 * 0.01 - 0.005
        }));
        let spans = Vad::new().unwrap().speech(&audio, rate).unwrap();
        let voice = crate::trim::voice(&spans, 1_500.0).expect("speech");
        eprintln!("spans {spans:?}, voice {voice:?}, speech {speech_ms:.0}ms from 1500ms");
        assert!((voice.start - 1_500.0).abs() < 300.0, "{voice:?}");
        assert!(
            (voice.end - (1_500.0 + speech_ms)).abs() < 500.0,
            "{voice:?}"
        );
    }
}
