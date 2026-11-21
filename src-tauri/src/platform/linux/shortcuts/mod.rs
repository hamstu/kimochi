//! Global shortcuts on Wayland (X11 uses tauri-plugin-global-shortcut in `hotkeys.rs`).
//!
//! One generic layer: `apply` turns the shortcut settings into `Shortcut`s, `plan` picks the
//! backends to try for this session, and the first that binds wins. Every backend implements
//! `Backend`, and each compositor's peculiarities stay in its own module:
//!
//! - `portal`: the XDG GlobalShortcuts portal (KDE Plasma, and any other desktop whose portal has it).
//! - `hyprland`: the portal, plus the binds Hyprland needs before it fires one (`hyprland_binds`).
//! - `gnome`: Kimochi's GNOME Shell extension, when it is running.
//! - `niri`: binds written to `~/.config/niri/kimochi.kdl`, for a niri without the portal.
//!
//! A backend that cannot bind hands over to the next in the plan (on niri: the portal, then the
//! kdl binds), so a shortcut is never bound twice.
mod gnome;
mod hyprland;
pub mod niri;
mod portal;

use crate::{
    actions,
    settings::{merged_hotkeys, Settings},
    state::Shared,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};

pub use gnome::dispatch as dispatch_gnome;

static GENERATION: AtomicU64 = AtomicU64::new(0);
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static REPORT: Mutex<Option<Value>> = Mutex::new(None);

/// One action shortcut, as the settings give it.
#[derive(Clone, Debug, PartialEq)]
pub struct Shortcut {
    /// The action (`triggerScan`).
    pub name: String,
    /// Electron-style (`Alt+Z`); empty when the action has no keys yet.
    pub accelerator: String,
    /// What the desktop shows for it ("Scan text").
    pub description: String,
}

/// What a backend set up.
pub(super) struct Bound {
    /// `globalShortcutReport`: `backend`, `registered`, `failed`, and anything backend-specific.
    pub report: Value,
    /// Whether any shortcut can fire (`capabilities.input.globalShortcuts`).
    pub available: bool,
    /// Runs on the backend's thread until the shortcuts change, for a backend that is told of
    /// presses (the portal's signals); `None` when presses reach Kimochi some other way.
    pub listen: Option<Box<dyn FnOnce() -> Result<(), String> + Send>>,
}

/// One way of binding global shortcuts on this desktop.
pub(super) trait Backend: Sync {
    /// `globalShortcutBackend`.
    fn id(&self) -> &'static str;
    /// Bind `shortcuts`, or say why not (then the plan's next backend is tried). Runs on a thread
    /// of its own and may block.
    fn bind(&self, run: &Run, shortcuts: &[Shortcut]) -> Result<Bound, String>;
    /// Take back what `bind` set up: before every new set, and on quit.
    fn stop(&self);
    /// Whether `bind` replaces the last set itself, so a new set needs no `stop` first (niri's
    /// file: emptying it before rewriting it would make niri reload twice, without shortcuts in
    /// between). Such a backend is stopped only on suspend, on quit, or when another one binds.
    fn rebinds_in_place(&self) -> bool {
        false
    }
}

/// The backends, in the order `plan` names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Gnome,
    Hyprland,
    Portal,
    Niri,
}

const BACKENDS: [(Kind, &dyn Backend); 4] = [
    (Kind::Gnome, &gnome::Gnome),
    (Kind::Hyprland, &hyprland::Hyprland),
    (Kind::Portal, &portal::Portal),
    (Kind::Niri, &niri::Niri),
];

fn backend(kind: Kind) -> &'static dyn Backend {
    BACKENDS.iter().find(|(k, _)| *k == kind).map(|(_, b)| *b).expect("every kind has a backend")
}

/// What the choice of backend depends on.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Facts {
    /// Kimochi's GNOME Shell extension is running and takes shortcuts.
    pub gnome_extension: bool,
    pub hyprland: bool,
    pub niri: bool,
    /// On niri: a GlobalShortcuts portal that can grab keys there (niri itself serves
    /// `org.gnome.Shell` for xdg-desktop-portal-gnome, after 26.04).
    pub niri_portal: bool,
}

