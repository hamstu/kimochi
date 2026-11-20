//! Explain with OpenAI's API: the prompt sent straight to Chat Completions with the reader's own
//! key, the answer streamed back as it is written. No CLI and no agent: nothing starts, and the
//! first words come as soon as the model sends them.
//!
//! The key is `superTexthooker.openaiApiKey`, entered in the Explain settings as the DeepL key is,
//! and read here from the settings: an explain request never carries it. Its name makes it
//! private (`profile::is_private`), so it never syncs. The events are
//! the CLI providers' (`explain:chunk`, `explain:done`, `explain:error`, by requestId), with the
//! same cancel and supersede rules (`current`).
use crate::state::Shared;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const URL: &str = "https://api.openai.com/v1/chat/completions";
/// The model when none is chosen in the Explain settings. At effort `none` (the Explain settings'
/// default for OpenAI) it began writing in about 1.1 s on the Explain prompt; at its own default
/// it thought for 5–6 s first.
pub const DEFAULT_MODEL: &str = "gpt-6-luna";
/// Reasoning efforts Chat Completions takes (`reasoning_effort`); only reasoning models take one,
/// and which varies by model (gpt-6-astra: `low` to `max`). `none` is no thinking at all, the fastest.
pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/// Service tiers the Explain settings offer (`service_tier`): `default`, OpenAI's normal one;
/// `fast` (formerly `priority`, which it still takes), the settings' default: twice the price, and
/// on the Explain prompt about half the wait (gpt-6-luna at effort none: 0.5–0.7 s to the first
/// words, 0.9–1.7 s at default); and `ultrafast`, six times the price, which only some models take
/// (`ULTRAFAST_MODELS` in ui/explain-settings.ts).
pub const TIERS: &[&str] = &["default", "fast", "ultrafast"];
pub const NO_KEY: &str = "Explain with the OpenAI API needs an API key: add yours in Settings → Translation & AI → Explain with AI → Configure….";

/// One client for every explanation, so its connection to OpenAI is kept and reused.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .user_agent("Kimochi")
        .connect_timeout(Duration::from_secs(15))
        // Between two reads of the answer. A model that thinks first sends nothing until it has,
        // which at a high effort takes minutes: as long as the CLI providers are waited for.
        .read_timeout(Duration::from_secs(300))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "could not initialize the HTTP client for OpenAI".to_string())?;
    Ok(CLIENT.get_or_init(|| client))
}

/// The reader's OpenAI key from the settings, if any.
fn api_key(app: &AppHandle) -> Option<String> {
    let service = app.try_state::<Shared>()?;
    let reader = service.settings.get("superTexthooker").ok().flatten()?;
    reader.get("openaiApiKey").and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty()).map(String::from)
}

/// The request body: the prompt as the one user message, streamed, at the effort and service tier
/// chosen (none: the model's and the account's own).
fn body(model: &str, effort: Option<&str>, tier: Option<&str>, prompt: &str) -> Value {
    let mut body = json!({
        "model": model,
        "stream": true,
        "messages": [{ "role": "user", "content": prompt }],
    });
    if let Some(effort) = effort {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(tier) = tier {
        body["service_tier"] = json!(tier);
    }
    body
}

/// What a server-sent-events stream holds so far: the text deltas of the complete `data:` lines,
/// whether `[DONE]` came, an error message if one did, and what is left over (an incomplete line).
#[derive(Debug, Default, PartialEq)]
struct Events {
    text: Vec<String>,
    done: bool,
    error: Option<String>,
}

fn read_events(buffer: &mut String) -> Events {
    let mut events = Events::default();
    while let Some(newline) = buffer.find('\n') {
        let line: String = buffer.drain(..=newline).collect();
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            events.done = true;
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
            events.error = Some(message.to_string());
        }
        if let Some(text) = value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            if !text.is_empty() {
                events.text.push(text.to_string());
            }
        }
    }
    events
}

/// What OpenAI's refusal means for the reader, from its status and error body.
fn describe(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(String::from))
        .unwrap_or_default();
    match status {
        401 => "OpenAI didn't accept the API key. Check it in the Explain settings.".into(),
        404 => {
            format!("OpenAI doesn't offer that model to this key. Choose another in the Explain settings. {message}")
                .trim()
                .to_string()
        }
        429 => format!("OpenAI's limit for this key was reached. {message}").trim().to_string(),
        400 if message.contains("service_tier") => {
            format!("This model doesn't take that service tier: change it in the Explain settings. {message}")
                .trim()
                .to_string()
        }
        400 if message.contains("reasoning_effort") => {
            format!("This model doesn't take that effort: change Effort in the Explain settings. {message}")
                .trim()
                .to_string()
        }
        _ if message.is_empty() => format!("OpenAI couldn't explain this line ({status})."),
        _ => format!("OpenAI couldn't explain this line: {message}"),
    }
}

