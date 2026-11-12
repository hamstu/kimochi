//! The `kimochi` command: parses the arguments, finds (or starts) the running app, sends it one
//! request and prints the answer. What needs only files (the Log, sessions, settings, paths)
//! works without the app. See site-docs/src/content/docs/reference/cli.mdx for the user's guide.
use super::endpoint::{self, CallError, Endpoint};
use serde_json::{json, Value};
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const DOCS: &str = "https://docs.kimochiapp.com/reference/cli/";

/// How the command ended, as an exit code.
pub enum Exit {
    Ok,
    /// Something went wrong (the app's message, or ours).
    Failed(String),
    /// The command line itself was wrong.
    Usage(String),
    /// Kimochi is not running and `--no-start` was given.
    NotRunning,
    Timeout(String),
}

impl Exit {
    pub fn code(&self) -> i32 {
        match self {
            Exit::Ok => 0,
            Exit::Failed(_) => 1,
            Exit::Usage(_) => 2,
            Exit::NotRunning => 3,
            Exit::Timeout(_) => 4,
        }
    }
}

type Outcome = Result<(), Exit>;

// ------------------------------------------------------------------------------ arguments

/// Options taking a value, wherever they appear.
const VALUED: &[&str] = &["--timeout", "-n", "--lines", "--session"];
/// Switches, wherever they appear.
const SWITCHES: &[&str] = &["--json", "--no-start", "-h", "--help", "--wait", "-f", "--follow", "--all", "--list", "-V", "--version"];

#[derive(Default, Debug)]
pub struct Args {
    pub words: Vec<String>,
    pub json: bool,
    pub no_start: bool,
    pub help: bool,
    pub timeout: Option<f64>,
    pub wait: bool,
    pub follow: bool,
    pub all: bool,
    pub list: bool,
    pub lines: Option<usize>,
    pub session: Option<String>,
    pub version: bool,
}