/// The backends to try, best first.
pub(super) fn plan(facts: Facts) -> Vec<Kind> {
    if facts.gnome_extension {
        vec![Kind::Gnome]
    } else if facts.hyprland {
        vec![Kind::Hyprland]
    } else if facts.niri && facts.niri_portal {
        vec![Kind::Portal, Kind::Niri]
    } else if facts.niri {
        vec![Kind::Niri]
    } else {
        vec![Kind::Portal]
    }
}

fn facts() -> Facts {
    let compositor = super::session().compositor.as_deref().unwrap_or("").to_ascii_lowercase();
    let niri = compositor == "niri";
    Facts {
        gnome_extension: super::gnome::status()["nativeShortcuts"] == true,
        hyprland: compositor.contains("hypr"),
        niri,
        niri_portal: niri && niri::portal_ready(),
    }
}

/// One `apply`'s binding, on its thread: stale once the shortcuts change again.
pub(super) struct Run {
    pub app: tauri::AppHandle,
    pub generation: u64,
}

impl Run {
    pub fn current(&self) -> bool {
        GENERATION.load(Ordering::SeqCst) == self.generation
    }
    /// Make `report` the shortcut report and tell every window.
    pub fn publish(&self, report: Value, available: bool) {
        if !self.current() {
            return;
        }
        AVAILABLE.store(available, Ordering::SeqCst);
        *REPORT.lock().unwrap() = Some(report.clone());
        self.record(json!({"check":"global-shortcuts","report":report}));
        self.capabilities_changed();
    }
    pub fn record(&self, entry: Value) {
        crate::record(&self.app, &self.app.state::<Shared>(), entry);
    }
    pub fn capabilities_changed(&self) {
        let _ =
            self.app.emit("platform-capabilities", crate::capabilities_value(&self.app, &self.app.state::<Shared>()));
    }
    pub fn dispatch(&self, action: &str) {
        actions::dispatch(&self.app, &self.app.state::<Shared>(), action);
    }
}

pub fn available() -> bool {
    AVAILABLE.load(Ordering::SeqCst)
}
pub fn report() -> Value {
    REPORT.lock().unwrap().clone().unwrap_or(json!({"backend":"portal","pending":true}))
}
/// `globalShortcutBackend`.
pub fn backend_id() -> String {
    report()["backend"].as_str().unwrap_or("portal").to_owned()
}
/// What to do about shortcuts the desktop would not take, if anything (Hyprland's binds).
pub fn remediation() -> Option<String> {
    hyprland::remediation(&report())
}

/// Change the report in place (the niri setup Kimochi just re-read). `change` returns whether
/// shortcuts can now fire, when that changed.
pub(super) fn update_report(change: impl FnOnce(&mut Value) -> Option<bool>) {
    if let Some(report) = REPORT.lock().unwrap().as_mut() {
        if let Some(available) = change(report) {
            AVAILABLE.store(available, Ordering::SeqCst);
        }
    }
}

pub fn stop() {
    halt(true);
}

/// Stop the backends (all of them, or those a new set doesn't replace in place) and make any
/// binding still running stale.
fn halt(all: bool) {
    for (_, backend) in BACKENDS {
        if all || !backend.rebinds_in_place() {
            backend.stop();
        }
    }
    GENERATION.fetch_add(1, Ordering::SeqCst);
    AVAILABLE.store(false, Ordering::SeqCst);
}

/// Stop the in-place backends other than `winner` (`None`: all of them).
fn stop_in_place(winner: Option<Kind>) {
    for (kind, backend) in BACKENDS {
        if backend.rebinds_in_place() && Some(kind) != winner {
            backend.stop();
        }
    }
}

/// What the shortcut settings ask for, minus what no backend could bind: a mouse button (bound on
/// another computer, then synced), returned as failures.
fn shortcuts(settings: &Settings) -> (Vec<Shortcut>, Vec<Value>) {
    let mut wanted = Vec::new();
    let mut failed = Vec::new();
    for (name, definition) in merged_hotkeys(settings) {
        if definition["enabled"] == json!(false) {
            continue;
        }
        let Some(accelerator) = definition["accelerator"].as_str() else {
            continue;
        };
        if crate::mouse_buttons::Button::parse(accelerator).is_some() {
            failed.push(
                json!({"name":name,"accelerator":accelerator,"error":"mouse buttons can't be shortcuts on Linux"}),
            );
            continue;
        }
        // A menu item with no keys is not offered: the portal would list every item.
        if accelerator.is_empty() && actions::is_menu_item(&name) {
            continue;
        }
        let description = match name.as_str() {
            "triggerScan" => "Scan text",
            "openControllerMenu" => "Open the radial menu",
            _ => actions::MENU_ITEM_ACTIONS
                .iter()
                .find(|(action, _, _)| *action == name)
                .map(|(_, label, _)| *label)
                .unwrap_or(name.as_str()),
        }
        .to_owned();
        wanted.push(Shortcut { name, accelerator: accelerator.to_owned(), description });
    }
    (wanted, failed)
}

