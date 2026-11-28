//! Text hooking for Windows games running through Wine or Proton on Linux.
//!
//! The hook helper and the hookers are Windows programs, so they run *inside the game's
//! prefix*: started with the game's own Wine build and its prefix's environment, they talk to
//! the game's wineserver and so see the game as an ordinary Windows process they can inject
//! into and open named pipes with. Proton's games run inside the Steam Linux Runtime container,
//! usually the prefix, Proton build and wineserver socket are reachable outside it. NixOS's
//! Steam wrapper gives games a private `/tmp`; helpers join its user and mount namespaces with
//! `nsenter --preserve-credentials`, retaining the user's uid/gid and the existing Wine session.
//!
//! A game in a Flatpak sandbox (Bottles, Lutris, Heroic or Steam from Flathub) is different: the
//! sandbox has its own `/tmp`, where the game's wineserver listens, and sees little of the home
//! folder. A Wine started outside would start a second wineserver on the same prefix, see none of
//! the game's processes, and could damage the prefix. So the programs run inside the sandbox
//! (`flatpak enter`), from copies in the game's prefix, which both sides see.
//!
//! Wine's process ids are its own, not Linux's, so the game's id inside the prefix comes from the
//! helper (`kimochi-hookd processes`), matched to the game by its Windows image path.
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::process::Target;
#[cfg(any(target_os = "linux", target_os = "macos", test))]
use std::path::Path;
use std::path::PathBuf;

/// How to run a Windows program alongside one game: in its prefix, with its Wine. Every
/// platform's hook target carries one (`None` off Linux), so the type exists everywhere; only
/// Linux reads it.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
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
    /// A non-Flatpak game with a private Wine socket, in an unprivileged user/mount namespace.
    pub namespace: Option<u32>,
    /// The game's Linux/macOS host process id, kept after `windows_targets` swaps `Target::pid`
    /// to Wine's internal process id so liveness watchers can detect game exit immediately.
    pub host_pid: Option<u32>,
}

/// `path` as a process sees it, as Kimochi can open it: through `/proc/<pid>/root`.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn in_root(pid: u32, path: &Path) -> PathBuf {
    PathBuf::from(format!("/proc/{pid}/root{}", path.to_string_lossy()))
}

/// The folder Wine's processes reach a prefix's wineserver in, for a prefix on device `dev` at
/// inode `ino`, run by user `uid` (Wine's `server-<dev>-<ino>`, both in hex).
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn server_dir(uid: u32, dev: u64, ino: u64) -> PathBuf {
    PathBuf::from(format!("/tmp/.wine-{uid}/server-{dev:x}-{ino:x}"))
}

/// A short name for a folder's contents: the same files give the same name, so a staged copy is
/// reused until Kimochi (or the hooker) changes. FNV-1a, stable across builds and Rust versions.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
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
#[cfg(any(target_os = "linux", target_os = "macos", test))]
const PROCESS_ONLY: &[&str] =
    &["WINELOADERNOEXEC", "WINESERVERSOCKET", "WINEPRELOADRESERVE", "WINE_LD_PRELOAD", "WINEDEBUG"];

/// From a process's environment, the variables a program sharing its prefix needs: every `WINE*`
/// variable except the process-only ones (the sync mode in particular must match the game's, or
/// the two disagree about how waits work), and Wine's library path where it exists here.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn shared_env(environ: &[(String, String)], exists: impl Fn(&Path) -> bool) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (key, value) in environ {
        if (key.starts_with("WINE") || key.starts_with("CX_") || key.starts_with("GPTK_"))
            && !PROCESS_ONLY.contains(&key.as_str())
        {
            out.push((key.clone(), value.clone()));
        } else if matches!(key.as_str(), "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH" | "DYLD_FALLBACK_LIBRARY_PATH") {
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
#[cfg(any(target_os = "linux", target_os = "macos", test))]
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
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn is_wine_loader(loader: &Path) -> bool {
    loader
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|n| matches!(n.as_str(), "wine" | "wine64" | "wine-preloader" | "wine64-preloader"))
}

/// A Windows path inside a prefix as a Linux path, through the prefix's drive links
/// (`dosdevices/s:` → the Steam library, `z:` → `/`). `None` for a path on no linked drive.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
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

