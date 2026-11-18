//! A dictionary-engine switch that waits for its download ("Use when downloaded").
//!
//! Choosing an engine that is not downloaded yet (Settings → Dictionary, the main window's
//! sidebar, onboarding's engine step) records it here as the PENDING switch and starts its
//! download. The switch belongs to the app, not to the page it was made on: the page can close,
//! onboarding can move on, the app can quit and start again, and the switch is still made once
//! the download is ready. Nothing changes until then, so the engine in use keeps working while
//! the new one downloads, and a download that never finishes leaves everything as it was.
//!
//! - **Stored** as the machine setting `dictionaryEnginePending` (an engine id that has a
//!   download: `yomitan`, `hachidori` or `tenten`; null when nothing waits), so every window
//!   follows it through `settings:changed` and it survives a restart. One switch waits at a
//!   time: choosing again replaces it (the earlier engine's download carries on, and is simply
//!   offered as "Use <name>" once ready).
//! - **Made** when the engine's download becomes ready ([`on_download_change`], from the store's
//!   `on_change`): `yomitanSettings.popupType` is saved, the pending switch cleared, every window
//!   told (`dictionary-switch`, which the main window uses to come back where it was), and the
//!   reader windows move to the engine as for any download that changes the effective engine
//!   (`follow_effective_engine`). The activity feed says "Now using …".
//! - **Dropped** when its download is cancelled (or the engine removed): the download going back
//!   to `absent` while it waits. A choice made directly (an engine that is ready) clears it too
//!   (the page calls [`dictionary_switch_queue`] with none).
//! - **Resumed** at launch ([`resume_at_launch`]): a download a quit paused carries on, one that
//!   failed or never started is started again, and one that finished just before the quit (with
//!   the switch not yet made) is switched to.
//!
//! The download itself is the extension store's (resumable, verified, moved into place only once
//! every file checks out: a half-downloaded engine is never served). This module only decides
//! what the pending switch does about it ([`next`]); it does not touch the transfer.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::{extension_store, extensions, settings::Settings, state::Shared};

/// The setting that holds the pending switch.
pub const KEY: &str = "dictionaryEnginePending";
/// Every window hears a switch made here: `{engine, popupType, at}`.
pub const EVENT: &str = "dictionary-switch";
/// The activity feed's key for the switch's posts.
const ACTIVITY_KEY: &str = "dictionary-switch";

/// When the pending switch is looked at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    /// It was just asked for, or the app just started: make sure its download is under way.
    Resume,
    /// Its download changed state while the app runs.
    Changed,
}

/// What the pending switch does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Wait: the download is under way (or paused or failed by the user's hand, with Resume
    /// and Retry where its progress is shown).
    Wait,
    /// Start (or resume, or retry) the download.
    Start,
    /// The download is ready: switch.
    Switch,
    /// The download is gone (cancelled, removed): forget the switch.
    Drop,
}

/// The decision, from the download's state (`ExtensionStatus::state`).
pub fn next(when: When, download: &str) -> Step {
    match (when, download) {
        (_, "ready") => Step::Switch,
        (When::Changed, "absent") => Step::Drop,
        (When::Resume, "absent" | "paused" | "failed") => Step::Start,
        _ => Step::Wait,
    }
}

/// The `yomitanSettings.popupType` for an engine id.
pub fn popup_type(engine: &str) -> &str {
    match engine {
        "yomitan" => "builtin",
        other => other,
    }
}

/// A stored value as a pending engine: one the store can download, else none.
pub fn parse(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|id| extension_store::IDS.contains(id)).map(str::to_string)
}

/// The engine waiting for its download, if any.
pub fn pending(settings: &Settings) -> Option<String> {
    parse(settings.get(KEY).ok().flatten().as_ref())
}

/// The last switch this module made, `(engine, epoch ms)`: a window reloaded by it asks, to say
/// "Now using …" once it is back.
static LAST_SWITCH: Mutex<Option<(String, u64)>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn download_state(app: &tauri::AppHandle, engine: &str) -> Option<&'static str> {
    extension_store::status(app, engine).map(|status| status.state)
}

