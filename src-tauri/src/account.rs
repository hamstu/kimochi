//! Optional Kimochi accounts: the accounts this computer has signed in to, which one is in use,
//! and switching between them (each has its own profile, `profile.rs`).
//!
//! **Accounts.** `accounts.json` in the app data folder lists every account signed in to here
//! (its server, user id, the cached user and usage, never a token) and which one is active.
//! Each account's token (`kmc_…`) lives alone in `accounts/<key>.json` (mode 600 on Unix) and is
//! sent only as `Authorization: Bearer` to that account's server. Several accounts can be signed
//! in at once, on Kimochi cloud and (in a development build) a local server; one is active. Like
//! the owner's access key in `cloud.rs`, a token never reaches a webview, a log or a diagnostic.
//!
//! **Profiles.** Signed out, Kimochi uses the Local profile (the data folder every earlier version
//! used). Each account has a profile of its own: switching swaps the Log, the notebook, presets,
//! stats and preferences, flushing the Log's pending writes first and reloading the windows that
//! show them. Nothing is merged across accounts. An account's profile is made the first time it
//! is used here: a copy of the Local profile when the account has nothing synced yet (so a new
//! sign-up keeps its work), otherwise filled from the server.
//!
//! Signing out of an account forgets its token and returns to the Local profile; its profile
//! stays on disk until "Remove from this computer".
//!
//! Linking is the server's device flow (`/api/v1/link/start`, then `/api/v1/link/poll` every
//! `interval` seconds on a thread of its own) with the confirmation page opened in the browser.
//! The `kimochi://account` URL the website's "Open Kimochi" button carries is handled here too.
use crate::{cloud, panels, platform, profile, settings, state::Shared, sync, sync_core};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const INDEX: &str = "accounts.json";
const TOKENS: &str = "accounts";
/// Files of the single sign-in per server that earlier versions kept; imported once.
const LEGACY: &[(&str, &str)] = &[("account.json", "cloud"), ("account-local.json", "local")];
const USER_AGENT: &str = "Kimochi/0.1";

/// One account signed in to on this computer (or signed out of, keeping its profile).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    /// `cloud` or `local`: which built-in server.
    pub mode: String,
    pub user_id: String,
    #[serde(default)]
    pub user: Value,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub last_used_at: u64,
}

impl Entry {
    pub fn base(&self) -> &'static str {
        settings::base_for_mode(&self.mode)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default)]
    version: u32,
    /// The active account's key; `None` is the Local profile.
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    accounts: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct TokenFile {
    token: String,
}

struct Link {
    seq: u64,
    code: String,
    verify_url: String,
    expires_at_ms: u64,
}

struct Account {
    app: AppHandle,
    /// The folder of `settings.json`, where `accounts.json` and the token files live.
    data_dir: PathBuf,
    /// The local data folder: the Local profile, and `profiles/` beneath it.
    local_dir: PathBuf,
    index: Mutex<Index>,
    link: Mutex<Option<Link>>,
    /// Bumped by every start and cancel; a poll thread stops once it is no longer current.
    link_seq: AtomicU64,
    usage_pending: AtomicBool,
    /// A switch in progress (the panels show it, and a second one waits).
    switching: Mutex<()>,
    switching_flag: AtomicBool,
}

static ACCOUNT: OnceLock<Account> = OnceLock::new();

fn account() -> Result<&'static Account, String> {
    ACCOUNT.get().ok_or_else(|| "native: accounts are not ready yet".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn token_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join(TOKENS).join(format!("{key}.json"))
}

fn read_token(data_dir: &Path, key: &str) -> Option<String> {
    let bytes = std::fs::read(token_path(data_dir, key)).ok()?;
    serde_json::from_slice::<TokenFile>(&bytes).ok().map(|t| t.token).filter(|t| !t.is_empty())
}

