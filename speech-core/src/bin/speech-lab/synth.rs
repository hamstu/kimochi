//! A session made from voiced lines whose text is known (a game's script and voice files): laid
//! out the way a player clicks through them, so the truth is known to the millisecond.
//!
//! The dataset is a JSON array of `{"text": …, "voice": "path/to/line.mp3"}` (paths relative to
//! the dataset file; a line without `voice` is unvoiced). The player:
//!
//! - sees each line, and its voice starts 100–400 ms later (sometimes 800 ms);
//! - waits 0.4–1.6 s after the voice ends before clicking on, but one line in eight is clicked
//!   past mid-voice, which cuts it off;
//! - reads an unvoiced line for a second or two.
//!
//! `--mode` is how the lines reach Kimochi: `hook` (as they appear, like a texthooker),
//! `typewriter` (drawn in at 35 ms a character and read by automatic OCR: screen readings every
//! 200 ms, the line logged once the text has settled), or `manual` (a manual OCR scan, with no
//! screen readings: one in three while the voice is still playing, the others up to a few
//! seconds after it). `--bgm` mixes music under it all (looped, at -18 dB).
//!
//! For the OCR modes, `--names` puts the speaker's name box (the dataset's `speaker`) in each
//! scan beside the dialogue, as its own line, the way OCR reads a game's name plate; and
//! `--rereads` has one line in four read first in part (automatic OCR settling early, a manual
//! scan that missed half the box) and then in full, the fuller reading replacing the first in
//! the Log as the app's history merge does.
use crate::session::{self, LineRow, Meta, ScreenRow, Truth};
use serde::Deserialize;
use std::path::Path;

const RATE: u32 = 48_000;
const CHAR_MS: f64 = 35.0;
const READING_MS: f64 = 200.0;
/// From the text settling to the OCR'd line arriving: two equal readings and the accurate scan.
const SETTLE_TO_LINE_MS: f64 = 2.0 * READING_MS + 400.0;
const BGM_GAIN: f32 = 0.125;
/// Session times start here (any fixed Unix time: the replay only cares about differences).
const T0: f64 = 1_800_000_000_000.0;

#[derive(Deserialize)]
struct Entry {
    text: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    speaker: Option<String>,
}

/// A small, seeded random source, so a dataset always lays out the same way.
struct Random(u64);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }

    fn between(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next()
    }
}

