//! Text hooking for Windows games running through Wine or Proton on Linux.
//!
//! The hook helper and the hookers are Windows programs, so they run *inside the game's
//! prefix*: started with the game's own Wine build and its prefix's environment, they talk to
//! the game's wineserver and so see the game as an ordinary Windows process they can inject
//! into and open named pipes with. Proton's games run inside the Steam Linux Runtime container,
//! but the prefix, the Proton build and the wineserver's socket (under `/tmp/.wine-<uid>`) are
//! all reachable from outside it, so nothing has to enter the container.
//!
//! Wine's process ids are its own, not Linux's, so the game's id inside the prefix comes from the
//! helper (`kimochi-hookd processes`), matched to the game by its Windows image path.
#[cfg(any(target_os = "linux", test))]
use super::process::Target;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
use std::path::PathBuf;

/// How to run a Windows program alongside one game: in its prefix, with its Wine. Every
/// platform's hook target carries one (`None` off Linux), so the type exists everywhere; only
/// Linux reads it.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct Wine {
    /// The `wine` launcher of the build the game runs on.
    pub binary: PathBuf,
    pub prefix: PathBuf,
    /// The variables taken from the game's environment (prefix, sync mode, Wine's library paths).
    pub env: Vec<(String, String)>,
    /// The game's Windows image path as Wine reports it (`S:\steamapps\common\Game\game.exe`).
    pub image: String,
}

/// Variables that describe the game's own process rather than its prefix; a second program
/// inheriting them would break (the preloader's reserved range, an inherited server socket).
#[cfg(any(target_os = "linux", test))]
const PROCESS_ONLY: &[&str] =
    &["WINELOADERNOEXEC", "WINESERVERSOCKET", "WINEPRELOADRESERVE", "WINE_LD_PRELOAD", "WINEDEBUG"];

/// From a process's environment, the variables a program sharing its prefix needs: every `WINE*`
/// variable except the process-only ones (the sync mode in particular must match the game's, or
/// the two disagree about how waits work), and Wine's library path where it exists here.
#[cfg(any(target_os = "linux", test))]
pub fn shared_env(environ: &[(String, String)], exists: impl Fn(&Path) -> bool) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (key, value) in environ {
        if key.starts_with("WINE") && !PROCESS_ONLY.contains(&key.as_str()) {
            out.push((key.clone(), value.clone()));
        } else if key == "LD_LIBRARY_PATH" {
            // Inside the runtime container some entries do not exist outside it; Proton's own
            // library directory does.
            let kept: Vec<&str> = value.split(':').filter(|p| !p.is_empty() && exists(Path::new(p))).collect();
            if !kept.is_empty() {
                out.push((key.clone(), kept.join(":")));
            }
        }
    }
    out
}

/// The `wine` launcher of the build whose loader is `loader` (what `/proc/<pid>/exe` names).
/// Wine 7 and later keep loaders in `lib/wine/<arch>-unix/` under the build's root; older builds
/// and distribution packages keep them in `bin/` beside `wine`.
#[cfg(any(target_os = "linux", test))]
pub fn launcher_candidates(loader: &Path) -> Vec<PathBuf> {
    let Some(dir) = loader.parent() else { return Vec::new() };
    let unix_dir = dir.file_name().is_some_and(|n| n.to_string_lossy().ends_with("-unix"));
    let bin = if unix_dir {
        match dir.parent().and_then(Path::parent).and_then(Path::parent) {
            Some(root) => root.join("bin"),
            None => return Vec::new(),
        }
    } else {
        dir.to_path_buf()
    };
    vec![bin.join("wine"), bin.join("wine64")]
}

/// Whether the program a process runs is one of Wine's loaders.
#[cfg(any(target_os = "linux", test))]
pub fn is_wine_loader(loader: &Path) -> bool {
    loader
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|n| matches!(n.as_str(), "wine" | "wine64" | "wine-preloader" | "wine64-preloader"))
}

