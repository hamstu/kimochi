//! The sentence-audio lab: the app's listener (`kimochi_speech::listener`) run outside the app,
//! on a recording, so how well lines get their voice can be measured and listened to.
//!
//! Everything goes through a *session*: a folder holding what was recorded and what was read.
//!
//! ```text
//! session.json   { "audio": "audio.wav", "audioStartMs": <Unix ms of the first sample> }
//! audio.wav      what the computer played (mono)
//! lines.jsonl    one line a row, as the Log got it: {"uid","text","ts","source":"hook"|"ocr",
//!                "appeared"?: ms, "scan"?: id (a scan's lines share it: name box, dialogue),
//!                "replaces"?: [uid…] (a fuller reading that took those lines' place),
//!                "kind"?: "name", "truth"?: {"voiced": bool, "startMs": ms, "endMs": ms}}
//! screen.jsonl   optional: the quick screen readings automatic OCR made, {"at": ms, "text"}
//! ```
//!
//! Sessions come from four places:
//!
//! - `record`: this computer's audio, live, with lines typed or piped in (one per row of stdin,
//!   plain text or a JSON line), as any texthooker would send them.
//! - `video`: a screen recording with sound. The audio is taken out with ffmpeg, the frames are
//!   read a few times a second with the OS's quick text reader (Live Text on macOS) the way
//!   automatic OCR reads a game, and a line is logged whenever the text settles.
//! - `synth`: voiced lines with their text (a game's voice files and script), laid out the way
//!   a player clicks through them, optionally under music, with the truth known.
//! - by hand: anything that writes the files above.
//!
//! `replay` runs a session through the listener as fast as the computer can, cutting each line's
//! clip, and writes `report.html` (every line, what was decided, its clip to play, and how far
//! off it was when the truth is known), `report.json` and `clips/`.
//!
//! ```text
//! speech-lab record <session> [--seconds N]
//! speech-lab video <file> <session> [--fps 5] [--crop x,y,w,h]
//! speech-lab synth <dataset.json> <session> [--bgm music.mp3] [--mode hook|typewriter|manual]
//!                  [--names] [--rereads] [--seed N] [--lines N]
//! speech-lab replay <session> [--model DIR | --no-model] [--out DIR]
//! ```
//!
//! The ONNX Runtime is the app's: `KIMOCHI_ORT` names the library, else the one staged in
//! `src-tauri/resources/meikiocr/runtime/` is used. The model is the one the app downloaded
//! (Settings → Anki → Sentence audio), or `--model`.
mod record;
mod replay;
mod report;
mod session;
mod synth;
mod video;

use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("replay") => replay::main(&args[1..]),
        Some("record") => record::main(&args[1..]),
        Some("video") => video::main(&args[1..]),
        Some("synth") => synth::main(&args[1..]),
        _ => Err(USAGE.to_string()),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

const USAGE: &str = "usage:
  speech-lab record <session> [--seconds N]
  speech-lab video <file> <session> [--fps 5] [--crop x,y,w,h]
  speech-lab synth <dataset.json> <session> [--bgm music.mp3] [--mode hook|typewriter|manual]
                   [--names] [--rereads] [--seed N] [--lines N]
  speech-lab replay <session> [--model DIR | --no-model] [--out DIR]";

/// `--name value` from `args`.
pub fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

pub fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// The positional arguments (those not a flag or a flag's value).
pub fn positional(args: &[String]) -> Vec<&str> {
    let mut out = Vec::new();
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
        } else if a.starts_with("--") {
            skip = !matches!(a.as_str(), "--no-model");
        } else {
            out.push(a.as_str());
        }
    }
    out
}

/// Load the app's ONNX Runtime.
pub fn onnx_runtime() -> Result<(), String> {
    let path = match std::env::var_os("KIMOCHI_ORT") {
        Some(path) => PathBuf::from(path),
        None => {
            let name = if cfg!(target_os = "windows") {
                "onnxruntime.dll"
            } else if cfg!(target_os = "macos") {
                "libonnxruntime.dylib"
            } else {
                "libonnxruntime.so"
            };
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-tauri/resources/meikiocr/runtime").join(name)
        }
    };
    if !path.is_file() {
        return Err(format!(
            "No ONNX Runtime at {}: stage it (npm run prepare in the repo) or set KIMOCHI_ORT.",
            path.display()
        ));
    }
    ort::init_from(path.to_string_lossy().to_string()).commit().map(|_| ()).map_err(|e| e.to_string())
}

/// Where the app keeps the downloaded SenseVoice model on this computer.
pub fn app_model_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    }?;
    Some(base.join("dev.kimochi.app/models/sensevoice"))
}

/// Decode any audio (or a video's sound) to mono f32 at `rate` with ffmpeg.
pub fn decode_audio(path: &Path, rate: u32) -> Result<Vec<f32>, String> {
    let out = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le", "-"])
        .output()
        .map_err(|e| format!("ffmpeg (needed to read {}): {e}", path.display()))?;
    if !out.status.success() {
        return Err(format!("ffmpeg could not read {}: {}", path.display(), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}
