//! Settings → About → Debug info: everything a remote bug report needs, gathered in one place
//! (COMMANDS.md → Debug info).
//!
//! `debug_report` answers what this copy of Kimochi is and what it believes right now: version
//! and build, OS, CPU, GPU and memory, the displays with their scaling, the capture backend, the
//! OCR and dictionary engines and their downloads, the session, Kimochi's own windows and the
//! last diagnostic events. The About page turns it into Markdown for "Copy debug info"
//! (`ui/debug-report.ts`); `debug_bundle_save` writes that Markdown, the JSON and the tails of
//! the on-disk logs into a zip the reader chooses where to save.
//!
//! Nothing secret leaves: settings are read field by field from a short list rather than
//! dumped, and every value and log line goes through `redact` (tokens, keys, cookies, JWTs, URL
//! query strings, long opaque strings, e-mail addresses, and the user's name in paths).
//!
//! Verbose logging (`debug_verbose_set`) is a switch for this run only: while on, `trace` adds
//! window focus and visibility changes, every scan's outcome and pointer diagnostics to
//! `evidence.jsonl`. Each change is announced as `verbose-logging` so open windows start or
//! stop their own diagnostics (`ui/pointer-diagnostics.js`).
use crate::state::Shared;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock,
    },
};
use tauri::{Emitter, Manager};

/// How much of the end of each log goes in a bundle.
const TAIL_BYTES: u64 = 512 * 1024;
/// The diagnostic events the report itself carries (the bundle has the whole tail).
const RECENT_EVENTS: usize = 40;
/// The logs a bundle includes, when they exist: the diagnostics record (and its rotated copy),
/// Auto OCR's scheduling trace and sync's log.
const LOGS: &[&str] = &[
    "evidence.jsonl",
    "evidence.1.jsonl",
    "auto-ocr-trace.jsonl",
    "auto-ocr-trace.1.jsonl",
    crate::sync_log::FILE,
];
/// The settings a report names. Never the whole file: it holds account and service tokens.
const SETTINGS: &[&str] = &[
    "ocrMode",
    "yomitanSettings.popupType",
    "autoOCRSettings",
    "autoScanSettings.enabled",
    "liveOverlayEnabled",
    "hasCompletedOnboarding",
    "gamepadSettings.enabled",
    "serverSettings.mode",
    "interfaceScale",
    "appearance",
    "sentenceAudio.enabled",
    "cardScreenshot.enabled",
];

static VERBOSE: AtomicBool = AtomicBool::new(false);

/// Whether verbose logging is on (for this run).
pub fn verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// Records `value` in the diagnostics log while verbose logging is on.
pub fn trace(app: &tauri::AppHandle, value: Value) {
    if !verbose() {
        return;
    }
    if let Some(service) = app.try_state::<Shared>() {
        crate::record(app, &service, value);
    }
}

/// `debug_verbose_set(enabled?) -> bool`: turns verbose logging on or off until the app quits;
/// without `enabled`, only answers whether it is on.
#[tauri::command]
pub fn debug_verbose_set(app: tauri::AppHandle, state: tauri::State<Shared>, enabled: Option<bool>) -> bool {
    let Some(enabled) = enabled else { return verbose() };
    if VERBOSE.swap(enabled, Ordering::Relaxed) != enabled {
        crate::record(&app, &state, json!({ "check": "verbose-logging", "enabled": enabled }));
        let _ = app.emit("verbose-logging", enabled);
    }
    enabled
}

/// `debug_report() -> DebugReport` (COMMANDS.md → Debug info), redacted.
#[tauri::command]
pub async fn debug_report(app: tauri::AppHandle, state: tauri::State<'_, Shared>) -> Result<Value, String> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || collect(&app, &service))
        .await
        .map_err(|e| e.to_string())
}

/// `debug_bundle_save(markdown) -> {saved, path?}`: asks where to save, then writes
/// `kimochi-debug-<time>.zip` with `report.md` (the page's Markdown, redacted again here),
/// `report.json` and the tail of each log in `LOGS`.
#[tauri::command]
pub async fn debug_bundle_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Shared>,
    markdown: String,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let service = state.inner().clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save debug bundle")
        .set_file_name(format!("kimochi-debug-{}.zip", stamp()))
        .add_filter("Zip archive", &["zip"])
        .set_parent(&window)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|e| format!("native: {e}"))? else {
        return Ok(json!({ "saved": false }));
    };
    let path = path.into_path().map_err(|e| format!("native: {e}"))?;
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let report = collect(&app, &service);
        let mut files = vec![
            ("report.md".to_string(), redact_text(&markdown).into_bytes()),
            (
                "report.json".to_string(),
                serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
            ),
        ];
        let directory = crate::data_dir(&app)?;
        for name in LOGS {
            if let Some(tail) = log_tail(&directory.join(name), TAIL_BYTES) {
                files.push((format!("logs/{name}"), tail.into_bytes()));
            }
        }
        let zip = zip(&files)?;
        std::fs::write(&target, zip).map_err(|e| format!("native: could not write {}: {e}", target.display()))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(json!({ "saved": true, "path": path.to_string_lossy() }))
}

