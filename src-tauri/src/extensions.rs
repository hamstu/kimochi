//! The native half of the dictionary extensions (Hachidori, 10ten): their custom-scheme
//! origins, which engine is active, their storage files and the generic host script.
//! The contract is DICTIONARY_ENGINES.md §2, §4 and §6. No extension knowledge beyond
//! ids and file serving lives here; everything that adapts an extension is `host/ext/`.
//! The engines' own files are downloaded on demand and served by `extension_store`.
use crate::settings::Settings;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;
use tauri::Manager;

/// The extension engines, by id. Each id is also its URI scheme. (Yomitan is not one: it is
/// served at the app origin root; `extension_store::IDS` lists every downloadable engine.)
pub const IDS: &[&str] = &["hachidori", "tenten"];

/// The host engine when no engine can run: the selected one is not downloaded (a first run that
/// skipped the choice, a removed download, a pin bump still downloading). Neither the Yomitan
/// shims nor the generic host install for it, and lookups say to choose an engine.
pub const NONE: &str = "none";

/// The generic extension host, bundled by `scripts/prepare.mjs` from `host/ext/`.
pub const EXT_HOST: &str = "/spike/ext-host.js";

/// The hidden window each extension engine's background document runs in (DICTIONARY_ENGINES.md
/// §5.4): `ext-<id>`. Its top document is the background page on the extension's own origin, so
/// the extension's IndexedDB and OPFS are first-party there. WebKit keeps a third-party frame's
/// storage (the background page framed by the overlay, as it once was) only for the session.
pub const WINDOW_PREFIX: &str = "ext-";

/// `ext-<id>` for an extension engine id.
pub fn window_label(id: &str) -> String {
    format!("{WINDOW_PREFIX}{id}")
}

/// Whether a webview label is an extension window's. Matched by prefix, so the invoke guard
/// also holds for any label of that shape, not only the engines that exist today.
pub fn is_extension_window(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX)
}

/// The document an extension window opens: the generic host's background page on the
/// engine's origin (`<origin>/__kimochi/ext-background.html?engine=<id>`).
pub fn background_url(id: &str) -> String {
    format!(
        "{}/__kimochi/ext-background.html?engine={id}",
        crate::platform::extension_origin(id)
    )
}

/// The app commands an extension window may invoke. Its top document runs the extension's
/// own background script next to the host, and a top-level document on a registered scheme
/// gets Tauri's IPC like any app page, so everything else is refused before it reaches a
/// command: the host there only relays to the overlay's hub (`ext_relay`), reports
/// diagnostics (`report`) and sends the extension's AnkiConnect requests on
/// (`anki_connect_relay`, which only carries AnkiConnect's request shape). Storage,
/// capture and window commands are the hub's, in the overlay. Plugin commands are not app
/// commands: `capabilities/extension-windows.json` grants these windows event listening and the
/// scoped plugin-http and nothing more.
pub const EXTENSION_WINDOW_COMMANDS: &[&str] =
    &["ext_relay", "ext_relay_listen", "ext_relay_bytes", "report", "anki_connect_relay"];

/// The invoke guard's decision for `command` from the webview `label`.
pub fn command_allowed(label: &str, command: &str) -> Result<(), String> {
    if !is_extension_window(label) || EXTENSION_WINDOW_COMMANDS.contains(&command) {
        Ok(())
    } else {
        Err(format!("invalid: {command} is not available to an extension window"))
    }
}

/// The engine *host* `yomitanSettings.popupType` selects: `'builtin'` (and anything missing or
/// malformed) is Yomitan; `hachidori` and `tenten` pass through. `'custom-api'` needs no host
/// ([`NONE`]): the Yomitan API pop-up splits words and looks them up through the browser's
/// Yomitan over its API, and the overlay installs its lookup hook without any extension
/// (`startApiEngine` in ui/overlay.js), so nothing has to be downloaded for it.
pub fn selected_engine(settings: &Settings) -> String {
    engine_for(
        settings
            .get_path(&["yomitanSettings", "popupType"])
            .ok()
            .flatten()
            .as_ref(),
    )
}

/// The engine the windows run: the selected one when its files can be served
/// (`extension_store::is_ready`), else [`NONE`]. Nothing is bundled, so there is no fallback
/// engine: a reader whose engine is missing gets "choose a dictionary" rather than another
/// engine's pop-up. Read from the store and the disk each time, never cached, so a window built
/// after a switch or a download gets the new engine.
pub fn dictionary_engine(settings: &Settings) -> String {
    effective(&selected_engine(settings), crate::extension_store::is_ready)
}

