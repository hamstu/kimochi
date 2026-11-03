//! From a window to the process(es) to hook, and whether they can be hooked at all.
//!
//! - The window's owning process comes from its source id (`windows:window:<hwnd>:<pid>`).
//! - A thin launcher's real engine runs as a child with another image extension
//!   (`game.exe` starting `game.bin` or `game.log`); those children are hooked too.
//! - Bitness comes from the image's PE header, corrected by what the process actually runs
//!   as: a .NET "Any CPU" image says i386 in its header but runs 64-bit (or ARM64).
//! - Not hookable: Kimochi itself, Windows' own processes and Store apps, native ARM64
//!   processes (the hook DLLs are x86/x64), and any process we may not open for injection
//!   (protected, anti-cheat, or elevated while Kimochi is not).
#[cfg(any(windows, test))]
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub pid: u32,
    pub exe: PathBuf,
    pub bits: u32,
}

/// The PE image's bitness from its header: 32 for i386, 64 for x64, `None` for anything else
/// (ARM64 native images cannot take x86/x64 hook DLLs). `bytes` is the start of the file.
#[cfg(any(windows, test))]
pub fn pe_bits(bytes: &[u8]) -> Option<u32> {
    if bytes.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if bytes.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    match u16::from_le_bytes(bytes.get(pe + 4..pe + 6)?.try_into().ok()?) {
        0x014c => Some(32),
        0x8664 => Some(64),
        _ => None,
    }
}

/// Windows' own programs, which are never games: anything under the Windows directory, and
/// packaged Store apps (their processes refuse injection).
#[cfg(any(windows, test))]
pub fn is_system_image(exe: &Path) -> bool {
    let lower = exe.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let windows = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()).to_ascii_lowercase();
    lower.starts_with(&(windows + "\\")) || lower.contains("\\windowsapps\\") || lower.contains("\\systemapps\\")
}

/// A launcher's child that is the real game: same family of image, another extension.
#[cfg(any(windows, test))]
pub fn is_engine_child(exe: &Path) -> bool {
    exe.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| matches!(e.as_str(), "bin" | "log" | "dat"))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::SystemInformation::{
        IMAGE_FILE_MACHINE, IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_I386, IMAGE_FILE_MACHINE_UNKNOWN,
    };
    use windows::Win32::System::Threading::{
        GetProcessInformation, IsWow64Process2, OpenProcess, ProcessMachineTypeInfo, QueryFullProcessImageNameW,
        PROCESS_CREATE_THREAD, PROCESS_MACHINE_INFORMATION, PROCESS_NAME_WIN32, PROCESS_QUERY_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
    };

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn image(handle: HANDLE) -> Option<PathBuf> {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }

    /// What the process runs as: 32, 64, or `None` for a native ARM64 process.
    fn running_bits(handle: HANDLE) -> Option<Option<u32>> {
        let mut info = PROCESS_MACHINE_INFORMATION::default();
        let machine = unsafe {
            GetProcessInformation(
                handle,
                ProcessMachineTypeInfo,
                (&mut info as *mut PROCESS_MACHINE_INFORMATION).cast(),
                std::mem::size_of::<PROCESS_MACHINE_INFORMATION>() as u32,
            )
        }
        .ok()
        .map(|()| info.ProcessMachine)
        .or_else(|| {
            // Before Windows 11: only WoW64 is visible, which is enough off ARM64.
            let (mut process, mut native) = (IMAGE_FILE_MACHINE::default(), IMAGE_FILE_MACHINE::default());
            unsafe { IsWow64Process2(handle, &mut process, Some(&mut native)) }.ok()?;
            Some(if process == IMAGE_FILE_MACHINE_UNKNOWN { native } else { process })
        })?;
        Some(match machine {
            IMAGE_FILE_MACHINE_I386 => Some(32),
            IMAGE_FILE_MACHINE_AMD64 => Some(64),
            _ => None,
        })
    }

    /// The process as a hook target, or why it cannot be one.
    pub fn target(pid: u32) -> Result<Target, String> {
        if pid == std::process::id() || pid == 0 || pid == 4 {
            return Err("Kimochi and the system cannot be hooked".into());
        }
        let query = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .map_err(|_| "this process is not running or cannot be inspected".to_string())?;
        let query = Owned(query);
        let exe = image(query.0).ok_or("this process cannot be inspected")?;
        if is_system_image(&exe) {
            return Err("this is part of Windows".into());
        }
        // The rights injection needs; refused for protected, anti-cheat and elevated processes.
        let inject = unsafe {
            OpenProcess(
                PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                false,
                pid,
            )
        }
        .map_err(|_| "Windows does not let Kimochi into this app (it may be protected, or running as administrator)".to_string())?;
        drop(Owned(inject));
        let header = std::fs::File::open(&exe).ok().and_then(|f| {
            use std::io::Read;
            let mut bytes = vec![0u8; 4096];
            let n = f.take(4096).read(&mut bytes).ok()?;
            bytes.truncate(n);
            Some(bytes)
        });
        let from_header = header.as_deref().and_then(pe_bits);
        let bits = match running_bits(query.0) {
            Some(Some(bits)) => bits,
            Some(None) => return Err("this app runs as native ARM64, which text hooks cannot enter".into()),
            None => from_header.ok_or("this app is not an x86 or x64 program")?,
        };
        Ok(Target { pid, exe, bits })
    }

    /// Every process with its parent and image name, from one snapshot.
    fn processes() -> Vec<(u32, u32, String)> {
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return Vec::new();
        };
        let snapshot = Owned(snapshot);
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut out = Vec::new();
        let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            out.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
            ok = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
        }
        out
    }

    /// The window's process and its engine children (a launcher's `.bin`/`.log` process), each
    /// that can be hooked.
    pub fn game_processes(pid: u32) -> Vec<Target> {
        let all = processes();
        let mut pids = vec![pid];
        let mut i = 0;
        while i < pids.len() {
            let parent = pids[i];
            for (child, ppid, name) in &all {
                if *ppid == parent && !pids.contains(child) && is_engine_child(Path::new(name)) {
                    pids.push(*child);
                }
            }
            i += 1;
        }
        pids.into_iter().filter_map(|p| target(p).ok()).collect()
    }
}

#[cfg(windows)]
pub use imp::{game_processes, target};

#[cfg(not(windows))]
pub fn target(_pid: u32) -> Result<Target, String> {
    Err("text hooking runs on Windows".into())
}
#[cfg(not(windows))]
pub fn game_processes(_pid: u32) -> Vec<Target> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pe(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 0x100];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    #[test]
    fn bitness_comes_from_the_pe_machine() {
        assert_eq!(pe_bits(&pe(0x014c)), Some(32));
        assert_eq!(pe_bits(&pe(0x8664)), Some(64));
        assert_eq!(pe_bits(&pe(0xaa64)), None);
        assert_eq!(pe_bits(b"not a program"), None);
    }

    #[test]
    fn launchers_hand_off_to_bin_and_log_children() {
        assert!(is_engine_child(Path::new("C:\\Games\\VN\\game.bin")));
        assert!(is_engine_child(Path::new("Game.LOG")));
        assert!(!is_engine_child(Path::new("C:\\Games\\VN\\updater.exe")));
    }

    #[test]
    fn windows_own_programs_are_not_games() {
        assert!(is_system_image(Path::new("C:\\Windows\\explorer.exe")));
        assert!(is_system_image(Path::new("C:\\Program Files\\WindowsApps\\Microsoft.Photos\\Photos.exe")));
        assert!(!is_system_image(Path::new("D:\\Games\\VN\\game.exe")));
    }
}