/// A Windows path inside a prefix as a Linux path, through the prefix's drive links
/// (`dosdevices/s:` → the Steam library, `z:` → `/`). `None` for a path on no linked drive.
#[cfg(any(target_os = "linux", test))]
pub fn unix_path(prefix: &Path, windows: &str, read_link: impl Fn(&Path) -> Option<PathBuf>) -> Option<PathBuf> {
    if windows.starts_with('/') {
        return Some(PathBuf::from(windows));
    }
    let mut chars = windows.chars();
    let drive = chars.next()?.to_ascii_lowercase();
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let devices = prefix.join("dosdevices");
    let link = devices.join(format!("{drive}:"));
    let target = read_link(&link)?;
    let mut path = if target.is_absolute() { target } else { devices.join(target) };
    for part in windows[2..].split(['\\', '/']).filter(|p| !p.is_empty()) {
        path.push(part);
    }
    Some(path)
}

/// A Linux path as Wine sees it, on the `Z:` drive every prefix maps to `/`.
#[cfg(any(target_os = "linux", test))]
pub fn windows_path(path: &Path) -> String {
    format!("Z:{}", path.to_string_lossy().replace('/', "\\"))
}

/// One process inside the prefix, as `kimochi-hookd processes` lists it.
#[derive(Debug, Clone, PartialEq)]
#[cfg(any(target_os = "linux", test))]
pub struct Listed {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    pub path: Option<String>,
    pub bits: Option<u32>,
}

#[cfg(any(target_os = "linux", test))]
pub fn parse_listing(output: &str) -> Vec<Listed> {
    output
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| v["event"] == "process")
        .filter_map(|v| {
            Some(Listed {
                pid: u32::try_from(v["pid"].as_u64()?).ok()?,
                parent: v["parent"].as_u64().and_then(|p| u32::try_from(p).ok()).unwrap_or(0),
                name: v["name"].as_str()?.to_string(),
                path: v["path"].as_str().map(str::to_string),
                bits: v["bits"].as_u64().and_then(|b| u32::try_from(b).ok()),
            })
        })
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn same_image(a: &str, b: &str) -> bool {
    a.replace('/', "\\").eq_ignore_ascii_case(&b.replace('/', "\\"))
}
#[cfg(any(target_os = "linux", test))]
fn file_name(windows: &str) -> &str {
    windows.rsplit(['\\', '/']).next().unwrap_or(windows)
}