/// `selected` if `ready` says so, else [`NONE`].
pub fn effective(selected: &str, ready: impl Fn(&str) -> bool) -> String {
    if ready(selected) {
        selected.to_string()
    } else {
        NONE.to_string()
    }
}

fn engine_for(popup_type: Option<&Value>) -> String {
    match popup_type.and_then(Value::as_str) {
        None | Some("") | Some("builtin") => "yomitan".into(),
        Some("custom-api") => NONE.into(),
        // An unknown value (a future engine, a corrupt store) gets Yomitan, as the TypeScript
        // side's `dictionaryEngineOf` does; passing it through would leave the window with no
        // host at all while the overlay still started Yomitan's.
        Some(id) if IDS.contains(&id) => id.into(),
        Some(_) => "yomitan".into(),
    }
}

/// `chrome.storage` persistence file: Yomitan keeps today's `chrome-local.json`, an
/// extension engine gets `chrome-local-<id>.json`.
pub fn storage_file(extension: Option<&str>) -> Result<String, String> {
    match extension {
        None => Ok("chrome-local.json".into()),
        Some(id) if valid_extension_id(id) => Ok(format!("chrome-local-{id}.json")),
        Some(id) => Err(format!("invalid: extension id {id:?} must match [a-z0-9-]{{1,32}}")),
    }
}

/// The name `storage_backup` copies an extension's storage file to before the host resets
/// stale metadata in it (DICTIONARY_ENGINES.md §5.4.1): `chrome-local-<id>.json.bak-<ms>`.
/// Only for an extension engine; Yomitan's file is never touched by this path.
pub fn backup_file(extension: &str, now_ms: u128) -> Result<String, String> {
    if !valid_extension_id(extension) {
        return Err(format!("invalid: extension id {extension:?} must match [a-z0-9-]{{1,32}}"));
    }
    Ok(format!("{}.bak-{now_ms}", storage_file(Some(extension))?))
}

fn valid_extension_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// What a request path on an extension's scheme names.
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// A host script or page: the `dist/spike/` asset key (`/spike/<path>`).
    Host(String),
    /// A file of the extension's release, relative to its tree (`extension_store::read`).
    File(String),
}