/// A relative image in Wine's command line is relative to the game's Linux working
/// directory, not Kimochi's. Drive-qualified and UNC paths need their prefix mapping.
#[cfg(any(target_os = "linux", test))]
fn relative_image(image: &str, cwd: &Path) -> Option<PathBuf> {
    if image.contains(':') || image.starts_with(['/', '\\']) {
        return None;
    }
    Some(PathBuf::from(format!("{}/{}", cwd.to_string_lossy().trim_end_matches('/'), image.replace('\\', "/"))))
}

/// A Linux path as Wine sees it, on the `Z:` drive every prefix maps to `/`.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn windows_path(path: &Path) -> String {
    format!("Z:{}", path.to_string_lossy().replace('/', "\\"))
}

/// One process inside the prefix, as `kimochi-hookd processes` lists it.
#[derive(Debug, Clone, PartialEq)]
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub struct Listed {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    pub path: Option<String>,
    pub bits: Option<u32>,
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
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

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn same_image(a: &str, b: &str) -> bool {
    a.replace('/', "\\").eq_ignore_ascii_case(&b.replace('/', "\\"))
}
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn file_name(windows: &str) -> &str {
    windows.rsplit(['\\', '/']).next().unwrap_or(windows)
}

/// The architecture a prefix was made for, from the head of its `system.reg` (`#arch=win32` or
/// `#arch=win64`, which Wine writes when it creates the prefix).
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn prefix_arch(system_reg: &str) -> Option<&str> {
    system_reg.lines().take(20).find_map(|l| l.trim().strip_prefix("#arch=")).map(str::trim)
}

/// The Flatpak app a sandboxed game runs in, with its branch (`org.winehq.Wine stable-22.08`),
/// from the sandbox's `/.flatpak-info`. Flathub's Wine keeps one Wine release per branch, so the
/// branch says which Wine the game has.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn flatpak_app(info: &str) -> Option<String> {
    let mut section = "";
    let (mut name, mut branch) = (None, None);
    for line in info.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
        } else if let Some((key, value)) = line.split_once('=') {
            match (section, key.trim()) {
                ("[Application]", "name") => name = Some(value.trim()),
                ("[Instance]", "branch") => branch = Some(value.trim()),
                _ => {}
            }
        }
    }
    Some(match branch.filter(|b| !b.is_empty()) {
        Some(branch) => format!("{} {branch}", name?),
        None => name?.to_string(),
    })
}

/// What Wine's loader could not give the helper, from its `err:module` lines: the DLL it lacks
/// (`import_dll Library X.dll (which is needed by …) not found`), else the function
/// (`No implementation for X.dll.F imported from …`), else that it failed. Wine releases
/// gain DLLs and functions, so on a Wine too old for the helper this is what goes missing. (Wine
/// before 8.14 lacks `bcryptprimitives.dll`, which Kimochi ships a stand-in for; see
/// `hookd/shim/`.)
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn missing_from_wine(output: &str) -> Option<String> {
    let lines: Vec<&str> = output.lines().map(str::trim).filter(|l| l.contains("err:module:")).collect();
    let after = |l: &str, start: &str, end: &str| -> Option<String> {
        let rest = &l[l.find(start)? + start.len()..];
        Some(rest[..rest.find(end)?].trim().to_string())
    };
    if lines.is_empty() {
        return None;
    }
    lines
        .iter()
        .find_map(|l| after(l, "Library ", " (").filter(|_| l.contains("not found")))
        .or_else(|| lines.iter().find_map(|l| after(l, "No implementation for ", " imported")))
        .or_else(|| Some(String::new()))
}

/// Where someone whose Wine is too old finds how to update it (WineHQ's download page, with
/// instructions for each distribution; `wiki.winehq.org/Download` redirects here).
pub const WINE_UPDATE_URL: &str = "https://gitlab.winehq.org/wine/wine/-/wikis/Download";

/// How a reason from `not_found_reason` that comes down to an old Wine begins, so the card can
/// offer `WINE_UPDATE_URL` with it.
pub const OLD_WINE: &str = "Kimochi's hook helper could not start with this game's Wine";

/// Whether a failed start's reason is an old Wine, for the card's link to `WINE_UPDATE_URL`.
pub fn needs_newer_wine(reason: &str) -> bool {
    reason.starts_with(OLD_WINE)
}

