//! niri: binds in a config file Kimochi owns.
//!
//! niri 26.04 and earlier have no GlobalShortcuts portal: niri's portals.conf hands the interface
//! to xdg-desktop-portal-gnome, which grabs keys through `org.gnome.Shell`, and only a later niri
//! serves that (niri#4744). Nor can binds be added at runtime as on Hyprland. So Kimochi writes its
//! shortcuts as niri binds to `~/.config/niri/kimochi.kdl`, each running `kimochi action <name>`
//! (the command line's client, `cli/`), rewrites the file whenever they change, and empties it
//! when it quits. niri reloads an included file when it changes, but the user's config has to
//! include it: Settings shows the line, and offers to append it (`append`), never silently.
//!
//! Where the portal can grab keys (`portal_ready`), the generic layer uses it instead and this
//! file stays empty.
use super::{update_report, Backend, Bound, Run, Shortcut};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub(super) struct Niri;

/// Starts every file Kimochi writes; a file without it is someone else's and is never replaced.
const HEADER: &str = "// Kimochi's global shortcuts, written by Kimochi from Settings → Shortcuts & Controls.";
const NOTE: &str = "// Added by Kimochi. Move this line above your own binds if you want yours to win on conflicts.";

impl Backend for Niri {
    fn id(&self) -> &'static str {
        "niri"
    }
    fn bind(&self, _run: &Run, shortcuts: &[Shortcut]) -> Result<Bound, String> {
        let paths = Paths::detect()?;
        let program = program()?;
        let (binds, registered, failed) = render(&program, shortcuts);
        write_binds(&paths.binds, &binds)?;
        let setup = setup(&paths);
        let available = setup["status"] == "active" && !registered.is_empty();
        Ok(Bound {
            report: json!({"backend":"niri","pending":false,"registered":registered,"failed":failed,"niri":setup}),
            available,
            listen: None,
        })
    }
    fn rebinds_in_place(&self) -> bool {
        true
    }
    fn stop(&self) {
        // Emptied rather than removed, so an include without `optional` still loads.
        if let Ok(paths) = Paths::detect() {
            if std::fs::read_to_string(&paths.binds).is_ok_and(|s| s.starts_with(HEADER) && has_binds(&s)) {
                let _ = write_binds(&paths.binds, &file(&[]));
            }
        }
    }
}

fn has_binds(text: &str) -> bool {
    text.lines().any(|line| line.contains("spawn "))
}

/// Whether the GlobalShortcuts portal can grab keys on this niri: a niri that implements
/// `org.gnome.Shell` for xdg-desktop-portal-gnome owns that name on the session bus.
pub(super) fn portal_ready() -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else { return false };
    let Ok(bus) = zbus::blocking::fdo::DBusProxy::new(&connection) else { return false };
    let Ok(name) = zbus::names::BusName::try_from("org.gnome.Shell") else { return false };
    bus.name_has_owner(name).unwrap_or(false)
}

// ------------------------------------------------------------------------------ paths

struct Paths {
    /// `~/.config/niri` (`$XDG_CONFIG_HOME/niri`).
    dir: PathBuf,
    /// niri's config: `$NIRI_CONFIG`, else `config.kdl` there.
    config: PathBuf,
    /// The file Kimochi owns: `kimochi.kdl` there.
    binds: PathBuf,
    home: PathBuf,
}

impl Paths {
    fn detect() -> Result<Paths, String> {
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME unavailable")?);
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        let dir = base.join("niri");
        let config = std::env::var_os("NIRI_CONFIG")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| dir.join("config.kdl"));
        Ok(Paths { binds: dir.join("kimochi.kdl"), dir, config, home })
    }
}

/// The program a bind runs: the AppImage itself, not its mount, which changes every launch.
fn program() -> Result<PathBuf, String> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| std::env::current_exe().map_err(|e| e.to_string()))
}

// ------------------------------------------------------------------------------ binds

