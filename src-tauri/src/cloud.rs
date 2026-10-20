//! Access to Kimochi's own server: cloud OCR, read aloud, translation and explanations.
//!
//! Every request is authorized by a signed-in Kimochi account (`account.rs`):
//! `Authorization: Bearer kmc_…` against the metered `/api/v1/*` endpoints, within the account's
//! monthly allowances. Without an account the request is refused before anything is sent.
//!
//! The token never leaves Rust: the webviews only learn whether someone is signed in
//! (`cloudAccess` in `platform_capabilities`) and the cached user and usage. Never log it or put
//! it in a diagnostic.
use crate::account;
use crate::settings;
use crate::state::Shared;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// What a scan, read-aloud, translation or explanation says without an account.
pub const NO_ACCOUNT_OCR: &str = "Kimochi cloud OCR needs a Kimochi account. Sign in from Settings → Account, or choose another OCR engine in Settings → OCR & Overlay.";
pub const NO_ACCOUNT_TTS: &str = "Read aloud runs on Kimochi cloud. Sign in from Settings → Account to use it.";
pub const NO_ACCOUNT_TRANSLATE: &str = "Kimochi cloud translation needs a Kimochi account. Sign in from Settings → Account, or use your own DeepL key in Settings → Translation & AI.";
pub const NO_ACCOUNT_EXPLAIN: &str = "Explanations from Kimochi cloud need a Kimochi account. Sign in from Settings → Account, or choose the Codex or Claude CLI in Settings → Translation & AI.";

/// Whether Kimochi cloud is usable here (someone is signed in): all the frontend is told.
pub fn access() -> bool {
    account::has_cloud()
}

/// Which service a failure belongs to, for its wording.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Feature {
    Ocr,
    Tts,
    Translate,
    Explain,
    Sync,
    Account,
}

impl Feature {
    fn name(self) -> &'static str {
        match self {
            Feature::Ocr => "Kimochi cloud OCR",
            Feature::Tts => "Read aloud",
            Feature::Translate => "Kimochi cloud translation",
            Feature::Explain => "Kimochi cloud explanations",
            Feature::Sync => "Sync",
            Feature::Account => "Kimochi cloud",
        }
    }
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Nov 1" from an ISO 8601 date.
pub fn short_date(iso: &str) -> Option<String> {
    let month: usize = iso.get(5..7)?.parse().ok()?;
    let day: u32 = iso.get(8..10)?.parse().ok()?;
    Some(format!("{} {day}", MONTHS.get(month.checked_sub(1)?)?))
}

fn bytes_label(bytes: f64) -> String {
    const MB: f64 = 1_000_000.0;
    if bytes >= 1000.0 * MB {
        format!("{} GB", (bytes / (1000.0 * MB) * 10.0).round() / 10.0)
    } else {
        format!("{} MB", (bytes / MB).round())
    }
}