/// Write a private file (mode 600 on Unix) through a temp file; `None` removes it.
fn write_private(file: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    let Some(bytes) = bytes else {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options.open(&tmp).map_err(|e| e.to_string())?;
        out.write_all(bytes).map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

fn save_token(data_dir: &Path, key: &str, token: Option<&str>) -> Result<(), String> {
    let bytes = token
        .map(|t| serde_json::to_vec(&TokenFile { token: t.to_string() }))
        .transpose()
        .map_err(|e| e.to_string())?;
    write_private(&token_path(data_dir, key), bytes.as_deref())
}

fn load_index(data_dir: &Path) -> Option<Index> {
    profile::read_json(&data_dir.join(INDEX)).and_then(|v| serde_json::from_value(v).ok())
}

fn save_index(data_dir: &Path, index: &Index) -> Result<(), String> {
    write_private(&data_dir.join(INDEX), Some(&serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?))
}

fn mode_of(base: &str) -> &'static str {
    if base == settings::LOCAL_SERVER {
        "local"
    } else {
        "cloud"
    }
}

/// Import the one-sign-in-per-server files of earlier versions. The account that was in use
/// becomes active, and its profile starts as a copy of the Local profile: that is the data it was
/// signed in with. Returns the log lines to record.
fn migrate_legacy(data_dir: &Path, local_dir: &Path, current_mode: &str) -> (Index, Vec<String>) {
    let mut index = Index { version: 1, ..Default::default() };
    let mut notes = Vec::new();
    for (file, mode) in LEGACY {
        let path = data_dir.join(file);
        let Some(stored) = profile::read_json(&path) else { continue };
        let token = stored["token"].as_str().unwrap_or("").to_string();
        let user = stored.get("user").cloned().unwrap_or(Value::Null);
        let Some(user_id) = user["id"].as_str().map(str::to_string) else { continue };
        if token.is_empty() {
            continue;
        }
        let key = profile::profile_key(mode, &user_id);
        if save_token(data_dir, &key, Some(&token)).is_err() {
            continue;
        }
        index.accounts.push(Entry {
            key: key.clone(),
            mode: (*mode).to_string(),
            user_id,
            user,
            usage: stored.get("usage").cloned().filter(|u| !u.is_null()),
            added_at: now_ms(),
            last_used_at: now_ms(),
        });
        if *mode == current_mode {
            let dir = profile::profile_dir(local_dir, Some(&key));
            if !dir.exists() {
                match profile::copy_profile_data(local_dir, &dir) {
                    Ok(copied) => {
                        let mut state = sync_core::State { origin: Some("copied-local".into()), ..Default::default() };
                        state.version = 1;
                        let _ = sync_core::save_state(&dir, &state);
                        notes.push(format!(
                            "Kept your Log with the account you were signed in to: copied the Local profile ({copied} files) into {key}"
                        ));
                    }
                    Err(e) => notes.push(format!("Could not copy the Local profile into {key}: {e}")),
                }
            }
            index.active = Some(key);
        }
    }
    (index, notes)
}

/// Load the accounts, choose the profile, and start Sync. Called once from `setup`, after the
/// shared service is managed and before any webview asks for its profile.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let local_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let mut notes = Vec::new();
    let index = match load_index(&data_dir) {
        Some(index) => index,
        None => {
            let mode = app
                .try_state::<Shared>()
                .map(|s| settings::server_mode(&s.settings))
                .unwrap_or("cloud");
            let (index, migrated) = migrate_legacy(&data_dir, &local_dir, mode);
            notes = migrated;
            if save_index(&data_dir, &index).is_ok() {
                for (file, _) in LEGACY {
                    let _ = std::fs::remove_file(data_dir.join(file));
                }
            }
            index
        }
    };
    let active = index.active.clone();
    let _ = ACCOUNT.set(Account {
        app: app.clone(),
        data_dir: data_dir.clone(),
        local_dir: local_dir.clone(),
        index: Mutex::new(index),
        link: Mutex::new(None),
        link_seq: AtomicU64::new(0),
        usage_pending: AtomicBool::new(false),
        switching: Mutex::new(()),
        switching_flag: AtomicBool::new(false),
    });
    sync::install(app, &data_dir, &local_dir);
    for note in notes {
        sync::log("profile", &note);
    }
    // The active account's server is the server in use.
    if let Some(entry) = active.as_deref().and_then(entry_for) {
        follow_server(&entry);
    }
    // The cached user and usage can be a month old: refresh them quietly once the app is up, and
    // again every so often, so a plan bought, cancelled or ended on the website shows (or hides
    // Kimochi Cloud) without a restart.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            if signed_in() {
                let _ = refresh_blocking();
            }
            std::thread::sleep(PLAN_REFRESH);
        }
    });
    Ok(())
}

fn entry_for(key: &str) -> Option<Entry> {
    let account = ACCOUNT.get()?;
    lock(&account.index).accounts.iter().find(|e| e.key == key).cloned()
}

/// The account in use, if any (signed in or not).
pub fn active_entry() -> Option<Entry> {
    let account = ACCOUNT.get()?;
    let key = lock(&account.index).active.clone()?;
    entry_for(&key)
}

/// The active profile's key (`None`: the Local profile).
pub fn active_key() -> Option<String> {
    ACCOUNT.get().and_then(|a| lock(&a.index).active.clone())
}

/// The folder of the profile in use.
pub fn active_profile_dir() -> Option<PathBuf> {
    let account = ACCOUNT.get()?;
    Some(profile::profile_dir(&account.local_dir, active_key().as_deref()))
}

fn token_of(key: &str) -> Option<String> {
    read_token(&account().ok()?.data_dir, key)
}

/// The account token for the server in use, if the active account is signed in there. Only for
/// request headers.
pub fn token() -> Option<String> {
    let entry = active_entry()?;
    if entry.base() != base().ok()? {
        return None;
    }
    token_of(&entry.key)
}

pub fn signed_in() -> bool {
    token().is_some()
}

/// Whether a cached user has Kimochi Cloud: the server's `cloud` flag, or for a user cached
/// before it existed, a plan that includes it.
pub fn user_has_cloud(user: &Value) -> bool {
    match user.get("cloud").and_then(Value::as_bool) {
        Some(cloud) => cloud,
        None => matches!(user.get("plan").and_then(Value::as_str), Some("trial" | "cloud" | "owner" | "plus")),
    }
}

/// Signed in to an account with Kimochi Cloud (trial, paid, lifetime or granted). Without it the
/// metered services are hidden and Sync does not run; the server refuses both anyway.
pub fn has_cloud() -> bool {
    signed_in() && active_entry().is_some_and(|e| user_has_cloud(&e.user))
}

/// What Sync needs of the active account: its profile, server and token.
pub struct SyncTarget {
    pub key: String,
    pub base: String,
    pub token: String,
    pub dir: PathBuf,
}