/// Why the game was not found among what the helper listed, for the person hooking it.
///
/// The helper always lists itself, so an empty list means it never ran. Its exit status cannot
/// tell: `flatpak enter` exits 0 whatever the program it ran did. Wine reports an exe it cannot
/// start (`Bad EXE format`) on stdout, a program it cannot load (a DLL it lacks) on stderr as a
/// `err:module` line, so both are looked at. `sandbox` names a Flatpak the game runs in.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub fn not_found_reason(
    image: &str,
    prefix: &Path,
    listed: &[Listed],
    sandbox: Option<&str>,
    stdout: &str,
    stderr: &str,
) -> String {
    let said = |text: &str| -> Option<String> {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .filter_map(|l| match serde_json::from_str::<serde_json::Value>(l) {
                // The helper's own error event.
                Ok(v) if v["event"] == "error" => v["text"].as_str().map(str::to_string),
                Ok(_) => None,
                Err(_) => Some(l.to_string()),
            })
            .next_back()
    };
    if listed.is_empty() {
        if let Some(missing) = missing_from_wine(stderr).or_else(|| missing_from_wine(stdout)) {
            let wine = sandbox.map(|app| format!(" (the {app} Flatpak)")).unwrap_or_default();
            let lacks = if missing.is_empty() { String::new() } else { format!(", which has no {missing}") };
            return format!(
                "{OLD_WINE}{wine}{lacks}. This Wine is probably too old: update it (for Flathub's Wine, install a newer branch of it), or run the game with a recent Proton."
            );
        }
        return match said(stderr).or_else(|| said(stdout)) {
            Some(what) => format!("Could not run the hook helper with the game's Wine: {what}"),
            None => format!(
                "Could not run the hook helper with the game's Wine in {} (it said nothing). Turn on verbose logging and send a debug report.",
                prefix.display()
            ),
        };
    }
    format!(
        "{} is not running in the Wine prefix Kimochi checked ({}; {} other programs there)",
        file_name(image),
        prefix.display(),
        listed.len()
    )
}

