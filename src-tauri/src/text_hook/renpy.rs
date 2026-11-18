//! Ren'Py dialogue without the hooker. LunaHook reaches a Ren'Py game's text through the Python
//! runtime's string functions, which run for every string the engine handles: its threads mix the
//! quick menu's labels, missing-image errors, the speaker glued to the line, repeats and lines
//! still to come (an `extend` laid out ahead), while the one clean thread sees a third of the lines.
//!
//! The voice hook DLL, which already runs Python inside Ren'Py for its audio, wraps the engine's
//! own `display_say` and sends what the say screen shows as it shows it: the line up to where it
//! is shown (a `{w}`/`{p}` pause shows it in parts, each the line so far), text tags out, the
//! speaker apart, and each choice menu as it opens. Kimochi asks for it as it asks for a Unity
//! game's text (`unity::request`), and reads the `text` events from the same capture. The say
//! screen is one thread (`RENPY:say`), choice menus another (`RENPY:menu`); the say thread is the
//! game's dialogue, so it is chosen as soon as it speaks.
use std::path::Path;

/// What the hook codes of the threads this makes start with (then the object: `say`, `menu`).
const HOOKCODE: &str = "RENPY:";

/// Whether a thread is the Ren'Py text the DLL reads.
pub fn is_renpy(hookcode: &str) -> bool {
    hookcode.starts_with(HOOKCODE)
}

/// Whether a thread is the say screen's dialogue: the game's line, whenever it speaks.
pub fn is_dialogue(hookcode: &str) -> bool {
    hookcode == "RENPY:say"
}

/// Whether a text the DLL read is Ren'Py's (`method` of its event), not a Unity object's.
pub fn is_renpy_text(method: &str) -> bool {
    method.starts_with("renpy.")
}

/// The thread a Ren'Py text object becomes: its key, hook code and name.
pub fn thread_of(pid: u32, obj: &str) -> (String, String, String) {
    let name = if obj == "menu" { "Ren'Py menu" } else { "Ren'Py dialogue" };
    (format!("{pid}:renpy:{obj}"), format!("{HOOKCODE}{obj}"), name.to_string())
}

/// Whether `exe` runs a Ren'Py game: the engine (`renpy/`) and the game (`game/`) beside it, or
/// two folders up for Ren'Py 6/7's `lib/<platform>/` executable, which the launcher starts.
pub fn is_renpy_game(exe: &Path) -> bool {
    exe.ancestors().skip(1).take(3).any(|dir| dir.join("renpy").is_dir() && dir.join("game").is_dir())
}

/// How a line from the say screen follows the thread's last: `Some(true)` when it is that line
/// shown further (the next part after a `{w}`/`{p}` pause, or an `extend`), which replaces it.
pub fn carries_on(before: &str, text: &str) -> bool {
    !before.is_empty() && text != before && text.starts_with(before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threads_are_told_by_their_hook_code() {
        let (key, hookcode, name) = thread_of(42, "say");
        assert_eq!(key, "42:renpy:say");
        assert!(is_renpy(&hookcode) && is_dialogue(&hookcode));
        assert_eq!(name, "Ren'Py dialogue");
        let (_, menu, _) = thread_of(42, "menu");
        assert!(is_renpy(&menu) && !is_dialogue(&menu));
        assert!(!is_renpy("UNITY:TMP_Text.set_text"));
        assert!(!is_renpy("HQN-4@0:python27.dll"));
        assert!(is_renpy_text("renpy.say") && !is_renpy_text("TMP_Text.set_text"));
    }

    #[test]
    fn renpy_games_are_told_by_engine_and_game_folders() {
        let base = std::env::temp_dir().join(format!("kimochi-renpy-game-{}", std::process::id()));
        std::fs::create_dir_all(base.join("lib").join("windows-i686")).unwrap();
        assert!(!is_renpy_game(&base.join("Game.exe")));
        std::fs::create_dir_all(base.join("renpy")).unwrap();
        assert!(!is_renpy_game(&base.join("Game.exe")), "no game folder");
        std::fs::create_dir_all(base.join("game")).unwrap();
        assert!(is_renpy_game(&base.join("Game.exe")));
        assert!(is_renpy_game(&base.join("lib").join("windows-i686").join("Game.exe")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_line_shown_further_carries_on() {
        assert!(carries_on("おはよう。", "おはよう。今日も晴れ。"));
        assert!(carries_on("一行目。", "一行目。\n二行目。"));
        assert!(!carries_on("おはよう。", "おはよう。"));
        assert!(!carries_on("", "おはよう。"));
        assert!(!carries_on("おはよう。", "こんにちは。"));
    }
}
