//! Opt-in native Mac launch. Gadget watches a private script file: loading or stopping a
//! hook replaces that file, so Frida owns script teardown and the game keeps running.
//! No game files, signing settings or network listeners are changed.
use super::*;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::sync::OnceLock;

pub const ENGINE: &str = "agent-gadget-macos";
const IDLE: &str = "// Kimochi: no hook selected.\n";
#[derive(Clone)]
pub(super) struct Launch {
    pid: u32,
    exe: PathBuf,
    dir: PathBuf,
}
static LAUNCHES: OnceLock<Mutex<HashMap<u32, Launch>>> = OnceLock::new();
fn unique() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn launches() -> &'static Mutex<HashMap<u32, Launch>> {
    LAUNCHES.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn find(target: &process::Target) -> Option<Launch> {
    if target.wine.is_some() {
        return None;
    }
    launches()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&target.pid)
        .filter(|run| run.exe == target.exe && super::super::macos::executable(run.pid).as_ref() == Some(&run.exe))
        .cloned()
}

// Atomic replacement lets Gadget's watcher see only complete JavaScript.
fn replace(path: &Path, source: &str) -> Result<(), String> {
    let temporary = path.with_extension("pending");
    fs::write(&temporary, source).and_then(|_| fs::rename(&temporary, path)).map_err(|e| e.to_string())
}
pub(in crate::text_hook) fn stop(session: &mut Session) {
    if let Some(path) = session.gadget.take() {
        let _ = replace(&path, IDLE);
    }
}

fn executable(bundle: &Path) -> Result<PathBuf, String> {
    if bundle.extension().and_then(|x| x.to_str()) != Some("app") || !bundle.is_dir() {
        return Err("Choose a native Mac game application (.app).".into());
    }
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleExecutable"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .map_err(|e| e.to_string())?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || name.is_empty() || name.contains(['/', '\\']) || name == ".." {
        return Err("The application does not name a valid executable.".into());
    }
    bundle.join("Contents/MacOS").join(name).canonicalize().map_err(|e| e.to_string())
}

