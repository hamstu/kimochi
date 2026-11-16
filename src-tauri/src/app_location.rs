//! macOS: is Kimochi running from an Applications folder, and if not, move it there (#205).
//!
//! Opened straight from Downloads, macOS runs a quarantined app through *App Translocation*: a
//! read-only copy at a random path under `/private/var/folders/…/AppTranslocation/`. Screen
//! Recording and System Audio permissions do not stick to a path like that (Kimochi is missing
//! from their lists in System Settings), Spotlight never indexes it, and the updater cannot
//! replace a bundle it cannot write. Run from a disk image the bundle is read-only too.
//!
//! [`app_location`] says where the bundle is and whether it should move; the panels ask on
//! launch and offer the move before anything else (`frontend/components/MoveToApplications.tsx`).
//! [`app_move_to_applications`] does what LetsMove (`PFMoveToApplicationsFolderIfNecessary`) does:
//!
//!  1. Work from the bundle the user put somewhere: a translocated path is resolved to its
//!     original with Security's `SecTranslocateCreateOriginalPathForURL`.
//!  2. Put an existing copy in `/Applications` in the Trash (recoverable), then copy the bundle
//!     there with `ditto`, which keeps the code signature, symlinks and extended attributes
//!     intact, and clear `com.apple.quarantine` from the copy so it is not translocated again
//!     (Gatekeeper has already approved this app; it is running).
//!  3. When `/Applications` (or the copy in it) is not the user's to write, the same steps run
//!     once through `osascript … with administrator privileges`, which shows the system's own
//!     password prompt.
//!  4. Put the original in the Trash, unless it is on a disk image or another read-only volume;
//!     those are copied, not moved.
//!  5. Relaunch: a detached `/bin/sh` waits for this process to end, opens the new copy and, for
//!     a disk image, ejects it. This process then quits as `app_quit` does.
//!
//! Elsewhere (and in a `tauri dev` binary, which is not inside a `.app`) nothing needs to move.
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, State};

/// Where the running bundle is, as the panels see it (COMMANDS.md → App location).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppLocation {
    /// The bundle is outside an Applications folder (or translocated) and should move.
    pub needs_move: bool,
    /// The bundle as the user placed it (the original of a translocated path).
    pub path: Option<String>,
    /// macOS is running a translocated, read-only copy of `path`.
    pub translocated: bool,
    /// `path` is on a disk image or another read-only volume: it is copied, not moved.
    pub copy_only: bool,
    /// `path` is on a mounted disk image, which is ejected after the move.
    pub disk_image: bool,
    /// Where the move puts it.
    pub destination: Option<String>,
    /// Something is already at `destination`; the move puts it in the Trash.
    pub replaces: bool,
    /// The move will ask for an administrator's password.
    pub needs_admin: bool,
    /// "Not now" was pressed in some window this run, so no other window asks again.
    pub dismissed: bool,
}

/// "Not now", for the rest of this run: every window asks once between them.
static DISMISSED: AtomicBool = AtomicBool::new(false);

/// `app_location`: where the running bundle is and whether it should move to Applications.
#[tauri::command]
pub fn app_location() -> AppLocation {
    #[cfg(target_os = "macos")]
    let location = macos::location();
    #[cfg(not(target_os = "macos"))]
    let location = AppLocation::default();
    AppLocation { dismissed: DISMISSED.load(Ordering::Relaxed), ..location }
}

/// `app_location_dismiss`: "Not now". The other windows stop offering the move until the next
/// launch, which asks again.
/// Emits `app-location` so a window still offering the move closes its dialog.
#[tauri::command]
pub fn app_location_dismiss(app: tauri::AppHandle) -> AppLocation {
    DISMISSED.store(true, Ordering::Relaxed);
    let location = app_location();
    let _ = app.emit("app-location", &location);
    location
}

/// `app_move_to_applications`: move (or copy) the bundle into `/Applications`, then relaunch
/// from there. On success the process quits shortly after replying; the error is a sentence
/// for the dialog, or `cancelled` when the administrator prompt was dismissed.
#[tauri::command]
pub async fn app_move_to_applications(app: tauri::AppHandle, state: State<'_, crate::Shared>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let location = macos::location();
        let outcome = tauri::async_runtime::spawn_blocking({
            let location = location.clone();
            move || macos::move_to_applications(&location)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        crate::record(
            &app,
            &state,
            json!({
                "check": "app-move",
                "from": location.path,
                "to": location.destination,
                "translocated": location.translocated,
                "copyOnly": location.copy_only,
                "diskImage": location.disk_image,
                "replaces": location.replaces,
                "admin": location.needs_admin,
                "result": match &outcome { Ok(_) => "relaunching".to_string(), Err(error) => error.clone() },
            }),
        );
        let relaunch = outcome?;
        // Let the reply reach the window before the process goes.
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            crate::shutdown_platform();
            relaunch.start();
            handle.exit(0);
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, json!(null));
        Err("Only Kimochi for macOS moves itself to Applications.".into())
    }
}

