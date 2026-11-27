// save_location.rs — where a file the user saves goes: the folder a save dialog opens in, and
// another folder when the chosen one cannot be written.
//
// A save dialog given only a file name opens in the process's working directory. For an
// AppImage that is the image itself, mounted read-only (`/tmp/.mount_Kimoch…/usr`: its AppRun
// starts the app from there, and WebKit's helper processes are found relative to it, so it
// cannot be changed). Pressing Save there failed with "Read-only file system (os error 30)", in
// every dialog: the debug bundle, an engine's downloads, the exports. So every save dialog opens
// in a folder that can be written (`start_dir`, `default_path`), and a file Kimochi writes
// itself still lands somewhere when the chosen folder turns out read-only (`write`), and says
// where.
//
// The rules are the same on every OS; what is specific to one (the AppImage mount) is `app_image`.

use std::path::{Path, PathBuf};
use tauri::Manager;

/// The folders a save may go to, best first: Downloads, Documents, Desktop, home.
fn folders(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let path = app.path();
    [path.download_dir(), path.document_dir(), path.desktop_dir(), path.home_dir()].into_iter().flatten().collect()
}

/// The folder a save dialog opens in: the first of the user's folders that can be written.
/// None leaves it to the dialog.
pub fn start_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    first_usable(&folders(app))
}

/// `name` in the folder a save dialog opens in; just `name` when there is none.
pub fn default_path(app: &tauri::AppHandle, name: &str) -> PathBuf {
    start_dir(app).map_or_else(|| PathBuf::from(name), |dir| dir.join(name))
}

/// Writes `bytes` to `path`, the place the user chose. When that place cannot be written (a
/// read-only file system, no permission, the app's own image), the file goes under the same name
/// to the first of the user's folders that can be, else the temporary folder. Answers where it
/// was written; the error names `path` when it could go nowhere.
pub fn write(app: &tauri::AppHandle, path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let mut elsewhere = folders(app);
    elsewhere.push(std::env::temp_dir());
    write_or_elsewhere(path, bytes, &elsewhere)
}

/// `save_default_path(name) -> string`: where a save dialog for a file named `name` should
/// start (`defaultPath`), for the dialogs the pages open themselves.
#[tauri::command]
pub fn save_default_path(app: tauri::AppHandle, name: String) -> String {
    default_path(&app, &name).to_string_lossy().into_owned()
}

fn first_usable(folders: &[PathBuf]) -> Option<PathBuf> {
    folders.iter().find(|dir| usable(dir)).cloned()
}

/// A folder a file can be created in.
fn usable(dir: &Path) -> bool {
    dir.is_dir() && !app_image::contains(dir) && writable(dir)
}

#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    // The kernel's own answer, read-only mounts included, without creating anything.
    unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

#[cfg(not(unix))]
fn writable(dir: &Path) -> bool {
    std::fs::metadata(dir).is_ok_and(|meta| !meta.permissions().readonly())
}

fn write_or_elsewhere(path: &Path, bytes: &[u8], elsewhere: &[PathBuf]) -> Result<PathBuf, String> {
    let error = if app_image::contains(path) {
        std::io::Error::from(std::io::ErrorKind::ReadOnlyFilesystem)
    } else {
        match std::fs::write(path, bytes) {
            Ok(()) => return Ok(path.to_path_buf()),
            Err(error) => error,
        }
    };
    let cannot_write_there =
        matches!(error.kind(), std::io::ErrorKind::ReadOnlyFilesystem | std::io::ErrorKind::PermissionDenied);
    if let (true, Some(name)) = (cannot_write_there, path.file_name()) {
        for dir in elsewhere.iter().filter(|dir| path.parent() != Some(dir.as_path()) && usable(dir)) {
            let target = unused(dir, Path::new(name));
            if std::fs::write(&target, bytes).is_ok() {
                return Ok(target);
            }
        }
    }
    Err(format!("native: could not write {}: {error}", path.display()))
}