/// The game's processes inside the prefix: the one running `image` (by full path, else by file
/// name) and its engine children (a launcher's `.bin`/`.log` process), with Wine's ids.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod imp {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[cfg(target_os = "linux")]
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
    #[cfg(target_os = "linux")]
    pub fn target(pid: u32) -> Result<Target, String> {
        if pid == 0 || pid == std::process::id() {
            return Err("Kimochi and the system cannot be hooked".into());
        }
        let loader = std::fs::read_link(format!("/proc/{pid}/exe"))
            .map_err(|_| "this process is not running or cannot be inspected".to_string())?;
        if !is_wine_loader(&loader) {
            return Err("Text Hooker reads Windows games running through Proton or Wine; this is a Linux app.".into());
        }
        let environ = environ(pid).ok_or("this process cannot be inspected")?;
        let var = |k: &str| environ.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        let prefix = var("WINEPREFIX")
            .map(PathBuf::from)
            .or_else(|| var("HOME").map(|h| Path::new(&h).join(".wine")))
            .ok_or("Kimochi cannot find this game's Wine prefix.")?;
        // In a Flatpak sandbox the paths below are the sandbox's (the Wine build may be one only
        // it has, under /app), so they are looked at through the game's own root.
        let flatpak = Path::new(&format!("/proc/{pid}/root/.flatpak-info")).is_file().then_some(pid);
        let namespace = if flatpak.is_none() && !server_reachable(pid, &prefix) {
            if !private_user_namespace(pid) {
                return Err("This game runs in a sandbox Kimochi cannot reach its Wine through.".into());
            }
            if !std::env::var_os("PATH")
                .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join("nsenter").is_file()))
            {
                return Err("This game's private Wine session needs nsenter (util-linux) to use Text hooking.".into());
            }
            Some(pid)
        } else {
            None
        };
        let outside = |p: &Path| match flatpak.or(namespace) {
            Some(pid) => in_root(pid, p),
            None => p.to_path_buf(),
        };
        let binary = launcher_candidates(&loader)
            .into_iter()
            .find(|p| outside(p).is_file())
            .ok_or("Kimochi cannot find the Wine this game runs on.")?;
        if !outside(&prefix.join("dosdevices")).is_dir() {
            return Err("Kimochi cannot find this game's Wine prefix.".into());
        }
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|_| "this process cannot be inspected")?;
        let mut image =
            String::from_utf8_lossy(cmdline.split(|b| *b == 0).next().unwrap_or_default()).trim().to_string();
        if !image.to_ascii_lowercase().ends_with(".exe") {
            return Err("this is part of Wine, not a game".into());
        }
        let exe = match unix_path(&prefix, &image, |p| std::fs::read_link(outside(p)).ok()) {
            Some(path) => path,
            None => {
                let cwd = std::fs::read_link(format!("/proc/{pid}/cwd"))
                    .map_err(|_| "Kimochi cannot find this game's working directory.")?;
                match relative_image(&image, &cwd) {
                    Some(path) => {
                        // Match the full image inside the prefix, even with two games named game.exe.
                        image = windows_path(&path);
                        path
                    }
                    None => PathBuf::from(&image),
                }
            }
        };
        let lower = image.to_ascii_lowercase().replace('/', "\\");
        if lower.starts_with("c:\\windows\\") || lower.contains("\\proton") && lower.contains("\\files\\") {
            return Err("this is part of Wine, not a game".into());
        }
        // The helper is a 64-bit program (it hosts LunaHook's 64-bit server), which a 32-bit
        // prefix cannot run; Wine would only say "Bad EXE format".
        let system_reg = std::fs::File::open(outside(&prefix.join("system.reg"))).ok().and_then(|f| {
            use std::io::Read;
            let mut text = String::new();
            f.take(1024).read_to_string(&mut text).ok()?;
            Some(text)
        });
        if system_reg.as_deref().and_then(prefix_arch) == Some("win32") {
            return Err(format!(
                "This game's Wine prefix ({}) is 32-bit (WINEARCH=win32), and Text Hooker needs a 64-bit prefix. A 64-bit prefix runs 32-bit games too.",
                prefix.display()
            ));
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
        Ok(Target {
            pid,
            exe,
            bits,
            arm64: false,
            wine: Some(Wine { binary, prefix, env, image, flatpak, namespace, host_pid: Some(pid) }),
        })
    }

    #[cfg(target_os = "linux")]
    fn private_user_namespace(pid: u32) -> bool {
        ["user", "mnt"].iter().all(|name| {
            let target = std::fs::read_link(format!("/proc/{pid}/ns/{name}"));
            let own = std::fs::read_link(format!("/proc/self/ns/{name}"));
            matches!((target, own), (Ok(target), Ok(own)) if target != own)
        })
    }

    /// Whether a Wine started here reaches the game's wineserver, rather than starting a second
    /// one on its prefix: false only when the game's is in a `/tmp` of its own (a sandbox) and
    /// none is in ours.
    #[cfg(target_os = "linux")]
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
        let Some(pid) = wine.flatpak.or(wine.namespace) else { return Ok(dir.to_path_buf()) };
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

    const WINEDEBUG: &str = "-all,err+module";

    /// Starts a Windows program with the game's Wine, in its prefix. The caller's own library
    /// path (Kimochi's AppImage bundles its own libraries) must not reach Wine, nor `flatpak`.
    /// `program` must be one the game can reach (`reachable`). Wine's debug output is off except
    /// the loader's errors, which are how Wine says it could not load the program at all (a DLL
    /// it lacks); without them a program that never started looks like one that printed nothing.
    pub fn command(wine: &Wine, program: &Path) -> Command {
        let mut command = Command::new(match wine.flatpak {
            Some(_) => Path::new("flatpak"),
            None if wine.namespace.is_some() => Path::new("nsenter"),
            None => wine.binary.as_path(),
        });
        command
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("LD_PRELOAD")
            .env_remove("DYLD_LIBRARY_PATH")
            .env_remove("DYLD_FALLBACK_LIBRARY_PATH")
            .env_remove("DYLD_INSERT_LIBRARIES");
        match wine.flatpak {
            // Inside the game's sandbox, where it starts with the game's environment: what
            // describes only the game's own process is taken out, and the prefix's variables given.
            Some(pid) => {
                command.args(["enter", &pid.to_string(), "env"]);
                for key in PROCESS_ONLY.iter().chain(&["LD_PRELOAD"]) {
                    command.args(["-u", key]);
                }
                command
                    .arg(format!("WINEPREFIX={}", wine.prefix.to_string_lossy()))
                    .arg(format!("WINEDEBUG={WINEDEBUG}"));
                command.args(wine.env.iter().map(|(k, v)| format!("{k}={v}")));
                command.arg(&wine.binary);
            }
            None => {
                if let Some(pid) = wine.namespace {
                    command.args(["--target", &pid.to_string(), "--user", "--mount", "--preserve-credentials", "--"]);
                    command.arg(&wine.binary);
                }
                for key in PROCESS_ONLY {
                    command.env_remove(key);
                }
                command
                    .env("WINEPREFIX", &wine.prefix)
                    .env("WINEDEBUG", WINEDEBUG)
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
                None if wine.namespace.is_some() => {
                    format!("could not enter the game's private Wine session (nsenter): {e}")
                }
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
        let stdout = reader.join().unwrap_or_default();
        let stderr = errors.join().unwrap_or_default();
        let listed = parse_listing(&stdout);
        let found = pick(&listed, &wine.image);
        let sandbox = wine
            .flatpak
            .and_then(|pid| std::fs::read_to_string(in_root(pid, Path::new("/.flatpak-info"))).ok())
            .and_then(|info| flatpak_app(&info));
        // What was asked and what came back, for a debug report (verbose logging): which Wine and
        // prefix, the image looked for, and every program the helper saw there.
        let tail = |text: &str| -> Vec<String> {
            let lines: Vec<&str> =
                text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("{\"bits\"")).collect();
            lines[lines.len().saturating_sub(8)..].iter().map(|l| l.to_string()).collect()
        };
        crate::debug_report::trace_now(serde_json::json!({
            "check": "texthook-wine-processes",
            "wine": wine.binary,
            "prefix": wine.prefix,
            "flatpak": wine.flatpak.is_some(),
            "sandbox": sandbox,
            "image": wine.image,
            "helper": windows_path(&hookd),
            // Not the helper's under Flatpak: `flatpak enter` exits 0 whatever it ran did.
            "exit": status.code(),
            "listed": listed.iter().map(|p| serde_json::json!({ "pid": p.pid, "parent": p.parent, "name": p.name, "path": p.path, "bits": p.bits })).collect::<Vec<_>>(),
            "found": found.iter().map(|p| p.pid).collect::<Vec<_>>(),
            "stdout": tail(&stdout),
            "stderr": tail(&stderr),
        }));
        if found.is_empty() {
            return Err(not_found_reason(&wine.image, &wine.prefix, &listed, sandbox.as_deref(), &stdout, &stderr));
        }
        Ok(found
            .into_iter()
            .map(|p| Target {
                pid: p.pid,
                exe: game.exe.clone(),
                bits: p.bits.unwrap_or(game.bits),
                arm64: false,
                wine: game.wine.clone(),
            })
            .collect())
    }
}

