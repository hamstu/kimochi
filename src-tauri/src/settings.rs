//! Generic dotted-key settings store, the replacement for Electron's `electron-store`.
//! Defaults mirror `src/main/settings.ts` plus the keys that are only ever written
//! through `useSetting`, so renderer code ports across unchanged.
use serde_json::{json, Map, Value};
use std::{path::PathBuf, sync::Mutex};

/// Every default in one place. Values that Electron writes only through `useSetting`
/// (and so never appear in its `StoreType`) are taken from their call sites.
pub fn defaults() -> Value {
    json!({
        "hasCompletedOnboarding": false,
        "windowPositions": {},
        "nativeWindowBounds": {},
        "nativeWindowPinned": {},
        "cropRegions": {},
        "cropScanEnabled": {},
        "hotkeys": {},
        "scannedTextFontSize": 14,
        "scannedTextHistory": [],
        "audioSettings": { "voiceId": "j210dv0vWm7fCknyQpbA" },
        "autoScanSettings": { "enabled": false, "triggerKeys": "", "scanDelay": 500 },
        "gamepadSettings": { "enabled": true },
        "autoOCRSettings": {
            "pollInterval": 2000,
            "imageHashThreshold": 5,
            "localOCRSimilarityThreshold": 0.85,
            // Disabled by default: The native observer gate is configured independently.
            "localOCRGateEnabled": false,
            "adaptivePollingEnabled": true,
            "adaptivePollMin": 500,
            "adaptivePollMax": 5000
        },
        "texthookerSettings": {
            "copyToClipboard": false,
            "sendToWebSocket": false,
            "webSocketUrl": "ws://localhost:6677"
        },
        "yomitanSettings": { "popupType": "builtin", "customApiUrl": "" },
        // An object, not a flat scalar: `useSetting<ServerSettings>('serverSettings')`.
        "serverSettings": { "mode": "cloud" },
        "textOverlayGrouping": {
            "enabled": false,
            "proximityThreshold": 100,
            "filterSmallText": true,
            "filterSmallTextThreshold": 0.75
        },
        "overlayOpacity": 80,
        "liveOverlayEnabled": false,
        "ocrMode": "cloud"
        // `endpoint` is intentionally absent: an unset endpoint follows
        // serverSettings.mode. See `resolve_endpoint`.
    })
}

pub struct Settings {
    path: PathBuf,
    doc: Mutex<Value>,
}