pub fn parse(raw: &[String]) -> Result<Args, String> {
    let mut args = Args::default();
    let mut rest = raw.iter();
    let mut literal = false;
    while let Some(arg) = rest.next() {
        if literal || !arg.starts_with('-') || arg == "-" || arg.parse::<f64>().is_ok() {
            args.words.push(arg.clone());
            continue;
        }
        if arg == "--" {
            literal = true;
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if arg.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        if VALUED.contains(&name) {
            let value = inline.or_else(|| rest.next().cloned()).ok_or_else(|| format!("{name} needs a value"))?;
            match name {
                "--timeout" => {
                    args.timeout = Some(value.parse::<f64>().ok().filter(|s| *s > 0.0).ok_or("--timeout takes a number of seconds")?)
                }
                "-n" | "--lines" => args.lines = Some(value.parse().map_err(|_| format!("{name} takes a number of lines"))?),
                _ => args.session = Some(value),
            }
            continue;
        }
        if !SWITCHES.contains(&name) || inline.is_some() {
            return Err(format!("unknown option {arg}"));
        }
        match name {
            "--json" => args.json = true,
            "--no-start" => args.no_start = true,
            "-h" | "--help" => args.help = true,
            "--wait" => args.wait = true,
            "-f" | "--follow" => args.follow = true,
            "--all" => args.all = true,
            "--list" => args.list = true,
            _ => args.version = true,
        }
    }
    Ok(args)
}

// ------------------------------------------------------------------------------ help

const OVERVIEW: &str = "\
Kimochi from the command line: drive the app from scripts, shortcuts and your own tools.

Usage: kimochi <command> [options]

Reading
  status                          What Kimochi is reading, and how
  scan [--wait]                   Scan the source now; --wait prints the text it read
  auto-ocr [on|off|toggle]        Show or set Auto OCR
  overlay [show|hide|toggle]      Show or set the overlay
  overlay text [show|hide|toggle] Show or hide the scanned text drawn over the source
  ocr [<engine>]                  List the OCR engines, or switch to one
  source [list|set <name>|clear|choose]
                                  Show, list or choose what Kimochi reads

The Log
  log [-n <count>] [--all] [--session <name>] [--follow]
                                  Print the Log's lines; --follow keeps printing new ones
  log add [<text>|-]              Add a line to the Log (reads stdin with - or a pipe)
  session [list|switch <name>|new [<name>]|rename <name>]
                                  Show, list, switch, start or rename sessions

The app
  open [log|notebook|anki|settings [<page>]|sources|mini|dictionary]
                                  Start Kimochi or bring a window forward
  quit                            Quit Kimochi
  settings [get <key>|set <key> <value>|list|path]
                                  Read and change settings
  action <name> | action --list   Fire one of Kimochi's actions
  watch [<event>...]              Stream events as JSON lines
  paths                           Where Kimochi keeps its files
  version                         This command's version, and the app's

Options
  --json          Machine-readable output
  --no-start      Don't start Kimochi when it isn't running (exit code 3 instead)
  --timeout <s>   How long to wait for Kimochi or a result (default 30)
  -h, --help      Help for a command: kimochi help <command>

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 not running (--no-start), 4 timed out.";

fn help_for(command: &str) -> Option<&'static str> {
    Some(match command {
        "status" => "\
Usage: kimochi status [--json]

What Kimochi is doing: the source it reads and its crop, the OCR engine, the input, Auto OCR,
the overlay, the Log's session and the last scan's text. Works when Kimochi isn't running too
(\"running\": false, with what the settings say).",
        "scan" => "\
Usage: kimochi scan [--wait] [--timeout <s>] [--json]

Scan the source now, as the Scan shortcut does. With --wait, wait for the result and print the
text it read (with Quick Shot on, once you've drawn the box).",
        "auto-ocr" => "\
Usage: kimochi auto-ocr [on|off|toggle] [--json]

Without an argument, print whether Auto OCR is on. Turning it on needs a source.",
        "overlay" => "\
Usage: kimochi overlay [show|hide|toggle]
       kimochi overlay text [show|hide|toggle]

The overlay is everything Kimochi draws over the source. `overlay text` is only the scanned text
(the boxes you point at), as the Text button in the main window.",
        "ocr" => "\
Usage: kimochi ocr [<engine>] [--json]

Without an argument, list this computer's OCR engines and which is selected. With one, switch:
googlelens, cloud, meikiocr, mangaocr, ppocr, screenai, vocr, livetext (macOS) or oneocr
(Windows). Choosing a local engine whose model isn't downloaded yet starts the download.",
        "source" => "\
Usage: kimochi source                 The source Kimochi reads
       kimochi source list            Every window and display it could read (not where only the
                                      system's picker can choose: Wayland, Gaming Mode)
       kimochi source set <name|id>   Read a window or display: by id, or by its title or app
                                      (exact, or the only one containing <name>); its saved crop
                                      comes back with it
       kimochi source clear           Read nothing
       kimochi source choose          Open the source picker in the main window",
        "log" => "\
Usage: kimochi log [-n <count>] [--all] [--session <name>] [--json]
       kimochi log --follow [--json]
       kimochi log add [<text>|-]

Print the newest lines of the open session's Log (20 unless -n or --all), oldest first; or of
another session with --session. --follow keeps printing each new line as the Log takes it in
(it needs Kimochi running). `log add` puts a line in the Log as if it had been read, whatever the
input is set to; with - or no text it reads standard input, so `pbpaste | kimochi log add` works.",
        "session" => "\
Usage: kimochi session                   The open session
       kimochi session list              Every session (the open one marked *)
       kimochi session switch <name|id>  Open another session
       kimochi session new [<name>]      Start a new session and open it
       kimochi session rename <name> [--session <which>]
                                         Rename the open session (or another one)

Names match exactly, or as the only session containing the words, ignoring case.",
        "open" => "\
Usage: kimochi open [log|notebook|anki|settings [<page>]|sources|mini|dictionary]

Start Kimochi if it isn't running, and bring a window forward: the main window (as it was, by
default; on the Log, the Notebook or the Anki tab when named), Settings (optionally on a page: general, sources, ocr, log, dictionary, anki, assist,
controls, gamemode, account, cli, about), the source picker, Mini mode, or the dictionary's own
settings.",
        "quit" => "Usage: kimochi quit\n\nQuit Kimochi, as Quit Kimochi in the tray menu does. Nothing happens when it isn't running.",
        "settings" => "\
Usage: kimochi settings list [--json]
       kimochi settings get <key>
       kimochi settings set <key> <value>
       kimochi settings path

Keys are dotted paths into settings.json: `overlayOpacity`, `autoOCRSettings.pollInterval`. A
value is read as JSON when it is valid JSON (60, true, {\"a\":1}) and as text otherwise; quote a
string that looks like JSON: '\"123\"'. While Kimochi runs, changes go through the app and take
effect at once; otherwise the file is changed for the next launch.",
        "action" => "\
Usage: kimochi action <name>
       kimochi action --list

Fire an action as a shortcut, the tray or a button would: triggerScan, toggleOverlay,
setCropArea, setAnkiCropArea, playAudio, selectAndScan, openControllerMenu, toggleAutoOcr,
toggleTextOverlay, toggleDebugOverlay.",
        "watch" => "\
Usage: kimochi watch [<event>...]

Stream what happens as JSON lines, one per event, until you stop it (Ctrl+C). Events: scan (a
scan's text), line (a line the Log took in), source, state (Auto OCR, the overlay, scanning),
session (another session opened) and action (a shortcut or button fired). Without names, all.
Each line has \"event\" and \"at\" (Unix milliseconds).",
        "paths" => "Usage: kimochi paths [--json]\n\nThe folders and files Kimochi keeps: settings, the Log, sessions, models.",
        "version" => "Usage: kimochi version [--json]\n\nThis command's version, and the running app's.",
        _ => return None,
    })
}

// ------------------------------------------------------------------------------ entry

pub fn run(raw: Vec<String>) -> Exit {
    let args = match parse(&raw) {
        Ok(args) => args,
        Err(message) => return Exit::Usage(message),
    };
    let words: Vec<&str> = args.words.iter().map(String::as_str).collect();
    let result = match words.as_slice() {
        [] if args.version => version(&args),
        [] | ["help"] => {
            println!("{OVERVIEW}\n\nDocs: {DOCS}");
            Ok(())
        }
        ["help", command, ..] | [command, ..] if args.help || words[0] == "help" => match help_for(command) {
            Some(text) => {
                println!("{text}\n\nDocs: {DOCS}");
                Ok(())
            }
            None => Err(Exit::Usage(format!("no command called {command:?}"))),
        },
        ["status"] => status(&args),
        ["version"] => version(&args),
        ["paths"] => paths(&args),
        ["scan"] => scan(&args),
        ["auto-ocr", rest @ ..] => switch(&args, "autoOcr", "Auto OCR", rest, ("on", "off")),
        ["overlay", "text", rest @ ..] => switch(&args, "textOverlay", "Scanned text", rest, ("shown", "hidden")),
        ["overlay", rest @ ..] => switch(&args, "overlay", "Overlay", rest, ("shown", "hidden")),
        ["ocr"] => ocr_list(&args),
        ["ocr", engine] => ocr_set(&args, engine),
        ["source"] => source_now(&args),
        ["source", "list"] => source_list(&args),
        ["source", "set", query @ ..] if !query.is_empty() => source_set(&args, &query.join(" ")),
        ["source", "clear"] => simple(&args, "source.clear", json!({}), "Kimochi reads nothing now."),
        ["source", "choose"] => simple(&args, "source.choose", json!({}), "The source picker is open in Kimochi."),
        ["log"] if args.follow => log_follow(&args),
        ["log"] => log_print(&args),
        ["log", "add", text @ ..] => log_add(&args, text),
        ["session"] => session_now(&args),
        ["session", "list"] => session_list(&args),
        ["session", "switch", query @ ..] if !query.is_empty() => session_switch(&args, &query.join(" ")),
        ["session", "new", name @ ..] => session_new(&args, &name.join(" ")),
        ["session", "rename", name @ ..] if !name.is_empty() => session_rename(&args, &name.join(" ")),
        ["open"] => open(&args, "main", None),
        ["open", "settings", page] => open(&args, "settings", Some(page)),
        ["open", view] => open(&args, view, None),
        ["quit"] => quit(&args),
        ["settings"] | ["settings", "list"] => settings_list(&args),
        ["settings", "path"] => settings_path(),
        ["settings", "get", key] => settings_get(&args, key),
        ["settings", "set", key, value @ ..] if !value.is_empty() => settings_set(&args, key, &value.join(" ")),
        ["action"] if args.list => action_list(&args),
        ["action", name] => simple(&args, "action", json!({ "name": name }), ""),
        ["watch", events @ ..] => watch(&args, events),
        [command, ..] if help_for(command).is_some() => Err(Exit::Usage(format!(
            "that isn't how {command} is used. See `kimochi help {command}`."
        ))),
        [command, ..] => Err(Exit::Usage(match suggestion(command) {
            Some(near) => format!("no command called {command:?}. Did you mean `kimochi {near}`?"),
            None => format!("no command called {command:?}. See `kimochi help`."),
        })),
    };
    match result {
        Ok(()) => Exit::Ok,
        Err(exit) => exit,
    }
}

/// The command a typo was probably meant to be: within two edits.
fn suggestion(typed: &str) -> Option<&'static str> {
    let distance = |a: &str, b: &str| {
        let b: Vec<char> = b.chars().collect();
        let mut row: Vec<usize> = (0..=b.len()).collect();
        for (i, ca) in a.chars().enumerate() {
            let mut previous = row[0];
            row[0] = i + 1;
            for (j, cb) in b.iter().enumerate() {
                let here = row[j + 1];
                row[j + 1] = (previous + usize::from(ca != *cb)).min(row[j] + 1).min(here + 1);
                previous = here;
            }
        }
        row[b.len()]
    };
    super::COMMANDS.iter().map(|c| (distance(typed, c), *c)).filter(|(d, _)| *d <= 2).min().map(|(_, c)| c)
}

// ------------------------------------------------------------------------------ the app

/// The running app's endpoint, if one answers.
fn running() -> Option<Endpoint> {
    endpoint::candidates()
        .into_iter()
        .find(|endpoint| endpoint::call(endpoint, "ping", json!({}), Duration::from_millis(1500)).is_ok())
}

fn wait_limit(args: &Args) -> Duration {
    Duration::from_secs_f64(args.timeout.unwrap_or(30.0))
}

/// The running app, started first unless `--no-start`.
fn app(args: &Args) -> Result<Endpoint, Exit> {
    if let Some(endpoint) = running() {
        return Ok(endpoint);
    }
    if args.no_start {
        return Err(Exit::NotRunning);
    }
    if std::io::stderr().is_terminal() {
        eprintln!("Starting Kimochi…");
    }
    super::launch::start_app().map_err(|e| Exit::Failed(format!("couldn't start Kimochi: {e}")))?;
    // A first launch builds its windows and loads the dictionary before it answers.
    let deadline = Instant::now() + wait_limit(args).max(Duration::from_secs(60));
    loop {
        std::thread::sleep(Duration::from_millis(300));
        if let Some(endpoint) = running() {
            return Ok(endpoint);
        }
        if Instant::now() >= deadline {
            return Err(Exit::Timeout("Kimochi didn't answer after starting. Is it showing an error?".into()));
        }
    }
}

/// Send one request to the app and return its result.
fn ask(args: &Args, method: &str, params: Value) -> Result<Value, Exit> {
    let endpoint = app(args)?;
    request(&endpoint, method, params, wait_limit(args) + Duration::from_secs(30))
}

fn request(endpoint: &Endpoint, method: &str, params: Value, timeout: Duration) -> Result<Value, Exit> {
    endpoint::call(endpoint, method, params, timeout).map_err(|error| match error {
        CallError::Unreachable(e) => Exit::Failed(format!("lost Kimochi: {e}")),
        CallError::Timeout => Exit::Timeout("Kimochi didn't answer in time".into()),
        CallError::Failed(message) => app_error(&message),
    })
}

/// The app's error, without its machine-readable prefix.
fn app_error(message: &str) -> Exit {
    let (prefix, text) = message.split_once(": ").unwrap_or(("", message));
    match prefix {
        "timeout" => Exit::Timeout(text.to_string()),
        "invalid" | "gone" | "busy" | "native" | "permission" => Exit::Failed(text.to_string()),
        _ => Exit::Failed(message.to_string()),
    }
}

fn print_json(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

/// A request whose answer needs no more than a confirmation.
fn simple(args: &Args, method: &str, params: Value, said: &str) -> Outcome {
    let result = ask(args, method, params)?;
    if args.json {
        print_json(&result);
    } else if !said.is_empty() {
        println!("{said}");
    }
    Ok(())
}

// ------------------------------------------------------------------------------ commands

fn version(args: &Args) -> Outcome {
    let cli = env!("CARGO_PKG_VERSION");
    let app = running().and_then(|endpoint| {
        endpoint::call(&endpoint, "ping", json!({}), Duration::from_secs(2)).ok().map(|v| v["version"].clone())
    });
    if args.json {
        print_json(&json!({ "cli": cli, "app": app, "flavor": endpoint::FLAVOR }));
    } else {
        println!("kimochi {cli}{}", if cfg!(dev) { " (development build)" } else { "" });
        match app.as_ref().and_then(Value::as_str) {
            Some(version) => println!("Kimochi {version} is running"),
            None => println!("Kimochi is not running"),
        }
    }
    Ok(())
}

fn status(args: &Args) -> Outcome {
    let report = match running() {
        Some(endpoint) => request(&endpoint, "status", json!({}), Duration::from_secs(10))?,
        None => offline_status(),
    };
    if args.json {
        print_json(&report);
        return Ok(());
    }
    let yes_no = |v: &Value, on: &str, off: &str| if v.as_bool() == Some(true) { on.to_string() } else { off.to_string() };
    if report["running"] == json!(true) {
        println!("Kimochi {} is running (pid {})", report["version"].as_str().unwrap_or("?"), report["pid"]);
    } else {
        println!("Kimochi is not running. From its settings:");
    }
    let source = &report["source"];
    let source_line = if source.is_object() {
        let crop = if report["cropEnabled"] == json!(true) { ", cropped" } else { "" };
        format!("{} {}{crop}", source["type"].as_str().unwrap_or("source"), describe_source(source))
    } else {
        "none".into()
    };
    let rows = [
        ("Source", source_line),
        ("Input", input_name(report["input"].as_str().unwrap_or("ocr")).to_string()),
        ("OCR engine", engine_name(report["ocrEngine"].as_str().unwrap_or("")).to_string()),
        ("Auto OCR", if report["running"] == json!(true) { yes_no(&report["autoOcr"], "on", "off") } else { "off".into() }),
        ("Overlay", if report["running"] == json!(true) {
            format!("{}, text {}", yes_no(&report["overlay"], "shown", "hidden"), yes_no(&report["textOverlay"], "shown", "hidden"))
        } else {
            "-".into()
        }),
        ("Session", report["session"]["name"].as_str().unwrap_or("none").to_string()),
    ];
    for (label, value) in rows {
        println!("  {label:<11} {value}");
    }
    if let Some(text) = report["lastScan"].as_str().filter(|t| !t.trim().is_empty()) {
        println!("  {:<11} {}", "Last scan", text.lines().collect::<Vec<_>>().join(" ⏎ "));
    }
    Ok(())
}

/// What the files say while the app isn't running.
fn offline_status() -> Value {
    let settings = settings_file().map(crate::settings::Settings::load);
    let get = |key: &str| settings.as_ref().and_then(|s| s.get(key).ok().flatten()).unwrap_or(Value::Null);
    let reader = get("superTexthooker");
    let input = reader["inputSource"].as_str().map(str::to_string).unwrap_or_else(|| {
        if reader["clipboardEnabled"] == json!(true) { "clipboard" } else { "ocr" }.to_string()
    });
    let manifest = sessions_manifest();
    json!({
        "running": false,
        "source": super::server::without_icon(&get("lastSelectedSource")),
        "ocrEngine": get("ocrMode"),
        "input": input,
        "dictionary": get("yomitanSettings")["popupType"],
        "session": active_session(&manifest),
        "profileDir": endpoint::profile_dir(),
    })
}

fn describe_source(source: &Value) -> String {
    let name = source["name"].as_str().unwrap_or_default();
    match source["appName"].as_str().filter(|app| !app.is_empty() && *app != name) {
        Some(app) => format!("\"{name}\" ({app})"),
        None => format!("\"{name}\""),
    }
}

fn input_name(input: &str) -> &str {
    match input {
        "ocr" => "OCR",
        "hook" => "Text Hooker",
        "clipboard" => "Clipboard",
        "websocket" => "WebSocket",
        "browser" => "Browser",
        other => other,
    }
}

fn engine_name(engine: &str) -> &str {
    match engine {
        "googlelens" => "Google Lens",
        "cloud" => "Kimochi Cloud",
        "meikiocr" | "local" => "MeikiOCR",
        "mangaocr" => "Manga OCR",
        "ppocr" => "PaddleOCR",
        "screenai" => "Screen AI",
        "vocr" => "VOCR6",
        "livetext" => "Live Text",
        "oneocr" => "Windows OCR (OneOCR)",
        other => other,
    }
}

fn paths(args: &Args) -> Outcome {
    let report = json!({
        "dataDir": endpoint::data_dir(),
        "localDir": endpoint::local_dir(),
        "profileDir": endpoint::profile_dir(),
        "settings": settings_file(),
        "sessions": endpoint::profile_dir().map(|d| d.join("sessions")),
        "evidenceLog": endpoint::data_dir().map(|d| d.join("evidence.jsonl")),
        "executable": super::launch::app_executable(),
    });
    if args.json {
        print_json(&report);
        return Ok(());
    }
    for (label, key) in [
        ("Data", "dataDir"),
        ("Local data", "localDir"),
        ("Profile", "profileDir"),
        ("Settings", "settings"),
        ("Sessions", "sessions"),
        ("Event log", "evidenceLog"),
        ("App", "executable"),
    ] {
        println!("  {label:<11} {}", report[key].as_str().unwrap_or("-"));
    }
    Ok(())
}

fn scan(args: &Args) -> Outcome {
    let params = json!({ "wait": args.wait, "timeout": args.timeout.unwrap_or(30.0) });
    let result = ask(args, "scan", params)?;
    if args.json {
        print_json(&result);
    } else if args.wait {
        println!("{}", result["text"].as_str().unwrap_or_default());
    }
    Ok(())
}

/// Auto OCR, the overlay and its text: print, or set and print.
fn switch(args: &Args, flag: &str, label: &str, rest: &[&str], words: (&str, &str)) -> Outcome {
    let result = match rest {
        [] => {
            let field = match flag {
                "autoOcr" => "autoOcr",
                "overlay" => "overlay",
                _ => "textOverlay",
            };
            let status = ask(args, "status", json!({}))?;
            json!({ flag: status[field] })
        }
        [to @ ("on" | "off" | "toggle" | "show" | "hide")] => ask(args, "toggle", json!({ "flag": flag, "to": to }))?,
        _ => return Err(Exit::Usage("use on, off or toggle (or show and hide)".into())),
    };
    if args.json {
        print_json(&result);
    } else {
        println!("{label}: {}", if result[flag] == json!(true) { words.0 } else { words.1 });
    }
    Ok(())
}

fn ocr_list(args: &Args) -> Outcome {
    let report = ask(args, "ocr.engines", json!({}))?;
    if args.json {
        print_json(&report);
        return Ok(());
    }
    let selected = report["selected"].as_str().unwrap_or_default();
    for (key, engine) in report["engines"].as_object().into_iter().flatten() {
        let state = if key == selected || (key == "meikiocr" && selected == "local") {
            "selected".to_string()
        } else if engine["available"] == json!(true) {
            "available".to_string()
        } else if !engine["model"].is_null() {
            "model not downloaded".to_string()
        } else {
            engine["reason"].as_str().map_or("unavailable".to_string(), |r| format!("unavailable: {r}"))
        };
        let mark = if state == "selected" { "*" } else { " " };
        println!("{mark} {key:<11} {:<22} {state}", engine_name(key));
    }
    Ok(())
}

/// Every `ocrMode` there is; which of them this computer has is the app's to say.
const ENGINES: &[&str] = &["googlelens", "cloud", "meikiocr", "local", "mangaocr", "ppocr", "screenai", "vocr", "livetext", "oneocr"];

fn ocr_set(args: &Args, engine: &str) -> Outcome {
    if !ENGINES.contains(&engine) {
        return Err(Exit::Usage(format!("no OCR engine called {engine:?}; see `kimochi help ocr`")));
    }
    let result = ask(args, "ocr.set", json!({ "engine": engine }))?;
    if args.json {
        print_json(&result);
    } else {
        let selected = result["selected"].as_str().unwrap_or(engine);
        println!("OCR engine: {}", engine_name(selected));
        if !result["model"].is_null() && result["model"] != json!("ready") {
            println!("Its model is downloading; scans use it once it's ready.");
        }
    }
    Ok(())
}

fn source_now(args: &Args) -> Outcome {
    let status = match running() {
        Some(endpoint) => request(&endpoint, "status", json!({}), Duration::from_secs(10))?,
        None => offline_status(),
    };
    let source = &status["source"];
    if args.json {
        print_json(&json!({ "source": source, "cropEnabled": status["cropEnabled"], "running": status["running"] }));
    } else if source.is_object() {
        println!("{} {}", source["type"].as_str().unwrap_or("source"), describe_source(source));
    } else {
        println!("No source is selected.");
    }
    Ok(())
}

fn source_list(args: &Args) -> Outcome {
    let list = ask(args, "source.list", json!({}))?;
    if args.json {
        print_json(&list);
        return Ok(());
    }
    for source in list.as_array().into_iter().flatten() {
        let app = source["app"].as_str().unwrap_or_default();
        println!(
            "{:<8} {:<20} {}  [{}]",
            source["kind"].as_str().unwrap_or_default(),
            if app.chars().count() > 20 { format!("{}…", app.chars().take(19).collect::<String>()) } else { app.to_string() },
            source["name"].as_str().unwrap_or_default(),
            source["id"].as_str().unwrap_or_default()
        );
    }
    Ok(())
}

fn source_set(args: &Args, query: &str) -> Outcome {
    let result = ask(args, "source.set", json!({ "query": query }))?;
    if args.json {
        print_json(&result);
    } else {
        let crop = if result["cropEnabled"] == json!(true) { ", with its saved crop" } else { "" };
        println!("Reading {}{crop}.", describe_source(&result["source"]));
    }
    Ok(())
}

// ------------------------------------------------------------------------------ the Log

fn sessions_manifest() -> Value {
    endpoint::profile_dir()
        .and_then(|dir| crate::profile::read_json(&dir.join("sessions.json")))
        .unwrap_or(Value::Null)
}

fn active_session(manifest: &Value) -> Value {
    let active = manifest["activeId"].as_str().unwrap_or_default();
    manifest["sessions"]
        .as_array()
        .and_then(|list| list.iter().find(|s| s["id"] == json!(active)).cloned())
        .unwrap_or(Value::Null)
}

fn log_print(args: &Args) -> Outcome {
    let dir = endpoint::profile_dir().ok_or_else(|| Exit::Failed("no data folder".into()))?;
    let manifest = sessions_manifest();
    if manifest.is_null() {
        return Err(Exit::Failed("the Log has no sessions yet".into()));
    }
    let session = match &args.session {
        Some(query) => super::server::find_session(&manifest, query).map_err(|e| app_error(&e))?,
        None => active_session(&manifest),
    };
    let sid = session["id"].as_str().filter(|id| crate::sync_core::safe_segment(id)).ok_or_else(|| Exit::Failed("no session is open".into()))?;
    let file = crate::profile::read_json(&dir.join("sessions").join(sid).join("lines.json")).unwrap_or(Value::Null);
    let lines: Vec<&Value> = file["lines"].as_array().into_iter().flatten().filter(|l| l["text"].as_str().is_some_and(|t| !t.trim().is_empty())).collect();
    let count = if args.all { lines.len() } else { args.lines.unwrap_or(20) };
    let shown = &lines[lines.len().saturating_sub(count)..];
    let mut out = std::io::stdout().lock();
    for line in shown {
        let written = if args.json {
            let id = line["uid"].as_str().map(str::to_string).unwrap_or_else(|| format!("{sid}-{}", line["id"]));
            let value = json!({ "id": id, "text": line["text"], "source": line["source"], "timestamp": line["ts"], "session": sid });
            writeln!(out, "{value}")
        } else {
            writeln!(out, "{}", line["text"].as_str().unwrap_or_default())
        };
        // A closed pipe (`| head`) ends the listing quietly.
        if written.is_err() {
            break;
        }
    }
    Ok(())
}

fn log_follow(args: &Args) -> Outcome {
    let endpoint = app(args)?;
    stream(&endpoint, json!({ "events": ["line"] }), |event| {
        if args.json {
            println!("{event}");
        } else {
            println!("{}", event["text"].as_str().unwrap_or_default());
        }
    })
}

fn log_add(args: &Args, text: &[&str]) -> Outcome {
    let text = match text {
        [] | ["-"] => {
            if text.is_empty() && std::io::stdin().is_terminal() {
                return Err(Exit::Usage("give the text, or pipe it in: echo 猫 | kimochi log add".into()));
            }
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).map_err(|e| Exit::Failed(format!("reading stdin: {e}")))?;
            decode_input(bytes)?
        }
        words => words.join(" "),
    };
    if text.trim().is_empty() {
        return Err(Exit::Usage("nothing to add".into()));
    }
    let result = ask(args, "log.add", json!({ "text": text }))?;
    if args.json {
        print_json(&result);
    }
    if result["added"] == json!(false) {
        return Err(Exit::Failed(
            "the Log didn't take it: its line filter may skip text not in the language being read, and it skips a repeat of a recent line".into(),
        ));
    }
    Ok(())
}

/// Piped-in text: UTF-8 (with or without a BOM), or on Windows the console's own code page, which
/// is what cmd.exe pipes in (932, Shift JIS, on a Japanese system).
fn decode_input(bytes: Vec<u8>) -> Result<String, Exit> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).map(<[u8]>::to_vec).unwrap_or(bytes);
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(error) => {
            #[cfg(windows)]
            if let Some(text) = console_code_page_text(error.as_bytes()) {
                return Ok(text);
            }
            Err(Exit::Failed(format!(
                "the text piped in isn't UTF-8 ({}). On Windows, `chcp 65001` first.",
                error.utf8_error()
            )))
        }
    }
}

#[cfg(windows)]
fn console_code_page_text(bytes: &[u8]) -> Option<String> {
    use windows::Win32::Globalization::{GetACP, MultiByteToWideChar, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
    use windows::Win32::System::Console::GetConsoleOutputCP;
    // SAFETY: plain Win32 calls on buffers that live across them.
    unsafe {
        let page = match GetConsoleOutputCP() {
            0 => GetACP(),
            page => page,
        };
        let length = MultiByteToWideChar(page, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, None);
        if length <= 0 {
            return None;
        }
        let mut wide = vec![0u16; length as usize];
        let written = MultiByteToWideChar(page, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, Some(&mut wide));
        (written > 0).then(|| String::from_utf16_lossy(&wide[..written as usize]))
    }
}

fn session_now(args: &Args) -> Outcome {
    let session = active_session(&sessions_manifest());
    if args.json {
        print_json(&session);
    } else {
        println!("{}", session["name"].as_str().unwrap_or("No session is open."));
    }
    Ok(())
}

fn session_list(args: &Args) -> Outcome {
    let manifest = sessions_manifest();
    let active = manifest["activeId"].clone();
    let sessions = manifest["sessions"].as_array().cloned().unwrap_or_default();
    if args.json {
        let list: Vec<Value> = sessions
            .into_iter()
            .map(|mut s| {
                s["active"] = json!(s["id"] == active);
                s
            })
            .collect();
        print_json(&json!(list));
        return Ok(());
    }
    for session in &sessions {
        let mark = if session["id"] == active { "*" } else { " " };
        println!("{mark} {}", session["name"].as_str().unwrap_or_default());
    }
    Ok(())
}

fn session_switch(args: &Args, query: &str) -> Outcome {
    let result = ask(args, "session.switch", json!({ "query": query }))?;
    if args.json {
        print_json(&result);
    } else {
        println!("Session: {}", result["name"].as_str().unwrap_or(query));
    }
    Ok(())
}

fn session_new(args: &Args, name: &str) -> Outcome {
    let result = ask(args, "session.new", json!({ "name": if name.trim().is_empty() { Value::Null } else { json!(name) } }))?;
    if args.json {
        print_json(&result);
    } else {
        println!("New session: {}", result["name"].as_str().unwrap_or(name));
    }
    Ok(())
}

fn session_rename(args: &Args, name: &str) -> Outcome {
    let result = ask(args, "session.rename", json!({ "name": name, "query": args.session }))?;
    if args.json {
        print_json(&result);
    } else {
        println!("Renamed to {}", result["name"].as_str().unwrap_or(name));
    }
    Ok(())
}

// ------------------------------------------------------------------------------ app & settings

fn open(args: &Args, view: &str, page: Option<&str>) -> Outcome {
    simple(args, "open", json!({ "view": view, "page": page }), "")
}

fn quit(args: &Args) -> Outcome {
    let Some(endpoint) = running() else {
        if !args.json {
            println!("Kimochi isn't running.");
        }
        return Ok(());
    };
    request(&endpoint, "quit", json!({}), Duration::from_secs(10))?;
    // Wait for it to be gone, so a script can start it again straight after.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && endpoint::call(&endpoint, "ping", json!({}), Duration::from_millis(500)).is_ok() {
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

fn settings_file() -> Option<PathBuf> {
    endpoint::data_dir().map(|dir| dir.join("settings.json"))
}

fn settings_path() -> Outcome {
    println!("{}", settings_file().map(|p| p.display().to_string()).unwrap_or_default());
    Ok(())
}

/// The settings, from the app while it runs (so they match what it uses), else from the file.
fn settings_value(key: Option<&str>) -> Result<Value, Exit> {
    if let Some(endpoint) = running() {
        return request(&endpoint, "settings.get", json!({ "key": key }), Duration::from_secs(10));
    }
    let path = settings_file().ok_or_else(|| Exit::Failed("no data folder".into()))?;
    let settings = crate::settings::Settings::load(path);
    match key {
        Some(key) => settings.get(key).map(|v| v.unwrap_or(Value::Null)).map_err(|e| app_error(&e)),
        None => Ok(settings.all()),
    }
}

fn settings_list(args: &Args) -> Outcome {
    let all = settings_value(None)?;
    if args.json {
        print_json(&all);
        return Ok(());
    }
    let mut flat = Vec::new();
    flatten("", &all, &mut flat);
    for (key, value) in flat {
        println!("{key} = {value}");
    }
    Ok(())
}

/// `a.b = 1` lines for the settings tree. Maps keyed by user data (crops, window bounds) stay
/// one value each, as do arrays.
fn flatten(prefix: &str, value: &Value, out: &mut Vec<(String, String)>) {
    match value.as_object() {
        Some(map) if !map.is_empty() && map.keys().all(|k| !k.contains('.') && !k.contains('/')) && prefix.split('.').count() < 3 => {
            for (key, child) in map {
                let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                flatten(&path, child, out);
            }
        }
        _ => out.push((prefix.to_string(), value.to_string())),
    }
}

fn settings_get(args: &Args, key: &str) -> Outcome {
    let value = settings_value(Some(key))?;
    match (&value, args.json) {
        (Value::String(text), false) => println!("{text}"),
        (Value::Null, false) => return Err(Exit::Failed(format!("{key} is not set"))),
        _ => print_json(&value),
    }
    Ok(())
}

/// A value as typed: JSON when it parses (numbers, true, objects, "quoted"), else text.
pub fn setting_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!(raw))
}

fn settings_set(args: &Args, key: &str, raw: &str) -> Outcome {
    let value = setting_value(raw);
    let stored = match running() {
        Some(endpoint) => request(&endpoint, "settings.set", json!({ "key": key, "value": value }), Duration::from_secs(10))?,
        None => {
            let path = settings_file().ok_or_else(|| Exit::Failed("no data folder".into()))?;
            let settings = crate::settings::Settings::load(path);
            settings.set(key, value.clone()).map_err(|e| app_error(&e))?;
            if !args.json {
                eprintln!("Kimochi isn't running; it will use this when it starts.");
            }
            value
        }
    };
    if args.json {
        print_json(&stored);
    } else {
        println!("{key} = {stored}");
    }
    Ok(())
}

fn action_list(args: &Args) -> Outcome {
    let list = json!(crate::actions::ACTIONS);
    if args.json {
        print_json(&list);
    } else {
        for name in crate::actions::ACTIONS.iter().filter(|n| !n.starts_with("hover")) {
            println!("{name}");
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------ streams

fn watch(args: &Args, events: &[&str]) -> Outcome {
    let endpoint = app(args)?;
    stream(&endpoint, json!({ "events": events }), |event| println!("{event}"))
}

/// Read `watch` events until the app or the reader goes away.
fn stream(endpoint: &Endpoint, params: Value, mut each: impl FnMut(&Value)) -> Outcome {
    let mut connection = endpoint::send(endpoint, "watch", params, None).map_err(|e| Exit::Failed(format!("lost Kimochi: {e}")))?;
    match connection.next() {
        Some(Ok(first)) if first["ok"] == json!(true) => {}
        Some(Ok(first)) => return Err(app_error(first["error"].as_str().unwrap_or("Kimochi refused"))),
        _ => return Err(Exit::Failed("Kimochi closed the stream".into())),
    }
    while let Some(event) = connection.next() {
        match event {
            Ok(event) => {
                each(&event);
                if std::io::stdout().flush().is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Err(Exit::Failed("Kimochi closed the stream (did it quit?)".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Args {
        parse(&line.split_whitespace().map(String::from).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn options_go_anywhere_and_words_stay_in_order() {
        let a = args("log --json -n 5 add --no-start");
        assert_eq!(a.words, ["log", "add"]);
        assert!(a.json && a.no_start);
        assert_eq!(a.lines, Some(5));
        let a = args("settings set overlayOpacity -5");
        assert_eq!(a.words, ["settings", "set", "overlayOpacity", "-5"]);
        let a = args("log add -- --not-an-option");
        assert_eq!(a.words, ["log", "add", "--not-an-option"]);
        assert_eq!(args("scan --timeout=12 --wait").timeout, Some(12.0));
        assert!(parse(&["--bogus".to_string()]).is_err());
        assert!(parse(&["--timeout".to_string()]).is_err());
    }

    #[test]
    fn typos_suggest_the_command() {
        assert_eq!(suggestion("stauts"), Some("status"));
        assert_eq!(suggestion("sesion"), Some("session"));
        assert_eq!(suggestion("frobnicate"), None);
    }

    #[test]
    fn setting_values_are_json_when_they_parse() {
        assert_eq!(setting_value("60"), json!(60));
        assert_eq!(setting_value("true"), json!(true));
        assert_eq!(setting_value("meikiocr"), json!("meikiocr"));
        assert_eq!(setting_value("\"123\""), json!("123"));
        assert_eq!(setting_value("{\"a\":1}"), json!({"a": 1}));
    }

    #[test]
    fn every_listed_command_has_help() {
        for command in ["status", "scan", "auto-ocr", "overlay", "ocr", "source", "log", "session", "open", "quit", "settings", "action", "watch", "paths", "version"] {
            assert!(help_for(command).is_some(), "{command}");
            assert!(OVERVIEW.contains(&format!("  {command}")), "{command} is missing from the overview");
            assert!(super::super::COMMANDS.contains(&command), "{command} does not start the CLI");
        }
    }

    #[test]
    fn settings_flatten_into_dotted_lines() {
        let mut out = Vec::new();
        flatten("", &json!({"a": 1, "b": {"c": true, "d": {"e": 1, "f": {"g": 2}}}, "crops": {"Node.js": {"x": 1}}}), &mut out);
        let keys: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["a", "b.c", "b.d.e", "b.d.f", "crops"]);
    }
}