/// Explain `prompt` with `model` (the default when none) at `effort`, streaming the answer as
/// `explain:chunk` events and finishing with `explain:done` or `explain:error`, while `current`.
pub async fn explain(
    app: AppHandle,
    request_id: u64,
    model: Option<String>,
    effort: Option<String>,
    tier: Option<String>,
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
    let key = api_key(&app).ok_or_else(|| NO_KEY.to_string())?;
    let model = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let mut response = client()?
        .post(URL)
        .bearer_auth(&key)
        .json(&body(&model, effort.as_deref(), tier.as_deref(), &prompt))
        .send()
        .await
        .map_err(|_| "OpenAI could not be reached (connection/TLS/timeout).".to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        if current() {
            emit("explain:error", describe(status, &body));
        }
        return Ok(());
    }
    let mut full = String::new();
    let mut buffer = String::new();
    let mut pending: Vec<u8> = Vec::new();
    // Whether `[DONE]` came: a stream that just ends was cut off, and what it had is not the answer.
    let mut finished = false;
    loop {
        if !current() {
            return Ok(());
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                if current() {
                    emit("explain:error", "The explanation stopped part way (connection lost). Try again.".into());
                }
                return Ok(());
            }
        };
        // A multi-byte character can be split across chunks: read only the complete prefix.
        pending.extend_from_slice(&chunk);
        let valid = match std::str::from_utf8(&pending) {
            Ok(text) => text.len(),
            Err(e) => e.valid_up_to(),
        };
        buffer.push_str(&String::from_utf8_lossy(&pending[..valid]));
        pending.drain(..valid);
        let events = read_events(&mut buffer);
        if let Some(error) = events.error {
            if current() {
                emit("explain:error", format!("OpenAI stopped the explanation: {error}"));
            }
            return Ok(());
        }
        for text in events.text {
            full.push_str(&text);
            if current() {
                emit("explain:chunk", text);
            }
        }
        if events.done {
            finished = true;
            break;
        }
    }
    if !current() {
        return Ok(());
    }
    if !finished {
        emit("explain:error", "The explanation stopped part way (OpenAI closed the connection). Try again.".into());
        return Ok(());
    }
    if full.trim().is_empty() {
        emit("explain:error", "OpenAI sent an empty explanation. Try again.".into());
    } else {
        emit("explain:done", full);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stream_is_read_line_by_line_and_a_split_line_waits() {
        let mut buffer = String::from(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"**ませんか**\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\" is\"}}]}\n\
             data: {\"choices\":[{\"del",
        );
        let events = read_events(&mut buffer);
        assert_eq!(events.text, ["**ませんか**", " is"]);
        assert!(!events.done);
        assert_eq!(buffer, "data: {\"choices\":[{\"del");
        buffer.push_str("ta\":{\"content\":\" polite\"}}]}\n\ndata: [DONE]\n\n");
        let events = read_events(&mut buffer);
        assert_eq!(events.text, [" polite"]);
        assert!(events.done);
        assert!(buffer.is_empty());
    }

    #[test]
    fn an_error_in_the_stream_is_reported() {
        let mut buffer = String::from("data: {\"error\":{\"message\":\"overloaded\"}}\n\n");
        assert_eq!(read_events(&mut buffer).error.as_deref(), Some("overloaded"));
    }

    #[test]
    fn the_request_has_the_effort_and_tier_only_when_chosen() {
        let with = body("gpt-6-luna", Some("none"), Some("fast"), "explain");
        assert_eq!(with["reasoning_effort"], "none");
        assert_eq!(with["service_tier"], "fast");
        assert_eq!(with["stream"], true);
        assert_eq!(with["messages"][0]["content"], "explain");
        let without = body("gpt-6-sol", None, None, "explain");
        assert!(without.get("reasoning_effort").is_none() && without.get("service_tier").is_none());
    }

    #[test]
    fn refusals_say_what_to_change() {
        assert!(describe(401, "").contains("API key"));
        assert!(describe(404, r#"{"error":{"message":"The model `x` does not exist"}}"#).contains("does not exist"));
        assert_eq!(describe(500, ""), "OpenAI couldn't explain this line (500).");
        let refused =
            r#"{"error":{"message":"Unsupported value: 'reasoning_effort' does not support 'none' with this model."}}"#;
        assert!(describe(400, refused).starts_with("This model doesn't take that effort"));
    }

    #[test]
    fn the_key_is_private_by_its_name() {
        assert!(crate::profile::is_private("openaiApiKey"));
    }
}