// ---------------------------------------------------------------- the report

fn collect(app: &tauri::AppHandle, service: &Shared) -> Value {
    let capabilities = crate::capabilities_value(app, service);
    let settings = {
        let mut picked = Map::new();
        for key in SETTINGS {
            if let Ok(Some(value)) = service.settings.get(key) {
                picked.insert((*key).to_string(), value);
            }
        }
        Value::Object(picked)
    };
    let dictionary = json!({
        "selected": crate::extensions::dictionary_engine(&service.settings),
        "downloads": crate::extension_store::IDS
            .iter()
            .filter_map(|id| crate::extension_store::status(app, id))
            .collect::<Vec<_>>(),
    });
    let models = [crate::model_store::Engine::Meiki, crate::model_store::Engine::Manga]
        .into_iter()
        .map(|engine| crate::model_store::status(app, engine))
        .collect::<Vec<_>>();
    let (session, recent) = {
        let view = service.view.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let source = service
            .selection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let session = json!({
            // The kind of source only (`window:…`, `screen:…`): a window's name can be anything.
            "sourceKind": source.as_deref().map(|id| id.split(':').next().unwrap_or("")),
            "sourceFocus": view.source_focus,
            "autoOcr": view.auto_ocr,
            "scanning": view.scanning,
            "status": view.status,
            "overlayVisible": view.overlay_visible,
            "textOverlayVisible": view.text_overlay_visible,
            "overlayThrottled": view.overlay_throttled,
            "frontmostApp": view.frontmost_app,
        });
        let skip = view.logs.len().saturating_sub(RECENT_EVENTS);
        (session, view.logs.iter().skip(skip).cloned().collect::<Vec<_>>())
    };
    let mut report = json!({
        "generatedAt": now_rfc3339(),
        "app": {
            "version": app.package_info().version.to_string(),
            // Set by CI; a local build has none.
            "commit": option_env!("GITHUB_SHA").map(|sha| &sha[..sha.len().min(10)]),
            "build": if cfg!(debug_assertions) { "debug" } else { "release" },
            "tauri": tauri::VERSION,
            "webview": tauri::webview_version().ok(),
        },
        "os": {
            "name": capabilities["os"],
            "version": capabilities["osVersion"],
            "arch": capabilities["arch"],
            "session": capabilities["session"],
        },
        "hardware": hardware(),
        "displays": crate::platform::desktop_display_infos(),
        "capture": capture_summary(&capabilities["capture"]),
        "ocr": {
            "selected": settings.get("ocrMode").cloned().unwrap_or(Value::Null),
            "engines": capabilities["ocrEngines"],
            "models": models,
            "cloudAccess": capabilities["cloudAccess"],
        },
        "observer": capabilities["observer"],
        "dictionary": dictionary,
        "session": session,
        "settings": settings,
        "windows": windows(app),
        "input": input_devices(),
        "verboseLogging": verbose(),
        "recentEvents": recent,
    });
    redact(&mut report);
    report
}

/// The pointing devices besides the mouse (Windows: pens, touchscreens and tablets in
/// Windows Ink mode), which reach the webviews as pointers of their own.
#[cfg(target_os = "windows")]
fn input_devices() -> Value {
    crate::platform::pointer_devices()
}
#[cfg(not(target_os = "windows"))]
fn input_devices() -> Value {
    Value::Null
}

/// Kimochi's webview windows: which exist, which are shown, where. Each one is a WebView2 (or
/// WKWebView, WebKitGTK) renderer, which is what a Task Manager count is made of.
fn windows(app: &tauri::AppHandle) -> Vec<Value> {
    let mut windows: Vec<Value> = app
        .webview_windows()
        .into_iter()
        .map(|(label, window)| {
            let position = window.outer_position().ok();
            let size = window.outer_size().ok();
            json!({
                "label": label,
                "visible": window.is_visible().ok(),
                "minimized": window.is_minimized().ok(),
                "focused": window.is_focused().ok(),
                "scale": window.scale_factor().ok(),
                "bounds": position.zip(size).map(|(p, s)| json!({
                    "x": p.x, "y": p.y, "width": s.width, "height": s.height,
                })),
            })
        })
        .collect();
    windows.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    windows
}

