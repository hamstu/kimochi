//! Help → Report a bug / Request a feature: sends the reporter's name, email and description, and
//! (bugs only) the debug bundle when they leave "Attach debug data" on, to the Kimochi server
//! (`POST /api/v1/bug-reports`, kimochi-server API.md → Bug reports), which emails it to the
//! maintainer with Reply-To the reporter. No account needed; a signed-in account's token goes
//! along so the report names the account.

use crate::state::Shared;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// The server refuses a bundle over 5 MB; ours is a few hundred KB (each log's last 512 KB).
const MAX_BUNDLE: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReport {
    /// `bug` (the default) or `feature`; the server refuses anything else.
    kind: Option<String>,
    name: String,
    email: String,
    description: String,
    /// The debug page's Markdown (`ui/debug-report.ts`); `None` sends no debug data.
    debug_markdown: Option<String>,
}

/// `bug_report_send(report) -> {id}`: the server's reference for the report. A refusal (a field,
/// the rate limit, the server unreachable) is an error whose text is a sentence for the reporter.
#[tauri::command]
pub async fn bug_report_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
    report: BugReport,
) -> Result<Value, String> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || send(&app, &service, report))
        .await
        .map_err(|e| e.to_string())?
}

fn platform() -> String {
    let mut platform = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    if crate::platform::gaming_mode() {
        platform.push_str(" (Steam Deck Gaming Mode)");
    }
    platform
}

fn send(app: &tauri::AppHandle, service: &Shared, report: BugReport) -> Result<Value, String> {
    use reqwest::blocking::multipart::{Form, Part};
    let base = crate::account::base()?;
    let kind = report.kind.unwrap_or_else(|| "bug".into());
    let mut form = Form::new()
        .text("kind", kind.clone())
        .text("name", report.name.trim().to_string())
        .text("email", report.email.trim().to_string())
        .text("description", report.description.trim().to_string())
        .text("appVersion", app.package_info().version.to_string())
        .text("platform", platform());
    if let Some(markdown) = report.debug_markdown.filter(|_| kind == "bug") {
        let zip = crate::debug_report::bundle(app, service, &markdown)?;
        if zip.len() > MAX_BUNDLE {
            return Err("native: The debug data is too large to send. Turn off Attach debug data and send the report without it.".into());
        }
        let part = Part::bytes(zip)
            .file_name("kimochi-debug.zip")
            .mime_str("application/zip")
            .map_err(|e| e.to_string())?;
        form = form.part("debug", part);
    }
    let mut request = crate::account::client(Duration::from_secs(60))?
        .post(format!("{base}/api/v1/bug-reports"))
        .multipart(form);
    if let Some(token) = crate::account::token() {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|_| {
        "native: Kimochi's server couldn't be reached. Check your internet connection and try again.".to_string()
    })?;
    let status = response.status();
    let body: Value = response.json().unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(json!({ "id": body.get("id").cloned().unwrap_or(Value::Null) }));
    }
    Err(format!("native: {}", refusal(status.as_u16(), &body)))
}

/// The server's own sentence when it sent one, else one for the status.
fn refusal(status: u16, body: &Value) -> String {
    if let Some(message) = body.get("message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) {
        return message.to_string();
    }
    match status {
        429 => "You've sent several reports in a short time. Please wait a while and try again.".into(),
        400 | 413 => "The report couldn't be accepted. Check the fields and try again.".into(),
        _ => format!("The report couldn't be sent (the server answered {status}). Please try again later, or tell us on Discord."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_prefers_the_servers_sentence() {
        let body = json!({ "error": "invalid", "message": "Please describe the problem in at least 10 characters." });
        assert_eq!(refusal(400, &body), "Please describe the problem in at least 10 characters.");
    }

    #[test]
    fn refusal_falls_back_on_the_status() {
        assert!(refusal(429, &Value::Null).contains("wait a while"));
        assert!(refusal(502, &json!({ "message": "  " })).contains("502"));
    }
}
