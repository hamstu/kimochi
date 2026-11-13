//! Process plumbing: start a game suspended, load the hook into it with
//! `CreateRemoteThread(LoadLibraryW)` (as Kimochi's hookd does), find processes and their
//! bitness. `LoadLibraryW`'s address comes from this process, so the target must have our
//! bitness; `main` hands other targets to the sibling build.
use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessW, CreateRemoteThread, GetExitCodeThread, IsWow64Process2, OpenProcess, ResumeThread,
    TerminateProcess, WaitForSingleObject, CREATE_SUSPENDED, PROCESS_ALL_ACCESS, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
};

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// The machine an exe is built for: 0x14c x86, 0x8664 x64, 0xaa64 ARM64.
pub fn pe_machine(exe: &Path) -> Result<u16, String> {
    let b = std::fs::read(exe).map_err(|e| format!("cannot read {}: {e}", exe.display()))?;
    let pe = b.get(0x3c..0x40).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize).ok_or("not an exe")?;
    if b.get(pe..pe + 4) != Some(b"PE\0\0") {
        return Err(format!("{} is not a PE executable", exe.display()));
    }
    Ok(u16::from_le_bytes([b[pe + 4], b[pe + 5]]))
}

/// Whether a running process is 32-bit x86.
pub fn is_x86_process(pid: u32) -> Result<bool, String> {
    unsafe {
        let h = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
        if h.0.is_null() {
            return Err(format!("cannot open process {pid} (error {})", GetLastError()));
        }
        let (mut process, mut native) = (0u16, 0u16);
        if IsWow64Process2(h.0, &mut process, &mut native) == 0 {
            return Err(format!("IsWow64Process2 failed (error {})", GetLastError()));
        }
        Ok(process == 0x14c)
    }
}

pub fn find_processes(name: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let want = name.to_ascii_lowercase();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                let end = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let exe = String::from_utf16_lossy(&e.szExeFile[..end]);
                let l = exe.to_ascii_lowercase();
                if want.is_empty() || l == want || l.trim_end_matches(".exe") == want.trim_end_matches(".exe") {
                    out.push((e.th32ProcessID, exe));
                }
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// Loads `dll` into `process` and waits for LoadLibraryW to return.
pub fn inject(process: HANDLE, pid: u32, dll: &Path) -> Result<(), String> {
    let path = wide(&dll.to_string_lossy());
    let bytes = path.len() * 2;
    unsafe {
        let remote = VirtualAllocEx(process, null(), bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        if remote.is_null() {
            return Err(format!("cannot allocate in process {pid} (error {})", GetLastError()));
        }
        let result = (|| {
            if WriteProcessMemory(process, remote, path.as_ptr().cast(), bytes, null_mut()) == 0 {
                return Err(format!("cannot write to process {pid} (error {})", GetLastError()));
            }
            let kernel32 = GetModuleHandleW(wide("kernel32.dll").as_ptr());
            let load = GetProcAddress(kernel32, c"LoadLibraryW".as_ptr().cast()).ok_or("LoadLibraryW not found")?;
            let start: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(load);
            let thread = Handle(CreateRemoteThread(process, null(), 0, Some(start), remote, 0, null_mut()));
            if thread.0.is_null() {
                return Err(format!("cannot start a thread in process {pid} (error {})", GetLastError()));
            }
            if WaitForSingleObject(thread.0, 20_000) != WAIT_OBJECT_0 {
                return Err(format!("the loader thread in process {pid} did not finish"));
            }
            let mut code = 0u32;
            GetExitCodeThread(thread.0, &mut code);
            if code == 0 {
                return Err(format!("{} did not load in process {pid}", dll.display()));
            }
            Ok(())
        })();
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        result
    }
}

pub fn ready_event(pid: u32) -> Handle {
    let name = wide(&format!("Local\\voicehook_ready_{pid}"));
    Handle(unsafe { CreateEventW(null(), 1, 0, name.as_ptr()) })
}

pub fn open_process(pid: u32) -> Result<Handle, String> {
    let h = Handle(unsafe { OpenProcess(PROCESS_ALL_ACCESS, 0, pid) });
    if h.0.is_null() {
        return Err(format!("cannot open process {pid} (error {}); try an elevated prompt", unsafe { GetLastError() }));
    }
    Ok(h)
}

/// Starts `exe` suspended, injects, waits for the hook to say it is ready, resumes. Returns
/// the process handle and pid.
pub fn launch(exe: &Path, args: &[String], dll: &Path) -> Result<(Handle, u32), String> {
    let quote = |s: &str| {
        if s.is_empty() || s.contains([' ', '\t', '"']) {
            format!("\"{}\"", s.replace('"', "\\\""))
        } else {
            s.to_string()
        }
    };
    let mut cmd = quote(&exe.to_string_lossy());
    for a in args {
        cmd.push(' ');
        cmd.push_str(&quote(a));
    }
    let mut cmd = wide(&cmd);
    let app = wide(&exe.to_string_lossy());
    let cwd = wide(&exe.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        if CreateProcessW(
            app.as_ptr(),
            cmd.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_SUSPENDED,
            null(),
            cwd.as_ptr(),
            &si,
            &mut pi,
        ) == 0
        {
            return Err(format!("cannot start {} (error {})", exe.display(), GetLastError()));
        }
        let process = Handle(pi.hProcess);
        let thread = Handle(pi.hThread);
        let ready = ready_event(pi.dwProcessId);
        if let Err(e) = inject(process.0, pi.dwProcessId, dll) {
            TerminateProcess(process.0, 1);
            return Err(e);
        }
        if WaitForSingleObject(ready.0, 15_000) != WAIT_OBJECT_0 {
            eprintln!("voicehook: the hook did not report ready within 15 s; resuming anyway");
        }
        ResumeThread(thread.0);
        Ok((process, pi.dwProcessId))
    }
}