/// A KDL string.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// An Electron-style accelerator (`CommandOrControl+Shift+S`) as a niri key (`Ctrl+Shift+S`).
fn key(accelerator: &str) -> Option<String> {
    let mut parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    let key = parts.pop().filter(|k| !k.is_empty())?;
    let mut mods: Vec<&str> = Vec::new();
    for part in parts {
        let modifier = match part {
            "CommandOrControl" | "CmdOrCtrl" | "Control" | "Ctrl" => "Ctrl",
            "Shift" => "Shift",
            "Alt" | "Option" => "Alt",
            "Super" | "Meta" | "Command" | "Cmd" => "Super",
            _ => return None,
        };
        if !mods.contains(&modifier) {
            mods.push(modifier);
        }
    }
    let named = match key {
        "Space" => "space",
        "Enter" | "Return" => "Return",
        "Esc" | "Escape" => "Escape",
        "ScrollLock" => "Scroll_Lock",
        "PageUp" => "Page_Up",
        "PageDown" => "Page_Down",
        "Plus" => "plus",
        "-" => "minus",
        "=" => "equal",
        "[" => "bracketleft",
        "]" => "bracketright",
        "\\" => "backslash",
        ";" => "semicolon",
        "'" => "apostrophe",
        "," => "comma",
        "." => "period",
        "/" => "slash",
        "`" => "grave",
        other => match other.strip_prefix("Num") {
            Some(digit) if digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit()) => {
                return Some(
                    mods.iter().map(|m| m.to_string()).chain([format!("KP_{digit}")]).collect::<Vec<_>>().join("+"),
                )
            }
            _ => other,
        },
    };
    // A keysym name, nothing a config could misread.
    if !named.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(mods.iter().copied().chain([named]).collect::<Vec<_>>().join("+"))
}

/// One bind per shortcut with keys, the shortcuts bound, and the ones niri could not take.
fn render(program: &Path, shortcuts: &[Shortcut]) -> (String, Vec<String>, Vec<Value>) {
    let program = quoted(&program.to_string_lossy());
    let mut lines = Vec::new();
    let mut registered = Vec::new();
    let mut failed = Vec::new();
    for shortcut in shortcuts {
        if shortcut.accelerator.is_empty() || !crate::actions::ACTIONS.contains(&shortcut.name.as_str()) {
            continue;
        }
        let Some(key) = key(&shortcut.accelerator) else {
            failed.push(json!({"name":shortcut.name,"accelerator":shortcut.accelerator,"error":"niri has no name for this key"}));
            continue;
        };
        lines.push(format!(
            "{key} repeat=false hotkey-overlay-title={} {{ spawn {program} \"action\" {} \"--no-start\"; }}",
            quoted(&format!("Kimochi: {}", shortcut.description)),
            quoted(&shortcut.name)
        ));
        registered.push(shortcut.name.clone());
    }
    (file(&lines), registered, failed)
}

fn file(lines: &[String]) -> String {
    let mut text = format!(
        "{HEADER}\n// It is rewritten whenever they change and emptied when Kimochi quits: change the keys in Kimochi.\nbinds {{\n"
    );
    for line in lines {
        text.push_str("    ");
        text.push_str(line);
        text.push('\n');
    }
    text.push_str("}\n");
    text
}

/// Replace Kimochi's file in one step (niri never reads half of it). Someone else's file of the
/// same name is left alone.
fn write_binds(path: &Path, text: &str) -> Result<(), String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == text {
            return Ok(());
        }
        if !existing.trim().is_empty() && !existing.starts_with(HEADER) {
            return Err(format!(
                "{} is not Kimochi's: move it away to let Kimochi write its binds there",
                path.display()
            ));
        }
    }
    let dir = path.parent().ok_or("no folder for kimochi.kdl")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let temporary = dir.join(".kimochi.kdl.tmp");
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------------------ setup

/// niri's version as `(year, month)`: the running compositor's, else the installed one's.
fn version() -> Option<(u32, u32)> {
    let run = |args: &[&str]| {
        niri(args, &[]).ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let running = run(&["msg", "--json", "version"])
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["compositor"].as_str().map(str::to_owned));
    parse_version(&running.or_else(|| run(&["--version"]))?)
}