fn hardware() -> Value {
    let probe = hardware::probe();
    json!({
        "cpu": probe.cpu,
        "cores": std::thread::available_parallelism().ok().map(|n| n.get()),
        "memoryBytes": probe.memory,
        "gpus": probe.gpus,
    })
}

#[derive(Default)]
struct Hardware {
    cpu: Option<String>,
    memory: Option<u64>,
    gpus: Vec<String>,
}

#[cfg(target_os = "macos")]
mod hardware {
    use super::Hardware;
    use std::process::Command;

    fn sysctl(name: &str) -> Option<String> {
        let out = Command::new("/usr/sbin/sysctl").args(["-n", name]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    }

    pub fn probe() -> Hardware {
        let gpus = Command::new("/usr/sbin/system_profiler")
            .args(["SPDisplaysDataType", "-json", "-detailLevel", "mini"])
            .output()
            .ok()
            .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok())
            .and_then(|value| {
                value["SPDisplaysDataType"].as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item["sppci_model"].as_str().map(str::to_string))
                        .collect()
                })
            })
            .unwrap_or_default();
        Hardware {
            cpu: sysctl("machdep.cpu.brand_string"),
            memory: sysctl("hw.memsize").and_then(|v| v.parse().ok()),
            gpus,
        }
    }
}

#[cfg(target_os = "windows")]
mod hardware {
    use super::Hardware;
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    /// The display adapters' device class.
    const DISPLAY_CLASS: &str =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    fn registry_string(key: &str, value: &str) -> Option<String> {
        let (key, value) = (HSTRING::from(key), HSTRING::from(value));
        let mut size = 0u32;
        unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, &key, &value, RRF_RT_REG_SZ, None, None, Some(&mut size)) }
            .ok()
            .ok()?;
        let mut data = vec![0u16; (size as usize).div_ceil(2)];
        unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                &key,
                &value,
                RRF_RT_REG_SZ,
                None,
                Some(data.as_mut_ptr().cast()),
                Some(&mut size),
            )
        }
        .ok()
        .ok()?;
        let text = String::from_utf16_lossy(&data).trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    pub fn probe() -> Hardware {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        let memory = unsafe { GlobalMemoryStatusEx(&mut status) }.ok().map(|_| status.ullTotalPhys);
        // Adapters are numbered subkeys (0000, 0001, …); a gap ends the list in practice.
        let gpus = (0..16)
            .map(|index| format!(r"{DISPLAY_CLASS}\{index:04}"))
            .filter_map(|key| {
                let name = registry_string(&key, "DriverDesc")?;
                Some(match registry_string(&key, "DriverVersion") {
                    Some(version) => format!("{name} (driver {version})"),
                    None => name,
                })
            })
            .collect();
        Hardware {
            cpu: registry_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString"),
            memory,
            gpus,
        }
    }
}

#[cfg(target_os = "linux")]
mod hardware {
    use super::Hardware;