pub fn sync_target() -> Option<SyncTarget> {
    let entry = active_entry()?;
    let token = token()?;
    if !user_has_cloud(&entry.user) {
        return None;
    }
    Some(SyncTarget {
        dir: profile::profile_dir(&account().ok()?.local_dir, Some(&entry.key)),
        base: entry.base().to_string(),
        key: entry.key,
        token,
    })
}

fn server_value(mode: &str) -> Value {
    json!({ "mode": mode, "url": settings::base_for_mode(mode), "forced": settings::server_mode_override().is_some() })
}

/// What the webviews may know: never a token.
fn status_value() -> Value {
    let Some(account) = ACCOUNT.get() else {
        return json!({ "signedIn": false, "accounts": [] });
    };
    let index = lock(&account.index).clone();
    let current_mode = account
        .app
        .try_state::<Shared>()
        .map(|s| settings::server_mode(&s.settings))
        .unwrap_or("cloud");
    let link_mode = link_mode();
    let linking = lock(&account.link).as_ref().map(|link| {
        json!({ "code": link.code, "verifyUrl": link.verify_url, "expiresAt": link.expires_at_ms })
    });
    let active = index.active.as_deref().and_then(|k| index.accounts.iter().find(|e| e.key == k));
    let mut accounts: Vec<&Entry> = index.accounts.iter().collect();
    accounts.sort_by_key(|e| std::cmp::Reverse(e.last_used_at));
    let accounts: Vec<Value> = accounts
        .into_iter()
        .map(|e| {
            json!({
                "key": e.key,
                "user": e.user,
                "server": server_value(&e.mode),
                "signedIn": read_token(&account.data_dir, &e.key).is_some(),
                "active": Some(&e.key) == index.active.as_ref(),
                // A forced server (KIMOCHI_SERVER) rules out the other server's accounts.
                "available": settings::server_mode_override().is_none_or(|m| m == e.mode),
            })
        })
        .collect();
    let signed_in = active.is_some_and(|e| read_token(&account.data_dir, &e.key).is_some());
    json!({
        "signedIn": signed_in,
        // Kimochi Cloud (a trial, a plan, lifetime or a grant): what shows its features.
        "cloud": signed_in && active.is_some_and(|e| user_has_cloud(&e.user)),
        "user": active.map(|e| e.user.clone()),
        "usage": active.and_then(|e| e.usage.clone()),
        "linking": linking,
        "server": server_value(active.map(|e| e.mode.as_str()).unwrap_or(current_mode)),
        "linkServer": server_value(link_mode),
        "accounts": accounts,
        "profile": {
            "key": index.active,
            "root": profile::profile_root(index.active.as_deref()),
            "needsSignIn": active.is_some() && !signed_in,
        },
        "switching": account.switching_flag.load(Ordering::SeqCst),
    })
}

fn announce() {
    let Some(account) = ACCOUNT.get() else { return };
    let _ = account.app.emit("account-changed", status_value());
}

/// Signing in or out changes what Kimochi cloud offers: tell every window again.
fn announce_capabilities() {
    let Some(account) = ACCOUNT.get() else { return };
    if let Some(service) = account.app.try_state::<Shared>() {
        crate::spawn_capabilities_watch(account.app.clone(), service.inner().clone());
    }
}

fn base() -> Result<String, String> {
    let account = account()?;
    let service = account
        .app
        .try_state::<Shared>()
        .ok_or("native: Kimochi is still starting")?;
    Ok(settings::server_base(&service.settings))
}

/// The server a new sign-in links against: `accountLinkServer` (the development build's picker),
/// else the server in use. `KIMOCHI_SERVER` overrides both.
fn link_mode() -> &'static str {
    if let Some(forced) = settings::server_mode_override() {
        return forced;
    }
    let Some(service) = ACCOUNT.get().and_then(|a| a.app.try_state::<Shared>()) else { return "cloud" };
    match service.settings.get_or::<String>("accountLinkServer", String::new()).as_str() {
        "local" if cfg!(debug_assertions) => "local",
        "cloud" => "cloud",
        _ => settings::server_mode(&service.settings),
    }
}

pub fn client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .build()
        .map_err(|_| "native: could not initialize the account HTTP client".to_string())
}

pub const OFFLINE: &str = "native: Kimochi cloud could not be reached (connection/TLS/timeout). Check your internet connection and try again.";

/// A failed answer from `base` as a sentence, forgetting the token when it is no longer accepted.
pub fn failure(feature: cloud::Feature, base: &str, response: reqwest::blocking::Response) -> String {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    if status == 401 {
        signed_out_remotely_from(base);
    }
    if is_plan_required(status, &body) {
        plan_required();
    }
    format!("native: {}", cloud::describe_failure(feature, status, &body, true))
}

/// The server answered 401 to the account token: it was revoked (on the website, by a password
/// reset) or expired. Forget it here; the account stays active and asks to be signed in again.
pub fn signed_out_remotely() {
    if let Ok(base) = base() {
        signed_out_remotely_from(&base);
    }
}

fn signed_out_remotely_from(base: &str) {
    let Some(entry) = active_entry().filter(|e| e.base() == base) else { return };
    let Ok(account) = account() else { return };
    if read_token(&account.data_dir, &entry.key).is_none() {
        return;
    }
    let _ = save_token(&account.data_dir, &entry.key, None);
    sync::log("error", "The server no longer accepts this computer's sign-in; sign in again to keep syncing");
    announce();
    announce_capabilities();
}