/// Run `niri` and wait at most two seconds: `niri msg` waits on the compositor, which must never
/// hang the shortcuts (or Settings) when niri itself is stuck.
fn niri(args: &[&str], env: &[(&str, &str)]) -> Result<std::process::Output, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut child = Command::new("niri")
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return child.wait_with_output().map_err(|e| e.to_string());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("niri {} didn't answer within 2 s", args.first().unwrap_or(&"")));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `niri 26.04 (8ed0da4)`, `26.04 (8ed0da4)`, `25.11`.
fn parse_version(text: &str) -> Option<(u32, u32)> {
    let word = text.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut parts = word.split('.');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()?;
    Some((year, month))
}

/// How this niri can include a file: `include optional=true` (26.04), a plain `include` (25.11),
/// or not at all. Unknown: as the newest, since `append` validates before keeping anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Include {
    Optional,
    Plain,
    Unsupported,
}

fn include_support(version: Option<(u32, u32)>) -> Include {
    match version {
        Some(v) if v >= (26, 4) => Include::Optional,
        Some(v) if v >= (25, 11) => Include::Plain,
        Some(_) => Include::Unsupported,
        None => Include::Optional,
    }
}

/// The line that includes `binds` from `config`: relative when they share a folder, else from home.
fn include_line(paths: &Paths, support: Include) -> String {
    let same_folder = paths.config.parent().is_some_and(|dir| dir == paths.dir)
        || (canonical(paths.config.parent().unwrap_or(Path::new("/"))) == canonical(&paths.dir));
    let target = if same_folder {
        "kimochi.kdl".to_owned()
    } else if let Ok(rest) = paths.binds.strip_prefix(&paths.home) {
        format!("~/{}", rest.display())
    } else {
        paths.binds.display().to_string()
    };
    let optional = if support == Include::Optional { "optional=true " } else { "" };
    format!("include {optional}{}", quoted(&target))
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The path an `include` line names, if `line` is one (not commented out).
fn included(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix("include")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    // The path is the node's one argument; properties (`optional=true`) are skipped.
    let mut rest = rest.trim_start();
    loop {
        if let Some(body) = rest.strip_prefix('"') {
            let mut out = String::new();
            let mut chars = body.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => return Some(out),
                    '\\' => out.push(chars.next()?),
                    other => out.push(other),
                }
            }
            return None;
        }
        if let Some(raw) = rest.strip_prefix('r').filter(|r| r.starts_with(['#', '"'])) {
            let hashes = raw.chars().take_while(|c| *c == '#').count();
            let body = raw[hashes..].strip_prefix('"')?;
            let end = body.find(&format!("\"{}", "#".repeat(hashes)))?;
            return Some(body[..end].to_owned());
        }
        // A property (`optional=true`): past it to the next token.
        let token = rest.find(char::is_whitespace)?;
        if !rest[..token].contains('=') {
            return None;
        }
        rest = rest[token..].trim_start();
    }
}

/// Whether `config` (or a file it includes) includes `binds`.
fn includes(config: &Path, binds: &Path, home: &Path) -> bool {
    fn walk(file: &Path, binds: &Path, home: &Path, depth: usize, seen: &mut Vec<PathBuf>) -> bool {
        let real = canonical(file);
        if depth > 8 || seen.contains(&real) {
            return false;
        }
        seen.push(real);
        let Ok(text) = std::fs::read_to_string(file) else { return false };
        let dir = file.parent().unwrap_or(Path::new("/"));
        let mut in_block_comment = false;
        for line in text.lines() {
            let trimmed = line.trim_start();
            if in_block_comment {
                in_block_comment = !trimmed.contains("*/");
                continue;
            }
            if trimmed.starts_with("/*") {
                in_block_comment = !trimmed.contains("*/");
                continue;
            }
            let Some(target) = included(trimmed) else { continue };
            let path = if let Some(rest) = target.strip_prefix("~/") { home.join(rest) } else { dir.join(&target) };
            if path == binds || canonical(&path) == canonical(binds) || walk(&path, binds, home, depth + 1, seen) {
                return true;
            }
        }
        false
    }
    walk(config, binds, home, 0, &mut Vec::new())
}