/// The game's processes inside the prefix: the one running `image` (by full path, else by file
/// name) and its engine children (a launcher's `.bin`/`.log` process), with Wine's ids.
#[cfg(any(target_os = "linux", test))]
pub fn pick<'a>(listed: &'a [Listed], image: &str) -> Vec<&'a Listed> {
    let by_path: Vec<&Listed> = listed.iter().filter(|p| p.path.as_deref().is_some_and(|q| same_image(q, image))).collect();
    let mut found = if by_path.is_empty() {
        let name = file_name(image);
        listed.iter().filter(|p| p.name.eq_ignore_ascii_case(name)).collect()
    } else {
        by_path
    };
    let mut i = 0;
    while i < found.len() {
        let parent = found[i].pid;
        for child in listed {
            if child.parent == parent
                && !found.iter().any(|f| f.pid == child.pid)
                && super::process::is_engine_child(Path::new(&child.name))
            {
                found.push(child);
            }
        }
        i += 1;
    }
    found
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn environ(pid: u32) -> Option<Vec<(String, String)>> {
        let bytes = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
        Some(
            bytes
                .split(|b| *b == 0)
                .filter_map(|kv| {
                    let kv = String::from_utf8_lossy(kv);
                    let (k, v) = kv.split_once('=')?;
                    Some((k.to_string(), v.to_string()))
                })
                .collect(),
        )
    }

    /// The process as a hook target, still with its Linux id: whether it runs under Wine, with
    /// which build and prefix, and its Windows image. Cheap enough for every listed window.
    pub fn target(pid: u32) -> Result<Target, String> {
        if pid == 0 || pid == std::process::id() {
            return Err("Kimochi and the system cannot be hooked".into());
        }
        let loader = std::fs::read_link(format!("/proc/{pid}/exe"))
            .map_err(|_| "this process is not running or cannot be inspected".to_string())?;
        if !is_wine_loader(&loader) {
            return Err("Text Hooker reads Windows games running through Proton or Wine; this is a Linux app.".into());
        }
        let binary = launcher_candidates(&loader)
            .into_iter()
            .find(|p| p.is_file())
            .ok_or("Kimochi cannot find the Wine this game runs on.")?;
        let environ = environ(pid).ok_or("this process cannot be inspected")?;
        let var = |k: &str| environ.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        let prefix = var("WINEPREFIX")
            .map(PathBuf::from)
            .or_else(|| var("HOME").map(|h| Path::new(&h).join(".wine")))
            .filter(|p| p.join("dosdevices").is_dir())
            .ok_or("Kimochi cannot find this game's Wine prefix.")?;
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|_| "this process cannot be inspected")?;
        let image = String::from_utf8_lossy(cmdline.split(|b| *b == 0).next().unwrap_or_default()).trim().to_string();
        if !image.to_ascii_lowercase().ends_with(".exe") {
            return Err("this is part of Wine, not a game".into());
        }
        let exe = unix_path(&prefix, &image, |p| std::fs::read_link(p).ok()).unwrap_or_else(|| PathBuf::from(&image));
        let lower = image.to_ascii_lowercase().replace('/', "\\");
        if lower.starts_with("c:\\windows\\") || lower.contains("\\proton") && lower.contains("\\files\\") {
            return Err("this is part of Wine, not a game".into());
        }
        let bits = std::fs::File::open(&exe)
            .ok()
            .and_then(|f| {
                use std::io::Read;
                let mut bytes = vec![0u8; 4096];
                let n = f.take(4096).read(&mut bytes).ok()?;
                bytes.truncate(n);
                super::super::process::pe_bits(&bytes)
            })
            .unwrap_or(64);
        let env = shared_env(&environ, Path::exists);
        Ok(Target { pid, exe, bits, wine: Some(Wine { binary, prefix, env, image }) })
    }

    /// Starts a Windows program with the game's Wine, in its prefix. The caller's own library
    /// path (Kimochi's AppImage bundles its own libraries) must not reach Wine.
    pub fn command(wine: &Wine, program: &Path) -> Command {
        let mut command = Command::new(&wine.binary);
        command
            .arg(windows_path(program))
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("LD_PRELOAD")
            .env("WINEPREFIX", &wine.prefix)
            .env("WINEDEBUG", "-all")
            .envs(wine.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        command
    }

    /// The game's processes with Wine's ids, from the helper run inside the prefix.
    pub fn windows_targets(hookd: &Path, game: &Target) -> Result<Vec<Target>, String> {
        let wine = game.wine.as_ref().ok_or("not a Wine game")?;
        let mut child = command(wine, hookd)
            .arg("processes")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start Wine ({}): {e}", wine.binary.display()))?;
        let mut stdout = child.stdout.take().ok_or("no output from Wine")?;
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
            text
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().ok().flatten().is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Wine did not answer in time".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let listed = parse_listing(&reader.join().unwrap_or_default());
        let found = pick(&listed, &wine.image);
        if found.is_empty() {
            return Err(format!("{} is not running in its Wine prefix", file_name(&wine.image)));
        }
        Ok(found
            .into_iter()
            .map(|p| Target {
                pid: p.pid,
                exe: game.exe.clone(),
                bits: p.bits.unwrap_or(game.bits),
                wine: game.wine.clone(),
            })
            .collect())
    }
}

