//! Windows: a release build is a GUI program (`windows_subsystem = "windows"`), started without
//! a console. Run as `kimochi` from a terminal (through the `kimochi.cmd` shim, which waits for
//! it), it attaches to that terminal's console so what it prints shows up there. Output already
//! redirected to a file or pipe arrives as inherited handles and is left alone.
#[cfg(windows)]
pub fn attach() {
    use std::os::windows::io::IntoRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_HANDLE,
        STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    let missing = |which: STD_HANDLE| unsafe { GetStdHandle(which) }.map_or(true, |h| h.is_invalid() || h.0.is_null());
    let (input, output, error) = (missing(STD_INPUT_HANDLE), missing(STD_OUTPUT_HANDLE), missing(STD_ERROR_HANDLE));
    // Attached even when every handle was inherited: Ctrl+C and the console's own state then
    // reach this process too. Fails harmlessly when it already has a console (a debug build).
    // SAFETY: plain Win32 calls; the handles opened here live as long as the process.
    if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) }.is_err() || !(input || output || error) {
        return;
    }
    let open = |name: &str, write: bool| {
        std::fs::OpenOptions::new().read(true).write(write).open(name).ok().map(|f| HANDLE(f.into_raw_handle()))
    };
    unsafe {
        if output {
            if let Some(handle) = open("CONOUT$", true) {
                let _ = SetStdHandle(STD_OUTPUT_HANDLE, handle);
            }
        }
        if error {
            if let Some(handle) = open("CONOUT$", true) {
                let _ = SetStdHandle(STD_ERROR_HANDLE, handle);
            }
        }
        if input {
            if let Some(handle) = open("CONIN$", true) {
                let _ = SetStdHandle(STD_INPUT_HANDLE, handle);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn attach() {}
