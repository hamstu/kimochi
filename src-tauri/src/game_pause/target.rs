//! Which game a pause is for: the selected window's process, else the frontmost window's, plus
//! what Gaming Mode knows. OS-specific tree walking is the backend's (`Backend::plan`).
use super::backend::GameRef;

/// The game for the current selection. `selection` is the selected source id string (if any),
/// `frontmost` the frontmost window's pid (when no window is selected), `steam_app_id` Gamescope's
/// focused app in Gaming Mode.
pub fn game_ref(selection: Option<&str>, frontmost: Option<u32>, steam_app_id: Option<u32>) -> GameRef {
    let parsed = selection.and_then(kimochi_capture::SourceId::parse);
    let pid = parsed.as_ref().and_then(|id| id.pid()).or(frontmost);
    let window = parsed.as_ref().filter(|id| id.pid().is_some()).and_then(|id| id.handle().parse::<u64>().ok());
    GameRef { pid, source: selection.map(str::to_owned), window, steam_app_id, title: None }
}
