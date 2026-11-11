//! The `ext` driver: compositors with the standard ext capture protocols (Hyprland ≥0.50,
//! Sway ≥1.12, COSMIC, and other wlroots-likes). See the table in `mod.rs`.
//!
//! **Inventory.** `ext_foreign_toplevel_list_v1` names every toplevel (identifier, title,
//! app_id) and `wl_output` + `zxdg_output_manager_v1` every output ([`lister`]). The protocol says
//! nothing about where a window is or whether it is in front, so where the compositor has an IPC
//! the driver asks it ([`ipc`]), matching windows by exact identity only:
//!
//! - Hyprland: `hyprland_toplevel_mapping_manager_v1` maps each toplevel to its window address,
//!   which `j/clients` describes (pid, `at`/`size`, workspace, focus history).
//! - Sway: `get_tree` carries each window's `foreign_toplevel_identifier`.
//! - Elsewhere: the wlr foreign-toplevel list says minimized/activated and can activate, for a
//!   toplevel it matches uniquely by app_id and title ([`unique_matches`]); no position or pid.
//!
//! **Capture.** `ext_image_copy_capture_manager_v1` on a toplevel source (or an output source,
//! when offered), into SHM buffers on a thread per stream ([`stream`]). A toplevel capture
//! renders that window alone (no other window, no overlay above it): [`Driver::isolated_windows`].
//! Its size is the window's surface at its output's scale, which is the IPC's rect × scale on
//! Sway and Hyprland (server-side borders are outside both).
use super::{encode_handle, decode_handle, Driver, Feed, Inventory, NativeWindow, Target};
use crate::{CaptureError, Result};

mod ipc;
mod lister;
mod protocols;
mod stream;

use ipc::{Facts, Ipc};
use lister::{Lister, Snap, TopInfo, WlrInfo};

pub fn probe() -> std::result::Result<Box<dyn Driver>, String> {
    let lister = Lister::start()?;
    let ipc = Ipc::detect();
    let ipc = match ipc {
        // Without the mapping protocol nothing ties a toplevel to a Hyprland window exactly.
        Some(Ipc::Hyprland(_)) if !lister.mapping => {
            eprintln!(
                "Wayland capture: ext: Hyprland without {}; no window geometry",
                lister::HYPRLAND_MAPPING
            );
            None
        }
        other => other,
    };
    Ok(Box::new(Ext { lister, ipc }))
}

struct Ext {
    lister: Lister,
    ipc: Option<Ipc>,
}

/// For each of `ext`'s (app_id, title), the index in `wlr` of the one toplevel with the same
/// pair, when the pair is unique on both sides. Anything else is no match: two windows alike
/// could be swapped, so they are left unknown rather than guessed.
pub fn unique_matches(ext: &[(Option<&str>, &str)], wlr: &[(Option<&str>, &str)]) -> Vec<Option<usize>> {
    ext.iter()
        .map(|key| {
            if ext.iter().filter(|k| *k == key).count() != 1 {
                return None;
            }
            let mut found = wlr.iter().enumerate().filter(|(_, k)| *k == key).map(|(i, _)| i);
            match (found.next(), found.next()) {
                (Some(i), None) => Some(i),
                _ => None,
            }
        })
        .collect()
}

fn wlr_matches(snap: &Snap) -> Vec<Option<&WlrInfo>> {
    let ext: Vec<_> = snap.toplevels.iter().map(|t| (t.app_id.as_deref(), t.title.as_str())).collect();
    let wlr: Vec<_> = snap.wlr.iter().map(|w| (w.app_id.as_deref(), w.title.as_str())).collect();
    unique_matches(&ext, &wlr).into_iter().map(|m| m.map(|i| &snap.wlr[i])).collect()
}

fn window(top: &TopInfo) -> NativeWindow {
    NativeWindow {
        handle: encode_handle(&top.identifier),
        title: top.title.clone(),
        app_id: top.app_id.clone(),
        app_name: None,
        pid: None,
        bounds: None,
        output: None,
        minimized: false,
        on_screen: None,
        focused: false,
        auxiliary: false,
    }
}

fn apply(window: &mut NativeWindow, facts: &Facts) {
    window.pid = facts.pid;
    window.bounds = facts.bounds;
    window.output = facts.output.clone();
    window.on_screen = facts.on_screen;
    window.focused = facts.focused;
}

impl Ext {
    fn snapshot(&self) -> Result<Snap> {
        let snap = self.lister.snapshot();
        if let Some(error) = &snap.dead {
            return Err(CaptureError::new("native", format!("Wayland connection lost: {error}")));
        }
        Ok(snap)
    }

