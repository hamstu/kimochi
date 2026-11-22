//! Same-user macOS process inspection. Wine helpers use the game's own runtime and prefix;
//! no process environment is logged or copied wholesale.
#[cfg(target_os = "macos")]
use super::{process::Target, wine};
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
struct Arguments {
    args: Vec<String>,
    env: Vec<(String, String)>,
}

/// KERN_PROCARGS2: argc, executable path, padding, argc NUL-terminated arguments, environment.
fn parse_arguments(bytes: &[u8]) -> Option<Arguments> {
    let argc = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
    if argc <= 0 || argc as usize > bytes.len() {
        return None;
    }
    let mut at = 4 + bytes.get(4..)?.iter().position(|b| *b == 0)?;
    while bytes.get(at) == Some(&0) {
        at += 1;
    }
    let mut strings = bytes.get(at..)?.split(|b| *b == 0);
    let mut args = Vec::new();
    for _ in 0..argc {
        args.push(String::from_utf8_lossy(strings.next()?).into_owned());
    }
    // Wine rewrites argv in place, leaving NUL padding before the original environment.
    let env = strings
        .skip_while(|s| s.is_empty())
        .take_while(|s| !s.is_empty())
        .filter_map(|s| {
            let s = String::from_utf8_lossy(s);
            let (key, value) = s.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect();
    Some(Arguments { args, env })
}

#[cfg(target_os = "macos")]
fn arguments(pid: u32) -> Option<Arguments> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, i32::try_from(pid).ok()?];
    let mut size = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0
        || size > 4 * 1024 * 1024
    {
        return None;
    }
    let mut bytes = vec![0; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, bytes.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0
    {
        return None;
    }
    bytes.truncate(size);
    parse_arguments(&bytes)
}

#[cfg(target_os = "macos")]
pub fn executable(pid: u32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(i32::try_from(pid).ok()?, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    use std::os::unix::ffi::OsStrExt;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..end])))
}

#[cfg(target_os = "macos")]
fn working_directory(pid: u32) -> Option<PathBuf> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info);
    let read = unsafe {
        libc::proc_pidinfo(
            i32::try_from(pid).ok()?,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut libc::proc_vnodepathinfo).cast(),
            size as i32,
        )
    };
    if read != size as i32 {
        return None;
    }
    let bytes: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().map(|b| *b as u8).take_while(|b| *b != 0).collect();
    use std::os::unix::ffi::OsStrExt;
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(&bytes));
    path.is_absolute().then_some(path)
}

#[cfg(target_os = "macos")]
fn relative_image(image: &str, cwd: Option<PathBuf>) -> Option<PathBuf> {
    // A drive-relative or root-relative Windows path needs Wine's drive state; never guess it.
    if image.is_empty() || image.starts_with(['/', '\\']) || image.contains(':') {
        return None;
    }
    Some(cwd?.join(image.replace('\\', "/")))
}

/// Native apps are candidates for Agent only; the source list also requires a matching script.
#[cfg(target_os = "macos")]
pub fn target(pid: u32) -> Result<Target, String> {
    if pid == 0 || pid == std::process::id() {
        return Err("Kimochi and the system cannot be hooked".into());
    }
    let exe = executable(pid).ok_or("this process is not running or cannot be inspected")?;
    if wine::is_wine_loader(&exe) {
        return wine_target(pid);
    }
    if exe.starts_with("/System") || exe.starts_with("/usr") || exe.starts_with("/sbin") {
        return Err("this is part of macOS".into());
    }
    if !cfg!(target_arch = "aarch64") {
        return Err("Native Agent scripts currently require an Apple Silicon Mac.".into());
    }
    Ok(Target { pid, exe, bits: 64, wine: None })
}

