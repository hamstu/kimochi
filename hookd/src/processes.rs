//! `kimochi-hookd processes`: every process this Windows (or Wine prefix) runs, one `process`
//! event each. Under Wine the app cannot see the prefix's process ids (they are not the Linux
//! ones), so it runs this inside the game's prefix and picks the game out of the list itself.
use crate::protocol::emit;
use serde_json::json;
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    IsWow64Process, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

fn details(pid: u32) -> (Option<String>, Option<u32>) {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return (None, None);
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let path = (QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0)
            .then(|| String::from_utf16_lossy(&buf[..len as usize]));
        let mut wow64 = 0;
        // A 32-bit process on a 64-bit system runs under WoW64; Wine reports it the same way.
        let bits = (IsWow64Process(handle, &mut wow64) != 0).then_some(if wow64 != 0 { 32 } else { 64 });
        CloseHandle(handle);
        (path, bits)
    }
}

pub fn list() -> Result<(), String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("could not list processes".into());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            let (path, bits) = details(entry.th32ProcessID);
            emit(
                "process",
                json!({
                    "pid": entry.th32ProcessID,
                    "parent": entry.th32ParentProcessID,
                    "name": name,
                    "path": path,
                    "bits": bits,
                }),
            );
            ok = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    Ok(())
}
