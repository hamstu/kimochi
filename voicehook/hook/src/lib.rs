//! voicehook: injected into a game, it records each sound the game hands DirectSound or
//! XAudio2 *before* the mix, so a voice line comes out on its own, apart from BGM and SFX.
//!
//! - Hooks are vtable patches, not code patches: a dummy device/engine created at start gives
//!   the implementation's vtables (shared by every object of that class, including the game's
//!   objects created before injection), and the slots we care about are pointed at our
//!   functions. This works the same on x64 and x86, under Wine, and in x64 games emulated on
//!   ARM64 Windows (whose system DLLs are ARM64X, which code patches would break).
//! - Everything the hooks see goes to a writer thread (`sink`) that cuts clips per buffer/voice
//!   and writes `clips/*.wav` plus `events.jsonl` into the capture directory
//!   (`VOICEHOOK_OUT`, else `<dll dir>\captures\<exe>_<pid>_<time>`).
//! - `census` logs which audio libraries the game loaded, so a run says which adapter a game
//!   still needs when neither API is used (FMOD, CRI, Wwise, WASAPI directly).
#![allow(clippy::missing_safety_doc)]
mod census;
mod cri;
mod ds;
mod fileread;
mod il2cpp;
mod iat;
mod renpy;
mod sdl;
mod sink;
mod unity;
mod util;
mod waveout;
mod vt;
mod xa;

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HMODULE};
use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows_sys::Win32::System::LibraryLoader::DisableThreadLibraryCalls;
use windows_sys::Win32::System::SystemServices::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH};
use windows_sys::Win32::System::Threading::{
    CreateThread, GetCurrentProcessId, GetCurrentThreadId, OpenEventW, SetEvent, EVENT_MODIFY_STATE,
};

pub(crate) static MODULE: AtomicUsize = AtomicUsize::new(0);
/// The init thread: its own dummy devices and voices are hooked but not recorded.
static INTERNAL_TID: AtomicU32 = AtomicU32::new(u32::MAX);

pub(crate) fn internal() -> bool {
    unsafe { GetCurrentThreadId() == INTERNAL_TID.load(Ordering::Relaxed) }
}

#[no_mangle]
pub unsafe extern "system" fn DllMain(module: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        DisableThreadLibraryCalls(module);
        MODULE.store(module as usize, Ordering::SeqCst);
        // Nothing heavy under the loader lock: the work happens on a thread of its own.
        let thread = CreateThread(std::ptr::null(), 0, Some(init_thread), std::ptr::null(), 0, std::ptr::null_mut());
        if !thread.is_null() {
            CloseHandle(thread);
        }
    } else if reason == DLL_PROCESS_DETACH && !_reserved.is_null() {
        // The process is exiting: keep the clips that were still being cut.
        let _ = std::panic::catch_unwind(sink::drain_at_exit);
    }
    1
}

unsafe extern "system" fn init_thread(_: *mut c_void) -> u32 {
    INTERNAL_TID.store(GetCurrentThreadId(), Ordering::SeqCst);
    if std::panic::catch_unwind(run).is_err() {
        util::log("init panicked");
        signal_ready();
    }
    0
}

fn out_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("VOICEHOOK_OUT").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let dll = util::module_path(MODULE.load(Ordering::SeqCst) as HMODULE);
    let exe = util::module_path(std::ptr::null_mut());
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "game".into());
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let pid = unsafe { GetCurrentProcessId() };
    if !dll.with_file_name("voicehook.exe").exists() {
        // Injected by Kimochi (attached to a running game): `%LOCALAPPDATA%\kimochi-voicehook\
        // <pid>-<unix s>`, which the app finds by the game's pid. Long clips (music) are logged
        // but not written.
        sink::set_app_mode();
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        return base.join("kimochi-voicehook").join(format!("{pid}-{secs}"));
    }
    dll.parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default()
        .join("captures")
        .join(format!("{stem}_{}_{secs}", unsafe { GetCurrentProcessId() }))
}

static XAUDIO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// The adapters `skip.txt` names.
fn skipped() -> Vec<String> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    std::fs::read_to_string(base.join("kimochi-voicehook").join("skip.txt"))
        .map(|t| t.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

fn run() {
    let out = out_dir();
    let _ = std::fs::create_dir_all(out.join("clips"));
    util::log_init(&out.join("voicehook.log"));
    sink::start(&out);
    let exe = util::module_path(std::ptr::null_mut());
    util::log(&format!(
        "voicehook {} in {} (pid {}, {}-bit), capturing to {}",
        env!("CARGO_PKG_VERSION"),
        exe.display(),
        unsafe { GetCurrentProcessId() },
        usize::BITS,
        out.display()
    ));
    sink::send(sink::Ev::Note(serde_json::json!({
        "ev": "start",
        "exe": exe.display().to_string(),
        "pid": unsafe { GetCurrentProcessId() },
        "bits": usize::BITS,
    })));
    unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as _) };
    census::scan();
    // Adapters named in `skip.txt` beside the captures (`%LOCALAPPDATA%\kimochi-voicehook`), one per
    // line, are left out: for finding which one a game does not get on with.
    let skip = skipped();
    let on = |name: &str| {
        let off = skip.iter().any(|s| s == name);
        if off {
            util::log(&format!("{name}: skipped (skip.txt)"));
        }
        !off
    };
    if on("dsound") {
        match unsafe { ds::install() } {
            Ok(n) => util::log(&format!("dsound: hooked ({n} vtables)")),
            Err(e) => util::log(&format!("dsound: not hooked: {e}")),
        }
    }
    let xaudio = on("xaudio");
    if xaudio {
        unsafe { xa::install() };
    }
    XAUDIO.store(xaudio, Ordering::SeqCst);
    // Export adapters: register their hooks, then patch every module's imports.
    if on("unity") {
        unity::register();
        iat::on_module("mono", unity::on_mono);
    }
    if on("waveout") {
        waveout::register();
    }
    if on("fileread") {
        fileread::register();
    }
    if on("cri") {
        cri::register();
        iat::on_module("cri_ware_unity", cri::on_cri);
    }
    if on("sdl") {
        sdl::register();
    }
    if on("il2cpp") {
        iat::on_module("gameassembly", il2cpp::on_il2cpp);
    }
    if on("renpy") {
        iat::on_module("python", renpy::on_python);
    }
    if !on("iat") {
        census::scan();
        signal_ready();
        return;
    }
    iat::rescan();
    census::scan();
    signal_ready();
    let mut tick = 0u32;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        tick += 1;
        if XAUDIO.load(Ordering::SeqCst) {
            unsafe { xa::install() };
        }
        iat::rescan();
        if tick < 60 || tick % 10 == 0 {
            census::scan();
        }
    }
}

/// Tells `voicehook launch` (waiting with the game suspended) that the hooks are in.
fn signal_ready() {
    let name = util::wide(&format!("Local\\voicehook_ready_{}", unsafe { GetCurrentProcessId() }));
    unsafe {
        let event = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
        if !event.is_null() {
            SetEvent(event);
            CloseHandle(event);
        }
    }
}
