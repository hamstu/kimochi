// translate.rs — thin DeepL proxy. The webview never talks to DeepL directly;
// the key lives in settings.json (AppLocalData) and is passed per call, so no
// key material is ever compiled into the bundle.

use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

#[derive(Deserialize)]
struct DeepLResponse {
    translations: Vec<DeepLTranslation>,
}

#[derive(Deserialize)]
struct DeepLTranslation {
    text: String,
}

/// Free-tier keys (":fx" suffix) must hit the api-free host; paid keys use the
/// main host. The wrong host rejects the key with a 403.
fn host_for(key: &str) -> &'static str {
    if key.ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    }
}

#[tauri::command]
pub async fn deepl_translate(text: String, api_key: String) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("DeepL API key is not set".into());
    }
    if text.trim().is_empty() {
        return Err("nothing to translate".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let url = format!("{}/v2/translate", host_for(key));
    let resp = client
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .json(&json!({
            "text": [text],
            "source_lang": "JA",
            "target_lang": "EN-US",
        }))
        .send()
        .await
        .map_err(|e| format!("deepl request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("deepl read failed: {e}"))?;
    if !status.is_success() {
        let hint = match status.as_u16() {
            403 => " (invalid key?)",
            456 => " (free-tier character quota exhausted)",
            _ => "",
        };
        return Err(format!("DeepL HTTP {}{hint}", status.as_u16()));
    }

    let parsed: DeepLResponse =
        serde_json::from_str(&body).map_err(|e| format!("deepl JSON parse failed: {e}"))?;
    parsed
        .translations
        .into_iter()
        .next()
        .map(|t| t.text)
        .ok_or_else(|| "deepl returned no translations".into())
}