#[cfg(target_os = "linux")]
pub use imp::{command, target, windows_targets};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launcher_is_found_from_the_loader() {
        assert_eq!(
            launcher_candidates(Path::new("/s/common/Proton 11.0/files/lib/wine/i386-unix/wine-preloader"))[0],
            PathBuf::from("/s/common/Proton 11.0/files/bin/wine")
        );
        assert_eq!(launcher_candidates(Path::new("/usr/bin/wine64-preloader"))[0], PathBuf::from("/usr/bin/wine"));
        assert!(is_wine_loader(Path::new("/x/wine64-preloader")));
        assert!(!is_wine_loader(Path::new("/usr/bin/firefox")));
    }

    #[test]
    fn only_the_prefix_wide_variables_are_shared() {
        let environ: Vec<(String, String)> = [
            ("WINEPREFIX", "/c/pfx"),
            ("WINEFSYNC", "1"),
            ("WINESERVERSOCKET", "40"),
            ("WINEPRELOADRESERVE", "000400000-000914000"),
            ("WINEDEBUG", "-all"),
            ("LD_LIBRARY_PATH", "/proton/lib:/usr/lib/pressure-vessel/overrides/lib"),
            ("LD_PRELOAD", "/tmp/overlay.so"),
            ("HOME", "/home/deck"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let shared = shared_env(&environ, |p| p.starts_with("/proton"));
        assert_eq!(
            shared,
            vec![
                ("WINEPREFIX".to_string(), "/c/pfx".to_string()),
                ("WINEFSYNC".to_string(), "1".to_string()),
                ("LD_LIBRARY_PATH".to_string(), "/proton/lib".to_string()),
            ]
        );
    }

    #[test]
    fn windows_paths_map_through_the_drive_links() {
        let links = |p: &Path| match p.to_str()? {
            "/pfx/dosdevices/s:" => Some(PathBuf::from("/home/deck/.local/share/Steam")),
            "/pfx/dosdevices/c:" => Some(PathBuf::from("../drive_c")),
            _ => None,
        };
        let prefix = Path::new("/pfx");
        assert_eq!(
            unix_path(prefix, "S:\\steamapps\\common\\Game\\game.exe", links),
            Some(PathBuf::from("/home/deck/.local/share/Steam/steamapps/common/Game/game.exe"))
        );
        assert_eq!(unix_path(prefix, "C:\\Games\\vn.exe", links), Some(PathBuf::from("/pfx/dosdevices/../drive_c/Games/vn.exe")));
        assert_eq!(unix_path(prefix, "Q:\\x.exe", links), None);
        assert_eq!(windows_path(Path::new("/home/deck/hook/kimochi-hookd-x64.exe")), "Z:\\home\\deck\\hook\\kimochi-hookd-x64.exe");
    }

    #[test]
    fn the_game_is_picked_out_of_the_prefix() {
        let listing = r#"{"bits":64,"event":"process","name":"steam.exe","parent":0,"path":"C:\\windows\\system32\\steam.exe","pid":32}
{"bits":32,"event":"process","name":"Game.exe","parent":32,"path":"S:\\steamapps\\common\\Game\\Game.exe","pid":308}
{"bits":32,"event":"process","name":"Game.bin","parent":308,"path":"S:\\steamapps\\common\\Game\\Game.bin","pid":400}
{"bits":64,"event":"process","name":"kimochi-hookd-x64.exe","parent":0,"path":null,"pid":500}
not json"#;
        let listed = parse_listing(listing);
        assert_eq!(listed.len(), 4);
        let pids = |image: &str| pick(&listed, image).iter().map(|p| p.pid).collect::<Vec<_>>();
        assert_eq!(pids("S:\\steamapps\\common\\Game\\Game.exe"), vec![308, 400]);
        // Wine may report another drive for the same file; the name still finds it.
        assert_eq!(pids("Z:\\home\\deck\\Game\\game.exe"), vec![308, 400]);
        assert!(pids("S:\\Other\\Other.exe").is_empty());
    }
}