fn store_pending(app: &tauri::AppHandle, settings: &Arc<Settings>, engine: Option<&str>) -> Result<(), String> {
    crate::apply_setting(app, settings, KEY, engine.map_or(Value::Null, |id| json!(id)))
}

/// Acts on the pending switch for `engine`'s download in `state`. Returns what it did.
fn act(app: &tauri::AppHandle, service: &Shared, engine: &str, when: When, state: &str) -> Step {
    let step = next(when, state);
    match step {
        Step::Wait => {}
        Step::Start => {
            if let Some(store) = app.try_state::<Arc<extension_store::ExtensionStore>>() {
                store.start(engine);
            }
        }
        Step::Drop => {
            let _ = store_pending(app, &service.settings, None);
        }
        Step::Switch => switch(app, service, engine),
    }
    crate::record(
        app,
        service,
        json!({ "check": "dictionary-switch", "engine": engine, "when": format!("{when:?}"), "download": state, "step": format!("{step:?}") }),
    );
    step
}

/// Makes the switch: the setting first (a quit between the two writes leaves a pending switch to
/// the engine already chosen, which the next launch simply clears), then the windows.
fn switch(app: &tauri::AppHandle, service: &Shared, engine: &str) {
    let settings = &service.settings;
    let popup = popup_type(engine);
    let mut yomitan = settings.get("yomitanSettings").ok().flatten().unwrap_or_else(|| json!({}));
    let changed = yomitan.get("popupType").and_then(Value::as_str) != Some(popup);
    if changed {
        if !yomitan.is_object() {
            yomitan = json!({});
        }
        yomitan["popupType"] = json!(popup);
        if let Err(e) = crate::apply_setting(app, settings, "yomitanSettings", yomitan) {
            // Left pending: the next launch tries again, and the page still shows it waiting.
            crate::activity::post(
                app,
                &format!("Couldn’t switch to {}: {e}", engine_name(engine)),
                crate::activity::Tone::Error,
                Some(ACTIVITY_KEY),
            );
            return;
        }
    }
    let _ = store_pending(app, settings, None);
    if !changed {
        // Already the chosen engine (a first run's Yomitan, or a launch after a quit mid-switch):
        // the store's own follow moves the windows; there is nothing to announce as new.
        return;
    }
    let at = now_ms();
    *LAST_SWITCH.lock().unwrap_or_else(|p| p.into_inner()) = Some((engine.to_string(), at));
    // Before the reload, so the main window can record where it is and come back there.
    let _ = app.emit(EVENT, json!({ "engine": engine, "popupType": popup, "at": at }));
    // In a language it cannot read (changed while it downloaded), Yomitan stands in for it.
    let language = &crate::language::current(settings).code;
    let text = if extensions::reads_language(engine, language) {
        format!("{} downloaded. Now using it to look words up", engine_name(engine))
    } else {
        format!("{} downloaded. It is used for the languages it reads", engine_name(engine))
    };
    crate::activity::post(app, &text, crate::activity::Tone::Ok, Some(ACTIVITY_KEY));
    // Idempotent: from the store's `on_change` the follow after this one finds nothing to do.
    crate::follow_effective_engine(app);
}

fn engine_name(engine: &str) -> String {
    extension_store::engine(engine).map_or_else(|| engine.to_string(), |engine| engine.pin.name.clone())
}

/// The store's `on_change` for `engine`: the pending switch follows its download. A switch made
/// here moves the windows itself (`follow_effective_engine`, which then has nothing more to do).
pub fn on_download_change(app: &tauri::AppHandle, engine: &str) {
    let Some(service) = app.try_state::<Shared>() else { return };
    if pending(&service.settings).as_deref() != Some(engine) {
        return;
    }
    if let Some(state) = download_state(app, engine) {
        act(app, &service, engine, When::Changed, state);
    }
}

/// At launch, once the store is up and before the windows' engine is worked out: the pending
/// switch's download carries on (or the switch is made, when it finished just before the quit,
/// so the windows are built for it).
pub fn resume_at_launch(app: &tauri::AppHandle, service: &Shared) -> Option<Value> {
    let engine = pending(&service.settings)?;
    let state = download_state(app, &engine)?;
    let step = act(app, service, &engine, When::Resume, state);
    Some(json!({ "engine": engine, "download": state, "step": format!("{step:?}") }))
}

