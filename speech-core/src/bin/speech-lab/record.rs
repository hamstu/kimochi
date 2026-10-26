//! Record a live session: what this computer plays (the app's own capture,
//! `kimochi_capture::audio`), and lines as they arrive on stdin: a row of plain text, or a JSON
//! row `{"text": …, "source"?: "hook"|"ocr", "ts"?: Unix ms, "truth"?: …}`, stamped on arrival
//! unless it carries its own time. Stops after `--seconds` (default 600), or when stdin closes
//! and `--seconds` was not given.
use crate::session::{self, LineRow, Meta};
use kimochi_speech::{now_ms, AudioRing};
use std::io::BufRead;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

pub fn main(args: &[String]) -> Result<(), String> {
    let positional = crate::positional(args);
    let dir = Path::new(positional.first().ok_or(crate::USAGE)?);
    let limit: Option<f64> = crate::flag(args, "--seconds").and_then(|s| s.parse().ok());
    let mut capture = kimochi_capture::audio::SystemAudio::start().map_err(|e| format!("{} ({})", e.message, e.code))?;
    eprintln!("recording {} (own audio left out: {})", capture.source(), capture.excludes_own_audio());
    let seconds = limit.unwrap_or(600.0);
    let mut ring = AudioRing::new(48_000, seconds + 5.0);
    let (tx, rx) = mpsc::channel::<Option<(f64, String)>>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let _ = tx.send(Some((now_ms(), line)));
        }
        let _ = tx.send(None);
    });
    let started = now_ms();
    let mut lines = Vec::new();
    let mut open = true;
    while now_ms() - started < seconds * 1000.0 && (open || limit.is_some()) {
        std::thread::sleep(Duration::from_millis(20));
        capture.drain_into(&mut ring);
        if let Some(why) = capture.ended() {
            eprintln!("the recording stopped: {why}");
            break;
        }
        while let Ok(message) = rx.try_recv() {
            match message {
                Some((at, text)) => {
                    if let Some(row) = row(at, &text, lines.len()) {
                        eprintln!("{:>7.2}s  {}", (row.ts - started) / 1000.0, row.text);
                        lines.push(row);
                    }
                }
                None => open = false,
            }
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    capture.drain_into(&mut ring);
    let (Some(start), Some(end)) = (ring.start_ms(), ring.end_ms()) else {
        return Err("No audio arrived.".into());
    };
    let clip = ring.snapshot(start, end).ok_or("No audio arrived.")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    kimochi_speech::wav::write(&dir.join("audio.wav"), &clip.samples, clip.sample_rate)?;
    let meta = Meta { audio: "audio.wav".into(), audio_start_ms: clip.start_ms, notes: Some(format!("recorded from {}", capture.source())) };
    session::write(dir, &meta, &lines, &[])?;
    println!("{} lines, {:.0}s of audio, in {}", lines.len(), clip.duration_ms() / 1000.0, dir.display());
    Ok(())
}

fn row(at: f64, text: &str, index: usize) -> Option<LineRow> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let uid = format!("r{:03}", index + 1);
    if text.starts_with('{') {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        return Some(LineRow {
            uid: field(&value, "uid").unwrap_or(uid),
            text: value.get("text")?.as_str()?.to_string(),
            ts: value.get("ts").and_then(|v| v.as_f64()).unwrap_or(at),
            source: value.get("source").and_then(|v| v.as_str()).unwrap_or("hook").to_string(),
            appeared: field(&value, "appeared"),
            scan: field(&value, "scan"),
            replaces: field(&value, "replaces").unwrap_or_default(),
            kind: field(&value, "kind"),
            truth: field(&value, "truth"),
        });
    }
    Some(LineRow { uid, text: text.to_string(), ts: at, source: "hook".into(), ..LineRow::default() })
}

fn field<T: serde::de::DeserializeOwned>(value: &serde_json::Value, name: &str) -> Option<T> {
    value.get(name).and_then(|v| serde_json::from_value(v.clone()).ok())
}
