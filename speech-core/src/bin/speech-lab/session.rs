//! A session folder: what was recorded and what was read (see main.rs).
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub audio: String,
    /// Unix ms of the audio's first sample.
    pub audio_start_ms: f64,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Truth {
    pub voiced: bool,
    #[serde(default)]
    pub start_ms: Option<f64>,
    #[serde(default)]
    pub end_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRow {
    pub uid: String,
    pub text: String,
    pub ts: f64,
    /// `hook` (WebSocket, clipboard: arrives as the text appears) or `ocr`.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appeared: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truth: Option<Truth>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenRow {
    pub at: f64,
    pub text: String,
}

pub struct Session {
    pub dir: PathBuf,
    pub meta: Meta,
    pub lines: Vec<LineRow>,
    pub screen: Vec<ScreenRow>,
}

fn rows<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(Vec::new()) };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| serde_json::from_str(l).map_err(|e| format!("{}:{}: {e}", path.display(), i + 1)))
        .collect()
}

impl Session {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let meta: Meta = serde_json::from_str(
            &std::fs::read_to_string(dir.join("session.json")).map_err(|e| format!("{}/session.json: {e}", dir.display()))?,
        )
        .map_err(|e| e.to_string())?;
        let mut lines: Vec<LineRow> = rows(&dir.join("lines.jsonl"))?;
        lines.sort_by(|a, b| a.ts.total_cmp(&b.ts));
        let mut screen: Vec<ScreenRow> = rows(&dir.join("screen.jsonl"))?;
        screen.sort_by(|a, b| a.at.total_cmp(&b.at));
        Ok(Self { dir: dir.to_path_buf(), meta, lines, screen })
    }

    pub fn audio_path(&self) -> PathBuf {
        self.dir.join(&self.meta.audio)
    }
}

/// Write a session's files (audio already written as `audio.wav`).
pub fn write(dir: &Path, meta: &Meta, lines: &[LineRow], screen: &[ScreenRow]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("session.json"), serde_json::to_string_pretty(meta).unwrap()).map_err(|e| e.to_string())?;
    let mut out = std::fs::File::create(dir.join("lines.jsonl")).map_err(|e| e.to_string())?;
    for line in lines {
        writeln!(out, "{}", serde_json::to_string(line).unwrap()).map_err(|e| e.to_string())?;
    }
    if !screen.is_empty() {
        let mut out = std::fs::File::create(dir.join("screen.jsonl")).map_err(|e| e.to_string())?;
        for row in screen {
            writeln!(out, "{}", serde_json::to_string(row).unwrap()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
