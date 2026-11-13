//! Text hooking for Windows games running through Wine or Proton on Linux.
//!
//! The hook helper and the hookers are Windows programs, so they run *inside the game's
//! prefix*: started with the game's own Wine build and its prefix's environment, they talk to
//! the game's wineserver and so see the game as an ordinary Windows process they can inject
//! into and open named pipes with. Proton's games run inside the Steam Linux Runtime container,
//! but the prefix, the Proton build and the wineserver's socket (under `/tmp/.wine-<uid>`) are
//! all reachable from outside it, so nothing has to enter the container.
//!
//! A game in a Flatpak sandbox (Bottles, Lutris, Heroic or Steam from Flathub) is different: the
//! sandbox has its own `/tmp`, where the game's wineserver listens, and sees little of the home
//! folder. A Wine started outside would start a second wineserver on the same prefix, see none of
//! the game's processes, and could damage the prefix. So the programs run inside the sandbox
//! (`flatpak enter`), from copies in the game's prefix, which both sides see.
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
    /// For a game in a Flatpak sandbox, its process's (Linux) id: programs are run inside the
    /// sandbox through it, and the paths above are as the sandbox sees them.
    pub flatpak: Option<u32>,
}

/// `path` as a process sees it, as Kimochi can open it: through `/proc/<pid>/root`.
#[cfg(any(target_os = "linux", test))]
pub fn in_root(pid: u32, path: &Path) -> PathBuf {
    PathBuf::from(format!("/proc/{pid}/root{}", path.to_string_lossy()))
}

/// The folder Wine's processes reach a prefix's wineserver in, for a prefix on device `dev` at
/// inode `ino`, run by user `uid` (Wine's `server-<dev>-<ino>`, both in hex).
#[cfg(any(target_os = "linux", test))]
pub fn server_dir(uid: u32, dev: u64, ino: u64) -> PathBuf {
    PathBuf::from(format!("/tmp/.wine-{uid}/server-{dev:x}-{ino:x}"))
}