#[cfg(target_os = "linux")]
pub use imp::target;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use imp::{command, reachable, reachable_dir, windows_targets};

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

    #[test]
    fn relative_images_use_the_games_directory() {
        let cwd = Path::new("/home/deck/Games/Cave Story");
        assert_eq!(
            relative_image("Doukutsu.exe", cwd),
            Some(PathBuf::from("/home/deck/Games/Cave Story/Doukutsu.exe"))
        );
        assert_eq!(
            relative_image(r"bin\Game.exe", cwd),
            Some(PathBuf::from("/home/deck/Games/Cave Story/bin/Game.exe"))
        );
        assert!(relative_image(r"C:\Games\game.exe", cwd).is_none());
        assert!(relative_image(r"\\server\share\game.exe", cwd).is_none());
        assert!(relative_image("/opt/game.exe", cwd).is_none());
    }

    #[test]
    fn a_32_bit_prefix_is_told_from_its_registry() {
        let head = "WINE REGISTRY Version 2\n;; All keys relative to REGISTRY\\\\Machine\n\n#arch=win32\n";
        assert_eq!(prefix_arch(head), Some("win32"));
        assert_eq!(prefix_arch(&head.replace("win32", "win64")), Some("win64"));
        assert_eq!(prefix_arch("WINE REGISTRY Version 2\n"), None);
    }

    #[test]
    fn a_helper_that_did_not_run_says_why_rather_than_that_the_game_is_missing() {
        let prefix = Path::new("/var/data/wine");
        let image = "Z:\\home\\deck\\Games\\VN\\Game.exe";
        // A 64-bit helper in a 32-bit prefix (Wine 11, live): exit 1, the reason on stdout only.
        let stdout = "Application could not be started, or no application associated with the specified file.\nShellExecuteEx failed: Bad EXE format for Z:\\x\\kimochi-hookd-x64.exe.\n\n";
        let reason = not_found_reason(image, prefix, &[], None, stdout, "");
        assert!(reason.contains("Bad EXE format"), "{reason}");
        // The helper's own error event, and stderr ahead of stdout.
        let reason = not_found_reason(
            image,
            prefix,
            &[],
            None,
            "{\"event\":\"error\",\"text\":\"could not list processes\"}",
            "",
        );
        assert!(reason.ends_with("could not list processes"), "{reason}");
        assert!(not_found_reason(image, prefix, &[], None, "noise", "wine: cannot find L\"x.exe\"")
            .ends_with("cannot find L\"x.exe\""));
        // Nothing at all (exit 0 under `flatpak enter` whatever happened): it did not run, which is
        // not the same as an empty prefix.
        let reason = not_found_reason(image, prefix, &[], None, "", "");
        assert!(reason.contains("said nothing") && reason.contains("/var/data/wine"), "{reason}");
        // It ran and listed programs, none of them the game: the prefix it looked in is named.
        let listed = parse_listing(
            r#"{"bits":64,"event":"process","name":"services.exe","parent":0,"path":"C:\\windows\\system32\\services.exe","pid":32}"#,
        );
        let reason = not_found_reason(image, prefix, &listed, None, "", "");
        assert!(
            reason.starts_with("Game.exe is not running in the Wine prefix Kimochi checked (/var/data/wine;"),
            "{reason}"
        );
    }

    #[test]
    fn a_wine_too_old_for_the_helper_says_so() {
        let prefix = Path::new("/var/data/wine");
        let image = "Z:\\home\\deck\\Downloads\\mla\\Muv-Luv_Alternative16.exe";
        // Flathub's Wine stable-22.08 (Wine 8.0.2), live, with the loader's errors kept.
        let stderr = r#"0128:err:module:import_dll Library bcryptprimitives.dll (which is needed by L"Z:\\var\\data\\wine\\drive_c\\users\\deck\\AppData\\Local\\kimochi-texthook\\hookd-0\\kimochi-hookd-x64.exe") not found
0128:err:module:LdrInitializeThunk Importing dlls for L"Z:\\var\\data\\wine\\drive_c\\users\\deck\\AppData\\Local\\kimochi-texthook\\hookd-0\\kimochi-hookd-x64.exe" failed, status c0000135
"#;
        let reason = not_found_reason(image, prefix, &[], Some("org.winehq.Wine stable-22.08"), "", stderr);
        assert_eq!(
            reason,
            "Kimochi's hook helper could not start with this game's Wine (the org.winehq.Wine stable-22.08 Flatpak), which has no bcryptprimitives.dll. This Wine is probably too old: update it (for Flathub's Wine, install a newer branch of it), or run the game with a recent Proton."
        );
        assert!(needs_newer_wine(&reason));
        let reason = not_found_reason(image, prefix, &[], None, "", stderr);
        assert!(
            reason.starts_with(
                "Kimochi's hook helper could not start with this game's Wine, which has no bcryptprimitives.dll."
            ),
            "{reason}"
        );
        // A function it lacks, and a failure that names neither.
        let reason = not_found_reason(image, prefix, &[], None, "", "0130:err:module:import_dll No implementation for kernel32.dll.GetSystemTimePreciseAsFileTime imported from L\"Z:\\x.exe\", setting to 0xdeadbeef\n");
        assert!(reason.contains("which has no kernel32.dll.GetSystemTimePreciseAsFileTime."), "{reason}");
        let reason = not_found_reason(
            image,
            prefix,
            &[],
            None,
            "",
            "0128:err:module:LdrInitializeThunk Importing dlls for L\"x\" failed, status c0000135\n",
        );
        assert!(
            reason.starts_with("Kimochi's hook helper could not start with this game's Wine. This Wine"),
            "{reason}"
        );
        // Anything else Wine says is passed on as it is, and is not an old Wine.
        let reason =
            not_found_reason(image, prefix, &[], None, "", "wine: could not load kernel32.dll, status c0000135");
        assert!(!needs_newer_wine(&reason) && reason.ends_with("status c0000135"), "{reason}");
    }

    #[test]
    fn a_sandbox_is_named_by_its_app_and_branch() {
        let info = "[Application]\nname=org.winehq.Wine\nruntime=runtime/org.freedesktop.Platform/x86_64/22.08\n\n[Instance]\ninstance-id=1437540275\nbranch=stable-22.08\narch=x86_64\n\n[Context]\nshared=network;ipc;\n";
        assert_eq!(flatpak_app(info).as_deref(), Some("org.winehq.Wine stable-22.08"));
        assert_eq!(
            flatpak_app("[Application]\nname=com.usebottles.bottles\n").as_deref(),
            Some("com.usebottles.bottles")
        );
        assert_eq!(flatpak_app("[Instance]\nbranch=stable\n"), None);
    }
}
