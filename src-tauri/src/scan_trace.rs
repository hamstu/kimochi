//! Bounded diagnostic sink, isolated from the UI event/log broadcast machinery.
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};
use tauri::Manager;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn append(directory: &Path, records: &[Value], limit: u64) -> Result<(), String> {
    if records.len() > 64 {
        return Err("invalid: trace batch too large".into());
    }
    let mut bytes = Vec::new();
    for record in records {
        let encoded = serde_json::to_vec(record).map_err(|e| e.to_string())?;
        if encoded.len() > 32 * 1024 {
            return Err("invalid: trace record too large".into());
        }
        bytes.extend_from_slice(&encoded);
        bytes.push(b'\n');
    }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let current = directory.join("auto-ocr-trace.jsonl");
    let previous = directory.join("auto-ocr-trace.1.jsonl");
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    if current.metadata().map(|m| m.len()).unwrap_or(0) + bytes.len() as u64 > limit {
        if previous.exists() {
            fs::remove_file(&previous).map_err(|e| e.to_string())?;
        }
        if current.exists() {
            fs::rename(&current, &previous).map_err(|e| e.to_string())?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_trace(app: tauri::AppHandle, records: Vec<Value>) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || append(&directory, &records, MAX_BYTES))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_keeps_two_readable_files_and_refuses_oversized_records() {
        let dir = std::env::temp_dir().join(format!("kimochi-trace-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let record = serde_json::json!({"kind":"first-pass","frameId":1});
        for _ in 0..4 {
            append(&dir, std::slice::from_ref(&record), 60).unwrap();
        }
        for name in ["auto-ocr-trace.jsonl", "auto-ocr-trace.1.jsonl"] {
            let data = fs::read_to_string(dir.join(name)).unwrap();
            assert!(data.len() <= 60);
            for line in data.lines() {
                assert_eq!(serde_json::from_str::<Value>(line).unwrap(), record);
            }
        }
        assert!(append(&dir, &[serde_json::json!({"x":"a".repeat(33000)})], 60).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
