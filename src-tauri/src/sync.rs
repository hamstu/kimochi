//! Sync: the active account's profile kept the same on every computer signed in to it, in the
//! background. The logic is `sync_core.rs`; this file runs it (a thread of its own), talks to the
//! server (the Kimochi server's `/api/v1/sync/*`), holds the Log window's writes while a
//! merge changes its files, and keeps the sync log (`sync_log.rs`).
//!
//! Signed in means syncing; there is no switch. A cycle runs a few seconds after something
//! changes here (the Log calls `sync_local_changed` after it writes; settings writes call
//! `local_changed`), when a window comes forward, at start, and every minute. Offline, a cycle
//! still notes what changed (with its time) and tries again a minute later.
use crate::sync_core::{self, Changed, Ctx, Host, Prefs, Remote, ScanCache, State};
use crate::sync_log::{Entry as LogEntry, SyncLog};
use crate::{account, cloud, panels, profile, settings, state::Shared};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_secs(60);
/// After a local change: wait for this much quiet...
const DEBOUNCE: Duration = Duration::from_secs(4);
/// ...but no longer than this.
const DEBOUNCE_MAX: Duration = Duration::from_secs(30);
const HOLD_TIMEOUT: Duration = Duration::from_secs(20);

enum Msg {
    Changed,
    Now,
}

#[derive(Default, Clone)]
struct Status {
    state: &'static str,
    last_error: Option<String>,
    used: Option<u64>,
    limit: Option<u64>,
    /// From the active profile's state, refreshed after each cycle and on a profile change.
    last_sync_at: Option<u64>,
    pending: usize,
    origin: Option<String>,
}

impl Status {
    fn summarize(&mut self, state: &State) {
        self.last_sync_at = state.last_sync_at;
        self.pending = state.pending.len();
        self.origin = state.origin.clone();
    }
}

/// The active profile's sync summary, read from its state file.
fn load_summary() {
    let Some(engine) = ENGINE.get() else { return };
    let state = match (account::active_key(), account::active_profile_dir()) {
        (Some(_), Some(dir)) => sync_core::load_state(&dir),
        _ => State::default(),
    };
    let mut status = lock(&engine.status);
    *status = Status { state: "idle", ..Default::default() };
    status.summarize(&state);
}

struct Engine {
    app: AppHandle,
    log: SyncLog,
    device_id: String,
    device_name: String,
    tx: Mutex<Sender<Msg>>,
    /// Held for a whole cycle, a profile switch, or a conflict being resolved.
    cycle: Mutex<()>,
    /// The active profile's state and scan cache, kept between cycles.
    loaded: Mutex<Option<(String, State, ScanCache)>>,
    status: Mutex<Status>,
    hold: Mutex<Option<(u64, Sender<()>)>>,
    hold_seq: AtomicU64,
    online: AtomicBool,
    last_cycle: Mutex<Option<Instant>>,
}

static ENGINE: OnceLock<Engine> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// This computer's id in the records it writes: random, kept in the app data folder.
fn device_id(data_dir: &Path) -> String {
    let path = data_dir.join("device-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return id;
        }
    }
    let id = sync_core::random_id("d");
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(&path, &id);
    id
}

pub fn install(app: &AppHandle, data_dir: &Path, local_dir: &Path) {
    let (tx, rx) = channel();
    let _ = std::fs::create_dir_all(local_dir);
    let engine = Engine {
        app: app.clone(),
        log: SyncLog::open(local_dir),
        device_id: device_id(data_dir),
        device_name: account::computer_name(),
        tx: Mutex::new(tx),
        cycle: Mutex::new(()),
        loaded: Mutex::new(None),
        status: Mutex::new(Status { state: "idle", ..Default::default() }),
        hold: Mutex::new(None),
        hold_seq: AtomicU64::new(0),
        online: AtomicBool::new(true),
        last_cycle: Mutex::new(None),
    };
    if ENGINE.set(engine).is_ok() {
        load_summary();
        std::thread::spawn(move || run(rx));
    }
}

