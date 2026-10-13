//! Access to Kimochi's own server (cloud OCR and text-to-speech), which runs on the owner's
//! paid accounts and so requires an access key.
//!
//! The key comes from `KIMOCHI_CLOUD_KEY`, else from `~/.config/kimochi/cloud-key` (the same
//! path on every OS, under the user's home directory), trimmed. It is read when needed, so
//! adding or removing the file takes effect without a restart. It never leaves Rust: requests
//! carry it as the `X-Kimochi-Key` header, and the webviews only ever learn whether one is
//! present (`cloudAccess` in `platform_capabilities`). Never log it or put it in a diagnostic.
use crate::settings;
use crate::state::Shared;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

const ENV_VAR: &str = "KIMOCHI_CLOUD_KEY";
const HEADER: &str = "X-Kimochi-Key";

/// What a scan or read-aloud says when there is no key: the feature is not offered publicly.
pub const NO_KEY_OCR: &str = "Kimochi cloud OCR needs an access key, and this copy of Kimochi does not have one. Choose another OCR engine in Settings → OCR & Overlay.";
pub const NO_KEY_TTS: &str = "Read aloud needs a Kimochi cloud access key, and this copy of Kimochi does not have one.";
/// What a `401` from the server means.
pub const REJECTED: &str = "Kimochi cloud did not accept the access key (HTTP 401): it is missing or not valid.";

fn key_file() -> Option<PathBuf> {
    let home = if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME")
    }?;
    Some(PathBuf::from(home).join(".config").join("kimochi").join("cloud-key"))
}

fn clean(raw: &str) -> Option<String> {
    let key = raw.trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// The access key, if this machine has one.
pub fn key() -> Option<String> {
    if let Some(key) = std::env::var(ENV_VAR).ok().as_deref().and_then(clean) {
        return Some(key);
    }
    let raw = std::fs::read_to_string(key_file()?).ok()?;
    clean(&raw)
}

/// Whether Kimochi cloud is usable here: the only thing the frontend is told about the key.
pub fn access() -> bool {
    key().is_some()
}

/// Attach the key to a request bound for Kimochi's server.
pub fn authorize(
    request: reqwest::blocking::RequestBuilder,
    key: &str,
) -> reqwest::blocking::RequestBuilder {
    request.header(HEADER, key)
}

/// Speak `text` through the server's `/tts` (ElevenLabs behind it) and return the audio bytes.
///
/// The POST happens here rather than in the webview so the access key never reaches JS.
/// Without a key it refuses before sending anything.
#[tauri::command]
pub async fn tts_speak(
    state: State<'_, Shared>,
    text: String,
    voice_id: String,
) -> Result<tauri::ipc::Response, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("invalid: nothing to read aloud".into());
    }
    let key = key().ok_or_else(|| format!("native: {NO_KEY_TTS}"))?;
    let url = format!("{}/tts", settings::server_base(&state.settings));
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Kimochi/0.1")
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "native: could not initialize the text-to-speech HTTP client")?;
        let response = authorize(client.post(url), &key)
            .json(&json!({ "text": text, "voiceId": voice_id }))
            .send()
            .map_err(|_| "native: text-to-speech request failed (connection/TLS/timeout)")?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(format!("native: {REJECTED}"));
        }
        if !status.is_success() {
            return Err(format!("native: text to speech failed (HTTP {})", status.as_u16()));
        }
        let bytes = response
            .bytes()
            .map_err(|_| "native: text-to-speech response could not be read")?;
        Ok(tauri::ipc::Response::new(bytes.to_vec()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_key_is_no_key() {
        assert_eq!(clean(""), None);
        assert_eq!(clean("  \n\t"), None);
        assert_eq!(clean("  abc123\n").as_deref(), Some("abc123"));
    }

    #[test]
    fn the_key_file_lives_under_the_home_directory() {
        let file = key_file().expect("a home directory");
        assert!(file.ends_with(".config/kimochi/cloud-key"));
    }
}