/// `dir/name`, or `dir/stem (2).ext`, … when a file is already there: the user chose no file in
/// this folder to replace.
fn unused(dir: &Path, name: &Path) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.file_stem().unwrap_or(name.as_os_str()).to_string_lossy();
    let extension = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..1000).map(|n| dir.join(format!("{stem} ({n}){extension}"))).find(|path| !path.exists()).unwrap_or(first)
}

/// The app's own files, when they are a read-only image: a Linux AppImage's mount.
mod app_image {
    use std::path::Path;

    /// Whether `path` is inside the image the app runs from.
    pub fn contains(path: &Path) -> bool {
        inside_app_image(path, std::env::var_os("APPDIR").as_deref().map(Path::new))
    }

    /// An AppImage runs from a FUSE mount of itself, which `$APPDIR` names: `.mount_<name><random>`
    /// in the temporary folder (`/tmp/.mount_KimochfpFHAg`). The name is checked as well, since a
    /// path can outlive the variable (a child's environment, a launcher that clears it).
    pub fn inside_app_image(path: &Path, appdir: Option<&Path>) -> bool {
        if !cfg!(target_os = "linux") {
            return false;
        }
        if appdir.is_some_and(|appdir| !appdir.as_os_str().is_empty() && path.starts_with(appdir)) {
            return true;
        }
        let Ok(inside) = path.strip_prefix(std::env::temp_dir()).or_else(|_| path.strip_prefix("/tmp")) else {
            return false;
        };
        inside.components().next().is_some_and(|first| first.as_os_str().to_string_lossy().starts_with(".mount_"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own under the temporary folder, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("kimochi-save-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn dir(&self, name: &str) -> PathBuf {
            let dir = self.0.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            #[cfg(unix)]
            for entry in std::fs::read_dir(&self.0).into_iter().flatten().flatten() {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o755));
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Takes write permission from `dir`, as a read-only mount would. False when that does not
    /// stop this process (root), and the test has nothing to check.
    #[cfg(unix)]
    fn read_only(dir: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        std::fs::write(dir.join("probe"), b"x").is_err()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_appimage_mount_is_the_apps_image() {
        use app_image::inside_app_image;
        // The reporter's path (CachyOS, the AppImage started by Shelly), with and without $APPDIR.
        let saved = Path::new("/tmp/.mount_KimochfpFHAg/usr/kimochi-debug-20261125-1908.zip");
        assert!(inside_app_image(saved, Some(Path::new("/tmp/.mount_KimochfpFHAg"))));
        assert!(inside_app_image(saved, None));
        assert!(inside_app_image(Path::new("/tmp/.mount_KimochfpFHAg"), None));
        // An image extracted or mounted elsewhere is known by $APPDIR alone.
        let extracted = Path::new("/home/deck/Applications/squashfs-root");
        assert!(inside_app_image(&extracted.join("usr/x.zip"), Some(extracted)));
        assert!(!inside_app_image(&extracted.join("usr/x.zip"), None));
        // The user's own folders are not, whatever $APPDIR says.
        for own in ["/home/psylia/Downloads/x.zip", "/tmp/x.zip", "/tmp/mount_x/x.zip", "/tmp/a/.mount_x/x.zip"] {
            assert!(!inside_app_image(Path::new(own), Some(Path::new("/tmp/.mount_KimochfpFHAg"))), "{own}");
            assert!(!inside_app_image(Path::new(own), Some(Path::new(""))), "{own}");
        }
    }

    #[test]
    fn a_dialog_starts_in_the_first_folder_that_can_be_written() {
        let scratch = Scratch::new("start");
        let (downloads, home) = (scratch.dir("Downloads"), scratch.dir("home"));
        let missing = scratch.0.join("Documents");
        assert_eq!(first_usable(&[missing.clone(), downloads.clone(), home.clone()]), Some(downloads.clone()));
        assert_eq!(first_usable(&[missing.clone()]), None);
        // A file is no folder.
        let file = scratch.0.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(first_usable(&[file, home.clone()]), Some(home.clone()));
        // The working directory of an AppImage, and a folder without write permission, are passed over.
        #[cfg(target_os = "linux")]
        assert_eq!(first_usable(&[PathBuf::from("/tmp/.mount_KimochfpFHAg/usr"), home.clone()]), Some(home.clone()));
        #[cfg(unix)]
        if read_only(&downloads) {
            assert!(!usable(&downloads));
            assert_eq!(first_usable(&[downloads, home.clone()]), Some(home));
        }
    }

    #[test]
    fn a_file_is_written_where_the_user_chose() {
        let scratch = Scratch::new("chosen");
        let (chosen, downloads) = (scratch.dir("chosen"), scratch.dir("Downloads"));
        let path = chosen.join("kimochi-debug.zip");
        assert_eq!(write_or_elsewhere(&path, b"zip", &[downloads.clone()]).unwrap(), path);
        assert_eq!(std::fs::read(&path).unwrap(), b"zip");
        assert!(!downloads.join("kimochi-debug.zip").exists());
        // Replacing the file the user picked is what they asked for.
        assert_eq!(write_or_elsewhere(&path, b"again", &[downloads]).unwrap(), path);
        assert_eq!(std::fs::read(&path).unwrap(), b"again");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_folder_falls_back_to_one_that_can_be_written() {
        let scratch = Scratch::new("fallback");
        let (mount, locked, downloads) = (scratch.dir("mount"), scratch.dir("Documents"), scratch.dir("Downloads"));
        if !read_only(&mount) || !read_only(&locked) {
            return;
        }
        // The working directory is read-only: the file goes to the first folder that takes it.
        let chosen = mount.join("kimochi-debug-20261125-1908.zip");
        let written = write_or_elsewhere(&chosen, b"zip", &[locked.clone(), downloads.clone()]).unwrap();
        assert_eq!(written, downloads.join("kimochi-debug-20261125-1908.zip"));
        assert_eq!(std::fs::read(&written).unwrap(), b"zip");
        // A file already there is not replaced: nobody chose it.
        let second = write_or_elsewhere(&chosen, b"second", &[downloads.clone()]).unwrap();
        assert_eq!(second, downloads.join("kimochi-debug-20261125-1908 (2).zip"));
        assert_eq!(std::fs::read(&written).unwrap(), b"zip");
        assert_eq!(std::fs::read(&second).unwrap(), b"second");
        // Nowhere to go: the error names the place the user chose, and why.
        let error = write_or_elsewhere(&chosen, b"zip", &[locked, mount.clone()]).unwrap_err();
        assert!(error.starts_with(&format!("native: could not write {}: ", chosen.display())), "{error}");
        // Any other failure is reported, not worked around: the folder chosen does not exist.
        let gone = scratch.0.join("gone/kimochi-debug.zip");
        assert!(write_or_elsewhere(&gone, b"zip", &[downloads.clone()]).is_err());
        assert!(!downloads.join("kimochi-debug.zip").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_path_inside_the_appimage_is_never_written() {
        // The reporter's case: the dialog opened in the mount and Save was pressed.
        let scratch = Scratch::new("image");
        let downloads = scratch.dir("Downloads");
        let chosen = Path::new("/tmp/.mount_KimochfpFHAg/usr/kimochi-debug-20261125-1908.zip");
        let written = write_or_elsewhere(chosen, b"zip", &[downloads.clone()]).unwrap();
        assert_eq!(written, downloads.join("kimochi-debug-20261125-1908.zip"));
        let error = write_or_elsewhere(chosen, b"zip", &[]).unwrap_err();
        assert!(error.contains("/tmp/.mount_KimochfpFHAg/usr/kimochi-debug-20261125-1908.zip"), "{error}");
    }
}
