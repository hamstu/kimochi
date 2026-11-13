//! vh-speechcheck: listens to a capture's WAV clips with Kimochi's own speech stack (Silero VAD
//! and SenseVoice from `kimochi-speech`) and writes `speech.jsonl` next to `events.jsonl`:
//! `{"seq", "file", "secs", "speech": <share of 32 ms frames with p > 0.5>, "text"}`.
//! `vh-classify` uses it as its per-clip speech check. Encoded clips (ogg, m4a) are skipped.
//!
//! ```text
//! vh-speechcheck <capture dir> [--ort <onnxruntime.dll>] [--model <sensevoice dir>] [--max-secs 30]
//! ```
//! Defaults: the ONNX Runtime and SenseVoice model a Kimochi install keeps in
//! `%LOCALAPPDATA%\Kimochi\meikiocr\runtime` and `%LOCALAPPDATA%\dev.kimochi.app\models\sensevoice`.
//! Build for the host (ARM64 on an ARM64 machine), to match that runtime.
use kimochi_speech::sense_voice::SenseVoice;
use kimochi_speech::vad::{self, Vad};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(dir) = args.get(1).map(PathBuf::from) else {
        eprintln!("vh-speechcheck <capture dir> [--ort dll] [--model dir] [--max-secs 30]");
        std::process::exit(2);
    };
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default());
    let ort_dll = arg(&args, "--ort")
        .map(PathBuf::from)
        .unwrap_or_else(|| local.join(r"Kimochi\meikiocr\runtime\onnxruntime.dll"));
    let model =
        arg(&args, "--model").map(PathBuf::from).unwrap_or_else(|| local.join(r"dev.kimochi.app\models\sensevoice"));
    let max_secs: f64 = arg(&args, "--max-secs").and_then(|s| s.parse().ok()).unwrap_or(30.0);
    if let Err(e) = ort::init_from(ort_dll.display().to_string()).commit() {
        eprintln!("ONNX Runtime {}: {e}", ort_dll.display());
        std::process::exit(1);
    }
    let mut asr = match SenseVoice::load(&model, 4) {
        Ok(a) => Some(a),
        Err(e) => {
            eprintln!("SenseVoice not loaded ({e}); speech ratio only");
            None
        }
    };
    let events = std::fs::read_to_string(dir.join("events.jsonl")).expect("events.jsonl");
    let mut out = std::fs::File::create(dir.join("speech.jsonl")).expect("speech.jsonl");
    for line in events.lines() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        let Some(file) =
            e["file"].as_str().filter(|f| e["ev"] == "clip" && (f.ends_with(".wav") || f.ends_with(".ogg")))
        else {
            continue;
        };
        if e["meta"]["replay"] == true {
            continue;
        }
        let secs = e["dur"].as_f64().unwrap_or(0.0);
        if secs > max_secs {
            continue;
        }
        let path = dir.join(file);
        let read = if file.ends_with(".ogg") { read_ogg(&path) } else { kimochi_speech::wav::read(&path) };
        let Ok((samples, rate)) = read else { continue };
        let audio = vad::to_16k(&samples, rate);
        let speech = speech_ratio(&audio);
        let text =
            asr.as_mut().and_then(|a| a.transcribe(&audio).ok()).map(|h| h.iter().map(|c| c.ch).collect::<String>());
        let row = json!({"seq": e["seq"], "file": file, "secs": secs, "speech": speech, "text": text});
        println!("{row}");
        let _ = writeln!(out, "{row}");
    }
}

fn speech_ratio(audio: &[f32]) -> Option<f64> {
    let mut stream = vad::Stream::new(Vad::new().ok()?);
    let p = stream.push(audio).ok()?;
    if p.is_empty() {
        return Some(0.0);
    }
    Some(p.iter().filter(|(x, _)| *x > 0.5).count() as f64 / p.len() as f64)
}

/// Ogg Vorbis to mono f32 (Ren'Py, RPG Maker and TyranoScript clips are the original files).
fn read_ogg(path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
    let f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut r = lewton::inside_ogg::OggStreamReader::new(f).map_err(|e| e.to_string())?;
    let (rate, ch) = (r.ident_hdr.audio_sample_rate, r.ident_hdr.audio_channels as usize);
    let mut out = Vec::new();
    while let Some(pkt) = r.read_dec_packet_itl().map_err(|e| e.to_string())? {
        for frame in pkt.chunks(ch.max(1)) {
            out.push(frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / ch.max(1) as f32);
        }
    }
    Ok((out, rate))
}
