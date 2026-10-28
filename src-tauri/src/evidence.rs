//! Whole-line diagnostic writes and rotation share one lock across recording threads.
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

static WRITER: Mutex<()> = Mutex::new(());

pub fn append(path: &Path, value: &serde_json::Value, max_bytes: u64) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value)?;
    line.push(b'\n');
    let _guard = WRITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if path.metadata().is_ok_and(|metadata| metadata.len() > max_bytes) {
        let previous = path.with_file_name("evidence.1.jsonl");
        // Windows rename does not replace an existing destination.
        match std::fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::rename(path, previous)?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(&line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_records_remain_whole_and_rotation_replaces_previous() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("kimochi-evidence-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("evidence.jsonl");
        std::thread::scope(|scope| {
            for writer in 0..8 {
                let path = &path;
                scope.spawn(move || {
                    for index in 0..100 {
                        append(path, &serde_json::json!({"writer": writer, "index": index}), u64::MAX).unwrap();
                    }
                });
            }
        });
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 800);
        for line in text.lines() { serde_json::from_str::<serde_json::Value>(line).unwrap(); }
        append(&path, &serde_json::json!({"next": 1}), 0).unwrap();
        append(&path, &serde_json::json!({"next": 2}), 0).unwrap();
        assert_eq!(std::fs::read_to_string(path.with_file_name("evidence.1.jsonl")).unwrap(), "{\"next\":1}\n");
        // Leave test artifacts in TEMP for inspection; no recursive cleanup.
    }
}
