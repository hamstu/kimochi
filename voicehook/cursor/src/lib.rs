//! The cursor hook: injected into a game by Kimochi ("Keep the mouse cursor visible in games",
//! Windows), it keeps the game from hiding the system cursor, so the reader can still see where
//! the pointer is for a hover lookup. How games hide it, and how each way is undone: `hooks.rs`.
//!
//! - It keeps the cursor showing while the pointer moves (and for a few seconds after); resting,
//!   the game may hide it again (an idle hide), and the next movement brings it back.
//! - It does nothing until asked, and stops when no longer asked: Kimochi holds the named event
//!   `Local\kimochi_cursor_<pid>` while it wants the game's cursor kept visible, and this checks
//!   for it four times a second. When Kimochi turns the setting off or quits, the event is gone
//!   and the game hides its cursor again as it meant to. `KIMOCHI_CURSOR=1` in the game's
//!   environment turns it on without Kimochi (testing).
//! - Hooks are import-table entries in the game's own modules (`iat.rs`, shared with the voice
//!   hook) and in-process thread hooks on the game's UI threads: pointer writes and documented
//!   hooks, never code patches, as in the voice hook. Unlike it, `GetProcAddress` is left alone.
//! - It logs to `%LOCALAPPDATA%\kimochi-voicehook\cursor\<exe>.log`.
#![allow(clippy::missing_safety_doc)]
mod hooks;
#[allow(dead_code)]
#[path = "../../hook/src/iat.rs"]
mod iat;
#[allow(dead_code)]
#[path = "../../hook/src/util.rs"]
mod util;
mod visible;

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HMODULE};
use windows_sys::Win32::System::LibraryLoader::DisableThreadLibraryCalls;
use windows_sys::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows_sys::Win32::System::Threading::{CreateThread, GetCurrentProcessId, OpenEventW};
/// `SYNCHRONIZE`: enough to open the event.
const SYNCHRONIZE: u32 = 0x0010_0000;

pub(crate) static MODULE: AtomicUsize = AtomicUsize::new(0);

#[no_mangle]
pub unsafe extern "system" fn DllMain(module: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        DisableThreadLibraryCalls(module);
        MODULE.store(module as usize, Ordering::SeqCst);
        // Nothing under the loader lock: the work happens on a thread of its own.
        let thread = CreateThread(std::ptr::null(), 0, Some(init_thread), std::ptr::null(), 0, std::ptr::null_mut());
        if !thread.is_null() {
            CloseHandle(thread);
        }
    }
    1
}

unsafe extern "system" fn init_thread(_: *mut c_void) -> u32 {
    if std::panic::catch_unwind(run).is_err() {
        util::log("cursor hook: init panicked");
    }
    0
}

/// The event Kimochi holds while it wants this game's cursor kept visible.
pub fn event_name(pid: u32) -> String {
    format!("Local\\kimochi_cursor_{pid}")
}

fn asked() -> bool {
    if std::env::var_os("KIMOCHI_CURSOR").is_some_and(|v| v == "1") {
        return true;
    }
    let name = util::wide(&event_name(unsafe { GetCurrentProcessId() }));
    let event = unsafe { OpenEventW(SYNCHRONIZE, 0, name.as_ptr()) };
    if event.is_null() {
        return false;
    }
    unsafe { CloseHandle(event) };
    true
}

fn log_path() -> PathBuf {
    let exe = util::module_path(std::ptr::null_mut());
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "game".into());
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("kimochi-voicehook").join("cursor").join(format!("{stem}.log"))
}

fn run() {
    let log = log_path();
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    util::log_init(&log);
    util::log(&format!(
        "cursor hook {} in {} (pid {}, {}-bit)",
        env!("CARGO_PKG_VERSION"),
        util::module_path(std::ptr::null_mut()).display(),
        unsafe { GetCurrentProcessId() },
        usize::BITS
    ));
    iat::HOOK_GPA.store(false, Ordering::SeqCst);
    iat::register(iat::Hook {
        dll: "user32",
        name: "ShowCursor",
        hook: hooks::show_cursor as *const () as usize,
        orig: &hooks::REAL_SHOW,
    });
    iat::register(iat::Hook {
        dll: "user32",
        name: "SetCursor",
        hook: hooks::set_cursor as *const () as usize,
        orig: &hooks::REAL_SET,
    });
    let mut tick = 0u64;
    loop {
        let on = asked();
        if hooks::ON.swap(on, Ordering::SeqCst) != on {
            util::log(if on { "on: Kimochi asks for the cursor" } else { "off" });
        }
        hooks::tick();
        // New modules and windows: often at first (a game still starting), then every second.
        if tick < 40 || tick.is_multiple_of(4) {
            iat::rescan();
            hooks::hook_ui_threads();
        }
        tick += 1;
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}