/// A failed answer from Kimochi's server, as one sentence for a person. `account` says whether
/// the request carried an account token (a 401 then means the account was signed out).
pub fn describe_failure(feature: Feature, status: u16, body: &str, account: bool) -> String {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let message = parsed.get("message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty());
    let code = parsed.get("error").and_then(Value::as_str).unwrap_or("");
    match status {
        401 if account => "Kimochi signed out of your account on this computer because the server no longer accepts it. Sign in again from Settings → Account.".into(),
        402 => quota_message(&parsed).unwrap_or_else(|| {
            message.map(str::to_string).unwrap_or_else(|| format!("You've used this month's {} allowance.", feature.name()))
        }),
        403 => message.map(str::to_string).unwrap_or_else(|| {
            "Your Kimochi account is suspended, so Kimochi cloud services are unavailable. See Manage account on the web for details.".into()
        }),
        503 if code == "not_configured" || code.is_empty() => format!(
            "{} isn't available right now: the service isn't set up on the server yet. Try again later.",
            feature.name()
        ),
        429 => format!("{} is busy right now. Try again in a moment.", feature.name()),
        _ => match message {
            Some(message) => format!("{} failed (HTTP {status}): {message}", feature.name()),
            None => format!("{} failed (HTTP {status}).", feature.name()),
        },
    }
}

/// "You've used this month's 500 Kimochi cloud scans. They reset on Nov 1."
fn quota_message(body: &Value) -> Option<String> {
    let metric = body.get("metric")?.as_str()?;
    let limit = body.get("limit")?.as_f64()?;
    if metric == "storage" {
        return Some(format!(
            "Your Kimochi sync storage is full ({}). Sync is paused until you free space under Manage account on the web; everything stays on this computer.",
            bytes_label(limit)
        ));
    }
    let units = match metric {
        "ocr" => "Kimochi cloud scans",
        "translate" => "Kimochi cloud translations",
        "tts" => "read-alouds",
        "explain" => "Kimochi cloud explanations",
        _ => return None,
    };
    let reset = body
        .get("resetsAt")
        .and_then(Value::as_str)
        .and_then(short_date)
        .map(|date| format!(" They reset on {date}."))
        .unwrap_or_default();
    Some(format!("You've used this month's {limit} {units}.{reset}"))
}

/// Read a failed blocking response to an account request and word it; a 401 signs the account
/// out locally.
pub fn failure(feature: Feature, response: reqwest::blocking::Response) -> String {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    if status == 401 {
        account::signed_out_remotely();
    }
    if account::is_plan_required(status, &body) {
        account::plan_required();
    }
    format!("native: {}", describe_failure(feature, status, &body, true))
}

fn blocking_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Kimochi/0.1")
        .timeout(timeout)
        .build()
        .map_err(|_| "native: could not initialize the Kimochi cloud HTTP client".to_string())
}

