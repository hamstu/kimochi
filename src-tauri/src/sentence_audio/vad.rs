//! Silero VAD v5 (https://github.com/snakers4/silero-vad, MIT), on the ONNX Runtime the app
//! already ships for MeikiOCR. The model (2.3 MB) is compiled in. It scores each 32ms of 16 kHz
//! audio for speech; `trim::spans_from_probabilities` turns the scores into spans with the
//! thresholds Silero's own `get_speech_timestamps` uses.
use super::trim::{spans_from_probabilities, Span};
use ort::{session::Session, value::Tensor};

const MODEL: &[u8] = include_bytes!("../../resources/silero-vad/silero_vad.onnx");
const RATE: u32 = 16_000;
const FRAME: usize = 512;
/// v5 reads each frame with the 64 samples before it.
const CONTEXT: usize = 64;
const ON: f32 = 0.5;
const OFF: f32 = 0.35;
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
        let audio = to_16k(samples, sample_rate);
        let mut state = vec![0f32; 2 * 128];
        let mut input = vec![0f32; CONTEXT + FRAME];
        let mut probabilities = Vec::with_capacity(audio.len() / FRAME + 1);
        for frame in audio.chunks(FRAME) {
            // The previous frame's last 64 samples, then this frame (zero-padded at the end).
            input.copy_within(FRAME.., 0);
            input[CONTEXT..CONTEXT + frame.len()].copy_from_slice(frame);
            input[CONTEXT + frame.len()..].fill(0.0);
            let outputs = self
                .session
                .run(ort::inputs![
                    "input" => Tensor::from_array(([1usize, CONTEXT + FRAME], input.clone())).map_err(error)?,
                    "state" => Tensor::from_array(([2usize, 1, 128], state.clone())).map_err(error)?,
                    "sr" => Tensor::from_array(((), vec![RATE as i64])).map_err(error)?,
                ])
                .map_err(error)?;
            let (_, p) = outputs["output"].try_extract_tensor::<f32>().map_err(error)?;
            probabilities.push(p.first().copied().unwrap_or(0.0));
            let (_, next) = outputs["stateN"].try_extract_tensor::<f32>().map_err(error)?;
            state.copy_from_slice(next);
        }
        let frame_ms = FRAME as f64 * 1000.0 / RATE as f64;
        Ok(spans_from_probabilities(&probabilities, frame_ms, ON, OFF, MIN_SILENCE_MS))
    }
}

/// Mono audio at 16 kHz: averaged down by a whole factor (48 kHz, 32 kHz), else interpolated.
pub fn to_16k(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if sample_rate == RATE || sample_rate == 0 || samples.is_empty() {
        return samples.to_vec();
    }
    if sample_rate.is_multiple_of(RATE) {
        let k = (sample_rate / RATE) as usize;
        return samples.chunks(k).map(|c| c.iter().sum::<f32>() / c.len() as f32).collect();
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
        assert_eq!(to_16k(&samples, 48_000), (0..16).map(|i| 3.0 * i as f32 + 1.0).collect::<Vec<_>>());
        assert_eq!(to_16k(&samples, 44_100).len(), 17);
        assert_eq!(to_16k(&samples, 16_000), samples);
    }

    /// Silero on real speech, opt-in: `KIMOCHI_ORT=…/libonnxruntime.dylib KIMOCHI_SPEECH_WAV=x.wav
    /// cargo test --bin kimochi silero_finds -- --ignored`, with a mono 16-bit WAV of speech
    /// (`say -v Kyoko -o x.wav --data-format=LEI16@48000 "今日はいい天気ですね。"`). The speech is
    /// put between 1.5 s of silence before and 2 s of quiet noise after, and must be found there.
    #[test]
    #[ignore]
    fn silero_finds_the_speech_between_silence_and_noise() {
        let ort_path = std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT");
        ort::init_from(ort_path).commit().unwrap();
        let wav = std::fs::read(std::env::var("KIMOCHI_SPEECH_WAV").expect("KIMOCHI_SPEECH_WAV")).unwrap();
        let data = wav.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let fmt = wav.windows(4).position(|w| w == b"fmt ").expect("fmt chunk") + 8;
        let rate = u32::from_le_bytes(wav[fmt + 4..fmt + 8].try_into().unwrap());
        let speech: Vec<f32> = wav[data..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let speech_ms = speech.len() as f64 * 1000.0 / rate as f64;
        let mut audio = vec![0.0; rate as usize * 3 / 2];
        audio.extend_from_slice(&speech);
        let mut seed = 1u32;
        audio.extend((0..rate * 2).map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1 << 24) as f32 * 0.01 - 0.005
        }));
        let spans = Vad::new().unwrap().speech(&audio, rate).unwrap();
        let voice = crate::sentence_audio::trim::voice(&spans, 1_500.0).expect("speech");
        eprintln!("spans {spans:?}, voice {voice:?}, speech {speech_ms:.0}ms from 1500ms");
        assert!((voice.start - 1_500.0).abs() < 300.0, "{voice:?}");
        assert!((voice.end - (1_500.0 + speech_ms)).abs() < 500.0, "{voice:?}");
    }
}