/// Why Kimochi will not append to the config itself, if it will not.
fn blocked(config: &Path) -> Option<&'static str> {
    let Ok(real) = std::fs::canonicalize(config) else { return Some("missing") };
    if real.starts_with("/nix/store") {
        return Some("nix");
    }
    if !std::fs::metadata(&real).is_ok_and(|m| m.is_file()) {
        return Some("notFile");
    }
    // Opening to append changes nothing, and is the one test that counts (permissions, a
    // read-only mount, an immutable file).
    if std::fs::OpenOptions::new().append(true).open(&real).is_err() {
        return Some("readOnly");
    }
    None
}

/// `globalShortcutReport.niri`.
fn setup(paths: &Paths) -> Value {
    let support = include_support(version());
    let line = include_line(paths, support);
    let included = includes(&paths.config, &paths.binds, &paths.home);
    let status = match (included, support) {
        (true, _) => "active",
        (false, Include::Unsupported) => "unsupported",
        (false, _) => "needsSetup",
    };
    // Home Manager and the like keep the config in the store: its own source needs the line.
    let nix_line = format!(
        "include {}\"~/.config/niri/kimochi.kdl\"",
        if support == Include::Optional { "optional=true " } else { "" }
    );
    json!({
        "status": status,
        "includeLine": line,
        "nixIncludeLine": nix_line,
        "config": paths.config.display().to_string(),
        "binds": paths.binds.display().to_string(),
        "blocked": if included { None } else { blocked(&paths.config) },
    })
}

/// Re-read whether the config includes Kimochi's binds (the user may have added the line).
pub fn refresh() -> Result<Value, String> {
    let paths = Paths::detect()?;
    let niri = setup(&paths);
    update_report(|report| {
        if report["backend"] != "niri" {
            return None;
        }
        report["niri"] = niri.clone();
        Some(niri["status"] == "active" && report["registered"].as_array().is_some_and(|r| !r.is_empty()))
    });
    Ok(niri)
}

/// "Add to my niri config": back up the config, append the include line, validate, and put the
/// backup back if niri rejects the result. Appends only: the file is never parsed and rewritten.
pub fn append() -> Result<Value, String> {
    let paths = Paths::detect()?;
    if includes(&paths.config, &paths.binds, &paths.home) {
        return refresh();
    }
    let support = include_support(version());
    if support == Include::Unsupported {
        return Err("This niri is older than 25.11, which can't include another file. Update niri, or copy the binds into your config.".into());
    }
    match blocked(&paths.config) {
        None => {}
        Some("nix") => return Err("Your niri config is in the Nix store. Add the line to its source (your Home Manager or NixOS configuration) instead.".into()),
        Some("readOnly") => return Err(format!("{} can't be written. Add the line yourself.", paths.config.display())),
        Some(_) => return Err(format!("There is no niri config at {}. Add the line to your config yourself.", paths.config.display())),
    }
    // A config that doesn't load already is the reader's to fix: appending can't be checked.
    if let Err(error) = validate(&paths.config) {
        return Err(format!("Your niri config doesn't load as it is, so Kimochi left it alone. {error}"));
    }
    // A plain include of a missing file breaks the config, so the file comes first (it exists
    // once shortcuts have been applied; an empty one otherwise).
    if !paths.binds.exists() {
        write_binds(&paths.binds, &file(&[]))?;
    }
    let real = std::fs::canonicalize(&paths.config).map_err(|e| e.to_string())?;
    let original = std::fs::read(&real).map_err(|e| e.to_string())?;
    let now = time::OffsetDateTime::now_utc();
    let stamp = format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "config.kdl".into());
    let backup = real.with_file_name(format!("{name}.bak-kimochi-{stamp}"));
    std::fs::write(&backup, &original).map_err(|e| format!("Couldn't back up your niri config: {e}"))?;
    let mut addition = String::new();
    if !original.is_empty() && !original.ends_with(b"\n") {
        addition.push('\n');
    }
    addition.push_str(&format!("\n{NOTE}\n{}\n", include_line(&paths, support)));
    let appended = std::fs::OpenOptions::new()
        .append(true)
        .open(&real)
        .and_then(|mut f| f.write_all(addition.as_bytes()).and_then(|_| f.flush()));
    if let Err(e) = appended {
        restore(&real, &original);
        return Err(format!("Couldn't add the line: {e}"));
    }
    if let Err(error) = validate(&paths.config) {
        restore(&real, &original);
        return Err(format!("niri rejected the config with the line added, so it was put back as it was. {error}"));
    }
    refresh()
}