    /// The IPC record of a toplevel, by its exact identity.
    fn facts_for<'a>(&self, ipc: &'a ipc::Snapshot, top: &TopInfo) -> Option<&'a Facts> {
        match ipc {
            ipc::Snapshot::Hyprland(by_address) => by_address.get(&top.address?),
            ipc::Snapshot::Sway(by_identifier) => by_identifier.get(&top.identifier),
        }
    }
}

impl Driver for Ext {
    fn name(&self) -> &'static str {
        "ext"
    }

    fn inventory(&self) -> Result<Inventory> {
        let snap = self.snapshot()?;
        let ipc = self.ipc.as_ref().and_then(Ipc::snapshot);
        let mut ranked: Vec<(Option<u32>, NativeWindow)> = Vec::with_capacity(snap.toplevels.len());
        match &ipc {
            Some(ipc) => {
                for top in &snap.toplevels {
                    let mut w = window(top);
                    let facts = self.facts_for(ipc, top);
                    if let Some(facts) = facts {
                        apply(&mut w, facts);
                    }
                    ranked.push((facts.and_then(|f| f.rank), w));
                }
            }
            None => {
                for (top, wlr) in snap.toplevels.iter().zip(wlr_matches(&snap)) {
                    let mut w = window(top);
                    if let Some(wlr) = wlr {
                        w.minimized = wlr.minimized;
                        w.focused = wlr.activated;
                        w.auxiliary = wlr.has_parent;
                        w.output = wlr.outputs.first().cloned();
                        if wlr.minimized {
                            w.on_screen = Some(false);
                        }
                    }
                    ranked.push((Some(if w.focused { 0 } else { 1 }), w));
                }
            }
        }
        // Front to back where the compositor says; the rest after, in list (creation) order.
        ranked.sort_by_key(|(rank, _)| rank.unwrap_or(u32::MAX));
        Ok(Inventory { windows: ranked.into_iter().map(|(_, w)| w).collect(), outputs: snap.outputs })
    }

    fn open(&self, target: Target<'_>) -> Result<Feed> {
        let source = match target {
            Target::Window(w) => stream::Source::Toplevel(
                decode_handle(&w.handle).ok_or_else(|| CaptureError::new("stale_source", "Not a window of this desktop"))?,
            ),
            Target::Output(o) => {
                if !self.lister.output_capture {
                    return Err(CaptureError::new("unsupported", "The compositor cannot capture whole outputs"));
                }
                stream::Source::Output(o.handle.clone())
            }
        };
        stream::open(source)
    }

    fn activate(&self, window: &NativeWindow) -> Result<()> {
        let identifier = decode_handle(&window.handle).ok_or_else(closed)?;
        let snap = self.snapshot()?;
        let top = snap.toplevels.iter().find(|t| t.identifier == identifier).ok_or_else(closed)?;
        let unsupported = || CaptureError::new("unsupported", "This compositor cannot bring that window forward");
        match &self.ipc {
            Some(ipc) => {
                let facts = ipc.snapshot().ok_or_else(|| CaptureError::new("native", "The compositor's IPC did not answer"))?;
                let id = self.facts_for(&facts, top).ok_or_else(unsupported)?.id;
                ipc.activate(id).map_err(|e| CaptureError::new("native", e))
            }
            None => {
                let index = snap.toplevels.iter().position(|t| t.identifier == identifier).ok_or_else(closed)?;
                let wlr = wlr_matches(&snap)[index].ok_or_else(unsupported)?;
                self.lister.activate_wlr(&wlr.proxy, wlr.minimized).map_err(|e| CaptureError::new("native", e))
            }
        }
    }

    fn isolated_windows(&self) -> bool {
        true
    }

    fn bounds_match_stream(&self) -> bool {
        // Bounds only come from IPC, whose rect is the window's surface (borders excluded) on
        // both Sway and Hyprland. Without IPC there are no bounds to compare.
        true
    }
}

fn closed() -> CaptureError {
    CaptureError::new("stale_source", "That window has closed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wlr_toplevels_match_only_when_unique_on_both_sides() {
        let ext = [
            (Some("foot"), "shell"),
            (Some("foot"), "shell"),
            (Some("game"), "Game"),
            (None, "untitled"),
            (Some("mpv"), "video"),
            (Some("app"), "dup in wlr"),
        ];
        let wlr = [
            (Some("game"), "Game"),
            (Some("foot"), "shell"),
            (None, "untitled"),
            (Some("app"), "dup in wlr"),
            (Some("app"), "dup in wlr"),
        ];
        assert_eq!(unique_matches(&ext, &wlr), [None, None, Some(0), Some(2), None, None]);
        assert_eq!(unique_matches(&[], &wlr), Vec::<Option<usize>>::new());
        // Same title, different app: different windows.
        assert_eq!(unique_matches(&[(Some("a"), "x")], &[(Some("b"), "x")]), [None]);
    }
}