/// Whether `path` is inside `/Applications` or `~/Applications` (subfolders count).
pub fn in_applications(path: &str, home: Option<&str>) -> bool {
    let inside = |root: &str| path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/') && rest.len() > 1);
    inside("/Applications") || home.is_some_and(|home| inside(&format!("{}/Applications", home.trim_end_matches('/'))))
}

/// The `.app` bundle an executable lives in (`…/Name.app/Contents/MacOS/exe`), if it is in one.
pub fn bundle_of(exe: &str) -> Option<&str> {
    let macos = exe.rfind("/Contents/MacOS/")?;
    let bundle = &exe[..macos];
    bundle.ends_with(".app").then_some(bundle)
}

/// The volume a path under `/Volumes` is on (`/Volumes/Name`).
pub fn volume_of(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/Volumes/")?;
    let name = rest.split('/').next().filter(|name| !name.is_empty())?;
    Some(&path[.."/Volumes/".len() + name.len()])
}

/// A path quoted for `/bin/sh`.
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `destination` is exactly `/Applications/<Name>.app`: the only path the privileged script may
/// delete before copying, checked again right where it is used.
pub fn safe_destination(destination: &str) -> bool {
    destination.strip_prefix("/Applications/").is_some_and(|name| {
        name.len() > ".app".len() && name.ends_with(".app") && !name.contains('/') && !name.starts_with('.')
    })
}

/// The privileged script: replace the copy in `/Applications`, then clear the quarantine.
pub fn admin_script(source: &str, destination: &str) -> Option<String> {
    if !safe_destination(destination) {
        return None;
    }
    let (src, dest) = (sh_quote(source), sh_quote(destination));
    let copy = if source == destination {
        String::new()
    } else {
        format!("/bin/rm -rf {dest} && /usr/bin/ditto {src} {dest} && ")
    };
    Some(format!("{copy}/usr/bin/xattr -dr com.apple.quarantine {dest}"))
}