/// Put the config's old contents back in place (the same file, so a symlink stays one).
fn restore(real: &Path, original: &[u8]) {
    let _ = std::fs::write(real, original);
}

fn validate(config: &Path) -> Result<(), String> {
    let config = config.to_string_lossy();
    let output = niri(&["validate", "-c", &config], &[("NO_COLOR", "1")])
        .map_err(|e| format!("Couldn't run niri validate: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&output.stderr);
    let text: String = strip_ansi(&text)
        .lines()
        .filter(|l| !l.contains(" DEBUG ") && !l.contains(" INFO "))
        .collect::<Vec<_>>()
        .join("\n");
    Err(text.trim().chars().take(600).collect())
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ … final byte in @–~.
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(name: &str, accelerator: &str) -> Shortcut {
        Shortcut { name: name.into(), accelerator: accelerator.into(), description: "Scan text".into() }
    }

    #[test]
    fn keys_use_niri_names() {
        assert_eq!(key("CommandOrControl+Shift+S").as_deref(), Some("Ctrl+Shift+S"));
        assert_eq!(key("Alt+Space").as_deref(), Some("Alt+space"));
        assert_eq!(key("Super+PageUp").as_deref(), Some("Super+Page_Up"));
        assert_eq!(key("Ctrl+`").as_deref(), Some("Ctrl+grave"));
        assert_eq!(key("Shift+Num5").as_deref(), Some("Shift+KP_5"));
        assert_eq!(key("Insert").as_deref(), Some("Insert"));
        assert_eq!(key("Hyper+X"), None);
        assert_eq!(key("Ctrl+\"").as_deref(), None);
    }

    #[test]
    fn render_writes_one_bind_per_action_with_keys() {
        let shortcuts = [
            shortcut("triggerScan", "Alt+Z"),
            shortcut("toggleOverlay", ""),
            shortcut("notAnAction", "Alt+Q"),
            shortcut("playAudio", "Ctrl+\""),
        ];
        let (text, registered, failed) = render(Path::new("/opt/Kimochi \"x\".AppImage"), &shortcuts);
        assert!(text.starts_with(HEADER));
        assert!(text.contains(
            r#"Alt+Z repeat=false hotkey-overlay-title="Kimochi: Scan text" { spawn "/opt/Kimochi \"x\".AppImage" "action" "triggerScan" "--no-start"; }"#
        ));
        assert_eq!(registered, ["triggerScan"]);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["name"], "playAudio");
        assert!(!has_binds(&file(&[])));
    }

    #[test]
    fn versions_decide_the_include() {
        assert_eq!(parse_version("niri 26.04 (8ed0da4)"), Some((26, 4)));
        assert_eq!(parse_version("25.11 (abc)"), Some((25, 11)));
        assert_eq!(include_support(Some((26, 4))), Include::Optional);
        assert_eq!(include_support(Some((26, 1))), Include::Plain);
        assert_eq!(include_support(Some((25, 11))), Include::Plain);
        assert_eq!(include_support(Some((25, 8))), Include::Unsupported);
    }

    #[test]
    fn include_lines_are_read_in_every_spelling() {
        assert_eq!(included(r#"include "kimochi.kdl""#).as_deref(), Some("kimochi.kdl"));
        assert_eq!(
            included(r#"  include optional=true "~/.config/niri/kimochi.kdl""#).as_deref(),
            Some("~/.config/niri/kimochi.kdl")
        );
        assert_eq!(included(r##"include r#"./kimochi.kdl"#"##).as_deref(), Some("./kimochi.kdl"));
        assert_eq!(included(r#"// include "kimochi.kdl""#), None);
        assert_eq!(included(r#"/-include "kimochi.kdl""#), None);
        assert_eq!(included(r#"includes "kimochi.kdl""#), None);
        assert_eq!(included(r#"include optional=true r"kimochi.kdl""#).as_deref(), Some("kimochi.kdl"));
        assert_eq!(included(r#"include optional=false "a\"b.kdl""#).as_deref(), Some("a\"b.kdl"));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kimochi-niri-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join("niri"));
        dir
    }

    #[test]
    fn an_include_is_found_however_it_names_the_file() {
        let home = scratch("includes");
        let niri = home.join("niri");
        let binds = niri.join("kimochi.kdl");
        let config = niri.join("config.kdl");
        for (text, found) in [
            ("binds {}\ninclude optional=true \"kimochi.kdl\"\n", true),
            ("include \"./kimochi.kdl\"\n", true),
            ("include \"~/niri/kimochi.kdl\"\n", true),
            ("// include \"kimochi.kdl\"\n", false),
            ("/*\ninclude \"kimochi.kdl\"\n*/\n", false),
            ("include \"other.kdl\"\n", true), // other.kdl includes it
        ] {
            std::fs::write(niri.join("other.kdl"), "include \"kimochi.kdl\"\n").unwrap();
            std::fs::write(&config, text).unwrap();
            assert_eq!(includes(&config, &binds, &home), found, "{text}");
        }
        std::fs::write(niri.join("other.kdl"), "include \"config.kdl\"\n").unwrap();
        std::fs::write(&config, "include \"other.kdl\"\n").unwrap();
        assert!(!includes(&config, &binds, &home), "a cycle ends");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_include_line_is_relative_beside_the_config() {
        let home = PathBuf::from("/home/u");
        let mut paths = Paths {
            dir: home.join(".config/niri"),
            config: home.join(".config/niri/config.kdl"),
            binds: home.join(".config/niri/kimochi.kdl"),
            home: home.clone(),
        };
        assert_eq!(include_line(&paths, Include::Optional), r#"include optional=true "kimochi.kdl""#);
        assert_eq!(include_line(&paths, Include::Plain), r#"include "kimochi.kdl""#);
        paths.config = PathBuf::from("/etc/niri/config.kdl");
        assert_eq!(include_line(&paths, Include::Optional), r#"include optional=true "~/.config/niri/kimochi.kdl""#);
    }

    #[test]
    fn a_file_kimochi_did_not_write_is_left_alone() {
        let dir = scratch("foreign");
        let path = dir.join("niri/kimochi.kdl");
        std::fs::write(&path, "binds { Mod+T { spawn \"x\"; } }\n").unwrap();
        assert!(write_binds(&path, &file(&[])).is_err());
        std::fs::write(&path, file(&["Alt+Z { spawn \"k\"; }".into()])).unwrap();
        assert!(write_binds(&path, &file(&[])).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), file(&[]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blocked_says_why() {
        let dir = scratch("blocked");
        let config = dir.join("niri/config.kdl");
        assert_eq!(blocked(&config), Some("missing"));
        std::fs::write(&config, "").unwrap();
        assert_eq!(blocked(&config), None);
        let mut permissions = std::fs::metadata(&config).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&config, permissions).unwrap();
        // root can write anything; the check is only meaningful as a user.
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(blocked(&config), Some("readOnly"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ansi_colours_are_dropped() {
        assert_eq!(strip_ansi("\u{1b}[2m2026\u{1b}[0m x"), "2026 x");
    }
}
