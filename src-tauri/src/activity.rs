//! The activity feed's transport: one short sentence about what the app is doing, broadcast to
//! every window as an `activity` event `{text, tone, key, at}`.
//!
//! Nothing is stored here. Each window keeps its own feed in memory (`ui/activity.ts`), which
//! is where repeats coalesce and a `busy` post is settled by the next post with its key. Rust
//! only stamps the time, so posts from different windows and from native code share one clock,
//! and keeps the text to a single bounded line.
use serde::Serialize;
use tauri::Emitter;

/// The event every window's feed listens to.
pub const EVENT: &str = "activity";

/// Longest message carried, in characters; `ACTIVITY_TEXT_LIMIT` in `ui/activity.ts`.
const TEXT_LIMIT: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Info,
    /// Work in progress; the next post with the same key settles it.
    Busy,
    Ok,
    Warn,
    Error,
}

impl Tone {
    pub fn parse(tone: &str) -> Result<Self, String> {
        Ok(match tone {
            "info" => Tone::Info,
            "busy" => Tone::Busy,
            "ok" => Tone::Ok,
            "warn" => Tone::Warn,
            "error" => Tone::Error,
            other => return Err(format!("invalid: unknown activity tone {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Activity {
    pub text: String,
    pub tone: Tone,
    pub key: Option<String>,
    /// Epoch milliseconds.
    pub at: u64,
}

/// One line of text, whitespace collapsed and bounded; `None` when there is nothing to say.
fn one_line(text: &str) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    if flat.chars().count() <= TEXT_LIMIT {
        return Some(flat);
    }
    let mut cut: String = flat.chars().take(TEXT_LIMIT - 1).collect();
    cut.push('…');
    Some(cut)
}

impl Activity {
    pub fn new(text: &str, tone: Tone, key: Option<&str>, at: u64) -> Option<Self> {
        Some(Activity {
            text: one_line(text)?,
            tone,
            key: key.filter(|key| !key.is_empty()).map(str::to_string),
            at,
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Post from native code. Never fails the caller: a feed that cannot be told is not an error.
pub fn post(app: &tauri::AppHandle, text: &str, tone: Tone, key: Option<&str>) {
    if let Some(activity) = Activity::new(text, tone, key, now_ms()) {
        let _ = app.emit(EVENT, activity);
    }
}

/// Post from any window, to every window (the poster included).
#[tauri::command]
pub fn activity_post(
    app: tauri::AppHandle,
    text: String,
    tone: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let tone = Tone::parse(tone.as_deref().unwrap_or("info"))?;
    post(&app, &text, tone, key.as_deref());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_post_serializes_as_the_event_payload_the_feed_reads() {
        let activity = Activity::new("Added 3 lines", Tone::Ok, Some("scan"), 42).unwrap();
        assert_eq!(
            serde_json::to_value(&activity).unwrap(),
            serde_json::json!({"text": "Added 3 lines", "tone": "ok", "key": "scan", "at": 42})
        );
        let unkeyed = Activity::new("Auto-scan on", Tone::Info, Some(""), 1).unwrap();
        assert_eq!(
            serde_json::to_value(&unkeyed).unwrap()["key"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn text_is_one_bounded_line_and_empty_text_is_dropped() {
        assert_eq!(
            Activity::new("OCR failed:\n  timeout\t(45 s) ", Tone::Error, None, 0)
                .unwrap()
                .text,
            "OCR failed: timeout (45 s)"
        );
        assert!(Activity::new(" \n ", Tone::Info, None, 0).is_none());
        let long = Activity::new(&"語".repeat(1000), Tone::Info, None, 0).unwrap();
        assert_eq!(long.text.chars().count(), TEXT_LIMIT);
        assert!(long.text.ends_with('…'));
    }

    #[test]
    fn tones_parse_by_name_and_unknown_ones_are_refused() {
        for (name, tone) in [
            ("info", Tone::Info),
            ("busy", Tone::Busy),
            ("ok", Tone::Ok),
            ("warn", Tone::Warn),
            ("error", Tone::Error),
        ] {
            assert_eq!(Tone::parse(name), Ok(tone));
            assert_eq!(serde_json::to_value(tone).unwrap(), name);
        }
        assert!(Tone::parse("loud").unwrap_err().starts_with("invalid:"));
    }
}