impl Settings {
    /// Stored values win over defaults; new defaults appear for keys a user never set.
    pub fn load(path: PathBuf) -> Self {
        let mut doc = defaults();
        let existing = std::fs::read(&path);
        if existing.is_err() {
            // First run on the new schema: carry the POC's preferences over rather
            // than silently resetting a user's endpoint, pins and crop.
            if let Some(legacy) = path.parent().map(|dir| dir.join("preferences.json")) {
                if let Ok(bytes) = std::fs::read(&legacy) {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        migrate_poc_preferences(&mut doc, &value);
                    }
                }
            }
        }
        if let Ok(bytes) = existing {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(stored) => merge(&mut doc, stored),
                // A corrupt file must not wipe the user's settings silently, and must
                // not stop the app booting. Keep defaults in memory and leave the file
                // alone until something explicitly writes.
                Err(e) => eprintln!("settings: ignoring unreadable {}: {e}", path.display()),
            }
        }
        Self {
            path,
            doc: Mutex::new(doc),
        }
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>, String> {
        self.get_path(&segments(key)?)
    }

    /// Literal path segments. Use this whenever a segment is user data — an
    /// application name may contain a dot ("Node.js"), and splitting it would nest a
    /// new object instead of writing the map entry Electron writes.
    pub fn get_path(&self, path: &[&str]) -> Result<Option<Value>, String> {
        if path.is_empty() || path.iter().any(|p| p.is_empty()) {
            return Err("invalid: settings path has an empty segment".into());
        }
        let doc = self.doc.lock().unwrap();
        let mut cursor = &*doc;
        for part in path {
            match cursor.get(part) {
                Some(next) => cursor = next,
                None => return Ok(None),
            }
        }
        Ok(Some(cursor.clone()))
    }

    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        self.set_many(&[(&segments(key)?, value)])
    }

    pub fn set_path(&self, path: &[&str], value: Value) -> Result<(), String> {
        self.set_many(&[(path, value)])
    }

    /// Apply several writes and persist once. Either the whole group reaches disk or
    /// none of it does, so a multi-key commit cannot be left half-applied.
    ///
    /// The mutation, the write and any rollback all happen under a single held lock.
    /// Releasing it around the write would let a concurrent writer interleave, and a
    /// rollback would then discard that other writer's committed update.
    pub fn set_many(&self, updates: &[(&[&str], Value)]) -> Result<(), String> {
        for (path, _) in updates {
            if path.is_empty() || path.iter().any(|p| p.is_empty()) {
                return Err("invalid: settings path has an empty segment".into());
            }
        }
        let mut doc = self.doc.lock().unwrap();
        let snapshot = doc.clone();
        for (path, value) in updates {
            let mut cursor = &mut *doc;
            for part in &path[..path.len() - 1] {
                if !cursor.get(*part).is_some_and(Value::is_object) {
                    cursor[*part] = json!({});
                }
                cursor = cursor.get_mut(*part).unwrap();
            }
            let leaf = path[path.len() - 1];
            match value {
                // Null removes a map entry rather than storing a null, so a cleared
                // crop leaves no residue behind.
                Value::Null => {
                    if let Some(object) = cursor.as_object_mut() {
                        object.remove(leaf);
                    }
                }
                value => cursor[leaf] = value.clone(),
            }
        }
        if let Err(e) = self.persist(&doc) {
            // Roll the in-memory document back so it never disagrees with disk.
            *doc = snapshot;
            return Err(e);
        }
        Ok(())
    }

    /// Read-modify-write under one held lock.
    ///
    /// A caller that reads with `get`, edits, then writes with `set` has a window in
    /// which another window's write lands and is then overwritten. Anything that edits
    /// a collection in place must come through here instead.
    pub fn update_path<F>(&self, path: &[&str], edit: F) -> Result<Value, String>
    where
        F: FnOnce(Option<&Value>) -> Value,
    {
        if path.is_empty() || path.iter().any(|p| p.is_empty()) {
            return Err("invalid: settings path has an empty segment".into());
        }
        let mut doc = self.doc.lock().unwrap();
        let snapshot = doc.clone();
        let current = {
            let mut cursor = Some(&*doc);
            for part in path {
                cursor = cursor.and_then(|value| value.get(part));
            }
            cursor.cloned()
        };
        let next = edit(current.as_ref());
        {
            let mut cursor = &mut *doc;
            for part in &path[..path.len() - 1] {
                if !cursor.get(*part).is_some_and(Value::is_object) {
                    cursor[*part] = json!({});
                }
                cursor = cursor.get_mut(*part).unwrap();
            }
            cursor[path[path.len() - 1]] = next.clone();
        }
        if let Err(e) = self.persist(&doc) {
            *doc = snapshot;
            return Err(e);
        }
        Ok(next)
    }

    pub fn all(&self) -> Value {
        self.doc.lock().unwrap().clone()
    }

    /// Typed read with a fallback, for the many call sites that want one field.
    pub fn get_or<T: serde::de::DeserializeOwned>(&self, key: &str, fallback: T) -> T {
        self.get(key)
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or(fallback)
    }

    /// Takes the document by reference so the caller can keep holding the lock.
    fn persist(&self, doc: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Write-then-rename: a crash mid-write leaves the previous file intact. The
        // temp name carries the pid so a second process cannot delete this one's
        // scratch file out from under it mid-rename.
        let tmp = self
            .path
            .with_extension(format!("tmp.{}", std::process::id()));
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

/// Server bases from `src/shared/constants.ts`.
pub const CLOUD_SERVER: &str = "https://kimochi-server.hamish.workers.dev";
pub const LOCAL_SERVER: &str = "http://localhost:3000";

pub fn server_base(settings: &Settings) -> String {
    let mode: String = settings.get_or("serverSettings.mode", "cloud".to_string());
    if mode == "local" {
        LOCAL_SERVER
    } else {
        CLOUD_SERVER
    }
    .to_string()
}

/// The OCR endpoint actually used for a request.
///
/// Precedence: a genuinely custom `endpoint` wins; otherwise the URL follows
/// `serverSettings.mode`. An `endpoint` that merely equals one of the two built-in
/// defaults does **not** count as custom — otherwise an inherited cloud default (or
/// one the POC's preferences round-tripped) would permanently pin the app to cloud and
/// make the Local toggle do nothing.
pub fn resolve_endpoint(settings: &Settings) -> String {
    let derived = format!("{}/detect-text", server_base(settings));
    let configured: Option<String> = settings
        .get("endpoint")
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|e| !e.trim().is_empty());
    match configured {
        Some(endpoint) if !is_builtin_endpoint(&endpoint) => endpoint,
        _ => derived,
    }
}