/// A short name for a folder's contents: the same files give the same name, so a staged copy is
/// reused until Kimochi (or the hooker) changes. FNV-1a, stable across builds and Rust versions.
#[cfg(any(target_os = "linux", test))]
pub fn content_key(files: &[(String, Vec<u8>)]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for (name, bytes) in files {
        for b in name.bytes().chain([0]).chain(bytes.iter().copied()) {
            hash = (hash ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
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
    // Linux paths whatever the host, so the tests mean the same on every platform: `/`-joined by
    // hand, where `Path::join` would use the host's separator (and, on Windows, call `/home/…`
    // relative).
    let devices = format!("{}/dosdevices", prefix.to_string_lossy().trim_end_matches('/'));
    let target = read_link(Path::new(&format!("{devices}/{drive}:")))?;
    let target = target.to_string_lossy();
    let mut path = if target.starts_with('/') { target.into_owned() } else { format!("{devices}/{target}") };
    for part in windows[2..].split(['\\', '/']).filter(|p| !p.is_empty()) {
        if !path.ends_with('/') {
            path.push('/');
        }
        path.push_str(part);
    }
    Some(PathBuf::from(path))
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
    let by_path: Vec<&Listed> =
        listed.iter().filter(|p| p.path.as_deref().is_some_and(|q| same_image(q, image))).collect();
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
        // In a Flatpak sandbox the paths below are the sandbox's (the Wine build may be one only
        // it has, under /app), so they are looked at through the game's own root.
        let flatpak = Path::new(&format!("/proc/{pid}/root/.flatpak-info")).is_file().then_some(pid);
        let outside = |p: &Path| match flatpak {
            Some(pid) => in_root(pid, p),
            None => p.to_path_buf(),
        };
        let binary = launcher_candidates(&loader)
            .into_iter()
            .find(|p| outside(p).is_file())
            .ok_or("Kimochi cannot find the Wine this game runs on.")?;
        let environ = environ(pid).ok_or("this process cannot be inspected")?;
        let var = |k: &str| environ.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        let prefix = var("WINEPREFIX")
            .map(PathBuf::from)
            .or_else(|| var("HOME").map(|h| Path::new(&h).join(".wine")))
            .filter(|p| outside(&p.join("dosdevices")).is_dir())
            .ok_or("Kimochi cannot find this game's Wine prefix.")?;
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|_| "this process cannot be inspected")?;
        let image = String::from_utf8_lossy(cmdline.split(|b| *b == 0).next().unwrap_or_default()).trim().to_string();
        if !image.to_ascii_lowercase().ends_with(".exe") {
            return Err("this is part of Wine, not a game".into());
        }
        let exe = unix_path(&prefix, &image, |p| std::fs::read_link(outside(p)).ok())
            .unwrap_or_else(|| PathBuf::from(&image));
        let lower = image.to_ascii_lowercase().replace('/', "\\");
        if lower.starts_with("c:\\windows\\") || lower.contains("\\proton") && lower.contains("\\files\\") {
            return Err("this is part of Wine, not a game".into());
        }
        if flatpak.is_none() && !server_reachable(pid, &prefix) {
            return Err("This game runs in a sandbox Kimochi cannot reach its Wine through.".into());
        }
        let bits = std::fs::File::open(outside(&exe))
            .ok()
            .and_then(|f| {
                use std::io::Read;
                let mut bytes = vec![0u8; 4096];
                let n = f.take(4096).read(&mut bytes).ok()?;
                bytes.truncate(n);
                super::super::process::pe_bits(&bytes)
            })
            .unwrap_or(64);
        let env = shared_env(&environ, |p| outside(p).exists());
        Ok(Target { pid, exe, bits, wine: Some(Wine { binary, prefix, env, image, flatpak }) })
    }

    /// Whether a Wine started here reaches the game's wineserver, rather than starting a second
    /// one on its prefix: false only when the game's is in a `/tmp` of its own (a sandbox) and
    /// none is in ours.
    fn server_reachable(pid: u32, prefix: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        let (Ok(me), Ok(prefix)) = (std::fs::metadata("/proc/self"), std::fs::metadata(prefix)) else { return true };
        let socket = server_dir(me.uid(), prefix.dev(), prefix.ino()).join("socket");
        socket.exists() || !in_root(pid, &socket).exists()
    }

    /// The prefix user's folder Kimochi keeps copies in (`AppData\Local\kimochi-texthook`), as
    /// the game sees it.
    fn stage_base(wine: &Wine, outside: &dyn Fn(&Path) -> PathBuf) -> Result<PathBuf, String> {
        let users = wine.prefix.join("drive_c").join("users");
        let mut names: Vec<String> = std::fs::read_dir(outside(&users))
            .map_err(|e| format!("the game's Wine prefix has no user folder: {e}"))?
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.eq_ignore_ascii_case("public"))
            .collect();
        names.sort();
        let unix_user = std::env::var("USER").ok();
        let user = ["steamuser"]
            .into_iter()
            .chain(unix_user.as_deref())
            .find(|u| names.iter().any(|n| n == u))
            .map(str::to_owned)
            .or_else(|| names.into_iter().next())
            .ok_or("the game's Wine prefix has no user folder")?;
        Ok(users.join(user).join("AppData").join("Local").join("kimochi-texthook"))
    }

    /// Kimochi's folder `dir` where the game can reach it: itself, or for a game in a sandbox that
    /// does not see it, a copy in the game's prefix, made once per content.
    pub fn reachable_dir(wine: &Wine, dir: &Path) -> Result<PathBuf, String> {
        use std::os::unix::fs::MetadataExt;
        let Some(pid) = wine.flatpak else { return Ok(dir.to_path_buf()) };
        let outside = |p: &Path| in_root(pid, p);
        let ours = std::fs::metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        if std::fs::metadata(outside(dir)).is_ok_and(|m| m.dev() == ours.dev() && m.ino() == ours.ino()) {
            return Ok(dir.to_path_buf());
        }
        let mut files = Vec::new();
        collect(dir, dir, &mut files)?;
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let staged = stage_base(wine, &outside)?.join(format!("{name}-{}", content_key(&files)));
        if outside(&staged).is_dir() {
            return Ok(staged);
        }
        // Written under a temporary name first, so a half-written copy is never used.
        let partial = outside(&staged.with_extension(format!("partial-{}", std::process::id())));
        let write = || -> std::io::Result<()> {
            for (relative, bytes) in &files {
                let path = partial.join(relative);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, bytes)?;
            }
            std::fs::rename(&partial, outside(&staged))
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_dir_all(&partial);
            // Another Kimochi staged the same copy meanwhile.
            if !outside(&staged).is_dir() {
                return Err(format!("could not copy Kimochi's text hook files into the game's prefix: {e}"));
            }
        }
        Ok(staged)
    }

    /// Kimochi's file `path` where the game can reach it, with the files beside it (the helper
    /// runs its other-bitness build from its own folder).
    pub fn reachable(wine: &Wine, path: &Path) -> Result<PathBuf, String> {
        let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { return Ok(path.to_path_buf()) };
        Ok(reachable_dir(wine, dir)?.join(name))
    }

    /// Every file under `dir`, by its path relative to `base`, in a stable order.
    fn collect(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
        let mut entries: Vec<_> =
            std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                collect(base, &path, out)?;
            } else if path.is_file() {
                let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                let relative = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().into_owned();
                out.push((relative, bytes));
            }
        }
        Ok(())
    }

    /// Starts a Windows program with the game's Wine, in its prefix. The caller's own library
    /// path (Kimochi's AppImage bundles its own libraries) must not reach Wine, nor `flatpak`.
    /// `program` must be one the game can reach (`reachable`).
    pub fn command(wine: &Wine, program: &Path) -> Command {
        let mut command = Command::new(match wine.flatpak {
            Some(_) => Path::new("flatpak"),
            None => wine.binary.as_path(),
        });
        command.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD");
        match wine.flatpak {
            // Inside the game's sandbox, where it starts with the game's environment: what
            // describes only the game's own process is taken out, and the prefix's variables given.
            Some(pid) => {
                command.args(["enter", &pid.to_string(), "env"]);
                for key in PROCESS_ONLY.iter().chain(&["LD_PRELOAD"]) {
                    command.args(["-u", key]);
                }
                command.arg(format!("WINEPREFIX={}", wine.prefix.to_string_lossy())).arg("WINEDEBUG=-all");
                command.args(wine.env.iter().map(|(k, v)| format!("{k}={v}")));
                command.arg(&wine.binary);
            }
            None => {
                command
                    .env("WINEPREFIX", &wine.prefix)
                    .env("WINEDEBUG", "-all")
                    .envs(wine.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
            }
        }
        command.arg(windows_path(program));
        command
    }

    /// The game's processes with Wine's ids, from the helper run inside the prefix.
    pub fn windows_targets(hookd: &Path, game: &Target) -> Result<Vec<Target>, String> {
        let wine = game.wine.as_ref().ok_or("not a Wine game")?;
        let hookd = reachable(wine, hookd)?;
        let mut child = command(wine, &hookd)
            .arg("processes")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match wine.flatpak {
                Some(_) => format!("could not reach into the game's Flatpak sandbox (flatpak enter): {e}"),
                None => format!("could not start Wine ({}): {e}", wine.binary.display()),
            })?;
        let mut stdout = child.stdout.take().ok_or("no output from Wine")?;
        let mut stderr = child.stderr.take().ok_or("no output from Wine")?;
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
            text
        });
        let errors = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
            text
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().ok().flatten() {
                break status;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Wine did not answer in time".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let listed = parse_listing(&reader.join().unwrap_or_default());
        let found = pick(&listed, &wine.image);
        if found.is_empty() {
            // Nothing listed at all: Wine (or `flatpak enter`) did not run; say why.
            let error = errors.join().unwrap_or_default();
            let last = error.lines().map(str::trim).rfind(|l| !l.is_empty());
            if let (true, false, Some(last)) = (listed.is_empty(), status.success(), last) {
                return Err(format!("could not run the hook helper with the game's Wine: {last}"));
            }
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
pub use imp::{command, reachable, reachable_dir, target, windows_targets};

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
        assert_eq!(
            unix_path(prefix, "C:\\Games\\vn.exe", links),
            Some(PathBuf::from("/pfx/dosdevices/../drive_c/Games/vn.exe"))
        );
        assert_eq!(unix_path(prefix, "Q:\\x.exe", links), None);
        assert_eq!(
            windows_path(Path::new("/home/deck/hook/kimochi-hookd-x64.exe")),
            "Z:\\home\\deck\\hook\\kimochi-hookd-x64.exe"
        );
    }

    #[test]
    fn a_sandboxed_games_files_and_wineserver_are_found_where_it_sees_them() {
        assert_eq!(in_root(4242, Path::new("/app/bin/wine")), PathBuf::from("/proc/4242/root/app/bin/wine"));
        // Wine's own naming: dev 0x830, inode 0x13ace8 (a Bottles prefix, live).
        assert_eq!(server_dir(1000, 0x830, 0x13ace8), PathBuf::from("/tmp/.wine-1000/server-830-13ace8"));
    }

    #[test]
    fn a_staged_copy_is_named_by_its_content() {
        let files = |bytes: &[u8]| {
            vec![("kimochi-hookd-x64.exe".to_string(), bytes.to_vec()), ("x86/a.dll".to_string(), vec![1])]
        };
        assert_eq!(content_key(&files(b"build 1")), content_key(&files(b"build 1")));
        assert_ne!(content_key(&files(b"build 1")), content_key(&files(b"build 2")));
        // A file renamed is another folder too.
        assert_ne!(content_key(&[("a".into(), b"bc".to_vec())]), content_key(&[("ab".into(), b"c".to_vec())]));
        assert_eq!(content_key(&files(b"x")).len(), 16);
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
