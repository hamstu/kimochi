//! SenseVoice-Small (FunASR, Alibaba; https://huggingface.co/FunAudioLLM/SenseVoiceSmall, under the
//! FunASR model licence), as sherpa-onnx converted it to ONNX with int8 weights: speech in, the
//! characters heard out, each with the time it was heard. It is downloaded on demand (Settings →
//! Anki → Sentence audio), never bundled, and runs on the ONNX Runtime the app ships for MeikiOCR.
//!
//! One pass over the whole stretch (a CTC model, no decoding loop): about 1/60 of real time on
//! two CPU threads, so a 10-second utterance costs well under a second even on a slow machine.
//! Characters come one token each for Japanese, at the 60 ms frame the model emitted them in.
use crate::fbank::{self, Fbank, FEATURE, LFR_MS};
use ort::{session::Session, value::Tensor};
use std::path::Path;

pub const MODEL_FILE: &str = "model.int8.onnx";
pub const TOKENS_FILE: &str = "tokens.txt";
/// The model emits four prompt frames (language, emotion, event, normalisation) before the speech.
const PROMPT_FRAMES: usize = 4;
const BLANK: usize = 0;

/// One character heard, at `ms` from the start of the audio given.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeardChar {
    pub ch: char,
    pub ms: f64,
}

pub struct SenseVoice {
    session: Session,
    fbank: Fbank,
    tokens: Vec<String>,
    neg_mean: Vec<f32>,
    inv_stddev: Vec<f32>,
    language: i32,
    text_norm: i32,
}

fn error(e: impl std::fmt::Display) -> String {
    format!("speech recognition: {e}")
}

impl SenseVoice {
    /// Load `model.int8.onnx` and `tokens.txt` from `dir`. The ONNX Runtime must be initialised
    /// first. `threads`: CPU threads for one run.
    pub fn load(dir: &Path, threads: usize) -> Result<Self, String> {
        let tokens_text = std::fs::read_to_string(dir.join(TOKENS_FILE)).map_err(error)?;
        let mut tokens = Vec::new();
        for line in tokens_text.lines() {
            let Some((piece, id)) = line.rsplit_once(' ') else {
                continue;
            };
            let id: usize = id.parse().map_err(error)?;
            if tokens.len() <= id {
                tokens.resize(id + 1, String::new());
            }
            tokens[id] = piece.to_string();
        }
        let session = Session::builder()
            .and_then(|b| b.with_intra_threads(threads.max(1)))
            .and_then(|b| b.commit_from_file(dir.join(MODEL_FILE)))
            .map_err(error)?;
        let (neg_mean, inv_stddev, language, text_norm) = {
            let meta = session.metadata().map_err(error)?;
            let get = |key: &str| {
                meta.custom(key)
                    .ok()
                    .flatten()
                    .ok_or_else(|| error(format!("the model has no {key}")))
            };
            let floats = |s: String| {
                s.split(',')
                    .map(|v| v.trim().parse::<f32>().map_err(error))
                    .collect::<Result<Vec<_>, _>>()
            };
            let int = |s: String| s.trim().parse::<i32>().map_err(error);
            (
                floats(get("neg_mean")?)?,
                floats(get("inv_stddev")?)?,
                int(get("lang_ja")?)?,
                int(get("without_itn")?)?,
            )
        };
        if neg_mean.len() != FEATURE || inv_stddev.len() != FEATURE {
            return Err(error(
                "the model's normalisation does not match its features",
            ));
        }
        Ok(Self {
            session,
            fbank: Fbank::new(),
            tokens,
            neg_mean,
            inv_stddev,
            language,
            text_norm,
        })
    }