pub fn main(args: &[String]) -> Result<(), String> {
    let positional = crate::positional(args);
    let (dataset, dir) = match positional.as_slice() {
        [dataset, dir, ..] => (Path::new(dataset), Path::new(dir)),
        _ => return Err(crate::USAGE.into()),
    };
    let mode = crate::flag(args, "--mode").unwrap_or("hook");
    if !matches!(mode, "hook" | "typewriter" | "manual") {
        return Err(format!("unknown --mode {mode}"));
    }
    let seed: u64 = crate::flag(args, "--seed").and_then(|s| s.parse().ok()).unwrap_or(7);
    let limit: usize = crate::flag(args, "--lines").and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let names = crate::has(args, "--names") && mode != "hook";
    let rereads = crate::has(args, "--rereads") && mode != "hook";
    let entries: Vec<Entry> = serde_json::from_str(&std::fs::read_to_string(dataset).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let base = dataset.parent().unwrap_or(Path::new("."));
    let mut random = Random(seed.max(1) * 0x9E37_79B9_7F4A_7C15);
    let mut audio: Vec<f32> = Vec::new();
    let mut lines = Vec::new();
    let mut screen = Vec::new();
    let ms_to_index = |ms: f64| (ms * RATE as f64 / 1000.0) as usize;
    let mut t = 1_000.0;
    for (i, entry) in entries.iter().take(limit).enumerate() {
        let shown = t;
        let chars = entry.text.chars().count();
        let drawn = shown + chars as f64 * CHAR_MS;
        let mut truth = Truth { voiced: false, start_ms: None, end_ms: None };
        let mut next = shown + 1_200.0 + chars as f64 * 60.0;
        let mut scan_at = drawn + random.between(1_000.0, 3_000.0);
        let mid_voice = random.next() < 1.0 / 3.0;
        if let Some(voice) = &entry.voice {
            let samples = crate::decode_audio(&base.join(voice), RATE)?;
            let (speech_from, speech_to) = speech_extent(&samples);
            let delay = if random.next() < 0.1 { 800.0 } else { random.between(100.0, 400.0) };
            let start = shown + delay;
            let mut length = samples.len() as f64 * 1000.0 / RATE as f64;
            let mut end = start + speech_to;
            next = end + random.between(400.0, 1_600.0);
            if random.next() < 0.125 && speech_to - speech_from > 1_500.0 {
                // Clicked past mid-voice: the voice stops there.
                let cut = start + speech_from + (speech_to - speech_from) * random.between(0.4, 0.8);
                length = cut - start;
                end = cut;
                next = cut;
            }
            let at = ms_to_index(start);
            let n = ms_to_index(length).min(samples.len());
            if audio.len() < at + n {
                audio.resize(at + n, 0.0);
            }
            for (k, s) in samples[..n].iter().enumerate() {
                audio[at + k] += s;
            }
            truth = Truth { voiced: true, start_ms: Some(T0 + start + speech_from), end_ms: Some(T0 + end) };
            scan_at = if mid_voice {
                // Scanned while the voice is still playing, once the text is there.
                (start + speech_from + (end - start - speech_from) * random.between(0.2, 0.8)).max(drawn + 200.0)
            } else {
                end + random.between(300.0, 3_000.0)
            };
        }
        let (ts, appeared_screen) = match mode {
            "hook" => (shown + random.between(5.0, 40.0), false),
            "typewriter" => (drawn + SETTLE_TO_LINE_MS, true),
            _ => (scan_at, false),
        };
        if mode == "manual" {
            next = next.max(scan_at + 500.0);
        }
        let name = entry.speaker.as_deref().filter(|_| names);
        if appeared_screen {
            let mut at = (shown / READING_MS).ceil() * READING_MS;
            while at < next.min(drawn + 3.0 * READING_MS) {
                let visible = (((at - shown) / CHAR_MS).floor() as usize).min(chars);
                if visible > 0 {
                    let text: String = entry.text.chars().take(visible).collect();
                    screen.push(ScreenRow { at: T0 + at, text: name.map_or(text.clone(), |n| format!("{n} {text}")) });
                }
                at += READING_MS;
            }
        }
        let uid = format!("l{:03}", i + 1);
        // A scan: the name box (when there is one) and the dialogue, arriving together.
        let scan = |uid: &str, text: String, ts: f64, replaces: Vec<String>, truth: Truth| {
            let mut rows = Vec::new();
            let ocr = mode != "hook";
            if let Some(name) = name {
                rows.push(LineRow {
                    uid: format!("{uid}n"),
                    text: name.to_string(),
                    ts: T0 + ts,
                    source: "ocr".into(),
                    scan: Some(format!("s{uid}")),
                    kind: Some("name".into()),
                    truth: Some(Truth { voiced: false, start_ms: None, end_ms: None }),
                    ..LineRow::default()
                });
            }
            rows.push(LineRow {
                uid: uid.to_string(),
                text,
                ts: T0 + ts,
                source: if ocr { "ocr".into() } else { "hook".into() },
                scan: ocr.then(|| format!("s{uid}")),
                replaces,
                truth: Some(truth),
                ..LineRow::default()
            });
            rows
        };
        let mut replaces = Vec::new();
        let ts = if rereads && chars >= 8 && random.next() < 0.25 {
            // Read in part first; the full reading follows and takes its place.
            let partial = format!("{uid}p");
            let half: String = entry.text.chars().take(chars / 2).collect();
            let (first, full) = match mode {
                "typewriter" => (shown + (chars / 2) as f64 * CHAR_MS + SETTLE_TO_LINE_MS, ts),
                _ => (ts, ts + random.between(800.0, 2_000.0)),
            };
            let rows = scan(&partial, half, first, Vec::new(), truth.clone());
            replaces = rows.iter().map(|r| r.uid.clone()).collect();
            lines.extend(rows);
            if mode == "manual" {
                next = next.max(full + 500.0);
            }
            full
        } else {
            ts
        };
        lines.extend(scan(&uid, entry.text.clone(), ts, replaces, truth));
        t = next.max(ts + 50.0);
    }
    audio.resize(ms_to_index(t + 3_000.0), 0.0);
    if let Some(bgm) = crate::flag(args, "--bgm") {
        let music = crate::decode_audio(Path::new(bgm), RATE)?;
        if !music.is_empty() {
            for (k, s) in audio.iter_mut().enumerate() {
                *s += music[k % music.len()] * BGM_GAIN;
            }
        }
    }
    let peak = audio.iter().fold(0f32, |m, s| m.max(s.abs()));
    if peak > 0.99 {
        audio.iter_mut().for_each(|s| *s *= 0.99 / peak);
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    kimochi_speech::wav::write(&dir.join("audio.wav"), &audio, RATE)?;
    let meta = Meta {
        audio: "audio.wav".into(),
        audio_start_ms: T0,
        notes: Some(format!("synth from {} (mode {mode}, seed {seed})", dataset.display())),
    };
    session::write(dir, &meta, &lines, &screen)?;
    println!("{} lines, {:.0}s of audio, in {}", lines.len(), audio.len() as f64 / RATE as f64, dir.display());
    Ok(())
}

/// Where the speech in a voice file starts and ends (ms): its first and last 10 ms above
/// -35 dB of its peak. Voice files carry silence at their ends, which is not the voice.
fn speech_extent(samples: &[f32]) -> (f64, f64) {
    let block = (RATE / 100) as usize;
    let levels: Vec<f32> = samples.chunks(block).map(|c| c.iter().fold(0f32, |m, s| m.max(s.abs()))).collect();
    let peak = levels.iter().fold(0f32, |m, l| m.max(*l));
    let loud = |l: &f32| *l >= peak * 0.018;
    let first = levels.iter().position(loud).unwrap_or(0);
    let last = levels.iter().rposition(loud).map_or(levels.len(), |i| i + 1);
    (first as f64 * 10.0, last as f64 * 10.0)
}
