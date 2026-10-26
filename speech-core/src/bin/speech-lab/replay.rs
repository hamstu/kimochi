//! Replay a session through the listener, as the app would have heard it live, but as fast as
//! the computer can: audio pushed into a ring in 20 ms chunks stamped with their recorded time,
//! lines and screen readings handed over when their time comes, a tick every 100 ms.
use crate::report::{self, Row};
use crate::session::Session;
use kimochi_speech::listener::{Decision, How, Listener, Outcome};
use kimochi_speech::sense_voice::SenseVoice;
use kimochi_speech::timeline::Line;
use kimochi_speech::vad::Vad;
use kimochi_speech::{clips, AudioRing};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

const CHUNK_MS: f64 = 20.0;
const TICK_MS: f64 = 100.0;
const RING_SECONDS: f64 = 60.0;

pub fn main(args: &[String]) -> Result<(), String> {
    let positional = crate::positional(args);
    let dir = Path::new(positional.first().ok_or(crate::USAGE)?);
    let out = crate::flag(args, "--out").map(PathBuf::from).unwrap_or_else(|| dir.join("replay"));
    let model = if crate::has(args, "--no-model") {
        None
    } else {
        let dir = crate::flag(args, "--model").map(PathBuf::from).or_else(crate::app_model_dir);
        dir.filter(|d| d.join(kimochi_speech::sense_voice::MODEL_FILE).is_file())
    };
    let session = Session::load(dir)?;
    crate::onnx_runtime()?;
    let result = run(&session, model.as_deref(), &out)?;
    println!("{}", result.summary);
    println!("report: {}", out.join("report.html").display());
    Ok(())
}

pub struct Replayed {
    pub summary: String,
}