fn update_entry(key: &str, edit: impl FnOnce(&mut Entry)) -> Result<(), String> {
    let account = account()?;
    let mut index = lock(&account.index);
    if let Some(entry) = index.accounts.iter_mut().find(|e| e.key == key) {
        edit(entry);
    }
    save_index(&account.data_dir, &index)
}

/// How often a signed-in account's user (and so its plan) is re-read.
const PLAN_REFRESH: Duration = Duration::from_secs(30 * 60);

/// The server refused a request for want of Kimochi Cloud (`plan_required`): the cached plan is
/// out of date, so re-read it now; the features hide once it arrives.
pub fn plan_required() {
    let Some(account) = ACCOUNT.get() else { return };
    if token().is_none() || account.usage_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let _ = refresh_blocking();
        if let Some(account) = ACCOUNT.get() {
            account.usage_pending.store(false, Ordering::SeqCst);
        }
    });
}

/// Whether a failed answer is the server's `plan_required`.
pub fn is_plan_required(status: u16, body: &str) -> bool {
    status == 403 && body.contains("\"plan_required\"")
}

/// Refresh the cached usage a moment after a metered call, at most one at a time.
pub fn usage_changed() {
    let Some(account) = ACCOUNT.get() else { return };
    if token().is_none() || account.usage_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(2));
        if let Some(account) = ACCOUNT.get() {
            account.usage_pending.store(false, Ordering::SeqCst);
        }
        let _ = refresh_usage();
    });
}

fn get_json(base: &str, token: &str, path: &str) -> Result<Value, String> {
    let http = client(Duration::from_secs(15))?;
    let response = http
        .get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    if !response.status().is_success() {
        return Err(failure(cloud::Feature::Account, base, response));
    }
    response.json().map_err(|_| "native: Kimochi cloud sent an unreadable answer".to_string())
}

fn refresh_usage() -> Result<(), String> {
    let entry = active_entry().ok_or("native: not signed in")?;
    let token = token().ok_or("native: not signed in")?;
    let usage = get_json(entry.base(), &token, "/api/v1/usage")?;
    update_entry(&entry.key, |e| e.usage = Some(usage))?;
    announce();
    Ok(())
}

fn refresh_blocking() -> Result<Value, String> {
    let entry = active_entry().ok_or("native: not signed in")?;
    let token = token().ok_or("native: not signed in")?;
    let me = get_json(entry.base(), &token, "/api/v1/me")?;
    let user = me.get("user").cloned().unwrap_or(Value::Null);
    let had_cloud = user_has_cloud(&entry.user);
    let cloud = user_has_cloud(&user);
    update_entry(&entry.key, |e| e.user = user)?;
    if cloud != had_cloud {
        // Kimochi Cloud came or went: the windows show or hide its features, and Sync starts or stops.
        sync::log("account", if cloud { "Kimochi Cloud is on for this account" } else { "Kimochi Cloud is off for this account" });
        announce_capabilities();
        sync::kick();
    }
    if cloud {
        refresh_usage()?;
    } else {
        announce();
    }
    Ok(status_value())
}

// ---------------------------------------------------------------- switching profiles

/// The windows that show a profile's data; they reload after a switch.
const PROFILE_WINDOWS: &[&str] = &[panels::MAIN, "settings", "diagnostics", "tray-popover", "sync-log"];

fn settings_store() -> Result<std::sync::Arc<settings::Settings>, String> {
    let account = account()?;
    Ok(account
        .app
        .try_state::<Shared>()
        .ok_or("native: Kimochi is still starting")?
        .settings
        .clone())
}

/// Put a profile's preferences in place of the current ones, keeping this computer's own keys.
fn load_profile_settings(app: &AppHandle, store: &std::sync::Arc<settings::Settings>, dir: &Path) -> Result<(), String> {
    let saved = profile::read_json(&dir.join(profile::SETTINGS_FILE)).unwrap_or_else(|| json!({}));
    let target = profile::with_defaults(&settings::defaults(), &saved);
    let updates = profile::switch_updates(&store.all(), &target);
    if updates.is_empty() {
        return Ok(());
    }
    let paths: Vec<(Vec<&str>, Value)> = updates.iter().map(|(k, v)| (vec![k.as_str()], v.clone())).collect();
    let refs: Vec<(&[&str], Value)> = paths.iter().map(|(p, v)| (p.as_slice(), v.clone())).collect();
    store.set_many(&refs)?;
    for (key, _) in &updates {
        let value = store.get_path(&[key.as_str()]).ok().flatten().unwrap_or(Value::Null);
        let _ = app.emit("settings:changed", json!({ "key": key, "value": value }));
        crate::setting_side_effects(app, store, key, &value);
    }
    Ok(())
}

/// The server in use follows the active account.
fn follow_server(entry: &Entry) {
    let Ok(store) = settings_store() else { return };
    if settings::server_mode_override().is_some() || settings::server_mode(&store) == entry.mode {
        return;
    }
    if store.set("serverSettings.mode", json!(entry.mode)).is_ok() {
        if let Ok(account) = account() {
            let value = store.get("serverSettings").ok().flatten().unwrap_or(Value::Null);
            let _ = account.app.emit("settings:changed", json!({ "key": "serverSettings", "value": value }));
        }
    }
}

fn server_status(base: &str, token: &str) -> Result<sync_core::Status, String> {
    let value = get_json(base, token, "/api/v1/sync/status")?;
    serde_json::from_value(value).map_err(|_| "native: Kimochi cloud sent an unreadable answer".to_string())
}

