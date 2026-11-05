//! Kimochi's command line: the app's own executable, started with a command (`kimochi status`,
//! `kimochi scan --wait`, …), runs as a small client instead of the app.
//!
//! - `run_if_invoked` is the first thing `main` does. A command never builds a window, takes the
//!   single-instance lock (macOS's take-over would otherwise quit the running app, and the
//!   plugin elsewhere would exit this process), or touches the app's state directly.
//! - It talks to the running app over a token-guarded loopback connection (`endpoint`,
//!   `server`), starting the app first when a command needs it. Reading the Log, sessions and
//!   settings needs only their files, so those also work while the app is closed.
//! - Settings → Command line puts a `kimochi` command on the PATH (`install`).
//!
//! The commands are documented for users in site-docs/…/reference/cli.mdx and the wire methods in
//! COMMANDS.md → "Command line".
mod client;
mod console;
pub mod endpoint;
pub mod install;
pub mod launch;
pub mod server;

/// Words that start the command line (the first argument). Every other first argument that is a
/// bare word is answered as an unknown command too (`is_cli_args`), so a typo never launches —
/// or, on macOS, replaces — the app.
pub const COMMANDS: &[&str] = &[
    "status", "scan", "auto-ocr", "overlay", "ocr", "source", "log", "session", "open", "quit", "settings", "action",
    "watch", "paths", "version", "help",
];

/// Whether these arguments (`argv`, the program first) are a command-line invocation rather than
/// an app launch. The app is launched with no arguments, a `kimochi://` URL (Windows and Linux
/// hand one to a second launch), or an internal `--flag` (Linux's watchdogs, `--check-audio`);
/// none of those is a bare word.
pub fn is_cli_args(args: &[String]) -> bool {
    let Some(first) = args.get(1) else { return false };
    if matches!(first.as_str(), "-h" | "--help" | "-V" | "--version") {
        return true;
    }
    !first.is_empty() && !first.starts_with('-') && !first.contains("://") && !first.contains(['/', '\\'])
}

/// Run as the command line if that is how this process was started, and exit with its code.
pub fn run_if_invoked() {
    let args: Vec<String> = std::env::args().collect();
    if !is_cli_args(&args) {
        return;
    }
    console::attach();
    let exit = client::run(args[1..].to_vec());
    match &exit {
        client::Exit::Failed(message) | client::Exit::Timeout(message) => eprintln!("kimochi: {message}"),
        client::Exit::Usage(message) => eprintln!("kimochi: {message}"),
        client::Exit::NotRunning => eprintln!("kimochi: Kimochi isn't running (and --no-start was given)."),
        client::Exit::Ok => {}
    }
    use std::io::Write;
    let _ = std::io::stdout().flush();
    std::process::exit(exit.code());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("kimochi").chain(args.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn app_launches_are_never_commands() {
        assert!(!is_cli_args(&argv(&[])));
        assert!(!is_cli_args(&argv(&["kimochi://account"])));
        assert!(!is_cli_args(&argv(&["--check-audio", "3"])));
        assert!(!is_cli_args(&argv(&["--gamescope-input-watchdog", "1"])));
        assert!(!is_cli_args(&argv(&["-psn_0_12345"])));
        assert!(!is_cli_args(&argv(&["/home/me/file.png"])));
    }

    #[test]
    fn commands_and_typos_are_commands() {
        assert!(is_cli_args(&argv(&["status"])));
        assert!(is_cli_args(&argv(&["log", "--follow"])));
        assert!(is_cli_args(&argv(&["--help"])));
        assert!(is_cli_args(&argv(&["--version"])));
        assert!(is_cli_args(&argv(&["stauts"])));
        for command in COMMANDS {
            assert!(is_cli_args(&argv(&[command])), "{command}");
        }
    }
}