/// What a request path on an extension's scheme maps to, or `None` for a 404.
///
/// `/<path>` is the extension's own file; `/__kimochi/<path>` is a host script or page
/// (`/spike/<path>`). The path is percent-decoded first and then checked segment by segment,
/// so an encoded `..` or `/` cannot escape either tree. Directory paths (`/`, a trailing slash)
/// never resolve: the extensions never ask for one. A file must also be in the pinned map
/// (`extension_store::read`), which is a second, filesystem-independent allowlist.
pub fn target(uri_path: &str) -> Option<Target> {
    let path = percent_decode(uri_path)?;
    let path = path.strip_prefix('/')?;
    if path.is_empty() || path.ends_with('/') {
        return None;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains(['\\', '\0']))
    {
        return None;
    }
    match segments.split_first() {
        Some((&"__kimochi", [])) => None,
        Some((&"__kimochi", rest)) => Some(Target::Host(format!("/spike/{}", rest.join("/")))),
        _ => Some(Target::File(path.to_string())),
    }
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `Content-Type` by extension. The extensions' own module scripts, WASM and fonts are
/// loaded cross-origin, where a wrong type is a hard failure rather than a sniff.
pub fn mime_for(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "md" | "txt" => "text/plain; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// The exact bytes of one bundled file, or `None` when that file is not in `dist/`.
///
/// `AssetResolver::get` is not exact on its own. In a bundle it falls back to
/// `<path>.html`, `<path>/index.html` and finally the root `index.html` (Yomitan's
/// page here), so a missing file would come back as somebody else's HTML; the embedded
/// key set is checked first. In `tauri dev` it reads `frontendDist` (`dist/`) from disk
/// with no fallback at all, and nothing is embedded, so it is used as is.
pub fn exact_asset(app: &tauri::AppHandle, key: &str) -> Option<Vec<u8>> {
    if !cfg!(dev) {
        static KEYS: OnceLock<HashSet<String>> = OnceLock::new();
        let keys = KEYS.get_or_init(|| {
            app.asset_resolver()
                .iter()
                .map(|(k, _)| k.into_owned())
                .collect()
        });
        if !keys.contains(key) {
            return None;
        }
    }
    app.asset_resolver().get(key.into()).map(|a| a.bytes)
}

/// The cross-origin isolation an extension asks for in its manifest
/// (`cross_origin_opener_policy` / `cross_origin_embedder_policy`), which Chrome applies to
/// every page of the extension. Hachidori declares both so its engine can run the threaded
/// Hoshidicts build (offscreen.js `supportsSharedWasmMemory`); without isolation it imports on
/// one thread, about 2–3× slower. 10ten declares neither. A test holds this to the manifests.
pub fn manifest_isolation(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        "hachidori" => Some(("same-origin", "require-corp")),
        _ => None,
    }
}

/// The isolation headers a response for extension `id` carries: its manifest's policies when
/// `supported` (Hachidori's loopback origin, `loopback.rs`; never the custom scheme, see
/// `platform::CROSS_ORIGIN_ISOLATION`), else none. `Cross-Origin-Resource-Policy`
/// keeps its scripts, CSS and fonts loadable by the app origin's documents should one of
/// them ever require it.
pub fn isolation_headers(id: &str, supported: bool) -> Vec<(&'static str, &'static str)> {
    match manifest_isolation(id) {
        Some((opener, embedder)) if supported => vec![
            ("Cross-Origin-Opener-Policy", opener),
            ("Cross-Origin-Embedder-Policy", embedder),
            ("Cross-Origin-Resource-Policy", "cross-origin"),
        ],
        _ => Vec::new(),
    }
}

/// The `Content-Type` and bytes an extension origin answers for `uri_path`: the extension's own
/// file or a host page (`/__kimochi/…`). Shared by the custom scheme and Hachidori's loopback
/// origin (`loopback.rs`), so both serve exactly the same tree.
pub fn lookup(app: &tauri::AppHandle, id: &str, uri_path: &str) -> Option<(&'static str, Vec<u8>)> {
    match target(uri_path) {
        Some(Target::Host(key)) => exact_asset(app, &key).map(|bytes| (mime_for(&key), bytes)),
        Some(Target::File(rel)) => {
            crate::extension_store::read(id, &rel).map(|bytes| (mime_for(&rel), bytes))
        }
        None => None,
    }
}

/// Answers one request on an extension scheme. Runs off the main thread.
pub fn respond(
    app: &tauri::AppHandle,
    id: &str,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let response = tauri::http::Response::builder()
        // Fonts, CSS and module scripts are loaded from the app origin's documents.
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    let isolate = crate::platform::CROSS_ORIGIN_ISOLATION && crate::platform::hachidori_threads_allowed();
    let response = isolation_headers(id, isolate)
        .into_iter()
        .fold(response, |response, (name, value)| response.header(name, value));
    match lookup(app, id, request.uri().path()) {
        Some((mime, bytes)) => response.header("Content-Type", mime).body(bytes),
        None => response.status(404).body(Vec::new()),
    }
    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// A document-start script from `dist/`, for `window` (only named in errors).
///
/// Every script is required, except that a debug build tolerates a missing generic
/// host (the build step that makes it may not have run in a working tree yet): it is
/// reported and the window is built without it. A release bundle without the host is
/// broken, so there it is an error like any other missing script.
pub fn init_script(
    app: &tauri::AppHandle,
    window: &str,
    asset: &str,
) -> Result<Option<String>, String> {
    let Some(bytes) = exact_asset(app, asset) else {
        if asset == EXT_HOST && cfg!(debug_assertions) {
            let report = json!({
                "check": "ext-host-missing",
                "window": window,
                "asset": asset,
                "detail": "dist/spike/ext-host.js is not built; Hachidori and 10ten cannot start in this window",
            });
            eprintln!("kimochi: {report}");
            if let Some(service) = app.try_state::<crate::Shared>() {
                crate::record(app, &service, report);
            }
            return Ok(None);
        }
        return Err(format!(
            "invalid: {window} needs {asset}, which is not in the bundle"
        ));
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("invalid: {asset} is not valid UTF-8"))
}

/// Publishes the active dictionary engine and the extension origins before any page or
/// extension script runs (DICTIONARY_ENGINES.md §2).
///
/// `engine` comes from the store when the window is built. A document on an extension's
/// own origin is that engine whatever the store said: it cannot read the app origin's
/// `localStorage` mirror, and this script keeps the value it had at build time across a
/// `dictionary_engine_apply` reload, so deriving it from the origin is what keeps an
/// extension frame right after a switch.
pub fn engine_prelude(engine: &str) -> String {
    let origins: serde_json::Map<String, Value> = IDS
        .iter()
        .map(|id| (id.to_string(), json!(crate::platform::extension_origin(id))))
        .collect();
    format!(
        ";(function(){{try{{\
var o={};\
window.__kimochiExtensionOrigins=o;\
var e={};\
var here=location.protocol+'//'+location.host;\
for(var k in o){{if(o[k]===here){{e=k;}}}}\
window.__kimochiDictionaryEngine=e;\
}}catch(e){{}}}})();\n",
        Value::Object(origins),
        serde_json::to_string(engine).unwrap_or_else(|_| "\"yomitan\"".into()),
    )
}

/// The windows whose extension pages may save a file through [`ext_save_file`]: the ones that
/// show an engine's own settings page (DICTIONARY_ENGINES.md §3).
pub const SAVE_WINDOWS: &[&str] = &["dictionary", "welcome"];

/// A download's file name as the page suggested it, made safe to offer in a save dialog: no
/// directories, no control characters, no leading dots, at most 200 characters.
pub fn download_name(suggested: &str) -> String {
    let base = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    if cleaned.is_empty() {
        "download".into()
    } else {
        cleaned.chars().take(200).collect()
    }
}

/// Saves a file an extension page downloads (`<a download>` on a `blob:` or `data:` URL:
/// Hachidori's backup, debug info and Anki add-on). A webview inside Kimochi has no browser
/// download UI: WKWebView cancels such a download, WebKitGTK drops it and WebView2 saves it
/// somewhere the user is never told about. The page's host reads the bytes and its window
/// (`dictionary`) sends them here as the raw body, with the suggested name percent-encoded in
/// `x-kimochi-filename`; the user picks where it goes. Answers `{saved, path?, bytes?}`;
/// `saved: false` when the dialog was cancelled.
#[tauri::command]
pub async fn ext_save_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    if !SAVE_WINDOWS.contains(&window.label()) {
        return Err(format!("invalid: {} cannot save extension downloads", window.label()));
    }
    let name = request
        .headers()
        .get("x-kimochi-filename")
        .and_then(|value| value.to_str().ok())
        .and_then(percent_decode)
        .map(|name| download_name(&name))
        .unwrap_or_else(|| "download".into());
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("invalid: a download needs a binary body".into());
    };
    let bytes = bytes.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save download")
        .set_file_name(&name)
        .set_parent(&window)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|e| format!("native: {e}"))? else {
        return Ok(json!({ "saved": false }));
    };
    let path = path.into_path().map_err(|e| format!("native: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("native: could not write {}: {e}", path.display()))?;
    Ok(json!({ "saved": true, "path": path.to_string_lossy(), "bytes": bytes.len() }))
}

/// `window.confirm`, `alert` and `prompt` for every webview. WKWebView shows these only through
/// its UI delegate, and wry's implements no panel: without one `confirm()` answers false at
/// once, `alert()` shows nothing and `prompt()` answers null. Hachidori asks before it removes a
/// dictionary or resets lookup counts, so on macOS those buttons silently did nothing. Here the
/// delegate gains the three panels as sheets on the page's window. A window that is hidden or
/// passes clicks through (the overlay, the engines' background windows) answers as WKWebView
/// did, without showing anything. WebView2 and WebKitGTK show their own dialogs already.
pub fn enable_script_dialogs<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    #[cfg(target_os = "macos")]
    {
        let label = webview.label().to_string();
        if let Err(error) = webview.with_webview(|platform| unsafe { script_dialogs::install(platform.inner()) }) {
            eprintln!("[kimochi] script dialogs for {label}: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = webview;
}

#[cfg(target_os = "macos")]
mod script_dialogs {
    use block2::{Block, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use std::ffi::c_void;

    const FIRST_BUTTON: isize = 1000;

    type AlertPanel = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject, *mut Block<dyn Fn()>);
    type ConfirmPanel = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject, *mut Block<dyn Fn(Bool)>);
    type PromptPanel = unsafe extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut AnyObject,
        *mut AnyObject,
        *mut AnyObject,
        *mut Block<dyn Fn(*mut AnyObject)>,
    );

    /// Adds the panels to the class of `webview`'s UI delegate (once; later calls find them) and
    /// sets the delegate again, which is when WebKit reads which panels it implements.
    pub unsafe fn install(webview: *mut c_void) {
        let Some(webview) = (webview as *mut AnyObject).as_ref() else { return };
        let delegate: *mut AnyObject = msg_send![webview, UIDelegate];
        let Some(delegate) = delegate.as_ref() else { return };
        let class = delegate.class() as *const AnyClass as *mut AnyClass;
        let alert: AlertPanel = alert_panel;
        let confirm: ConfirmPanel = confirm_panel;
        let prompt: PromptPanel = prompt_panel;
        let methods: [(Sel, Imp, &std::ffi::CStr); 3] = [
            (
                sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
                std::mem::transmute::<AlertPanel, Imp>(alert),
                c"v@:@@@@?",
            ),
            (
                sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
                std::mem::transmute::<ConfirmPanel, Imp>(confirm),
                c"v@:@@@@?",
            ),
            (
                sel!(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:),
                std::mem::transmute::<PromptPanel, Imp>(prompt),
                c"v@:@@@@@?",
            ),
        ];
        for (selector, imp, types) in methods {
            // NO when the class has it already: an earlier webview added it.
            let _ = objc2::ffi::class_addMethod(class, selector, imp, types.as_ptr());
        }
        let _: () = msg_send![webview, setUIDelegate: delegate];
    }

    unsafe extern "C-unwind" fn alert_panel(
        _this: *mut AnyObject,
        _cmd: Sel,
        webview: *mut AnyObject,
        message: *mut AnyObject,
        _frame: *mut AnyObject,
        handler: *mut Block<dyn Fn()>,
    ) {
        let Some(handler) = RcBlock::copy(handler) else { return };
        present(webview, message, false, None, Box::new(move |_, _| handler.call(())));
    }

    unsafe extern "C-unwind" fn confirm_panel(
        _this: *mut AnyObject,
        _cmd: Sel,
        webview: *mut AnyObject,
        message: *mut AnyObject,
        _frame: *mut AnyObject,
        handler: *mut Block<dyn Fn(Bool)>,
    ) {
        let Some(handler) = RcBlock::copy(handler) else { return };
        present(webview, message, true, None, Box::new(move |ok, _| handler.call((Bool::new(ok),))));
    }

    unsafe extern "C-unwind" fn prompt_panel(
        _this: *mut AnyObject,
        _cmd: Sel,
        webview: *mut AnyObject,
        prompt: *mut AnyObject,
        default_text: *mut AnyObject,
        _frame: *mut AnyObject,
        handler: *mut Block<dyn Fn(*mut AnyObject)>,
    ) {
        let Some(handler) = RcBlock::copy(handler) else { return };
        let default_text = (default_text as *mut NSString).as_ref().map(|text| text.to_string()).unwrap_or_default();
        present(
            webview,
            prompt,
            true,
            Some(default_text),
            Box::new(move |ok, text: Option<String>| match text.filter(|_| ok) {
                Some(text) => {
                    let answer = NSString::from_str(&text);
                    handler.call((Retained::as_ptr(&answer) as *mut AnyObject,));
                }
                None => handler.call((std::ptr::null_mut(),)),
            }),
        );
    }

    /// Shows one panel and calls `done(ok, text)` exactly once (WebKit raises if a completion
    /// handler is released uncalled): as a sheet on the page's window, app-modal when that window
    /// already has a sheet, and not at all (cancelled) when the window cannot take a click.
    unsafe fn present(
        webview: *mut AnyObject,
        message: *mut AnyObject,
        cancellable: bool,
        default_text: Option<String>,
        done: Box<dyn Fn(bool, Option<String>)>,
    ) {
        let window: *mut AnyObject = match webview.as_ref() {
            Some(webview) => msg_send![webview, window],
            None => std::ptr::null_mut(),
        };
        let usable = window.as_ref().is_some_and(|window| {
            let visible: Bool = msg_send![window, isVisible];
            let passes_clicks: Bool = msg_send![window, ignoresMouseEvents];
            visible.as_bool() && !passes_clicks.as_bool()
        });
        let Some(alert_class) = AnyClass::get(c"NSAlert").filter(|_| usable) else {
            done(false, None);
            return;
        };
        let alert: Retained<AnyObject> = msg_send![alert_class, new];
        let text = (message as *mut NSString).as_ref().map(|m| m.to_string()).unwrap_or_default();
        let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(&text)];
        let _: *mut AnyObject = msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("OK")];
        if cancellable {
            let _: *mut AnyObject = msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Cancel")];
        }
        let field: Option<Retained<AnyObject>> = match (&default_text, AnyClass::get(c"NSTextField")) {
            (Some(initial), Some(field_class)) => {
                let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(300., 24.));
                let field: Retained<AnyObject> = msg_send![msg_send![field_class, alloc], initWithFrame: frame];
                let _: () = msg_send![&*field, setStringValue: &*NSString::from_str(initial)];
                let _: () = msg_send![&*alert, setAccessoryView: &*field];
                let panel: *mut AnyObject = msg_send![&*alert, window];
                if let Some(panel) = panel.as_ref() {
                    let _: () = msg_send![panel, setInitialFirstResponder: &*field];
                }
                Some(field)
            }
            _ => None,
        };
        let read = move |response: isize| {
            let ok = response == FIRST_BUTTON;
            let text = field.as_ref().map(|field| {
                let value: Retained<NSString> = msg_send![&**field, stringValue];
                value.to_string()
            });
            (ok, text)
        };
        let window = &*window;
        let sheet: *mut AnyObject = msg_send![window, attachedSheet];
        if sheet.is_null() {
            let keep = alert.clone();
            let completion = RcBlock::new(move |response: isize| {
                let _ = &keep;
                let (ok, text) = read(response);
                done(ok, text);
            });
            let _: () = msg_send![&*alert, beginSheetModalForWindow: window, completionHandler: &*completion];
        } else {
            let response: isize = msg_send![&*alert, runModal];
            let (ok, text) = read(response);
            done(ok, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names_are_offered_without_directories_or_tricks() {
        assert_eq!(download_name("hachidori-backup-2026-10-23.zip"), "hachidori-backup-2026-10-23.zip");
        assert_eq!(download_name("../../.ssh/authorized_keys"), "authorized_keys");
        assert_eq!(download_name("C:\\Windows\\evil.dll"), "evil.dll");
        assert_eq!(download_name(".hidden"), "hidden");
        assert_eq!(download_name("a\u{0}b<c>.txt"), "abc.txt");
        assert_eq!(download_name(""), "download");
        assert_eq!(download_name("..."), "download");
        assert_eq!(download_name(&"x".repeat(500)).len(), 200);
        assert!(SAVE_WINDOWS.contains(&"dictionary"));
        assert!(!SAVE_WINDOWS.iter().any(|label| is_extension_window(label)));
    }

    #[test]
    fn request_paths_map_to_the_extension_or_host_tree_only() {
        let file = |p: &str| Some(Target::File(p.into()));
        let host = |p: &str| Some(Target::Host(p.into()));
        assert_eq!(target("/settings.html"), file("settings.html"));
        assert_eq!(target("/fonts/NotoSansJP.woff2"), file("fonts/NotoSansJP.woff2"));
        assert_eq!(target("/__kimochi/ext-host.js"), host("/spike/ext-host.js"));
        assert_eq!(target("/__kimochi/sub/page.html"), host("/spike/sub/page.html"));
        // Percent-decoded before mapping.
        assert_eq!(target("/assets/a%20b.png"), file("assets/a b.png"));
        assert_eq!(target("/_locales/ja/messages.json"), file("_locales/ja/messages.json"));
        // Directories, traversal (plain or encoded), empty segments and malformed escapes.
        for bad in [
            "",
            "/",
            "/fonts/",
            "/__kimochi",
            "/__kimochi/",
            "/../spike/shim.js",
            "/a/../../settings.html",
            "/%2e%2e/settings.html",
            "/a%2F..%2F..%2Fx",
            "/./settings.html",
            "//settings.html",
            "/a//b.js",
            "/a\\b.js",
            "/a%5cb.js",
            "/a%00.js",
            "/a%zz.js",
            "/a%2",
            "/%ff.js",
            "/__kimochi/../ext/tenten/x.js",
            "settings.html",
        ] {
            assert_eq!(target(bad), None, "{bad:?}");
        }
        // A well-formed path outside the pinned release is still a 404: the map is the allowlist.
        assert!(crate::extension_store::read("tenten", "installed.json").is_none());
        assert!(crate::extension_store::read("tenten", "not-in-the-release.js").is_none());
        assert!(crate::extension_store::read("none", "manifest.json").is_none());
    }

    #[test]
    fn the_effective_engine_is_the_selected_one_only_when_it_can_be_served() {
        let ready = |id: &str| id == "hachidori";
        assert_eq!(effective("hachidori", ready), "hachidori");
        // Nothing is bundled any more: a missing engine is no engine, never another one.
        assert_eq!(effective("tenten", ready), NONE);
        assert_eq!(effective("yomitan", ready), NONE);
        assert_eq!(effective("yomitan", |_| true), "yomitan");
    }

    #[test]
    fn content_types_follow_the_extension() {
        let cases = [
            ("/ext/hachidori/settings.html", "text/html; charset=utf-8"),
            ("/ext/hachidori/background.js", "text/javascript; charset=utf-8"),
            ("/ext/hachidori/x.mjs", "text/javascript; charset=utf-8"),
            ("/ext/hachidori/content.css", "text/css; charset=utf-8"),
            ("/ext/tenten/manifest.json", "application/json"),
            ("/ext/hachidori/engine.wasm", "application/wasm"),
            ("/ext/tenten/images/logo.svg", "image/svg+xml"),
            ("/ext/tenten/images/a.PNG", "image/png"),
            ("/ext/tenten/a.webp", "image/webp"),
            ("/ext/tenten/a.gif", "image/gif"),
            ("/ext/tenten/favicon.ico", "image/x-icon"),
            ("/ext/tenten/f.woff", "font/woff"),
            ("/ext/tenten/f.woff2", "font/woff2"),
            ("/ext/tenten/f.ttf", "font/ttf"),
            ("/ext/hachidori/a.mp3", "audio/mpeg"),
            ("/ext/hachidori/a.ogg", "audio/ogg"),
            ("/ext/tenten/data/words.ljson", "application/octet-stream"),
            ("/ext/tenten/data/words.idx", "application/octet-stream"),
            ("/ext/tenten/LICENSE", "application/octet-stream"),
        ];
        for (path, mime) in cases {
            assert_eq!(mime_for(path), mime, "{path}");
        }
    }

    #[test]
    fn storage_is_namespaced_per_extension() {
        assert_eq!(storage_file(None).unwrap(), "chrome-local.json");
        assert_eq!(
            storage_file(Some("hachidori")).unwrap(),
            "chrome-local-hachidori.json"
        );
        assert_eq!(storage_file(Some("tenten")).unwrap(), "chrome-local-tenten.json");
        assert_eq!(storage_file(Some("a-1")).unwrap(), "chrome-local-a-1.json");
        let long = "a".repeat(33);
        for bad in ["", "Tenten", "../x", "a/b", "a.b", "a b", "é", long.as_str()] {
            assert!(
                storage_file(Some(bad)).unwrap_err().starts_with("invalid:"),
                "{bad:?}"
            );
        }
        assert!(storage_file(Some(&"a".repeat(32))).is_ok());
    }

    #[test]
    fn backups_are_named_beside_the_extension_file_and_never_for_yomitan() {
        assert_eq!(
            backup_file("hachidori", 1791823478169).unwrap(),
            "chrome-local-hachidori.json.bak-1791823478169"
        );
        assert_eq!(backup_file("tenten", 1).unwrap(), "chrome-local-tenten.json.bak-1");
        for bad in ["", "../x", "a/b", "Tenten"] {
            assert!(backup_file(bad, 1).unwrap_err().starts_with("invalid:"), "{bad:?}");
        }
    }

    #[test]
    fn popup_type_names_the_engine() {
        assert_eq!(engine_for(None), "yomitan");
        assert_eq!(engine_for(Some(&json!("builtin"))), "yomitan");
        assert_eq!(engine_for(Some(&json!(""))), "yomitan");
        assert_eq!(engine_for(Some(&json!(3))), "yomitan");
        // The Yomitan API pop-up talks to the browser's Yomitan: no host, nothing to download.
        assert_eq!(engine_for(Some(&json!("custom-api"))), NONE);
        assert_eq!(engine_for(Some(&json!("hachidori"))), "hachidori");
        assert_eq!(engine_for(Some(&json!("tenten"))), "tenten");
        assert_eq!(engine_for(Some(&json!("rikaikun"))), "yomitan");
    }

    #[test]
    fn extension_windows_are_named_and_opened_per_engine() {
        assert_eq!(window_label("hachidori"), "ext-hachidori");
        assert_eq!(window_label("tenten"), "ext-tenten");
        assert!(is_extension_window("ext-hachidori"));
        assert!(is_extension_window("ext-tenten"));
        for label in ["overlay", "log", "dictionary", "popup-host", "welcome", "settings", "extension", "Ext-x"] {
            assert!(!is_extension_window(label), "{label}");
        }
        assert_eq!(
            background_url("tenten"),
            format!(
                "{}/__kimochi/ext-background.html?engine=tenten",
                crate::platform::extension_origin("tenten")
            )
        );
        // The URL is on the engine's own origin, so its window's allowlist admits it.
        let url: tauri::Url = background_url("hachidori").parse().unwrap();
        assert!(crate::platform::is_extension_url_of(&url, "hachidori"));
        assert_eq!(target(url.path()), Some(Target::Host("/spike/ext-background.html".into())));
    }

    #[test]
    fn extension_windows_may_only_relay_and_report() {
        for command in ["ext_relay", "ext_relay_listen", "ext_relay_bytes", "report", "anki_connect_relay"] {
            assert!(command_allowed("ext-hachidori", command).is_ok(), "{command}");
            assert!(command_allowed("ext-tenten", command).is_ok(), "{command}");
        }
        for command in [
            "storage_load",
            "storage_save",
            "storage_backup",
            "settings_get",
            "settings_set",
            "settings_all",
            "panel",
            "dictionary_engine_apply",
            "extension_window_ensure",
            "extension_fetch",
            "capture_frame",
            "capture_frame_source",
            "retain_frame",
            "history_clear",
            "app_quit",
            "anki_add_note",
            "yomitan_request",
            "platform_capabilities",
            "",
        ] {
            assert_eq!(
                command_allowed("ext-hachidori", command).unwrap_err(),
                format!("invalid: {command} is not available to an extension window")
            );
            assert!(command_allowed("ext-someday", command).is_err(), "{command}");
        }
        // Every other window is untouched by the guard.
        for label in ["overlay", "log", "dictionary", "welcome", "settings"] {
            assert!(command_allowed(label, "storage_save").is_ok());
            assert!(command_allowed(label, "app_quit").is_ok());
        }
    }

    #[test]
    fn the_engine_prelude_publishes_engine_and_origins() {
        let script = engine_prelude("tenten");
        assert!(script.starts_with(";(function(){try{"));
        assert!(script.ends_with("}catch(e){}})();\n"));
        assert!(script.contains("var e=\"tenten\";"));
        assert!(script.contains("window.__kimochiDictionaryEngine=e;"));
        let origins = format!(
            "var o={{\"hachidori\":\"{}\",\"tenten\":\"{}\"}};",
            crate::platform::extension_origin("hachidori"),
            crate::platform::extension_origin("tenten")
        );
        assert!(script.contains(&origins), "{script}");
        // An engine value is data, never code.
        assert!(engine_prelude("x\";alert(1);//").contains(r#"var e="x\";alert(1);//";"#));
    }

    #[test]
    fn isolation_follows_each_manifest() {
        // The committed copy of each release's manifest (host/ext/engines.js reads the same).
        for id in IDS {
            let path = format!("{}/../extensions/{id}.manifest.json", env!("CARGO_MANIFEST_DIR"));
            let manifest: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let policy = |key: &str| manifest[key]["value"].as_str().map(str::to_owned);
            let declared = match (
                policy("cross_origin_opener_policy"),
                policy("cross_origin_embedder_policy"),
            ) {
                (Some(opener), Some(embedder)) => Some((opener, embedder)),
                _ => None,
            };
            let ours = manifest_isolation(id).map(|(o, e)| (o.to_owned(), e.to_owned()));
            assert_eq!(ours, declared, "{id}");
        }
    }

    #[test]
    fn isolation_headers_only_where_the_webview_can_isolate() {
        assert_eq!(
            isolation_headers("hachidori", true),
            vec![
                ("Cross-Origin-Opener-Policy", "same-origin"),
                ("Cross-Origin-Embedder-Policy", "require-corp"),
                ("Cross-Origin-Resource-Policy", "cross-origin"),
            ]
        );
        assert!(isolation_headers("hachidori", false).is_empty());
        assert!(isolation_headers("tenten", true).is_empty());
        // No webview gives a scheme page what the threaded engine needs; the loopback origin does.
        assert!(!crate::platform::CROSS_ORIGIN_ISOLATION);
    }
}