fn is_builtin_endpoint(endpoint: &str) -> bool {
    [CLOUD_SERVER, LOCAL_SERVER]
        .iter()
        .any(|base| endpoint == format!("{base}/detect-text"))
}

/// Map the POC's flat `preferences.json` onto the new schema. Read-only: the old file
/// is left in place, so a downgrade still finds it.
fn migrate_poc_preferences(doc: &mut Value, legacy: &Value) {
    if let Some(endpoint) = legacy.get("endpoint").and_then(Value::as_str) {
        doc["endpoint"] = json!(endpoint);
    }
    for (from, to) in [("controller_pin", "controller"), ("log_pin", "log")] {
        if let Some(pinned) = legacy.get(from).and_then(Value::as_bool) {
            doc["nativeWindowPinned"][to] = json!(pinned);
        }
    }
    let source = legacy.get("source").filter(|v| !v.is_null());
    if let Some(source) = source {
        doc["lastSelectedSource"] = source.clone();
        // The POC held one global crop; the new schema keys it per source descriptor.
        if let Some(crop) = legacy.get("crop").filter(|v| !v.is_null()) {
            let app = source.get("appName").and_then(Value::as_str);
            let name = source
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let kind = source
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("window");
            let key = crate::state::descriptor_key(kind, name, app);
            doc["cropRegions"][&key] = crop.clone();
            doc["cropScanEnabled"][&key] = json!(true);
        }
    }
}

/// Reject empty keys and empty segments so `set("a..b")` cannot create a `""` field.
fn segments(key: &str) -> Result<Vec<&str>, String> {
    let parts: Vec<&str> = key.split('.').collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err(format!(
            "invalid: settings key {key:?} has an empty segment"
        ));
    }
    Ok(parts)
}

/// Deep-merge objects; any other value replaces wholesale.
fn merge(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(t), Value::Object(s)) => {
            for (k, v) in s {
                merge(t.entry(k).or_insert(Value::Null), v);
            }
        }
        (t, s) => *t = s,
    }
}