/// Make an account's profile the first time it is used here.
fn prepare_profile(account: &Account, entry: &Entry) -> Result<(), String> {
    let dir = profile::profile_dir(&account.local_dir, Some(&entry.key));
    if dir.join(profile::SETTINGS_FILE).exists() || dir.join("sessions.json").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let who = entry.user["email"].as_str().unwrap_or(&entry.user_id).to_string();
    let token = read_token(&account.data_dir, &entry.key);
    let remote = token.as_deref().map(|t| server_status(entry.base(), t));
    let mut state = sync_core::State { version: 1, ..Default::default() };
    match remote {
        Some(Ok(status)) if status.records == 0 => {
            let copied = profile::copy_profile_data(&account.local_dir, &dir)?;
            state.origin = Some("copied-local".into());
            sync::log(
                "profile",
                &format!("First sign-in to {who} here and the account has nothing synced yet: copied this computer's Local profile ({copied} files) into it. The Local profile is unchanged."),
            );
        }
        Some(Ok(status)) => {
            profile::write_json(&dir.join(profile::SETTINGS_FILE), &profile::profile_part(&settings::defaults()))?;
            state.origin = Some("server".into());
            sync::log(
                "profile",
                &format!("First sign-in to {who} here: starting from the account's synced data ({} records) instead of this computer's Local profile", status.records),
            );
            sync_core::save_state(&dir, &state)?;
            if let Err(e) = sync::initial_sync(&entry.key, entry.base(), token.as_deref().unwrap_or(""), &dir) {
                sync::log("error", &format!("Downloading {who}'s data did not finish ({}); it continues in the background", e.trim_start_matches("native: ")));
            }
            return Ok(());
        }
        _ => {
            profile::write_json(&dir.join(profile::SETTINGS_FILE), &profile::profile_part(&settings::defaults()))?;
            state.origin = Some("empty".into());
            sync::log(
                "profile",
                &format!("First sign-in to {who} here, but the server could not be reached to see what the account holds: starting empty; its data arrives once Kimochi is online"),
            );
        }
    }
    sync_core::save_state(&dir, &state)
}

/// Switch to `target` (`None`: the Local profile): flush the Log, keep the current preferences
/// with the current profile, put the target's in place, and reload the windows.
fn activate(target: Option<String>) -> Result<(), String> {
    let account = account()?;
    let _switch = lock(&account.switching);
    let current = lock(&account.index).active.clone();
    if current == target {
        return Ok(());
    }
    let entry = match &target {
        Some(key) => Some(entry_for(key).ok_or("invalid: that account is not on this computer")?),
        None => None,
    };
    if let (Some(forced), Some(entry)) = (settings::server_mode_override(), &entry) {
        if entry.mode != forced {
            return Err(format!("invalid: {}={forced} picks the server for this run; that account is on the other one", settings::SERVER_ENV));
        }
    }
    account.switching_flag.store(true, Ordering::SeqCst);
    announce();
    let result = sync::paused(|| -> Result<(), String> {
        let store = settings_store()?;
        // The Log's pending writes reach the current profile's files first.
        sync::flush_host();
        let from = profile::profile_dir(&account.local_dir, current.as_deref());
        profile::write_json(&from.join(profile::SETTINGS_FILE), &profile::profile_part(&store.all()))?;
        if let Some(entry) = &entry {
            prepare_profile(account, entry)?;
        }
        let to = profile::profile_dir(&account.local_dir, target.as_deref());
        load_profile_settings(&account.app, &store, &to)?;
        {
            let mut index = lock(&account.index);
            index.active = target.clone();
            if let Some(key) = &target {
                if let Some(e) = index.accounts.iter_mut().find(|e| &e.key == key) {
                    e.last_used_at = now_ms();
                }
            }
            save_index(&account.data_dir, &index)?;
        }
        if let Some(entry) = &entry {
            follow_server(entry);
        }
        let name = entry
            .as_ref()
            .map(|e| e.user["email"].as_str().unwrap_or(&e.key).to_string())
            .unwrap_or_else(|| "Local (no account)".into());
        sync::log("profile", &format!("Switched to {name}"));
        Ok(())
    });
    account.switching_flag.store(false, Ordering::SeqCst);
    result?;
    reload_windows(&account.app);
    announce();
    announce_capabilities();
    sync::profile_changed();
    Ok(())
}

fn reload_windows(app: &AppHandle) {
    for label in PROFILE_WINDOWS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.eval("window.location.reload()");
        }
    }
}

/// The profile root the webviews' file paths start with (`""`: the Local profile).
#[tauri::command]
pub fn profile_current() -> Value {
    let key = active_key();
    json!({ "key": key, "root": profile::profile_root(key.as_deref()) })
}

#[tauri::command]
pub async fn account_switch(key: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || activate(key))
        .await
        .map_err(|e| e.to_string())??;
    Ok(status_value())
}

// ---------------------------------------------------------------- linking

fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return name.chars().take(64).collect();
        }
    }
    #[cfg(target_os = "windows")]
    let name = std::env::var("COMPUTERNAME").unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let name = {
        let mut buf = [0u8; 256];
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        if ok {
            String::from_utf8_lossy(&buf[..end]).trim_end_matches(".local").to_string()
        } else {
            String::new()
        }
    };
    let name = name.trim();
    if name.is_empty() {
        "Kimochi".into()
    } else {
        name.chars().take(64).collect()
    }
}