/// Speak `text` through the server (ElevenLabs behind it) and return the audio bytes.
///
/// The POST happens here rather than in the webview so the account token never reaches JS.
/// Without an account it refuses before sending anything.
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
    let token = account::token().ok_or_else(|| format!("native: {NO_ACCOUNT_TTS}"))?;
    let url = format!("{}/api/v1/tts", settings::server_base(&state.settings));
    let model = tts_model(&state.settings.get_or("audioSettings.model", String::new()));
    tauri::async_runtime::spawn_blocking(move || {
        let client = blocking_client(Duration::from_secs(30))?;
        let response = client
            .post(url)
            .bearer_auth(&token)
            .json(&json!({ "text": text, "voiceId": voice_id, "model": model }))
            .send()
            .map_err(|_| "native: text-to-speech request failed (connection/TLS/timeout)")?;
        if !response.status().is_success() {
            return Err(failure(Feature::Tts, response));
        }
        let bytes = response
            .bytes()
            .map_err(|_| "native: text-to-speech response could not be read")?;
        account::usage_changed();
        Ok(tauri::ipc::Response::new(bytes.to_vec()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Translate one line (Japanese to English) through the account's Kimochi cloud allowance.
#[tauri::command]
pub async fn cloud_translate(state: State<'_, Shared>, text: String) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("invalid: nothing to translate".into());
    }
    if text.chars().count() > 1500 {
        return Err("invalid: that line is too long for Kimochi cloud translation (1500 characters at most)".into());
    }
    let token = account::token().ok_or_else(|| format!("native: {NO_ACCOUNT_TRANSLATE}"))?;
    let url = format!("{}/api/v1/translate", settings::server_base(&state.settings));
    tauri::async_runtime::spawn_blocking(move || {
        let client = blocking_client(Duration::from_secs(20))?;
        let response = client
            .post(url)
            .bearer_auth(&token)
            .json(&json!({ "text": text, "sourceLang": "JA", "targetLang": "EN-US" }))
            .send()
            .map_err(|_| "native: the translation request failed (connection/TLS/timeout)")?;
        if !response.status().is_success() {
            return Err(failure(Feature::Translate, response));
        }
        let body: Value = response
            .json()
            .map_err(|_| "native: Kimochi cloud sent an unreadable translation")?;
        account::usage_changed();
        body.get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "native: Kimochi cloud sent no translation".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The marker the server ends a stream with when the model fails after streaming began.
const STREAM_ERROR: &str = "\n\n[error:";

/// Split a streamed answer into its text and, when it ended with the server's error line, the error.
pub fn split_stream_error(full: &str) -> (&str, Option<String>) {
    match full.rfind(STREAM_ERROR) {
        Some(at) if full.trim_end().ends_with(']') => {
            let detail = full[at + STREAM_ERROR.len()..].trim().trim_end_matches(']').trim();
            (&full[..at], Some(detail.to_string()))
        }
        _ => (full, None),
    }
}

/// Stream an explanation from `/api/v1/explain`, emitting the same `explain:chunk` / `done` /
/// `error` events as the CLI path. `current` says whether this run is still the one wanted; a
/// superseded or cancelled run stops reading (dropping the response closes the stream).
pub async fn explain(
    app: AppHandle,
    request_id: u64,
    prompt: String,
    current: impl Fn() -> bool,
) -> Result<(), String> {
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct ExplainEvent {
        request_id: u64,
        text: String,
    }
    let emit = |event: &str, text: String| {
        let _ = app.emit(event, ExplainEvent { request_id, text });
    };
    let token = account::token().ok_or_else(|| NO_ACCOUNT_EXPLAIN.to_string())?;
    if prompt.chars().count() > 12000 {
        return Err("The prompt is too long for Kimochi cloud (12000 characters at most). Shorten the prompt template in Explain settings.".into());
    }
    let base = {
        use tauri::Manager;
        let service = app.try_state::<Shared>().ok_or("Kimochi is still starting")?;
        settings::server_base(&service.settings)
    };
    let client = reqwest::Client::builder()
        .user_agent("Kimochi/0.1")
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "could not initialize the Kimochi cloud HTTP client".to_string())?;
    let mut response = client
        .post(format!("{base}/api/v1/explain"))
        .bearer_auth(&token)
        .json(&json!({ "prompt": prompt }))
        .send()
        .await
        .map_err(|_| "Kimochi cloud could not be reached (connection/TLS/timeout).".to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        if status == 401 {
            account::signed_out_remotely();
        }
        if account::is_plan_required(status, &body) {
            account::plan_required();
        }
        if current() {
            emit("explain:error", describe_failure(Feature::Explain, status, &body, true));
        }
        return Ok(());
    }
    account::usage_changed();
    let mut full = String::new();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        if !current() {
            return Ok(());
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                if current() {
                    emit("explain:error", "The explanation stopped part way (connection lost). Try Regenerate.".into());
                }
                return Ok(());
            }
        };
        pending.extend_from_slice(&chunk);
        // A multi-byte character can be split across chunks: emit only the complete prefix.
        let valid = match std::str::from_utf8(&pending) {
            Ok(text) => text.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid == 0 {
            continue;
        }
        let text = String::from_utf8_lossy(&pending[..valid]).to_string();
        pending.drain(..valid);
        full.push_str(&text);
        // Hold back what could be the start of the error line, so it never flashes in the answer.
        if current() && !full.contains(STREAM_ERROR) {
            emit("explain:chunk", text);
        }
    }
    if !pending.is_empty() {
        full.push_str(&String::from_utf8_lossy(&pending));
    }
    if !current() {
        return Ok(());
    }
    let (answer, error) = split_stream_error(&full);
    match error {
        Some(detail) => emit("explain:error", format!("Kimochi cloud could not finish the explanation: {detail}")),
        None if answer.trim().is_empty() => emit("explain:error", "Kimochi cloud sent an empty explanation. Try Regenerate.".into()),
        None => emit("explain:done", answer.to_string()),
    }
    Ok(())
}

/// The ElevenLabs speech models read aloud may ask for; the first is the default.
pub const TTS_MODELS: [&str; 3] = ["eleven_v3", "eleven_v4", "eleven_v4_turbo"];

/// The chosen speech model, or the default for an unset or unknown value.
fn tts_model(chosen: &str) -> &'static str {
    TTS_MODELS.iter().copied().find(|m| *m == chosen).unwrap_or(TTS_MODELS[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_speech_model_falls_back_to_the_default() {
        assert_eq!(tts_model("eleven_v4"), "eleven_v4");
        assert_eq!(tts_model("eleven_v4_turbo"), "eleven_v4_turbo");
        assert_eq!(tts_model(""), "eleven_v3");
        assert_eq!(tts_model("gpt-voice"), "eleven_v3");
    }

    #[test]
    fn quota_errors_read_as_a_sentence() {
        let body = r#"{"error":"quota_exceeded","message":"x","metric":"ocr","limit":500,"used":500,"resetsAt":"2026-11-01T00:00:00Z"}"#;
        assert_eq!(
            describe_failure(Feature::Ocr, 402, body, true),
            "You've used this month's 500 Kimochi cloud scans. They reset on Nov 1."
        );
        let body = r#"{"error":"quota_exceeded","metric":"explain","limit":30,"used":30,"resetsAt":"2027-01-01T00:00:00Z"}"#;
        assert_eq!(
            describe_failure(Feature::Explain, 402, body, true),
            "You've used this month's 30 Kimochi cloud explanations. They reset on Jan 1."
        );
        let body = r#"{"error":"quota_exceeded","metric":"storage","limit":250000000,"used":1}"#;
        assert!(describe_failure(Feature::Sync, 402, body, true).starts_with("Your Kimochi sync storage is full (250 MB)"));
        // A 402 without the fields falls back to the server's sentence.
        assert_eq!(describe_failure(Feature::Tts, 402, r#"{"message":"Out of read-alouds."}"#, true), "Out of read-alouds.");
    }

    #[test]
    fn other_failures_name_the_service() {
        let suspended = r#"{"error":"forbidden","message":"This account is suspended."}"#;
        assert_eq!(describe_failure(Feature::Tts, 403, suspended, true), "This account is suspended.");
        assert!(describe_failure(Feature::Tts, 403, "", true).contains("suspended"));
        let unset = r#"{"error":"not_configured","message":"No key"}"#;
        assert!(describe_failure(Feature::Translate, 503, unset, true).starts_with("Kimochi cloud translation isn't available right now"));
        assert!(describe_failure(Feature::Ocr, 401, "", true).contains("Sign in again"));
        // Without a token (linking a device), a 401 is just a failure.
        assert_eq!(describe_failure(Feature::Account, 401, "", false), "Kimochi cloud failed (HTTP 401).");
        assert_eq!(describe_failure(Feature::Ocr, 500, r#"{"message":"Boom"}"#, true), "Kimochi cloud OCR failed (HTTP 500): Boom");
        assert_eq!(describe_failure(Feature::Ocr, 502, "<html>", true), "Kimochi cloud OCR failed (HTTP 502).");
    }

    #[test]
    fn dates_are_short() {
        assert_eq!(short_date("2026-11-01T00:00:00Z").as_deref(), Some("Nov 1"));
        assert_eq!(short_date("2026-12-25").as_deref(), Some("Dec 25"));
        assert_eq!(short_date("nonsense"), None);
        assert_eq!(short_date("2026-13-01"), None);
    }

    #[test]
    fn an_error_line_ends_a_stream() {
        assert_eq!(split_stream_error("All good."), ("All good.", None));
        let (text, error) = split_stream_error("Partial answer\n\n[error: upstream overloaded]");
        assert_eq!(text, "Partial answer");
        assert_eq!(error.as_deref(), Some("upstream overloaded"));
        let (text, error) = split_stream_error("Uses [error: in prose] mid-text\n\nmore");
        assert_eq!(text, "Uses [error: in prose] mid-text\n\nmore");
        assert_eq!(error, None);
    }
}
