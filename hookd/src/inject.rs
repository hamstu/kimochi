//! Loads a DLL into another process with `CreateRemoteThread(LoadLibraryW)`, the same way
//! LunaTranslator's own injector does (`LunaHost/injector.cpp` `SafeInject`). The thread start
//! address is this process's `LoadLibraryW`, so the target must have our bitness: the x64 build
//! injects 64-bit games and the i686 build injects 32-bit ones.
use std::ffi::c_void;
use std::path::Path;
use std::ptr::null;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows_sys::Win32::System::Threading::{
    CreateRemoteThread, GetExitCodeThread, OpenProcess, WaitForSingleObject, PROCESS_CREATE_THREAD,
    PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
};

pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub fn inject(pid: u32, dll: &Path) -> Result<(), String> {
    let path = wide(&dll.to_string_lossy());
    let bytes = path.len() * 2;
    unsafe {
        let process = OpenProcess(
            PROCESS_CREATE_THREAD
                | PROCESS_QUERY_INFORMATION
                | PROCESS_VM_OPERATION
                | PROCESS_VM_WRITE
                | PROCESS_VM_READ,
            0,
            pid,
        );
        if process.is_null() {
            return Err(format!("could not open process {pid} (error {})", GetLastError()));
        }
        let process = Handle(process);
        let remote = VirtualAllocEx(process.0, null(), bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        if remote.is_null() {
            return Err(format!("could not allocate in process {pid} (error {})", GetLastError()));
        }
        // Whether the loader thread is done with `remote`: it reads the path from there whenever it
        // gets to run, so the buffer may only be freed once the thread has exited.
        let (mut started, mut finished) = (false, false);
        let result = (|| {
            if WriteProcessMemory(process.0, remote, path.as_ptr().cast(), bytes, std::ptr::null_mut()) == 0 {
                return Err(format!("could not write to process {pid} (error {})", GetLastError()));
            }
            let kernel32 = GetModuleHandleW(wide("kernel32.dll").as_ptr());
            let load = GetProcAddress(kernel32, c"LoadLibraryW".as_ptr().cast())
                .ok_or("LoadLibraryW not found")?;
            let start: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(load);
            let thread = CreateRemoteThread(process.0, null(), 0, Some(start), remote, 0, std::ptr::null_mut());
            if thread.is_null() {
                return Err(format!("could not start a thread in process {pid} (error {})", GetLastError()));
            }
            started = true;
            let thread = Handle(thread);
            // Under Wine the thread can wait many seconds before it runs (seen with a game busy
            // starting its audio). Freeing the path under it then crashed the game, so a thread
            // that is still out keeps its buffer (one page, left allocated).
            if WaitForSingleObject(thread.0, 60_000) != WAIT_OBJECT_0 {
                return Err(format!("the loader thread in process {pid} did not finish (it may still load the DLL)"));
            }
            finished = true;
            let mut code = 0u32;
            GetExitCodeThread(thread.0, &mut code);
            // The thread's exit code is the low half of the module handle LoadLibraryW returned.
            if code == 0 {
                return Err(format!("{} did not load in process {pid}", dll.display()));
            }
            Ok(())
        })();
        if !started || finished {
            VirtualFreeEx(process.0, remote, 0, MEM_RELEASE);
        }
        result
    }
}
