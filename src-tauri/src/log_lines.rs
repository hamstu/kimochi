//! The Log's newest lines, for the controller's Recent text (ui/controller-history.js): what the
//! Log shows, whatever it came from (OCR, the Text Hooker, the clipboard, a WebSocket), not
//! only the scan history the overlay keeps.
//!
//! The Log owns its files (frontend/texthooker/core/sessions.ts); this only reads the open
//! session's `<profile>/sessions/<sid>/lines.json`, which the Log writes a moment after each line.
use serde_json::{json, Value};
use std::path::Path;

/// The newest `limit` lines of the session the Log has open in profile folder `dir`, newest
/// first, as `{id, text, timestamp, source}`. Empty when there is no open session or file.
pub fn recent(dir: &Path, limit: usize) -> Vec<Value> {
    let Some(sid) = crate::anki_cards::active_session(dir) else { return Vec::new() };
    let Some(file) = crate::profile::read_json(&dir.join("sessions").join(&sid).join("lines.json")) else {
        return Vec::new();
    };
    file["lines"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|line| {
            let text = line["text"].as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            let id = line["uid"]
                .as_str()
                .map(str::to_string)
                .or_else(|| line["id"].as_u64().map(|n| format!("{sid}-{n}")))?;
            Some(json!({
                "id": id,
                "text": text,
                "timestamp": line["ts"].as_u64(),
                "source": line["source"],
            }))
        })
        .take(limit)
        .collect()
}

/// The Log's newest lines (up to `limit`, 50 by default), newest first.
#[tauri::command]
pub fn log_recent(limit: Option<usize>) -> Vec<Value> {
    crate::account::active_profile_dir().map_or_else(Vec::new, |dir| recent(&dir, limit.unwrap_or(50).min(200)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_open_sessions_lines_come_newest_first_whatever_their_source() {
        let dir = std::env::temp_dir().join(format!("kimochi-log-lines-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sessions/s1")).unwrap();
        std::fs::write(
            dir.join("sessions.json"),
            r#"{"version":1,"activeId":"s1","sessions":[{"id":"s1","name":"Game"}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("sessions/s1/lines.json"),
            r#"{"version":1,"lines":[
                {"id":1,"uid":"a","text":"スキャン","source":"ocr","ts":1},
                {"id":2,"text":"  ","source":"hook","ts":2},
                {"id":3,"uid":"c","text":"わたしは見守る。","source":"hook","ts":3},
                {"id":4,"text":"沈みゆく地球を。","source":"hook","ts":4}
            ]}"#,
        )
        .unwrap();
        let lines = recent(&dir, 50);
        let texts: Vec<&str> = lines.iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["沈みゆく地球を。", "わたしは見守る。", "スキャン"]);
        assert_eq!(lines[0]["id"], "s1-4");
        assert_eq!(lines[0]["source"], "hook");
        assert_eq!(lines[0]["timestamp"], 4);
        assert_eq!(recent(&dir, 1).len(), 1);
        std::fs::write(dir.join("sessions.json"), r#"{"version":1,"activeId":"gone","sessions":[]}"#).unwrap();
        assert!(recent(&dir, 50).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