    /// The characters heard in 16 kHz mono `samples`, in order. Empty for audio too short to hold
    /// a frame of speech.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<Vec<HeardChar>, String> {
        let features = fbank::lfr(
            &self.fbank.compute(samples),
            &self.neg_mean,
            &self.inv_stddev,
        );
        let frames = features.len() / FEATURE;
        if frames == 0 {
            return Ok(Vec::new());
        }
        let ids = {
            let outputs = self
            .session
            .run(ort::inputs![
                "x" => Tensor::from_array(([1usize, frames, FEATURE], features)).map_err(error)?,
                "x_length" => Tensor::from_array(([1usize], vec![frames as i32])).map_err(error)?,
                "language" => Tensor::from_array(([1usize], vec![self.language])).map_err(error)?,
                "text_norm" => Tensor::from_array(([1usize], vec![self.text_norm])).map_err(error)?,
            ])
            .map_err(error)?;
            let (shape, logits) = outputs["logits"]
                .try_extract_tensor::<f32>()
                .map_err(error)?;
            let vocab = *shape.last().ok_or_else(|| error("no logits"))? as usize;
            logits
                .chunks(vocab)
                .map(|row| {
                    row.iter()
                        .enumerate()
                        .max_by(|a, b| a.1.total_cmp(b.1))
                        .map_or(BLANK, |(i, _)| i)
                })
                .collect::<Vec<usize>>()
        };
        Ok(self.characters(&ids))
    }

    /// Greedy CTC: a token wherever the best guess changes to something other than blank, at that
    /// frame's time. A token of several characters spreads them over the frame.
    fn characters(&self, ids: &[usize]) -> Vec<HeardChar> {
        let mut out = Vec::new();
        let mut previous = BLANK;
        for (frame, &id) in ids.iter().enumerate() {
            let fresh = id != BLANK && id != previous;
            previous = id;
            if !fresh || frame < PROMPT_FRAMES {
                continue;
            }
            let piece = self.tokens.get(id).map_or("", String::as_str);
            if piece.starts_with("<|") && piece.ends_with("|>") || piece == "<unk>" {
                continue;
            }
            let ms = (frame - PROMPT_FRAMES) as f64 * LFR_MS;
            let chars: Vec<char> = piece.chars().filter(|&c| c != '▁').collect();
            let each = LFR_MS / chars.len().max(1) as f64;
            out.extend(chars.iter().enumerate().map(|(i, &ch)| HeardChar {
                ch,
                ms: ms + i as f64 * each,
            }));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SenseVoice on a game's voiced line, opt-in: `KIMOCHI_ORT=…/libonnxruntime.dylib
    /// KIMOCHI_SENSEVOICE=<dir with model.int8.onnx, tokens.txt> KIMOCHI_SPEECH_WAV=line.wav
    /// KIMOCHI_SPEECH_TEXT=… cargo test sense_voice -- --ignored --nocapture`. The WAV is mono
    /// 16-bit; what is heard must be most of the line's text, in order.
    #[test]
    #[ignore]
    fn sense_voice_hears_a_line() {
        ort::init_from(std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT"))
            .commit()
            .unwrap();
        let mut model =
            SenseVoice::load(Path::new(&std::env::var("KIMOCHI_SENSEVOICE").unwrap()), 2).unwrap();
        let (samples, rate) =
            crate::wav::read(Path::new(&std::env::var("KIMOCHI_SPEECH_WAV").unwrap())).unwrap();
        let audio = crate::vad::to_16k(&samples, rate);
        let started = std::time::Instant::now();
        let heard = model.transcribe(&audio).unwrap();
        let text: String = heard.iter().map(|c| c.ch).collect();
        eprintln!("{text:?} in {:?}", started.elapsed());
        eprintln!(
            "{:?}",
            heard
                .iter()
                .map(|c| (c.ch, (c.ms / 10.0).round() / 100.0))
                .collect::<Vec<_>>()
        );
        let expected = std::env::var("KIMOCHI_SPEECH_TEXT").unwrap();
        let score = crate::matching::find(
            &expected,
            &[crate::matching::Heard::new(0.0, 1e9, heard)],
            0.0,
            1e9,
        )
        .map(|m| m.score);
        assert!(score.is_some_and(|s| s > 0.6), "{score:?}");
    }
}