    fn field(text: &str, name: &str) -> Option<String> {
        text.lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_once(':'))
            .map(|(_, value)| value.trim().to_string())
    }

    pub fn probe() -> Hardware {
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let memory = field(&meminfo, "MemTotal")
            .and_then(|value| value.trim_end_matches("kB").trim().parse::<u64>().ok())
            .map(|kb| kb * 1024);
        let gpus = std::process::Command::new("lspci")
            .output()
            .ok()
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .filter(|line| {
                        line.contains("VGA compatible controller")
                            || line.contains("3D controller")
                            || line.contains("Display controller")
                    })
                    .filter_map(|line| line.splitn(3, ':').nth(2).map(|name| name.trim().to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Hardware {
            cpu: field(&cpuinfo, "model name").or_else(|| field(&cpuinfo, "Model")),
            memory,
            gpus,
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod hardware {
    pub fn probe() -> super::Hardware {
        super::Hardware::default()
    }
}

// ---------------------------------------------------------------- logs

/// The last `limit` bytes of a log, from its first whole line, each line redacted. JSON lines
/// are redacted as values, so a key that names a secret hides it whatever it holds.
fn log_tail(path: &Path, limit: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(limit);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let whole = if start > 0 { text.split_once('\n').map_or("", |(_, rest)| rest) } else { &text };
    let mut out = String::with_capacity(whole.len());
    for line in whole.lines() {
        match serde_json::from_str::<Value>(line) {
            Ok(mut value) => {
                redact(&mut value);
                out.push_str(&value.to_string());
            }
            Err(_) => out.push_str(&redact_text(line)),
        }
        out.push('\n');
    }
    Some(out)
}

// ---------------------------------------------------------------- redaction

/// A key whose value is a secret whatever it looks like.
fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
    const WORDS: &[&str] = &[
        "token", "secret", "password", "passwd", "apikey", "authorization", "cookie", "credential",
        "privatekey", "sessionid", "jwt", "bearer", "signature",
    ];
    WORDS.iter().any(|word| key.contains(word)) || key == "key" || key == "auth" || key.ends_with("key")
}

/// Redacts a report or a log record in place: secret keys' values, and every string.
fn capture_summary(capture: &Value) -> Value {
    json!({
        "permission": capture["authorization"],
        "windowCapture": capture["windowCapture"],
        "excludesOwnWindows": capture["excludesOwnWindows"],
    })
}

pub fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if secret_key(key) && !item.is_null() && !item.is_boolean() {
                    *item = Value::String("[redacted]".into());
                } else {
                    redact(item);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        Value::String(text) => *text = redact_text(text),
        _ => {}
    }
}

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]"),
        (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "[redacted-jwt]"),
        // A URL's query often carries a token or a signed key: keep where it went, not what.
        (r#"((?:https?|kimochi|wss?)://[^\s?#"'<>]+)\?[^\s#"'<>]*"#, "$1?[redacted]"),
        (
            r#"(?i)\b(access_token|refresh_token|id_token|token|api[_-]?key|apikey|secret|password|key)=[^&\s"']+"#,
            "$1=[redacted]",
        ),
        (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", "[email]"),
        // The user's name in a path.
        (r"(?i)([A-Z]:[\\/]+Users[\\/]+|/Users/|/home/)[^\\/\s:]+", "$1<user>"),
        // Long opaque strings: keys, tokens, base64 blobs (32+ characters with a digit in them).
        // `/` is left out so a file path is not taken for one.
        (r"\b[A-Za-z0-9_+=-]*[0-9][A-Za-z0-9_+=-]*", ""),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("redaction pattern"), replacement))
    .collect()
});

/// Redacts secrets from free text (a log line, an error message, the report's Markdown).
pub fn redact_text(text: &str) -> String {
    let mut out = text.to_string();
    let (opaque, rest) = PATTERNS.split_last().expect("patterns");
    for (pattern, replacement) in rest {
        if pattern.is_match(&out) {
            out = pattern.replace_all(&out, *replacement).into_owned();
        }
    }
    // Opaque strings only when long: a word with a digit in it ("MeikiOCR v2", "x86_64") stays.
    opaque
        .0
        .replace_all(&out, |caps: &regex::Captures| {
            let found = &caps[0];
            if found.len() >= 32 { "[redacted]".to_string() } else { found.to_string() }
        })
        .into_owned()
}

// ---------------------------------------------------------------- zip

/// A zip of `files` (deflated; no ZIP64, so each must be under 4 GiB, which a bundle is).
fn zip(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    use flate2::{write::DeflateEncoder, Compression};
    let (time, date) = dos_time();
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).map_err(|e| e.to_string())?;
        let compressed = encoder.finish().map_err(|e| e.to_string())?;
        let crc = crc32fast::hash(data);
        let offset = u32::try_from(out.len()).map_err(|_| "bundle too large")?;
        let name = name.as_bytes();
        let fields = |buf: &mut Vec<u8>| {
            buf.extend_from_slice(&8u16.to_le_bytes()); // deflate
            buf.extend_from_slice(&time.to_le_bytes());
            buf.extend_from_slice(&date.to_le_bytes());
            buf.extend_from_slice(&crc.to_le_bytes());
            buf.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
            buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes()); // extra field
        };
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        fields(&mut out);
        out.extend_from_slice(name);
        out.extend_from_slice(&compressed);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        fields(&mut central);
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let start = out.len() as u32;
    let count = files.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

/// In UTC (the time crate's local offset is not enabled here); the report says so.
fn now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

fn now_rfc3339() -> String {
    now()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// `20261027-1742` (UTC), for the bundle's file name.
fn stamp() -> String {
    let t = now();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute()
    )
}