pub fn computer_name() -> String {
    device_name()
}

#[allow(deprecated)] // the shell plugin's `open` is the opener the app already uses
fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(url, None)
        .map_err(|e| format!("native: could not open the browser: {e}"))
}

/// Bring the main window to the front and focus it; on `account`, on Settings → Account.
pub fn bring_forward(app: &AppHandle, account_page: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(service) = handle.try_state::<Shared>() else { return };
        let settings = service.settings.clone();
        if account_page && settings.set("settingsActiveTab", json!("account")).is_ok() {
            let _ = handle.emit(
                "settings:changed",
                json!({ "key": "settingsActiveTab", "value": "account" }),
            );
        }
        let _ = panels::act_existing(&handle, &settings, panels::MAIN, "show", None);
        if let Some(main) = handle.get_webview_window(panels::MAIN) {
            let _ = platform::activate_self(Some(&main));
        }
        if account_page {
            let _ = handle.emit("main:show-settings", json!({}));
        }
    });
}

/// `kimochi://…` URLs, from the deep-link plugin (a running copy, or a second launch forwarded by
/// the single-instance plugin, or the URL this copy was launched with).
pub fn handle_urls(app: &AppHandle, urls: &[String]) {
    for url in urls {
        if let Some(page) = deep_link_page(url) {
            bring_forward(app, page == "account");
            // Coming back from the website: whatever it changed (a new plan, a device removed)
            // shows at once.
            if page == "account" && signed_in() {
                std::thread::spawn(|| {
                    let _ = refresh_blocking();
                });
            }
        }
    }
}

/// The page a `kimochi://` URL asks for: `kimochi://account` (also `kimochi:///account`,
/// `kimochi://account/…`) is `account`; any other `kimochi://` URL just brings Kimochi forward.
fn deep_link_page(url: &str) -> Option<&'static str> {
    let rest = url.strip_prefix("kimochi:")?;
    let path = rest.trim_start_matches('/');
    let first = path.split(['/', '?', '#']).next().unwrap_or("");
    Some(if first.eq_ignore_ascii_case("account") { "account" } else { "" })
}

fn link_event(status: &str, code: &str, message: Option<&str>) {
    let Some(account) = ACCOUNT.get() else { return };
    let _ = account
        .app
        .emit("account-link", json!({ "status": status, "code": code, "message": message }));
}