/// What the pages draw from: the pending engine (null when none) and the last switch made here
/// (`{engine, at}`, null before one), so a window the switch reloaded can say "Now using …".
#[tauri::command]
pub fn dictionary_switch_state(state: tauri::State<Shared>) -> Value {
    let last = LAST_SWITCH.lock().unwrap_or_else(|p| p.into_inner()).clone();
    json!({
        "pending": pending(&state.settings),
        "switched": last.map(|(engine, at)| json!({ "engine": engine, "at": at })),
    })
}

/// "Use when downloaded": records `engine` as the pending switch and starts (resumes, retries) its
/// download; one already ready is switched to at once. `null` clears the pending switch (a choice
/// made directly), leaving any download running. Refused for an engine that cannot read the
/// language being learned (the choosers offer it disabled).
#[tauri::command]
pub async fn dictionary_switch_queue(
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
    engine: Option<String>,
) -> Result<Value, String> {
    let service = state.inner().clone();
    let Some(engine) = engine else {
        if pending(&service.settings).is_some() {
            store_pending(&app, &service.settings, None)?;
        }
        return Ok(dictionary_switch_state(state));
    };
    if !extension_store::IDS.contains(&engine.as_str()) {
        return Err(format!("invalid: {engine} is not a dictionary engine with a download"));
    }
    let language = &crate::language::current(&service.settings).code;
    if !extensions::reads_language(&engine, language) {
        return Err(format!("invalid: {engine} cannot read {language}"));
    }
    store_pending(&app, &service.settings, Some(&engine))?;
    let handle = app.clone();
    // The store's start and a switch's window reloads are not for the IPC thread.
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(download) = download_state(&handle, &engine) {
            act(&handle, &service, &engine, When::Resume, download);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(dictionary_switch_state(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ready_download_is_switched_to_whenever_it_is_seen() {
        assert_eq!(next(When::Changed, "ready"), Step::Switch);
        // Finished just before a quit, with the switch not made yet.
        assert_eq!(next(When::Resume, "ready"), Step::Switch);
    }

    #[test]
    fn a_cancelled_download_drops_the_switch() {
        assert_eq!(next(When::Changed, "absent"), Step::Drop);
    }

    #[test]
    fn asking_again_or_relaunching_gets_the_download_going() {
        // Never started (or its partial file is gone), paused by the quit, or failed offline.
        for state in ["absent", "paused", "failed"] {
            assert_eq!(next(When::Resume, state), Step::Start, "{state}");
        }
        // Already under way: nothing to start, so no second download.
        for state in ["downloading", "verifying"] {
            assert_eq!(next(When::Resume, state), Step::Wait, "{state}");
        }
    }

    #[test]
    fn while_the_app_runs_a_pause_or_failure_waits_for_the_user() {
        for state in ["downloading", "verifying", "paused", "failed"] {
            assert_eq!(next(When::Changed, state), Step::Wait, "{state}");
        }
    }

    #[test]
    fn only_engines_with_a_download_can_wait() {
        assert_eq!(parse(Some(&json!("hachidori"))), Some("hachidori".into()));
        assert_eq!(parse(Some(&json!("yomitan"))), Some("yomitan".into()));
        assert_eq!(parse(Some(&json!("custom-api"))), None);
        assert_eq!(parse(Some(&json!("builtin"))), None);
        assert_eq!(parse(Some(&Value::Null)), None);
        assert_eq!(parse(None), None);
    }

    #[test]
    fn yomitan_is_saved_as_builtin() {
        assert_eq!(popup_type("yomitan"), "builtin");
        assert_eq!(popup_type("tenten"), "tenten");
        assert_eq!(popup_type("hachidori"), "hachidori");
    }

    #[test]
    fn the_pending_switch_is_stored_with_the_settings_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("kimochi-switch-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let settings = Settings::load(path.clone());
        assert_eq!(pending(&settings), None, "nothing waits by default");
        settings.set(KEY, json!("tenten")).unwrap();
        let reloaded = Settings::load(path);
        assert_eq!(pending(&reloaded), Some("tenten".into()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_pending_switch_stays_on_this_computer() {
        assert!(crate::profile::MACHINE_KEYS.contains(&KEY));
    }
}