fn dos_time() -> (u16, u16) {
    let t = now();
    let time = (u16::from(t.hour()) << 11) | (u16::from(t.minute()) << 5) | (u16::from(t.second()) / 2);
    let year = (t.year() - 1980).clamp(0, 127) as u16;
    let date = (year << 9) | (u16::from(u8::from(t.month())) << 5) | u16::from(t.day());
    (time, date)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_survives_redaction_but_authorization_does_not() {
        let mut report = json!({
            "capture": capture_summary(&json!({"authorization": "granted", "windowCapture": true})),
            "authorization": "Bearer private-token",
        });
        redact(&mut report);
        assert_eq!(report["capture"]["permission"], "granted");
        assert_eq!(report["authorization"], "[redacted]");
    }

    #[test]
    fn secret_keys_are_hidden_whatever_they_hold() {
        let mut value = json!({
            "check": "account",
            "accessToken": "abc",
            "nested": [{ "apiKey": "x", "authorization": "Basic Zm9v", "enabled": true }],
            "settings": { "ankiConnectKey": "k", "signedIn": true },
            "monkey": null,
        });
        redact(&mut value);
        assert_eq!(value["accessToken"], "[redacted]");
        assert_eq!(value["nested"][0]["apiKey"], "[redacted]");
        assert_eq!(value["nested"][0]["authorization"], "[redacted]");
        assert_eq!(value["nested"][0]["enabled"], true);
        assert_eq!(value["settings"]["ankiConnectKey"], "[redacted]");
        assert_eq!(value["check"], "account");
        assert_eq!(value["monkey"], Value::Null);
    }

    #[test]
    fn free_text_loses_tokens_queries_addresses_and_user_names() {
        // Generate a synthetic provider token instead of storing a live-key-shaped literal.
        let stripe = ["sk", "live", &"a1".repeat(12)].join("_");
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let text = format!(
            "GET https://kimochiapp.com/api/ocr?token=s3cr3t&x=1 failed; Authorization: Bearer abc.def-123 \
             {jwt} mail hamish@example.com at C:\\Users\\Nadekai\\AppData\\Roaming and /Users/hamstu/Library \
             key=deadbeef {stripe}"
        );
        let out = redact_text(&text);
        assert!(out.contains("https://kimochiapp.com/api/ocr?[redacted]"), "{out}");
        assert!(out.contains("Bearer [redacted]"), "{out}");
        assert!(out.contains("[redacted-jwt]"), "{out}");
        assert!(out.contains("[email]"), "{out}");
        assert!(out.contains(r"C:\Users\<user>\AppData"), "{out}");
        assert!(out.contains("/Users/<user>/Library"), "{out}");
        assert!(out.contains("key=[redacted]"), "{out}");
        for secret in ["s3cr3t", "abc.def-123", "hamish@", "Nadekai", "hamstu", "deadbeef", "sk_live"] {
            assert!(!out.contains(secret), "{secret} leaked: {out}");
        }
    }

    #[test]
    fn ordinary_words_and_versions_survive() {
        let text = "MeikiOCR 0.3.1 on x86_64, Windows 10.0.26100, WebView2 131.0.2903.70, 1920×1080 @150%";
        assert_eq!(redact_text(text), text);
    }

    #[test]
    fn a_tail_starts_at_a_whole_line_and_is_redacted() {
        let dir = std::env::temp_dir().join(format!("kimochi-debug-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("evidence.jsonl");
        let mut body = String::new();
        for i in 0..50 {
            body.push_str(&format!("{{\"check\":\"line\",\"i\":{i},\"token\":\"t{i}\"}}\n"));
        }
        body.push_str("not json: Bearer xyz\n");
        std::fs::write(&path, &body).unwrap();
        let tail = log_tail(&path, 200).unwrap();
        let first = tail.lines().next().unwrap();
        assert!(first.starts_with('{') || first.starts_with("not json"), "{first}");
        assert!(tail.contains("\"token\":\"[redacted]\""), "{tail}");
        assert!(tail.ends_with("not json: Bearer [redacted]\n"), "{tail}");
        assert!(!tail.contains("\"t49\""));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_bundle_is_a_zip_the_engine_reader_accepts() {
        let files = vec![
            ("report.md".to_string(), b"# Kimochi debug info\n".repeat(50)),
            ("logs/evidence.jsonl".to_string(), b"{}\n".to_vec()),
        ];
        let bytes = zip(&files).unwrap();
        let entries = crate::extension_store::zip_entries(&bytes).unwrap();
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["report.md", "logs/evidence.jsonl"]);
    }
}