#[cfg(target_os = "macos")]
pub fn wine_target(pid: u32) -> Result<Target, String> {
    if pid == 0 || pid == std::process::id() {
        return Err("Kimochi and the system cannot be hooked".into());
    }
    let loader = executable(pid).ok_or("this process is not running or cannot be inspected")?;
    if !wine::is_wine_loader(&loader) {
        return Err("This Mac app has no supported text hook; Windows games can use Wine or CrossOver.".into());
    }
    let process = arguments(pid).ok_or("this process cannot be inspected")?;
    let var = |key: &str| process.env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    // CrossOver normally sets WINEPREFIX too. Never guess a bottle from Kimochi's environment.
    let prefix = var("WINEPREFIX")
        .map(PathBuf::from)
        .or_else(|| var("CX_BOTTLE_PATH").map(PathBuf::from))
        .or_else(|| var("HOME").map(|home| Path::new(home).join(".wine")))
        .ok_or("Kimochi cannot find this game's Wine prefix.")?;
    if !prefix.join("dosdevices").is_dir() {
        return Err("Kimochi cannot find this game's Wine prefix.".into());
    }
    // macOS has no per-process mount namespace. Require the existing wineserver socket so a
    // mistaken prefix never starts a second session.
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(&prefix).map_err(|e| e.to_string())?;
    let socket = wine::server_dir(unsafe { libc::getuid() }, metadata.dev(), metadata.ino()).join("socket");
    if !socket.exists() {
        return Err("Kimochi cannot reach this game's running Wine session.".into());
    }
    let binary = wine::launcher_candidates(&loader)
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("Kimochi cannot find the Wine this game runs on.")?;
    // Wine replaces argv[0] with the Windows image. Some launchers retain the loader first.
    let image = process
        .args
        .iter()
        .take(2)
        .find(|s| s.to_ascii_lowercase().ends_with(".exe"))
        .ok_or("this is part of Wine, not a game")?
        .clone();
    let exe = wine::unix_path(&prefix, &image, |p| std::fs::read_link(p).ok())
        .or_else(|| relative_image(&image, working_directory(pid)))
        .ok_or("Kimochi cannot locate this game's Windows executable.")?;
    let exe = std::fs::canonicalize(exe).map_err(|_| "this game's Windows executable cannot be read")?;
    let windows = std::fs::canonicalize(prefix.join("drive_c/windows")).ok();
    if windows.as_ref().is_some_and(|w| exe.starts_with(w)) {
        return Err("this is part of Wine, not a game".into());
    }
    use std::io::Read;
    let mut header = Vec::new();
    std::fs::File::open(&exe)
        .and_then(|f| f.take(4096).read_to_end(&mut header))
        .map_err(|_| "this game's Windows executable cannot be read")?;
    let bits = super::process::pe_bits(&header).ok_or("this game is not an x86 or x64 Windows program")?;
    let mut registry = String::new();
    if let Ok(file) = std::fs::File::open(prefix.join("system.reg")) {
        let _ = file.take(1024).read_to_string(&mut registry);
    }
    if wine::prefix_arch(&registry) == Some("win32") {
        return Err("Text Hooker needs a 64-bit Wine prefix; it can run 32-bit games too.".into());
    }
    let env = wine::shared_env(&process.env, Path::exists);
    Ok(Target { pid, exe, bits, wine: Some(wine::Wine { binary, prefix, env, image, flatpak: None, namespace: None }) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn relative_wine_images_use_the_games_working_directory() {
        let cwd = Some(PathBuf::from("/Games/My VN"));
        assert_eq!(relative_image("Game Name.exe", cwd.clone()), Some(PathBuf::from("/Games/My VN/Game Name.exe")));
        assert_eq!(relative_image(r"bin\Game.exe", cwd.clone()), Some(PathBuf::from("/Games/My VN/bin/Game.exe")));
        for image in ["", r"C:Game.exe", r"\Game.exe", "/Game.exe"] {
            assert_eq!(relative_image(image, cwd.clone()), None);
        }
        assert_eq!(relative_image("Game.exe", None), None);
        assert_eq!(working_directory(std::process::id()), std::env::current_dir().ok());
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a running Wine game; set KIMOCHI_TEST_WINE_PID"]
    fn running_wine_game_is_discovered() {
        let pid = std::env::var("KIMOCHI_TEST_WINE_PID").unwrap().parse().unwrap();
        let target = wine_target(pid).expect("the running Wine game must be discoverable");
        let wine = target.wine.unwrap();
        println!(
            "game={} bits={} runtime={} prefix={}",
            target.exe.display(),
            target.bits,
            wine.binary.display(),
            wine.prefix.display()
        );
    }

    #[test]
    fn process_arguments_preserve_spaces_empty_arguments_and_environment_values() {
        let mut bytes = 3i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/Applications/Wine Devel.app/wine\0\0\0C:\\Games\\My VN.exe\0\0--windowed\0\0\0WINEPREFIX=/Users/me/Game Bottle\0TOKEN=a=b\0\0");
        assert_eq!(
            parse_arguments(&bytes),
            Some(Arguments {
                args: vec![r"C:\Games\My VN.exe".into(), "".into(), "--windowed".into()],
                env: vec![("WINEPREFIX".into(), "/Users/me/Game Bottle".into()), ("TOKEN".into(), "a=b".into())],
            })
        );
        assert!(parse_arguments(b"bad").is_none());
        assert!(parse_arguments(&(-1i32).to_ne_bytes()).is_none());
        assert!(parse_arguments(&[2, 0, 0, 0, b'a']).is_none());
    }
}