fn end_link(seq: u64) {
    if let Some(account) = ACCOUNT.get() {
        let mut link = lock(&account.link);
        if link.as_ref().is_some_and(|l| l.seq == seq) {
            *link = None;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkStart {
    code: String,
    poll_token: String,
    verify_url: String,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

/// Add an account: link this computer to it on the sign-in server (`linkServer`).
#[tauri::command]
pub async fn account_link_start(app: AppHandle) -> Result<Value, String> {
    let mode = link_mode();
    let base = settings::base_for_mode(mode).to_string();
    let start_base = base.clone();
    let start = tauri::async_runtime::spawn_blocking(move || -> Result<LinkStart, String> {
        let base = start_base;
        let http = client(Duration::from_secs(15))?;
        let response = http
            .post(format!("{base}/api/v1/link/start"))
            .json(&json!({ "deviceName": device_name(), "platform": std::env::consts::OS }))
            .send()
            .map_err(|_| OFFLINE.to_string())?;
        if !response.status().is_success() {
            return Err(failure(cloud::Feature::Account, &base, response));
        }
        response
            .json::<LinkStart>()
            .map_err(|_| "native: Kimochi cloud sent an unreadable answer".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let account = account()?;
    let seq = account.link_seq.fetch_add(1, Ordering::SeqCst) + 1;
    *lock(&account.link) = Some(Link {
        seq,
        code: start.code.clone(),
        verify_url: start.verify_url.clone(),
        expires_at_ms: now_ms() + start.expires_in * 1000,
    });
    link_event("pending", &start.code, None);
    announce();
    // A browser that cannot be opened is not fatal: the code is on screen with "Open browser again".
    let _ = open_in_browser(&app, &start.verify_url);

    let interval = Duration::from_secs(start.interval.unwrap_or(2).clamp(1, 30));
    let deadline = Instant::now() + Duration::from_secs(start.expires_in);
    let (code, poll_token) = (start.code.clone(), start.poll_token);
    std::thread::spawn(move || poll(seq, base, code, poll_token, interval, deadline));

    Ok(json!({ "code": start.code, "verifyUrl": start.verify_url, "expiresIn": start.expires_in }))
}

/// A sign-in approved: keep the account and its token, and switch to it.
fn approved(base: &str, token: String, user: Value) -> Result<(), String> {
    let account = account()?;
    let user_id = user["id"].as_str().ok_or("native: Kimochi cloud sent no user id")?.to_string();
    let mode = mode_of(base);
    let key = profile::profile_key(mode, &user_id);
    save_token(&account.data_dir, &key, Some(&token))?;
    {
        let mut index = lock(&account.index);
        match index.accounts.iter_mut().find(|e| e.key == key) {
            Some(entry) => entry.user = user,
            None => index.accounts.push(Entry {
                key: key.clone(),
                mode: mode.to_string(),
                user_id,
                user,
                usage: None,
                added_at: now_ms(),
                last_used_at: now_ms(),
            }),
        }
        save_index(&account.data_dir, &index)?;
    }
    activate(Some(key))
}

fn poll(seq: u64, base: String, code: String, poll_token: String, interval: Duration, deadline: Instant) {
    let current = || ACCOUNT.get().is_some_and(|a| a.link_seq.load(Ordering::SeqCst) == seq);
    let Ok(http) = client(Duration::from_secs(15)) else { return };
    let mut wait = interval;
    let mut failures = 0u32;
    loop {
        std::thread::sleep(wait);
        if !current() {
            return;
        }
        if Instant::now() >= deadline {
            end_link(seq);
            link_event("expired", &code, None);
            announce();
            return;
        }
        let answer = http
            .post(format!("{base}/api/v1/link/poll"))
            .json(&json!({ "pollToken": poll_token }))
            .send();
        let response = match answer {
            Ok(response) => response,
            Err(_) => {
                failures += 1;
                if failures >= 15 {
                    end_link(seq);
                    link_event("error", &code, Some(OFFLINE.trim_start_matches("native: ")));
                    announce();
                    return;
                }
                continue;
            }
        };
        if response.status().as_u16() == 429 {
            wait = (wait * 2).min(Duration::from_secs(30));
            continue;
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            failures += 1;
            if failures >= 5 || status == 400 || status == 404 {
                end_link(seq);
                let message = cloud::describe_failure(cloud::Feature::Account, status, &body, false);
                link_event("error", &code, Some(&message));
                announce();
                return;
            }
            continue;
        }
        failures = 0;
        wait = interval;
        let Ok(body) = response.json::<Value>() else { continue };
        if !current() {
            return;
        }
        match body.get("status").and_then(Value::as_str).unwrap_or("") {
            "pending" => {}
            "approved" => {
                let token = body.get("token").and_then(Value::as_str).unwrap_or("").to_string();
                if token.is_empty() {
                    continue;
                }
                let user = body.get("user").cloned().unwrap_or(Value::Null);
                end_link(seq);
                if let Err(e) = approved(&base, token, user) {
                    link_event("error", &code, Some(&format!("Signed in, but switching to the account failed: {}", e.trim_start_matches("native: ").trim_start_matches("invalid: "))));
                    announce();
                    return;
                }
                link_event("approved", &code, None);
                if let Some(account) = ACCOUNT.get() {
                    bring_forward(&account.app, true);
                }
                let _ = refresh_usage();
                return;
            }
            status @ ("denied" | "expired") => {
                end_link(seq);
                link_event(status, &code, None);
                announce();
                return;
            }
            _ => {}
        }
    }
}

/// Stop the sign-in in progress, if any: its poll thread ends at its next turn.
fn cancel_link(account: &Account) -> Option<String> {
    account.link_seq.fetch_add(1, Ordering::SeqCst);
    lock(&account.link).take().map(|l| l.code)
}

#[tauri::command]
pub fn account_link_cancel() -> Result<Value, String> {
    let code = cancel_link(account()?).unwrap_or_default();
    link_event("cancelled", &code, None);
    announce();
    Ok(status_value())
}

/// Development builds only: the server "Add account" signs in to (`accountLinkServer`). Signed
/// out, it is also the server in use. Accounts carry their own server, so switching to one
/// follows it regardless.
#[tauri::command]
pub fn account_set_server(mode: String) -> Result<Value, String> {
    if !cfg!(debug_assertions) {
        return Err("invalid: the server can only be switched in a development build".into());
    }
    if mode != "cloud" && mode != "local" {
        return Err(format!("invalid: unknown server mode {mode:?} (cloud or local)"));
    }
    if let Some(forced) = settings::server_mode_override() {
        return Err(format!(
            "invalid: {}={forced} picks the server for this run; unset it to switch here",
            settings::SERVER_ENV
        ));
    }
    let account = account()?;
    let store = settings_store()?;
    if let Some(code) = cancel_link(account) {
        link_event("cancelled", &code, None);
    }
    store.set("accountLinkServer", json!(mode))?;
    if active_key().is_none() {
        store.set("serverSettings.mode", json!(mode))?;
        let value = store.get("serverSettings").ok().flatten().unwrap_or_else(|| json!({ "mode": mode }));
        let _ = account.app.emit("settings:changed", json!({ "key": "serverSettings", "value": value }));
    }
    announce();
    announce_capabilities();
    Ok(status_value())
}

#[tauri::command]
pub fn account_status() -> Value {
    status_value()
}

/// Sign out of an account (default: the active one): its token is forgotten here and revoked on
/// the server; its profile stays. Signing out of the active account returns to the Local profile.
#[tauri::command]
pub async fn account_sign_out(key: Option<String>) -> Result<Value, String> {
    let key = key.or_else(active_key).ok_or("invalid: no account is signed in")?;
    let entry = entry_for(&key).ok_or("invalid: that account is not on this computer")?;
    let account = account()?;
    let token = read_token(&account.data_dir, &key);
    if active_key().as_deref() == Some(key.as_str()) {
        let target = None;
        tauri::async_runtime::spawn_blocking(move || activate(target))
            .await
            .map_err(|e| e.to_string())??;
    }
    // The local sign-out is what counts: the file goes even when the server cannot be reached.
    save_token(&account.data_dir, &key, None)?;
    sync::log("profile", &format!("Signed out of {}; its data stays on this computer", entry.user["email"].as_str().unwrap_or(&key)));
    announce();
    announce_capabilities();
    if let Some(token) = token {
        let base = entry.base().to_string();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(http) = client(Duration::from_secs(5)) {
                let _ = http.post(format!("{base}/api/v1/sign-out")).bearer_auth(&token).send();
            }
        })
        .await;
    }
    Ok(status_value())
}

/// Sign out of an account and delete its profile from this computer (its data stays in the
/// account, on the server).
#[tauri::command]
pub async fn account_remove(key: String) -> Result<Value, String> {
    if entry_for(&key).is_none() {
        return Err("invalid: that account is not on this computer".into());
    }
    account_sign_out(Some(key.clone())).await?;
    let account = account()?;
    let dir = profile::profile_dir(&account.local_dir, Some(&key));
    if dir.starts_with(account.local_dir.join(profile::PROFILES_DIR)) && dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("native: could not delete the profile: {e}"))?;
    }
    {
        let mut index = lock(&account.index);
        index.accounts.retain(|e| e.key != key);
        save_index(&account.data_dir, &index)?;
    }
    sync::log("profile", &format!("Removed {key} and its data from this computer"));
    announce();
    Ok(status_value())
}

#[tauri::command]
pub async fn account_refresh() -> Result<Value, String> {
    if !signed_in() {
        return Ok(status_value());
    }
    tauri::async_runtime::spawn_blocking(refresh_blocking)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn account_open_web(app: AppHandle) -> Result<(), String> {
    let base = active_entry().map(|e| e.base().to_string()).map_or_else(base, Ok)?;
    open_in_browser(&app, &format!("{base}/account"))
}

/// "Open browser again" while linking.
#[tauri::command]
pub fn account_link_open(app: AppHandle) -> Result<(), String> {
    let url = lock(&account()?.link).as_ref().map(|l| l.verify_url.clone());
    open_in_browser(&app, &url.ok_or("invalid: no sign-in is in progress")?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_comes_from_the_server_flag_or_an_older_plan() {
        assert!(user_has_cloud(&json!({ "plan": "trial", "cloud": true })));
        assert!(!user_has_cloud(&json!({ "plan": "free", "cloud": false })));
        // The flag wins over the plan name, so new plans need no app update.
        assert!(user_has_cloud(&json!({ "plan": "patron", "cloud": true })));
        // Cached before the flag existed.
        assert!(user_has_cloud(&json!({ "plan": "plus" })));
        assert!(!user_has_cloud(&json!({ "plan": "free" })));
        assert!(!user_has_cloud(&Value::Null));
    }

    #[test]
    fn plan_required_is_a_403_with_that_code() {
        assert!(is_plan_required(403, r#"{"error":"plan_required","message":"x"}"#));
        assert!(!is_plan_required(403, r#"{"error":"forbidden"}"#));
        assert!(!is_plan_required(402, r#"{"error":"plan_required"}"#));
    }

    #[test]
    fn deep_links_name_the_account_page() {
        assert_eq!(deep_link_page("kimochi://account"), Some("account"));
        assert_eq!(deep_link_page("kimochi:///account?x=1"), Some("account"));
        assert_eq!(deep_link_page("kimochi://account/devices"), Some("account"));
        assert_eq!(deep_link_page("kimochi://"), Some(""));
        assert_eq!(deep_link_page("https://account"), None);
    }

    #[test]
    fn token_files_are_private_and_per_account() {
        let dir = std::env::temp_dir().join(format!("kimochi-account-tokens-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save_token(&dir, "cloud-u1", Some("kmc_a")).unwrap();
        save_token(&dir, "local-u1", Some("kmc_b")).unwrap();
        assert_eq!(read_token(&dir, "cloud-u1").as_deref(), Some("kmc_a"));
        assert_eq!(read_token(&dir, "local-u1").as_deref(), Some("kmc_b"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(token_path(&dir, "cloud-u1")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        save_token(&dir, "cloud-u1", None).unwrap();
        save_token(&dir, "cloud-u1", None).unwrap();
        assert_eq!(read_token(&dir, "cloud-u1"), None);
        assert_eq!(read_token(&dir, "local-u1").as_deref(), Some("kmc_b"), "signing out of one leaves the other");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_earlier_sign_in_becomes_the_active_account_with_its_data() {
        let root = std::env::temp_dir().join(format!("kimochi-account-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (data, local) = (root.join("data"), root.join("local"));
        std::fs::create_dir_all(local.join("sessions/s1")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(local.join("sessions.json"), r#"{"version":1,"activeId":"s1","sessions":[{"id":"s1"}]}"#).unwrap();
        std::fs::write(local.join("sessions/s1/lines.json"), r#"{"version":1,"lines":[]}"#).unwrap();
        std::fs::write(data.join("account.json"), r#"{"token":"kmc_cloud","user":{"id":"usr_1","email":"a@b.c"}}"#).unwrap();
        std::fs::write(data.join("account-local.json"), r#"{"token":"kmc_local","user":{"id":"usr_2"}}"#).unwrap();
        let (index, notes) = migrate_legacy(&data, &local, "cloud");
        assert_eq!(index.accounts.len(), 2);
        assert_eq!(index.active.as_deref(), Some("cloud-usr_1"));
        assert_eq!(read_token(&data, "local-usr_2").as_deref(), Some("kmc_local"));
        assert!(local.join("profiles/cloud-usr_1/sessions/s1/lines.json").exists());
        assert!(local.join("sessions.json").exists(), "the Local profile is untouched");
        assert!(!local.join("profiles/local-usr_2").exists(), "only the account in use takes the data");
        assert_eq!(notes.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
