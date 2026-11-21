//! Shortcuts through Kimochi's GNOME Shell extension: it grabs the keys and calls back
//! (`platform/linux/gnome.rs` → `dispatch`).
use super::{report, Backend, Bound, Run, Shortcut};
use crate::{actions, state::Shared};
use serde_json::{json, Value};
use tauri::Manager;

pub(super) struct Gnome;

impl Backend for Gnome {
    fn id(&self) -> &'static str {
        "gnome-shell"
    }
    fn bind(&self, _run: &Run, shortcuts: &[Shortcut]) -> Result<Bound, String> {
        let bindings: Vec<Value> = shortcuts
            .iter()
            .filter(|s| actions::ACTIONS.contains(&s.name.as_str()) && !s.accelerator.is_empty())
            .map(|s| json!({"name":s.name,"accelerator":gtk_trigger(&s.accelerator)}))
            .collect();
        let result = crate::platform::linux::gnome::request("shortcuts", json!({"bindings":bindings}))?;
        let available = result["registered"].as_array().is_some_and(|v| !v.is_empty());
        Ok(Bound { report: result, available, listen: None })
    }
    fn stop(&self) {
        if report()["backend"] == "gnome-shell" {
            let _ = crate::platform::linux::gnome::request("shortcuts", json!({"bindings":[]}));
        }
    }
}

/// A press the extension reports, if that shortcut is one it was given.
pub fn dispatch(app: &tauri::AppHandle, name: &str) {
    let allowed = report();
    if super::available()
        && allowed["backend"] == "gnome-shell"
        && allowed["registered"].as_array().is_some_and(|keys| keys.iter().any(|key| key == name))
        && actions::ACTIONS.contains(&name)
    {
        crate::record(
            app,
            &app.state::<Shared>(),
            json!({"check":"global-shortcut-activated","backend":"gnome-shell","action":name}),
        );
        actions::dispatch(app, &app.state::<Shared>(), name);
    }
}

fn gtk_trigger(accelerator: &str) -> String {
    let mut result = String::new();
    for part in accelerator.split('+') {
        result.push_str(match part {
            "CommandOrControl" | "Control" | "Ctrl" => "<Control>",
            "Shift" => "<Shift>",
            "Alt" => "<Alt>",
            "Super" | "Meta" => "<Super>",
            "Space" => "space",
            "Enter" => "Return",
            other => other,
        });
    }
    result
}