pub fn apply(app: &tauri::AppHandle, settings: &Arc<Settings>, suspended: bool) -> Value {
    // Suspended (a key is being recorded): nothing may keep a key, so every backend stops.
    halt(suspended);
    super::shift::portal_bound(false);
    let _ = app.emit("linux-dictionary-modifier", json!({"shift":false}));
    if suspended {
        return json!({"registered":[],"failed":[],"suspended":true,"backend":backend_id()});
    }
    let generation = GENERATION.load(Ordering::SeqCst);
    let (wanted, failed) = shortcuts(settings);
    let pending = json!({"registered":[],"failed":failed,"backend":backend_id(),"pending":true});
    *REPORT.lock().unwrap() = Some(pending.clone());
    let run = Run { app: app.clone(), generation };
    std::thread::spawn(move || {
        let plan = plan(facts());
        let mut errors = Vec::new();
        for kind in &plan {
            let backend = backend(*kind);
            match backend.bind(&run, &wanted) {
                Ok(bound) => {
                    if !run.current() {
                        return;
                    }
                    if !errors.is_empty() {
                        run.record(json!({"check":"global-shortcuts-fallback","backend":backend.id(),"errors":errors}));
                    }
                    stop_in_place(Some(*kind));
                    run.publish(bound.report, bound.available);
                    if let Some(listen) = bound.listen {
                        if let Err(error) = listen() {
                            fail(&run, backend.id(), error);
                        }
                    }
                    return;
                }
                Err(error) => {
                    // Superseded: the next set's backend may already be up, so leave it be.
                    if !run.current() {
                        return;
                    }
                    // Whatever it set up before failing goes, so the next one cannot double it.
                    backend.stop();
                    errors.push(json!({"backend":backend.id(),"error":error}));
                }
            }
        }
        stop_in_place(None);
        let last = errors.last().cloned().unwrap_or(json!({"backend":"portal","error":"no backend"}));
        fail(&run, last["backend"].as_str().unwrap_or("portal"), last["error"].as_str().unwrap_or("").to_owned());
    });
    pending
}

fn fail(run: &Run, backend: &str, error: String) {
    if !run.current() {
        return;
    }
    let _ = run.app.emit("linux-dictionary-modifier", json!({"shift":false}));
    run.publish(
        json!({"registered":[],"failed":[{"name":"Wayland shortcuts","error":error}],"backend":backend,"pending":false}),
        false,
    );
}

/// Drop `action` from the report's failures (and count it registered). True when it was there.
pub(super) fn forget_failure(action: &str) -> bool {
    let mut report = REPORT.lock().unwrap();
    let Some(report) = report.as_mut() else { return false };
    let Some(failed) = report["failed"].as_array_mut() else { return false };
    let before = failed.len();
    failed.retain(|f| f["name"] != action);
    if failed.len() == before {
        return false;
    }
    if let Some(registered) = report["registered"].as_array_mut() {
        registered.push(json!(action));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{plan, Facts, Kind};

    #[test]
    fn plan_picks_one_backend_per_desktop() {
        assert_eq!(plan(Facts::default()), [Kind::Portal]);
        assert_eq!(plan(Facts { hyprland: true, ..Facts::default() }), [Kind::Hyprland]);
        // The extension wins wherever it runs.
        assert_eq!(plan(Facts { gnome_extension: true, ..Facts::default() }), [Kind::Gnome]);
    }

    #[test]
    fn niri_uses_the_portal_only_where_it_can_grab_keys() {
        // niri 26.04: no portal backend can grab keys, so the kdl binds.
        assert_eq!(plan(Facts { niri: true, ..Facts::default() }), [Kind::Niri]);
        // A later niri serves xdg-desktop-portal-gnome: the portal, and the kdl binds if it refuses.
        assert_eq!(plan(Facts { niri: true, niri_portal: true, ..Facts::default() }), [Kind::Portal, Kind::Niri]);
    }
}
