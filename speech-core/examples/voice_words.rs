//! Transcribes recorded voice clips and scores every line against every clip by its words, for
//! measuring how well a clip's own transcript tells which line it voices.
//!   cargo run --release --example voice_words -- <dir> [--ort onnxruntime.dll] [--model sensevoice dir]
//! `<dir>` holds `voices.json` (`[{start, dur, file}]`, files relative to it) and `lines.jsonl`
//! (`{uid, text, ts}`). Writes `<dir>/words.json`: each clip's transcript and transcription time,
//! and for each (line, clip) within 20 s of each other the match score and the share of the
//! clip's heard characters the match covers.
use kimochi_speech::matching::{self, Heard};
use kimochi_speech::sense_voice::SenseVoice;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Instant;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(&args[1]);
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default());
    let ort = arg(&args, "--ort")
        .map(PathBuf::from)
        .unwrap_or_else(|| local.join(r"Kimochi\meikiocr\runtime\onnxruntime.dll"));
    let model =
        arg(&args, "--model").map(PathBuf::from).unwrap_or_else(|| local.join(r"dev.kimochi.app\models\sensevoice"));
    let threads: usize = arg(&args, "--threads").and_then(|t| t.parse().ok()).unwrap_or(2);
    ort::init_from(ort.display().to_string()).commit().expect("onnx runtime");
    let loaded = Instant::now();
    let mut asr = SenseVoice::load(&model, threads).expect("sensevoice");
    let mut vad = kimochi_speech::vad::Vad::new().expect("silero");
    eprintln!("model loaded in {:?}", loaded.elapsed());
    let voices: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(dir.join("voices.json")).unwrap()).unwrap();
    let lines: Vec<Value> = std::fs::read_to_string(dir.join("lines.jsonl"))
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let mut clips = Vec::new();
    for v in &voices {
        if v["candidates"].as_u64().is_some_and(|c| c != 1) {
            continue;
        }
        let start = v["start"].as_f64().unwrap();
        let path = dir.join(v["file"].as_str().unwrap());
        let (samples, rate) = match kimochi_speech::hooked::feed::decode(&path) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("{}: {e}", path.display());
                continue;
            }
        };
        let secs = samples.len() as f64 / rate as f64;
        let vad_began = Instant::now();
        let share = vad.speech_share(&samples, rate).unwrap_or(-1.0);
        let vad_ms = vad_began.elapsed().as_secs_f64() * 1000.0;
        let began = Instant::now();
        let audio = kimochi_speech::vad::to_16k(&samples, rate);
        let heard = asr.transcribe(&audio).unwrap_or_default();
        let ms = began.elapsed().as_secs_f64() * 1000.0;
        let text: String = heard.iter().map(|c| c.ch).collect();
        eprintln!("{start:.0} {secs:.2}s speech {share:.2} (vad {vad_ms:.0} ms) asr {ms:.0} ms: {text}");
        clips.push((start, secs, Heard::new(start, start + secs * 1000.0, heard), ms));
    }
    let mut pairs = Vec::new();
    for l in &lines {
        let (uid, text, ts) = (l["uid"].as_str().unwrap(), l["text"].as_str().unwrap(), l["ts"].as_f64().unwrap());
        for (start, _, heard, _) in &clips {
            if (start - ts).abs() > 20_000.0 {
                continue;
            }
            let m = matching::find(text, std::slice::from_ref(heard), heard.start_ms, heard.end_ms);
            let heard_n = matching::fold(&heard.text()).0.len().max(1);
            let (score, covered, from_start) = m.as_ref().map_or((0.0, 0.0, false), |m| {
                let covered = heard.chars.iter().filter(|c| c.ms >= m.heard_from_ms && c.ms <= m.heard_to_ms).count();
                (m.score, covered as f64 / heard_n as f64, m.from_line_start)
            });
            pairs.push(json!({ "uid": uid, "start": start, "d": start - ts, "score": score, "covered": covered, "fromStart": from_start }));
        }
    }
    let out = json!({
        "clips": clips.iter().map(|(s, secs, h, ms)| json!({ "start": s, "secs": secs, "text": h.text(), "ms": ms })).collect::<Vec<_>>(),
        "pairs": pairs,
    });
    std::fs::write(dir.join("words.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
