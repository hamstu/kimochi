//! Hyprland: the portal registers Kimochi's shortcuts, but fires one only for a bind naming it, so
//! Kimochi adds those binds at runtime (`platform/linux/hyprland_binds.rs`). Hyprland also takes
//! modifier-only, non-consuming binds, so the dictionary's held Shift is offered here too.
use super::portal::{self, Held};
use super::{Backend, Bound, Run, Shortcut};
use crate::platform::linux::hyprland_binds;
use serde_json::{json, Value};

pub(super) struct Hyprland;

const SHIFT: [Held; 2] = [
    Held { name: "dictionaryShiftLeft", key: "Shift_L", description: "Hold Shift for dictionary lookup" },
    Held { name: "dictionaryShiftRight", key: "Shift_R", description: "Hold Shift for dictionary lookup" },
];

impl Backend for Hyprland {
    fn id(&self) -> &'static str {
        "portal"
    }
    fn bind(&self, run: &Run, shortcuts: &[Shortcut]) -> Result<Bound, String> {
        let keyed: Vec<hyprland_binds::Shortcut> = shortcuts
            .iter()
            .map(|s| hyprland_binds::Shortcut {
                id: portal::id(&s.name),
                accelerator: s.accelerator.clone(),
                description: s.description.clone(),
                passive: false,
            })
            .chain(SHIFT.iter().map(|h| hyprland_binds::Shortcut {
                id: portal::id(h.name),
                accelerator: h.key.to_owned(),
                description: h.description.to_owned(),
                passive: true,
            }))
            .collect();
        portal::bind(run, shortcuts, &SHIFT, |bound| {
            if !hyprland_binds::available() {
                return Vec::new();
            }
            let keyed: Vec<_> = keyed.into_iter().filter(|k| bound.contains(&k.id)).collect();
            let accelerators: Vec<_> = keyed.iter().map(|k| (k.id.clone(), k.accelerator.clone())).collect();
            hyprland_binds::bind(keyed)
                .into_iter()
                .map(|(id, error)| {
                    let accelerator = accelerators.iter().find(|(k, _)| *k == id).map(|(_, a)| a.clone());
                    json!({"name": id.strip_prefix("dev.kimochi.app.").unwrap_or(&id), "accelerator": accelerator, "error": error, "hyprland": true})
                })
                .collect()
        })
    }
    fn stop(&self) {
        hyprland_binds::unbind();
        super::portal::Portal.stop();
    }
}

/// What to do about shortcuts Kimochi could not bind on Hyprland, if any.
pub(super) fn remediation(report: &Value) -> Option<String> {
    let failed: Vec<String> = report["failed"]
        .as_array()?
        .iter()
        .filter(|f| f["hyprland"] == true)
        .filter_map(|f| Some(format!("{} ({})", f["name"].as_str()?, f["error"].as_str()?)))
        .collect();
    (!failed.is_empty()).then(|| format!(
        "Hyprland could not take these shortcuts: {}. Choose another key here, or bind one in your Hyprland config to the global shortcut Kimochi:dev.kimochi.app.<name>.",
        failed.join("; ")))
}
