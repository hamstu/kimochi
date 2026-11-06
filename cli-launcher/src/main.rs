//! `kimochi` on Windows (Settings → Command line copies this to `…\dev.kimochi.app\bin\kimochi.exe`).
//!
//! Kimochi itself is a GUI program, and Windows gives a GUI program none of the shell's standard
//! handles: run directly, its output can't be redirected or piped, and the shell doesn't wait for it.
//! This is a console program, so the shell waits for it and hands it the real handles (a file, a
//! pipe, the console). It runs the app's executable, named in `kimochi.target` beside it, with the
//! same arguments and those handles, and exits with its code. The app's executable attaches to this
//! console (src-tauri/src/cli/console.rs), so Ctrl+C reaches both.
use std::process::Command;

fn main() {
    let target = std::env::current_exe()
        .ok()
        .map(|me| me.with_extension("target"))
        .and_then(|file| std::fs::read_to_string(file).ok())
        .map(|text| text.trim().to_string())
        .filter(|path| !path.is_empty());
    let Some(app) = target else {
        eprintln!("kimochi: this command isn't set up. Install it again from Kimochi's Settings > Command line.");
        std::process::exit(1);
    };
    match Command::new(&app).args(std::env::args_os().skip(1)).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("kimochi: can't run Kimochi at {app}: {error}. Install the command again from Kimochi's Settings > Command line.");
            std::process::exit(1);
        }
    }
}