/// Called only after the reader explicitly chooses Launch through Kimochi and a game.
pub(in crate::text_hook) fn launch_game(bundle: PathBuf) -> Result<Value, String> {
    let hook = super::super::hook().ok_or("Text Hooker is not ready")?;
    let bundle = bundle.canonicalize().map_err(|e| e.to_string())?;
    let exe = executable(&bundle)?;
    let steam = index::steam_app_id(&exe);
    let script = index::find(&index::Game { exe: &exe, window_title: None, steam, language: &hook.language().code })
        .filter(|s| s.platform == "pc")
        .ok_or("No indexed Agent script matches this native Mac game.")?;
    // Do not launch a second copy of an already-running game.
    if crate::sources::catalog()?
        .iter()
        .filter_map(|s| s["id"].as_str())
        .filter_map(super::super::window_pid)
        .filter_map(super::super::macos::executable)
        .any(|p| p == exe)
    {
        return Err("Close the game before launching it through Kimochi.".into());
    }
    let root = hook.root()?;
    let fetch = store::HttpFetch::new()?;
    let installed = match store::installed(&root, ENGINE) {
        Some(dir) => dir,
        None => store::install(&fetch, &root, ENGINE, &|_, _| {})?,
    };
    scripts::install(&fetch, &root, &|_| {})?;
    let dir = root.join(format!("gadget-{}", unique()?));
    fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        fs::copy(installed.join("Gadget.dylib"), dir.join("Gadget.dylib")).map_err(|e| e.to_string())?;
        fs::set_permissions(dir.join("Gadget.dylib"), fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let identity = dir.join("identity.json");
        let script_path = dir.join("hook.js");
        fs::write(
            &script_path,
            format!(
                "if (Process.mainModule.path === {}) File.writeAllText({}, JSON.stringify({{pid:Process.id,exe:Process.mainModule.path}}));",
                json!(exe), json!(identity)
            ),
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            dir.join("Gadget.config"),
            json!({"interaction":{"type":"script","path":script_path,"on_change":"reload"},"runtime":"qjs"})
                .to_string(),
        )
        .map_err(|e| e.to_string())?;
        let mut command = Command::new("/usr/bin/open");
        command.args(["-n", "--env"]).arg(format!("DYLD_INSERT_LIBRARIES={}", dir.join("Gadget.dylib").display()));
        if let Some(id) = steam {
            command.args(["--env", &format!("SteamAppId={id}"), "--env", &format!("SteamGameId={id}")]);
        }
        let status = command.arg(&bundle).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("macOS could not launch the game.".into());
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(bytes) = fs::read(&identity) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(pid) = value["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) {
                        if value["exe"].as_str() == exe.to_str()
                            && super::super::macos::executable(pid).as_ref() == Some(&exe)
                        {
                            return Ok(pid);
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("The game launched but did not load Agent. Its signing or runtime may prevent this launch method.".into())
    })();
    let pid = match result {
        Ok(pid) => pid,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
    };
    let run = Launch { pid, exe: exe.clone(), dir: dir.clone() };
    launches().lock().unwrap_or_else(|e| e.into_inner()).insert(pid, run);
    std::thread::spawn(move || {
        while super::super::macos::executable(pid).as_ref() == Some(&exe) {
            std::thread::sleep(Duration::from_millis(500));
        }
        launches().lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
        let _ = fs::remove_dir_all(dir);
    });
    Ok(json!({"launched":true,"pid":pid,"title":script.title}))
}

pub(super) fn attach(
    hook: &'static Hook,
    generation: u64,
    collection: &Path,
    script: &'static Script,
    target: &process::Target,
    launch: Launch,
    started: Instant,
) -> Result<(), String> {
    let events = launch.dir.join(format!("events-{}.jsonl", unique()?));
    let reader = OpenOptions::new().create_new(true).read(true).write(true).open(&events).map_err(|e| e.to_string())?;
    let loader = fs::read_to_string(collection.join("libLoader.js")).map_err(|e| e.to_string())?;
    let dir = collection.to_string_lossy();
    let mission = collection.join(&script.file).to_string_lossy().into_owned();
    let source = build_script(&loader, &dir, &mission);
    // Keep the regular host/protocol. Only its output sink differs from frida-inject.
    let source =
        source.replacen(PRELUDE, &format!("globalThis.__kimochi.outputFile = {};\n{}", json!(events), PRELUDE), 1);
    let source = format!("{source}\nrpc.exports.dispose = globalThis.__kimochi.dispose;");
    let source = guarded(&source, target.pid, &target.exe);
    let path = launch.dir.join("hook.js");
    {
        let mut session = hook.lock();
        if session.generation != generation {
            return Err("cancelled".into());
        }
        session.gadget = Some(path.clone());
        session.engine = Some(super::ENGINE);
        session.phase = "attaching";
        session.download = None;
        hook.publish(&session);
        replace(&path, &source)?;
    }
    let context = Context {
        injector: PathBuf::new(),
        collection: collection.to_path_buf(),
        script,
        target: target.clone(),
        started,
    };
    std::thread::spawn(move || {
        let run = Mutex::new(Run::default());
        let mut reader = BufReader::new(reader);
        let mut pending = Vec::new();
        loop {
            {
                let session = hook.lock();
                if session.generation != generation || session.gadget.as_ref() != Some(&path) {
                    return;
                }
            }
            if target_running(&context.target) == Some(false) {
                finish(hook, generation, &context, &run, Ending::GameClosed);
                return;
            }
            if started.elapsed() > STARTUP_LIMIT && !run.lock().unwrap_or_else(|e| e.into_inner()).ready {
                fall_back(hook, generation, super::ENGINE, "The launched game did not load its Agent script.".into());
                return;
            }
            match reader.read_until(b'\n', &mut pending) {
                Ok(0) => std::thread::sleep(Duration::from_millis(100)),
                Ok(_) => {
                    if pending.last() == Some(&b'\n') {
                        read(hook, generation, &context, &run, std::io::Cursor::new(&pending));
                        pending.clear();
                        if run.lock().unwrap_or_else(|e| e.into_inner()).over {
                            return;
                        }
                    }
                    if pending.len() > 64 * 1024 {
                        fall_back(hook, generation, super::ENGINE, "Invalid Agent output.".into());
                        return;
                    }
                }
                Err(error) => {
                    fall_back(hook, generation, super::ENGINE, error.to_string());
                    return;
                }
            }
        }
    });
    Ok(())
}

/// DYLD_INSERT_LIBRARIES can be inherited by a game's children. Only the exact
/// selected process may run this hook, even when a child loads the same Gadget.
fn guarded(source: &str, pid: u32, exe: &Path) -> String {
    format!("if (Process.id === {pid} && Process.mainModule.path === {}) {{\n{source}\n}}", json!(exe))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kimochi-gadget-test-{}", unique().unwrap()));
        fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn stopping_unloads_the_script_without_owning_the_game() {
        let dir = scratch();
        let path = dir.join("hook.js");
        fs::write(&path, "Interceptor.attach(game, callback)").unwrap();
        let mut session = Session { gadget: Some(path.clone()), ..Session::default() };
        stop(&mut session);
        assert!(session.gadget.is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), IDLE);
        assert!(!path.with_extension("pending").exists());
        stop(&mut session);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn bundle_executable_cannot_escape_macos_directory() {
        let dir = scratch();
        let bundle = dir.join("Game.app");
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        fs::write(bundle.join("Contents/Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>../../other</string></dict></plist>"#).unwrap();
        assert!(executable(&bundle).is_err());
        fs::write(bundle.join("Contents/Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Game</string></dict></plist>"#).unwrap();
        fs::write(bundle.join("Contents/MacOS/Game"), []).unwrap();
        assert_eq!(executable(&bundle).unwrap(), bundle.join("Contents/MacOS/Game").canonicalize().unwrap());
        assert!(executable(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