/// Add a line to the sync log and tell the open log window.
pub fn log(kind: &str, text: &str) {
    let Some(engine) = ENGINE.get() else { return };
    let entry = engine.log.push(now_ms(), kind, text);
    let _ = engine.app.emit("sync-log", entry);
}

fn send(msg: Msg) {
    if let Some(engine) = ENGINE.get() {
        let _ = lock(&engine.tx).send(msg);
    }
}

/// Something changed here: sync after a few quiet seconds.
pub fn local_changed() {
    send(Msg::Changed);
}

/// Sync now.
pub fn kick() {
    send(Msg::Now);
}

/// Another profile is in use: forget the last one's state, and sync the new one.
pub fn profile_changed() {
    if let Some(engine) = ENGINE.get() {
        *lock(&engine.loaded) = None;
        load_summary();
        announce();
    }
    kick();
}

/// Run `f` with no cycle in progress (a profile switch).
pub fn paused<T>(f: impl FnOnce() -> T) -> T {
    match ENGINE.get() {
        Some(engine) => {
            let _cycle = lock(&engine.cycle);
            f()
        }
        None => f(),
    }
}

fn run(rx: Receiver<Msg>) {
    // The first cycle waits for the Log window to load (it must answer `sync:hold`).
    let mut wait = Duration::from_secs(8);
    loop {
        match rx.recv_timeout(wait) {
            Ok(Msg::Changed) => {
                // Wait for the edits to settle.
                let started = Instant::now();
                loop {
                    let left = DEBOUNCE_MAX.saturating_sub(started.elapsed());
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(DEBOUNCE.min(left)) {
                        Ok(Msg::Changed) => continue,
                        Ok(Msg::Now) | Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            }
            Ok(Msg::Now) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        // Several requests that arrived meanwhile are one cycle.
        while rx.try_recv().is_ok() {}
        wait = cycle();
    }
}

// ---------------------------------------------------------------- the server

struct Http {
    base: String,
    token: String,
    client: reqwest::blocking::Client,
}

/// The prefix that marks a failure to reach the server at all (offline).
const OFFLINE: &str = "offline: ";

impl Http {
    fn new(base: &str, token: &str) -> Result<Self, String> {
        Ok(Self { base: base.to_string(), token: token.to_string(), client: account::client(Duration::from_secs(60))? })
    }

    fn send(&self, request: reqwest::blocking::RequestBuilder) -> Result<reqwest::blocking::Response, String> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .map_err(|_| format!("{OFFLINE}Kimochi cloud could not be reached"))?;
        if !response.status().is_success() {
            return Err(account::failure(cloud::Feature::Sync, &self.base, response));
        }
        Ok(response)
    }

    fn json<T: serde::de::DeserializeOwned>(&self, request: reqwest::blocking::RequestBuilder) -> Result<T, String> {
        self.send(request)?
            .json::<T>()
            .map_err(|_| "native: Kimochi cloud sent an unreadable sync answer".to_string())
    }
}

impl Remote for Http {
    fn status(&self) -> Result<sync_core::Status, String> {
        self.json(self.client.get(format!("{}/api/v1/sync/status", self.base)))
    }
    fn changes(&self, since: u64, limit: u32) -> Result<sync_core::ChangesPage, String> {
        self.json(self.client.get(format!("{}/api/v1/sync/changes?since={since}&limit={limit}", self.base)))
    }
    fn push(&self, device_id: &str, records: &[sync_core::PushRecord]) -> Result<sync_core::PushResult, String> {
        self.json(
            self.client
                .post(format!("{}/api/v1/sync/push", self.base))
                .json(&json!({ "deviceId": device_id, "records": records })),
        )
    }
    fn blobs_missing(&self, hashes: &[String]) -> Result<Vec<String>, String> {
        let answer: Value = self.json(
            self.client
                .post(format!("{}/api/v1/sync/blobs/missing", self.base))
                .json(&json!({ "hashes": hashes })),
        )?;
        Ok(answer["missing"].as_array().into_iter().flatten().filter_map(|h| h.as_str().map(str::to_string)).collect())
    }
    fn blob_put(&self, sha: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String> {
        self.send(
            self.client
                .put(format!("{}/api/v1/sync/blobs/{sha}", self.base))
                .header("Content-Type", content_type)
                .body(bytes),
        )
        .map(|_| ())
    }
    fn blob_get(&self, sha: &str) -> Result<Vec<u8>, String> {
        self.send(self.client.get(format!("{}/api/v1/sync/blobs/{sha}", self.base)))?
            .bytes()
            .map(|b| b.to_vec())
            .map_err(|_| format!("{OFFLINE}an image did not download"))
    }
}

// ---------------------------------------------------------------- the Log window and settings

/// The Log window (the `log` label hosts the session files, `frontend/texthooker/host.ts`).
struct WindowHost {
    app: AppHandle,
    id: Mutex<Option<u64>>,
}

impl Host for WindowHost {
    fn hold(&self) -> Result<(), String> {
        let Some(engine) = ENGINE.get() else { return Ok(()) };
        if self.app.get_webview_window(panels::MAIN).is_none() {
            return Ok(()); // nothing else writes the files
        }
        let id = engine.hold_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = channel();
        *lock(&engine.hold) = Some((id, tx));
        let _ = self.app.emit_to(panels::MAIN, "sync:hold", json!({ "id": id }));
        let answered = rx.recv_timeout(HOLD_TIMEOUT).is_ok();
        *lock(&engine.hold) = None;
        if !answered {
            return Err("busy: the Log window did not answer; Sync tries again shortly".into());
        }
        *lock(&self.id) = Some(id);
        Ok(())
    }

    fn release(&self, changed: &Changed) {
        let id = lock(&self.id).take();
        if let Some(id) = id {
            let _ = self.app.emit_to(panels::MAIN, "sync:release", json!({ "id": id, "changed": changed }));
        }
    }
}

/// Wait for the Log to write what it has pending, then let it go on (before a profile switch).
pub fn flush_host() {
    let Some(engine) = ENGINE.get() else { return };
    let host = WindowHost { app: engine.app.clone(), id: Mutex::new(None) };
    if host.hold().is_ok() {
        host.release(&Changed::default());
    }
}

/// The profile in use's preferences: the live settings.
struct LivePrefs {
    app: AppHandle,
}

impl Prefs for LivePrefs {
    fn document(&self) -> Value {
        self.app.try_state::<Shared>().map(|s| s.settings.all()).unwrap_or(Value::Null)
    }

    fn apply(&mut self, changes: &[(Vec<String>, Option<Value>)]) -> Result<(), String> {
        let service = self.app.try_state::<Shared>().ok_or("native: Kimochi is still starting")?;
        let store = &service.settings;
        let allowed: Vec<&(Vec<String>, Option<Value>)> = changes
            .iter()
            .filter(|(path, _)| {
                !path.is_empty()
                    && !profile::is_machine_key(&path[0])
                    && !profile::PROFILE_LOCAL_KEYS.contains(&path[0].as_str())
                    && path.iter().all(|p| !p.is_empty() && !profile::is_private(p))
            })
            .collect();
        if allowed.is_empty() {
            return Ok(());
        }
        let paths: Vec<Vec<&str>> = allowed.iter().map(|(p, _)| p.iter().map(String::as_str).collect()).collect();
        let updates: Vec<(&[&str], Value)> = paths
            .iter()
            .zip(&allowed)
            .map(|(p, (_, v))| (p.as_slice(), v.clone().unwrap_or(Value::Null)))
            .collect();
        store.set_many(&updates)?;
        let mut tops: Vec<&str> = paths.iter().map(|p| p[0]).collect();
        tops.sort();
        tops.dedup();
        for top in tops {
            let value = store.get_path(&[top]).ok().flatten().unwrap_or(Value::Null);
            let _ = self.app.emit("settings:changed", json!({ "key": top, "value": value }));
            crate::setting_side_effects(&self.app, store, top, &value);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- a cycle

fn set_status(edit: impl FnOnce(&mut Status)) {
    if let Some(engine) = ENGINE.get() {
        edit(&mut lock(&engine.status));
        announce();
    }
}

fn announce() {
    if let Some(engine) = ENGINE.get() {
        let _ = engine.app.emit("sync-status", status_value());
    }
}

fn clean(error: &str) -> String {
    ["native: ", "offline: ", "busy: ", "invalid: "]
        .iter()
        .fold(error.to_string(), |e, prefix| e.trim_start_matches(prefix).to_string())
}

/// One cycle of the active account; returns how long to wait before the next poll.
fn cycle() -> Duration {
    let Some(engine) = ENGINE.get() else { return POLL };
    let _cycle = lock(&engine.cycle);
    *lock(&engine.last_cycle) = Some(Instant::now());
    let Some(target) = account::sync_target() else {
        // Signed in without Kimochi Cloud is off, like no account; only a lost sign-in asks for one.
        let state = if account::active_key().is_some() && !account::signed_in() { "signed-out" } else { "off" };
        let mut status = lock(&engine.status);
        if status.state != state {
            status.state = state;
            drop(status);
            announce();
        }
        return POLL;
    };
    set_status(|s| s.state = "syncing");
    let result = run_cycle(engine, &target);
    match result {
        Ok(()) => {
            if !engine.online.swap(true, Ordering::SeqCst) {
                log("net", "Back online");
            }
            set_status(|s| {
                s.state = "idle";
                s.last_error = None;
            });
            POLL
        }
        Err(e) if e.starts_with(OFFLINE) => {
            if engine.online.swap(false, Ordering::SeqCst) {
                log("net", "Offline: changes are kept here and sync once Kimochi cloud can be reached");
            }
            set_status(|s| {
                s.state = "offline";
                s.last_error = None;
            });
            POLL
        }
        Err(e) if e.starts_with("busy:") => {
            // The Log window is loading or busy: not an error, try again soon.
            log("info", &clean(&e));
            set_status(|s| s.state = "idle");
            Duration::from_secs(15)
        }
        Err(e) => {
            let message = clean(&e);
            log("error", &message);
            set_status(|s| {
                s.state = "error";
                s.last_error = Some(message);
            });
            POLL
        }
    }
}

fn run_cycle(engine: &Engine, target: &account::SyncTarget) -> Result<(), String> {
    let mut loaded = lock(&engine.loaded);
    if loaded.as_ref().is_none_or(|(key, _, _)| key != &target.key) {
        *loaded = Some((target.key.clone(), sync_core::load_state(&target.dir), ScanCache::default()));
    }
    let (_, state, cache) = loaded.as_mut().expect("just loaded");
    let remote = Http::new(&target.base, &target.token)?;
    let host = WindowHost { app: engine.app.clone(), id: Mutex::new(None) };
    let mut prefs = LivePrefs { app: engine.app.clone() };
    let outcome = sync_profile(engine, &target.dir, &remote, &host, &mut prefs, state, cache);
    if let Err(e) = &outcome {
        if !e.starts_with(OFFLINE) {
            state.last_error = Some(clean(e));
        }
    }
    sync_core::save_state(&target.dir, state)?;
    lock(&engine.status).summarize(state);
    outcome
}

/// One cycle of one profile.
fn sync_profile(
    engine: &Engine,
    dir: &Path,
    remote: &dyn Remote,
    host: &dyn Host,
    prefs: &mut dyn Prefs,
    state: &mut State,
    cache: &mut ScanCache,
) -> Result<(), String> {
    let status = match remote.status() {
        Ok(status) => status,
        Err(e) => {
            // Offline: still note what changed here, and when.
            let doc = prefs.document();
            let local = sync_core::scan(dir, &doc, &engine.device_id, &engine.device_name, cache);
            let log_fn = |kind: &str, text: String| log(kind, &text);
            let now = now_ms;
            let mut ctx = Ctx { dir, device_id: &engine.device_id, device_name: &engine.device_name, remote, host, prefs, cache, state, log: &log_fn, now: &now };
            sync_core::stamp_pending(&mut ctx, &local);
            return Err(e);
        }
    };
    set_status(|s| {
        s.used = Some(status.used);
        s.limit = status.limit;
    });
    if status.seq < state.cursor {
        log("info", "The account's synced data was erased on the server; sending this computer's data again");
        let origin = state.origin.clone();
        *state = State { version: 1, origin, ..Default::default() };
    }
    let log_fn = |kind: &str, text: String| log(kind, &text);
    let now = now_ms;
    let mut ctx = Ctx { dir, device_id: &engine.device_id, device_name: &engine.device_name, remote, host, prefs, cache, state, log: &log_fn, now: &now };
    let report = sync_core::sync_once(&mut ctx)?;
    if report.pulled + report.pushed + report.conflicts > 0 {
        log(
            "info",
            &format!(
                "Synced: {} change(s) received, {} applied here, {} sent{}",
                report.pulled,
                report.applied,
                report.pushed,
                if report.conflicts > 0 { format!(", {} conflict(s) kept", report.conflicts) } else { String::new() }
            ),
        );
    }
    Ok(())
}

/// Fill a profile not yet in use from the server (the first sign-in to an account that already
/// has data). The caller holds the cycle lock (a profile switch).
pub fn initial_sync(key: &str, base: &str, token: &str, dir: &Path) -> Result<(), String> {
    let engine = ENGINE.get().ok_or("native: Sync is not ready")?;
    let remote = Http::new(base, token)?;
    let mut prefs = sync_core::FilePrefs::open(dir.join(profile::SETTINGS_FILE), profile::profile_part(&settings::defaults()));
    let mut state = sync_core::load_state(dir);
    let mut cache = ScanCache::default();
    let result = sync_profile(engine, dir, &remote, &sync_core::NoHost, &mut prefs, &mut state, &mut cache);
    sync_core::save_state(dir, &state)?;
    if result.is_ok() {
        log("profile", &format!("Downloaded {key}'s data"));
    }
    result
}

// ---------------------------------------------------------------- status and commands

fn conflicts_value(dir: &Path) -> Value {
    let conflicts = sync_core::load_conflicts(dir).unwrap_or_default();
    let mut list: Vec<Value> = conflicts
        .into_iter()
        .map(|(id, data)| {
            let mut out = data;
            out["id"] = json!(id);
            out
        })
        .collect();
    list.sort_by(|a, b| b["detectedAt"].as_u64().cmp(&a["detectedAt"].as_u64()));
    Value::Array(list)
}

fn status_value() -> Value {
    let Some(engine) = ENGINE.get() else { return json!({ "state": "off" }) };
    let status = lock(&engine.status).clone();
    let key = account::active_key();
    let dir = account::active_profile_dir();
    // Never the cycle's own locks: this is called from inside a cycle (`set_status`).
    json!({
        "state": if key.is_none() { "off" } else { status.state },
        "account": key,
        "lastSyncAt": status.last_sync_at,
        "pending": status.pending,
        "origin": status.origin,
        "lastError": status.last_error,
        "used": status.used,
        "limit": status.limit,
        "conflicts": match (&key, &dir) { (Some(_), Some(dir)) => conflicts_value(dir), _ => json!([]) },
        "deviceId": engine.device_id,
    })
}

#[tauri::command]
pub fn sync_status() -> Value {
    status_value()
}

#[tauri::command]
pub fn sync_now() -> Value {
    kick();
    status_value()
}

#[tauri::command]
pub fn sync_log() -> Vec<LogEntry> {
    ENGINE.get().map(|e| e.log.entries()).unwrap_or_default()
}

#[tauri::command]
pub fn sync_log_clear() {
    if let Some(engine) = ENGINE.get() {
        engine.log.clear();
        let _ = engine.app.emit("sync-log-cleared", json!({}));
    }
}

/// The Log has flushed and paused its writes for `sync:hold` `id`.
#[tauri::command]
pub fn sync_hold_ready(id: u64) {
    let Some(engine) = ENGINE.get() else { return };
    let hold = lock(&engine.hold);
    if let Some((current, tx)) = hold.as_ref() {
        if *current == id {
            let _ = tx.send(());
        }
    }
}

/// The Log wrote its files (`reason: 'write'`) or a window came forward (`'focus'`).
#[tauri::command]
pub fn sync_local_changed(reason: Option<String>) {
    if reason.as_deref() == Some("focus") {
        let stale = ENGINE
            .get()
            .and_then(|e| *lock(&e.last_cycle))
            .is_none_or(|at| at.elapsed() > Duration::from_secs(15));
        if stale {
            kick();
        }
    } else {
        local_changed();
    }
}

/// Restore a conflict's kept version (`restore`) or drop it (`dismiss`).
#[tauri::command]
pub async fn sync_conflict_resolve(id: String, action: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let engine = ENGINE.get().ok_or("native: Sync is not ready")?;
        let dir = account::active_profile_dir().filter(|_| account::active_key().is_some()).ok_or("invalid: no account is in use")?;
        let _cycle = lock(&engine.cycle);
        match action.as_str() {
            "restore" => {
                let state = sync_core::load_state(&dir);
                let host = WindowHost { app: engine.app.clone(), id: Mutex::new(None) };
                let mut prefs = LivePrefs { app: engine.app.clone() };
                let what = sync_core::restore_conflict(&dir, &mut prefs, &host, &state, &id, now_ms())?;
                log("merge", &format!("Restored the kept version of {what}"));
            }
            "dismiss" => {
                let mut conflicts = sync_core::load_conflicts(&dir).ok_or("native: the conflicts file is unreadable")?;
                if conflicts.remove(&id).is_some() {
                    profile::write_json(&sync_core::conflicts_path(&dir), &serde_json::to_value(conflicts).map_err(|e| e.to_string())?)?;
                    log("merge", &format!("Dismissed conflict {id}"));
                }
            }
            _ => return Err(format!("invalid: unknown action {action:?} (restore or dismiss)")),
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    *lock(&ENGINE.get().ok_or("native: Sync is not ready")?.loaded) = None;
    kick();
    announce();
    Ok(status_value())
}

/// Save everything the account holds on the server (`GET /api/v1/sync/export`, a ZIP) to `path`.
#[tauri::command]
pub async fn sync_export(path: String) -> Result<u64, String> {
    let target = account::sync_target().ok_or("invalid: sign in to export your synced data")?;
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let client = account::client(Duration::from_secs(600))?;
        let mut response = client
            .get(format!("{}/api/v1/sync/export", target.base))
            .bearer_auth(&target.token)
            .send()
            .map_err(|_| account::OFFLINE.to_string())?;
        if !response.status().is_success() {
            return Err(account::failure(cloud::Feature::Sync, &target.base, response));
        }
        let tmp = path.with_extension("part");
        let mut file = std::fs::File::create(&tmp).map_err(|e| format!("native: could not write {}: {e}", tmp.display()))?;
        let written = response.copy_to(&mut file).map_err(|_| account::OFFLINE.to_string())?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        log("info", &format!("Exported the account's synced data to {} ({written} bytes)", path.display()));
        Ok(written)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_core::tests::Device;

    /// Two computers and an account switch against a real server: run with
    /// `KIMOCHI_E2E_BASE=http://localhost:3000 KIMOCHI_E2E_TOKEN_A=kmc_… KIMOCHI_E2E_TOKEN_B=kmc_…
    /// [KIMOCHI_E2E_TOKEN_OTHER=kmc_…] cargo test e2e -- --ignored` (`scripts/sync-e2e.mjs` signs in
    /// and runs it). Tokens A and B belong to the same account, on two linked "computers".
    #[test]
    #[ignore]
    fn e2e_two_computers_against_a_server() {
        let base = std::env::var("KIMOCHI_E2E_BASE").expect("KIMOCHI_E2E_BASE");
        let server_a = Http::new(&base, &std::env::var("KIMOCHI_E2E_TOKEN_A").expect("token A")).unwrap();
        let server_b = Http::new(&base, &std::env::var("KIMOCHI_E2E_TOKEN_B").expect("token B")).unwrap();
        let tag = format!("e2e{}", now_ms());
        let mut a = Device::new(&format!("A{tag}"), "e2e");
        let mut b = Device::new(&format!("B{tag}"), "e2e");
        let sid = format!("s{tag}");
        let line = |id: u64, uid: &str, text: &str, ts: u64| json!({ "id": id, "uid": format!("{uid}{tag}"), "text": text, "source": "ocr", "ts": ts });

        // Union: each computer's lines reach the other.
        a.session(&sid, "E2E", json!([line(1, "a", "一", 10)]));
        a.sync(&server_a);
        b.sync(&server_b);
        let mut lines = b.lines(&sid);
        lines.push(line(2, "b", "二", 20));
        b.write(&format!("sessions/{sid}/lines.json"), json!({ "version": 1, "lines": lines }));
        b.cache = ScanCache::default();
        b.sync(&server_b);
        a.cache = ScanCache::default();
        a.sync(&server_a);
        assert_eq!(a.texts(&sid), ["一", "二"]);
        println!("union ok");

        // Conflict: both rename the session; the later wins, the other is kept.
        for (device, name) in [(&mut a, "A's name"), (&mut b, "B's name")] {
            let mut manifest = device.read("sessions.json");
            for s in manifest["sessions"].as_array_mut().unwrap() {
                if s["id"] == json!(sid) {
                    s["name"] = json!(name);
                }
            }
            device.write("sessions.json", manifest);
            device.cache = ScanCache::default();
        }
        a.sync(&server_a);
        b.clock.set(a.clock.get() + 60_000);
        b.sync(&server_b);
        a.cache = ScanCache::default();
        a.sync(&server_a);
        let name = |d: &Device| d.read("sessions.json")["sessions"].as_array().unwrap().iter().find(|s| s["id"] == json!(sid)).unwrap()["name"].clone();
        assert_eq!(name(&a), "B's name");
        assert_eq!(name(&b), "B's name");
        assert!(a.conflicts().values().any(|c| c["data"]["name"] == "A's name"));
        println!("conflict ok");

        // Tombstone: A deletes a line; B loses it.
        let uid = format!("a{tag}");
        let kept: Vec<Value> = a.lines(&sid).into_iter().filter(|l| l["uid"] != json!(uid)).collect();
        a.write(&format!("sessions/{sid}/lines.json"), json!({ "version": 1, "lines": kept, "deleted": [{ "uid": uid }] }));
        a.cache = ScanCache::default();
        a.sync(&server_a);
        b.cache = ScanCache::default();
        b.sync(&server_b);
        assert_eq!(b.texts(&sid), ["二"]);
        println!("tombstone ok");

        // Another account sees none of it.
        if let Ok(other) = std::env::var("KIMOCHI_E2E_TOKEN_OTHER") {
            let server_c = Http::new(&base, &other).unwrap();
            let mut c = Device::new(&format!("C{tag}"), "e2e");
            c.sync(&server_c);
            assert!(c.read("sessions.json")["sessions"].as_array().is_none_or(|s| s.iter().all(|s| s["id"] != json!(sid))));
            println!("isolation ok");
        }
    }
}