pub fn run(session: &Session, model: Option<&Path>, out: &Path) -> Result<Replayed, String> {
    let clips_dir = out.join("clips");
    let _ = std::fs::remove_dir_all(&clips_dir);
    std::fs::create_dir_all(&clips_dir).map_err(|e| e.to_string())?;
    let (audio, rate) = kimochi_speech::wav::read(&session.audio_path())?;
    let asr = match model {
        Some(dir) => Some(SenseVoice::load(dir, 2)?),
        None => None,
    };
    eprintln!(
        "replaying {:.0}s of audio, {} lines, {} screen readings, {}",
        audio.len() as f64 / rate as f64,
        session.lines.len(),
        session.screen.len(),
        model.map_or("timing only (no model)".to_string(), |m| format!("model {}", m.display()))
    );
    let mut listener = Listener::new(Some(Vad::new()?), asr);
    let mut ring = AudioRing::new(rate, RING_SECONDS);
    let start = session.meta.audio_start_ms;
    let chunk = (rate as f64 * CHUNK_MS / 1000.0) as usize;
    let (mut next_line, mut next_screen) = (0, 0);
    let mut since_tick = 0.0;
    let mut decided: HashMap<String, (Decision, Option<Clipped>)> = HashMap::new();
    // Lines whose clip changed after they were matched by their words, other than for a better
    // match (more of the line heard): what the Log would show flipping.
    let mut changed_after_match: Vec<String> = Vec::new();
    let score = |d: &Decision| match &d.outcome {
        Outcome::Voiced(v) => match &v.how {
            How::Matched(m) => Some(m.score),
            How::Timed => None,
        },
        _ => None,
    };
    // When each line first got a clip: how long the Log waits for its voice.
    let mut voiced_at: HashMap<String, f64> = HashMap::new();
    let mut keep = |decided: &mut HashMap<String, (Decision, Option<Clipped>)>, decisions: Vec<Decision>, ring: &AudioRing, now: f64| {
        for d in decisions {
            if matches!(d.outcome, Outcome::Voiced(_)) {
                voiced_at.entry(d.uid.clone()).or_insert(now);
            }
            if let Some((before, _)) = decided.get(&d.uid) {
                let flipped = score(before).is_some_and(|b| score(&d).is_none_or(|n| n <= b)) && before.outcome != d.outcome;
                if flipped && !changed_after_match.contains(&d.uid) {
                    changed_after_match.push(d.uid.clone());
                }
            }
            let clip = match &d.outcome {
                Outcome::Voiced(voice) => Some(clip(ring, &d, voice, &clips_dir)),
                _ => None,
            };
            decided.insert(d.uid.clone(), (d, clip));
        }
    };
    let started = Instant::now();
    for (i, samples) in audio.chunks(chunk).enumerate() {
        let at = start + i as f64 * CHUNK_MS;
        ring.push(at, rate, samples);
        let now = at + samples.len() as f64 * 1000.0 / rate as f64;
        while let Some(row) = session.screen.get(next_screen).filter(|r| r.at <= now) {
            listener.screen.observed(&row.text, row.at);
            next_screen += 1;
        }
        while let Some(row) = session.lines.get(next_line).filter(|r| r.ts <= now) {
            if !row.replaces.is_empty() {
                listener.forget(&row.replaces);
            }
            listener.line(Line {
                uid: row.uid.clone(),
                text: row.text.clone(),
                ts: row.ts,
                ocr: row.source == "ocr",
                appeared: row.appeared,
                scan: row.scan.clone(),
            });
            next_line += 1;
        }
        since_tick += CHUNK_MS;
        if since_tick >= TICK_MS {
            since_tick = 0.0;
            let decisions = listener.tick(&ring, now);
            keep(&mut decided, decisions, &ring, now);
        }
    }
    // The recording is over: whatever is left is decided with what was heard.
    let end = ring.end_ms().unwrap_or(start);
    let decisions = listener.tick(&ring, end);
    keep(&mut decided, decisions, &ring, end);
    for row in &session.lines {
        let open = decided.get(&row.uid).is_none_or(|(d, _)| d.provisional);
        if open {
            if let Some(d) = listener.decide_now(&ring, end, &row.uid) {
                keep(&mut decided, vec![d], &ring, end);
            }
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    drop(keep);
    // Lines a fuller reading replaced are gone from the Log: not reported.
    let replaced: Vec<&String> = session.lines.iter().flat_map(|l| &l.replaces).collect();
    let rows: Vec<Row> = session
        .lines
        .iter()
        .filter(|line| !replaced.contains(&&line.uid))
        .map(|line| {
            let (decision, clip) = decided.get(&line.uid).cloned().map_or((None, None), |(d, c)| (Some(d), c));
            let appeared = listener.get_line(&line.uid).and_then(|l| l.appeared);
            let note = listener.note(&line.uid).unwrap_or_default();
            Row { line: line.clone(), decision, clip, appeared, note, flipped: changed_after_match.contains(&line.uid), voiced_at: voiced_at.get(&line.uid).copied() }
        })
        .collect();
    let heard: Vec<_> = listener.transcripts().to_vec();
    let summary = report::write(session, out, &rows, &heard, elapsed, audio.len() as f64 / rate as f64, model.is_some())?;
    Ok(Replayed { summary })
}

#[derive(Debug, Clone)]
pub struct Clipped {
    pub file: Option<String>,
    pub error: Option<String>,
    pub word: Option<String>,
}

/// Render a voiced line's clip into `dir`, plus the clip of its longest kanji word when it was
/// matched (a stand-in for the word a card would be mined for).
fn clip(ring: &AudioRing, decision: &Decision, voice: &kimochi_speech::listener::Voice, dir: &Path) -> Clipped {
    let rendered = match clips::render(ring, voice) {
        Ok(r) => r,
        Err(e) => return Clipped { file: None, error: Some(e), word: None },
    };
    let safe: String = decision.uid.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let file = format!("{safe}.mp3");
    let _ = std::fs::write(dir.join(&file), &rendered.mp3);
    let mut word = None;
    if let How::Matched(m) = &voice.how {
        if let Some(w) = longest_kanji_run(&decision.text) {
            if let Some((a, b)) = kimochi_speech::matching::word_span(&decision.text, &w, &m.char_ms) {
                if let Ok(mp3) = clips::render_word(&rendered.pcm, rendered.sample_rate, rendered.start_ms, a, b) {
                    let name = format!("{safe}-word.mp3");
                    let _ = std::fs::write(dir.join(&name), mp3);
                    word = Some(format!("{w}|{name}"));
                }
            }
        }
    }
    Clipped { file: Some(file), error: None, word }
}

fn longest_kanji_run(text: &str) -> Option<String> {
    let mut best = String::new();
    let mut run = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if ('\u{4E00}'..='\u{9FFF}').contains(&c) || c == '々' {
            run.push(c);
        } else {
            if run.chars().count() > best.chars().count() {
                best = run.clone();
            }
            run.clear();
        }
    }
    (best.chars().count() >= 2).then_some(best)
}