/// An AppleScript string literal.
pub fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The helper that relaunches once this process has gone: `sh -c SCRIPT sh PID APP [VOLUME]`.
pub const RELAUNCH_SCRIPT: &str = "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.2; done; \
/usr/bin/open \"$2\"; if [ -n \"$3\" ]; then /bin/sleep 1; /usr/bin/hdiutil detach -quiet \"$3\"; fi";

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::Retained;
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    use std::ffi::c_void;
    use std::path::Path;
    use std::process::{Command, Stdio};

    const APPLICATIONS: &str = "/Applications";

    type IsTranslocatedFn = unsafe extern "C" fn(*const c_void, *mut bool, *mut *mut c_void) -> bool;
    type OriginalPathFn = unsafe extern "C" fn(*const c_void, *mut *mut c_void) -> *const c_void;

    /// Security.framework's translocation calls (exported since macOS 10.12, not in its headers),
    /// looked up at run time as LetsMove does.
    fn security_symbol(name: &std::ffi::CStr) -> *mut c_void {
        unsafe {
            let handle = libc::dlopen(
                c"/System/Library/Frameworks/Security.framework/Security".as_ptr(),
                libc::RTLD_LAZY | libc::RTLD_NOLOAD,
            );
            let handle = if handle.is_null() {
                libc::dlopen(c"/System/Library/Frameworks/Security.framework/Security".as_ptr(), libc::RTLD_LAZY)
            } else {
                handle
            };
            if handle.is_null() {
                return std::ptr::null_mut();
            }
            libc::dlsym(handle, name.as_ptr())
        }
    }

    /// `Some(original)` when `bundle` is a translocated path; `Some(None)` when it is but the
    /// original could not be resolved; `None` when it is not translocated.
    fn translocation(bundle: &str) -> Option<Option<String>> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(bundle));
        let url_ptr = Retained::as_ptr(&url).cast::<c_void>();
        let is_fn = security_symbol(c"SecTranslocateIsTranslocatedURL");
        let translocated = if is_fn.is_null() {
            bundle.contains("/AppTranslocation/")
        } else {
            let is_fn: IsTranslocatedFn = unsafe { std::mem::transmute(is_fn) };
            let mut flag = false;
            let ok = unsafe { is_fn(url_ptr, &mut flag, std::ptr::null_mut()) };
            if ok {
                flag
            } else {
                bundle.contains("/AppTranslocation/")
            }
        };
        if !translocated {
            return None;
        }
        let original_fn = security_symbol(c"SecTranslocateCreateOriginalPathForURL");
        if original_fn.is_null() {
            return Some(None);
        }
        let original_fn: OriginalPathFn = unsafe { std::mem::transmute(original_fn) };
        let original = unsafe { original_fn(url_ptr, std::ptr::null_mut()) };
        if original.is_null() {
            return Some(None);
        }
        // A CFURLRef from a Create function (+1), toll-free bridged to NSURL.
        let original: Option<Retained<NSURL>> = unsafe { Retained::from_raw(original as *mut NSURL) };
        Some(original.and_then(|url| url.path()).map(|path| path.to_string()))
    }

    fn writable(path: &str) -> bool {
        let Ok(c) = std::ffi::CString::new(path) else { return false };
        unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
    }

    fn read_only_volume(path: &str) -> bool {
        let Ok(c) = std::ffi::CString::new(path) else { return false };
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c.as_ptr(), &mut stat) } != 0 {
            return false;
        }
        stat.f_flags & libc::MNT_RDONLY as u32 != 0
    }

    pub(super) fn location() -> AppLocation {
        let Ok(exe) = std::env::current_exe() else { return AppLocation::default() };
        let exe = exe.to_string_lossy().into_owned();
        let Some(bundle) = bundle_of(&exe) else { return AppLocation::default() };
        let (translocated, original) = match translocation(bundle) {
            Some(original) => (true, original),
            None => (false, None),
        };
        let path = original.unwrap_or_else(|| bundle.to_string());
        let home = std::env::var("HOME").ok();
        if !translocated && in_applications(&path, home.as_deref()) {
            return AppLocation { path: Some(path), ..AppLocation::default() };
        }
        let name = Path::new(&path).file_name().map(|name| name.to_string_lossy().into_owned());
        let destination = name.map(|name| format!("{APPLICATIONS}/{name}"));
        let replaces = destination.as_deref().is_some_and(|dest| dest != path && Path::new(dest).exists());
        let parent = Path::new(&path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let copy_only = volume_of(&path).is_some() || read_only_volume(&path) || !writable(&parent);
        let needs_admin = destination.as_deref().is_some_and(|dest| {
            if dest == path {
                !writable(dest)
            } else {
                !writable(APPLICATIONS) || (replaces && !writable(dest))
            }
        });
        let disk_image = volume_of(&path).is_some_and(is_disk_image);
        AppLocation {
            needs_move: destination.is_some(),
            path: Some(path),
            translocated,
            copy_only,
            disk_image,
            destination,
            replaces,
            needs_admin,
            dismissed: false,
        }
    }

    fn trash(path: &str) -> Result<(), String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|error| error.localizedDescription().to_string())
    }

    fn run(command: &mut Command) -> Result<(), String> {
        let output = command.stdin(Stdio::null()).output().map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    fn clear_quarantine(path: &str) {
        let _ = run(Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine", path]));
    }

    fn as_admin(source: &str, destination: &str) -> Result<(), String> {
        let script = admin_script(source, destination).ok_or("The destination is not in /Applications.")?;
        let apple = format!("do shell script {} with administrator privileges", applescript_string(&script));
        run(Command::new("/usr/bin/osascript").args(["-e", &apple])).map_err(|error| {
            // -128: the user cancelled the password prompt.
            if error.contains("-128") {
                "cancelled".to_string()
            } else {
                format!("Kimochi could not be moved with an administrator’s password: {error}")
            }
        })
    }

    /// Whether `volume` (`/Volumes/Name`) is a mounted disk image, so ejecting it is safe.
    fn is_disk_image(volume: &str) -> bool {
        Command::new("/usr/bin/hdiutil")
            .args(["info", "-plist"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .is_some_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("<string>{volume}</string>")))
    }

    /// The relaunch, started just before this process quits.
    pub(super) struct Relaunch {
        app: String,
        eject: Option<String>,
    }

    impl Relaunch {
        pub(super) fn start(self) {
            let pid = std::process::id().to_string();
            let mut command = Command::new("/bin/sh");
            command.args(["-c", RELAUNCH_SCRIPT, "sh", &pid, &self.app, self.eject.as_deref().unwrap_or("")]);
            let _ = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        }
    }

    pub(super) fn move_to_applications(location: &AppLocation) -> Result<Relaunch, String> {
        if !location.needs_move {
            return Err("Kimochi is already in Applications.".into());
        }
        let source = location.path.as_deref().ok_or("Kimochi could not tell where it is.")?;
        let destination = location.destination.as_deref().ok_or("Kimochi could not tell where it is.")?;
        if !safe_destination(destination) {
            return Err("The destination is not in /Applications.".into());
        }
        if location.needs_admin {
            as_admin(source, destination)?;
        } else if source == destination {
            // Translocated in place: only the quarantine kept it from running from here.
            clear_quarantine(destination);
        } else {
            if Path::new(destination).exists() {
                trash(destination).map_err(|error| {
                    format!("The copy already in Applications could not be moved to the Trash: {error}")
                })?;
            }
            if let Err(error) = run(Command::new("/usr/bin/ditto").args([source, destination])) {
                // A partial copy must not be left behind looking like an app.
                if Path::new(destination).exists() {
                    let _ = trash(destination);
                }
                return Err(format!("Kimochi could not be copied to Applications: {error}"));
            }
            clear_quarantine(destination);
        }
        if !Path::new(destination).join("Contents/Info.plist").exists() {
            return Err("The copy in Applications is incomplete.".into());
        }
        if source != destination && !location.copy_only {
            // Best effort: two copies are confusing, but the move has worked either way.
            let _ = trash(source);
        }
        let eject = volume_of(source).filter(|_| location.disk_image).map(str::to_string);
        Ok(Relaunch { app: destination.to_string(), eject })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applications_folders() {
        let home = Some("/Users/ana");
        assert!(in_applications("/Applications/Kimochi.app", home));
        assert!(in_applications("/Applications/Utilities/Kimochi.app", home));
        assert!(in_applications("/Users/ana/Applications/Kimochi.app", home));
        assert!(!in_applications("/Users/ana/Downloads/Kimochi.app", home));
        assert!(!in_applications("/Volumes/Kimochi/Kimochi.app", home));
        assert!(!in_applications("/ApplicationsOld/Kimochi.app", home));
        assert!(!in_applications("/Applications", home));
        assert!(!in_applications("/Users/bo/Applications/Kimochi.app", home));
        assert!(!in_applications("/private/var/folders/x1/T/AppTranslocation/0C4F/d/Kimochi.app", home));
    }

    #[test]
    fn bundles() {
        assert_eq!(bundle_of("/Applications/Kimochi.app/Contents/MacOS/kimochi"), Some("/Applications/Kimochi.app"));
        assert_eq!(bundle_of("/Users/ana/dev/kimochi/src-tauri/target/debug/kimochi"), None);
        assert_eq!(bundle_of("/tmp/Contents/MacOS/kimochi"), None);
    }

    #[test]
    fn volumes() {
        assert_eq!(volume_of("/Volumes/Kimochi 1.0/Kimochi.app"), Some("/Volumes/Kimochi 1.0"));
        assert_eq!(volume_of("/Volumes/"), None);
        assert_eq!(volume_of("/Users/ana/Kimochi.app"), None);
    }

    #[test]
    fn destinations_the_admin_script_may_replace() {
        assert!(safe_destination("/Applications/Kimochi.app"));
        assert!(!safe_destination("/Applications/"));
        assert!(!safe_destination("/Applications/.app"));
        assert!(!safe_destination("/Applications"));
        assert!(!safe_destination("/Applications/Utilities/Kimochi.app"));
        assert!(!safe_destination("/Applications/../Users/Kimochi.app"));
        assert!(!safe_destination("/Users/ana/Applications/Kimochi.app"));
        assert!(admin_script("/a", "/").is_none());
    }

    #[test]
    fn admin_script_quotes_paths() {
        let script = admin_script("/Users/ana/Down loads/It's.app", "/Applications/Kimochi.app").unwrap();
        assert_eq!(
            script,
            "/bin/rm -rf '/Applications/Kimochi.app' && /usr/bin/ditto '/Users/ana/Down loads/It'\\''s.app' \
'/Applications/Kimochi.app' && /usr/bin/xattr -dr com.apple.quarantine '/Applications/Kimochi.app'"
        );
        assert_eq!(
            admin_script("/Applications/Kimochi.app", "/Applications/Kimochi.app").unwrap(),
            "/usr/bin/xattr -dr com.apple.quarantine '/Applications/Kimochi.app'"
        );
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }
}