/// Electron's default hotkeys, from `src/shared/defaults.ts`.
pub fn default_hotkeys() -> Map<String, Value> {
    let rows = [
        (
            "triggerScan",
            "Trigger Scan",
            "CommandOrControl+Shift+8",
            "Trigger OCR scan on current source",
        ),
        (
            "toggleOverlay",
            "Toggle Overlay",
            "CommandOrControl+Shift+9",
            "Show or hide the overlay window",
        ),
        (
            "setCropArea",
            "Set Crop Area",
            "CommandOrControl+Shift+0",
            "Set a new crop area for the current source",
        ),
        (
            "playAudio",
            "Play Audio",
            "CommandOrControl+Shift+7",
            "Play audio of scanned text",
        ),
        (
            "selectAndScan",
            "Select and Scan",
            "CommandOrControl+Shift+6",
            "Select a screen region and scan immediately",
        ),
    ];
    rows.iter()
        .map(|(key, name, accelerator, description)| {
            (
                (*key).to_string(),
                json!({
                    "name": name,
                    "accelerator": accelerator,
                    "description": description,
                    "enabled": true
                }),
            )
        })
        .collect()
}

/// Defaults merged with the user's `hotkeys` overrides, matching
/// `mergeHotkeysWithOverrides`. Unknown override keys are ignored, as in Electron.
pub fn merged_hotkeys(settings: &Settings) -> Map<String, Value> {
    let overrides = settings
        .get("hotkeys")
        .ok()
        .flatten()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut merged = default_hotkeys();
    for (name, entry) in merged.iter_mut() {
        let Some(over) = overrides.get(name).and_then(Value::as_object) else {
            continue;
        };
        for field in ["accelerator", "enabled", "gamepadButton"] {
            if let Some(value) = over.get(field) {
                entry[field] = value.clone();
            }
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test gets its own file: these run in parallel, and a shared path made
    /// them clobber each other's atomic rename.
    fn store() -> Settings {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Settings {
            path: std::env::temp_dir().join(format!(
                "kimochi-settings-test-{}-{n}.json",
                std::process::id()
            )),
            doc: Mutex::new(defaults()),
        }
    }

    #[test]
    fn dotted_reads_and_writes_nest() {
        let s = store();
        assert_eq!(
            s.get("audioSettings.voiceId").unwrap().unwrap(),
            "j210dv0vWm7fCknyQpbA"
        );
        {
            let mut doc = s.doc.lock().unwrap();
            let mut cursor = &mut *doc;
            for part in ["nativeWindowBounds", "controls"] {
                if !cursor.get(part).is_some_and(Value::is_object) {
                    cursor[part] = json!({});
                }
                cursor = cursor.get_mut(part).unwrap();
            }
            cursor["x"] = json!(12);
        }
        assert_eq!(s.get("nativeWindowBounds.controls.x").unwrap().unwrap(), 12);
        assert!(s.get("nativeWindowBounds.missing").unwrap().is_none());
    }

    #[test]
    fn map_keys_containing_dots_stay_literal() {
        let s = store();
        s.set_path(&["cropRegions", "Node.js"], json!({"x": 1}))
            .unwrap();
        let regions = s.get("cropRegions").unwrap().unwrap();
        // One literal entry, not a nested {"Node": {"js": ...}} object.
        assert!(regions.get("Node.js").is_some());
        assert!(regions.get("Node").is_none());
        assert_eq!(
            s.get_path(&["cropRegions", "Node.js", "x"])
                .unwrap()
                .unwrap(),
            1
        );
    }

    #[test]
    fn null_removes_a_map_entry() {
        let s = store();
        s.set_path(&["cropRegions", "Safari"], json!({"x": 1}))
            .unwrap();
        s.set_path(&["cropRegions", "Safari"], Value::Null).unwrap();
        let regions = s.get("cropRegions").unwrap().unwrap();
        assert!(regions.get("Safari").is_none());
    }

    #[test]
    fn set_many_applies_every_update() {
        let s = store();
        s.set_many(&[
            (&["cropRegions", "Safari"], json!({"x": 1})),
            (&["cropScanEnabled", "Safari"], json!(true)),
            (&["lastSelectedSource"], json!({"name": "Safari"})),
        ])
        .unwrap();
        assert_eq!(
            s.get_path(&["cropScanEnabled", "Safari"]).unwrap().unwrap(),
            true
        );
        assert_eq!(s.get("lastSelectedSource.name").unwrap().unwrap(), "Safari");
    }

    #[test]
    fn poc_preferences_are_carried_over_not_reset() {
        let mut doc = defaults();
        migrate_poc_preferences(
            &mut doc,
            &json!({
                "endpoint": "https://example.test/detect-text",
                "controller_pin": false,
                "log_pin": true,
                "source": {"sourceId": "macos:window:1:2", "type": "window", "name": "Doc", "appName": "Safari"},
                "crop": {"x": 0, "y": 40, "width": 576, "height": 320,
                         "reference_width": 640, "reference_height": 400}
            }),
        );
        assert_eq!(doc["endpoint"], "https://example.test/detect-text");
        assert_eq!(doc["nativeWindowPinned"]["controller"], false);
        assert_eq!(doc["lastSelectedSource"]["appName"], "Safari");
        // The POC's single global crop becomes a per-descriptor entry.
        assert_eq!(doc["cropRegions"]["Safari"]["width"], 576);
        assert_eq!(doc["cropScanEnabled"]["Safari"], true);
    }

    #[test]
    fn migration_without_a_source_leaves_crops_empty() {
        let mut doc = defaults();
        migrate_poc_preferences(&mut doc, &json!({"endpoint": "https://x.test/y"}));
        assert_eq!(doc["endpoint"], "https://x.test/y");
        assert_eq!(doc["cropRegions"], json!({}));
    }

    #[test]
    fn mode_drives_the_endpoint_unless_it_is_genuinely_custom() {
        let s = store();
        // Unset endpoint: follows the mode.
        assert!(resolve_endpoint(&s).starts_with(CLOUD_SERVER));
        s.set("serverSettings.mode", json!("local")).unwrap();
        assert_eq!(resolve_endpoint(&s), format!("{LOCAL_SERVER}/detect-text"));

        // An inherited built-in default must not pin the app to cloud.
        s.set("endpoint", json!(format!("{CLOUD_SERVER}/detect-text")))
            .unwrap();
        assert_eq!(resolve_endpoint(&s), format!("{LOCAL_SERVER}/detect-text"));

        // A real custom endpoint wins over the mode.
        s.set("endpoint", json!("https://ocr.example.test/detect-text"))
            .unwrap();
        assert_eq!(resolve_endpoint(&s), "https://ocr.example.test/detect-text");

        // Blank is treated as unset, not as a custom empty endpoint.
        s.set("endpoint", json!("  ")).unwrap();
        assert_eq!(resolve_endpoint(&s), format!("{LOCAL_SERVER}/detect-text"));
    }

    #[test]
    fn empty_segments_are_rejected() {
        assert!(store().get("a..b").is_err());
        assert!(store().get("").is_err());
    }

    #[test]
    fn stored_values_win_over_defaults_but_new_defaults_survive() {
        let mut doc = defaults();
        merge(
            &mut doc,
            json!({"overlayOpacity": 40, "autoOCRSettings": {"pollInterval": 9}}),
        );
        assert_eq!(doc["overlayOpacity"], 40);
        assert_eq!(doc["autoOCRSettings"]["pollInterval"], 9);
        // Untouched sibling default must still be present after a partial merge.
        assert_eq!(doc["autoOCRSettings"]["adaptivePollMax"], 5000);
    }

    #[test]
    fn hotkey_overrides_apply_per_field() {
        let s = store();
        s.doc.lock().unwrap()["hotkeys"] =
            json!({"triggerScan": {"accelerator": "Alt+1", "enabled": false}});
        let merged = merged_hotkeys(&s);
        assert_eq!(merged["triggerScan"]["accelerator"], "Alt+1");
        assert_eq!(merged["triggerScan"]["enabled"], false);
        // Description comes from the default, not the override.
        assert_eq!(merged["triggerScan"]["name"], "Trigger Scan");
        assert_eq!(
            merged["playAudio"]["accelerator"],
            "CommandOrControl+Shift+7"
        );
    }
}
