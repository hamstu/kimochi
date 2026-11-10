//! Hosts LunaHook through `LunaHost64.dll`'s C API, as LunaTranslator does through ctypes
//! (`textio/textsource/texthook.py`; exports in `NativeImpl/LunaHook/LunaHost/LunaHostDll.cpp`).
//! The host DLL, the hook DLLs and the pipe protocol must all come from one LunaTranslator
//! release; the app's manifest pins it. The host DLL owns sentence buffering (flush delay),
//! charset detection and the per-thread histories; we forward its threads and sentences.
use crate::protocol::{emit, thread_event, PcHooks, Thread};
use libloading::{Library, Symbol};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ThreadParam {
    process_id: u32,
    addr: u64,
    ctx: u64,
    ctx2: u64,
}
impl From<ThreadParam> for Thread {
    fn from(tp: ThreadParam) -> Self {
        Thread { pid: tp.process_id, addr: tp.addr, ctx: tp.ctx, ctx2: tp.ctx2 }
    }
}

type ProcessEvent = extern "C" fn(u32);
type ThreadCreate = extern "C" fn(*const u16, *const c_char, ThreadParam, bool);
type ThreadDestroy = extern "C" fn(*const u16, *const c_char, ThreadParam);
type Output = extern "C" fn(*const u16, *const c_char, ThreadParam, *const u16);
type HostInfo = extern "C" fn(i32, *const u16);
type HookInsert = extern "C" fn(u32, u64, *const u16);
type Embed = extern "C" fn(*const u16, ThreadParam);
type I18n = extern "C" fn(*const u16) -> *mut u16;
type EmuGameInfo = extern "C" fn(*const u16, *const u16, *const u16);
type Start = unsafe extern "C" fn(
    ProcessEvent,
    ProcessEvent,
    ThreadCreate,
    ThreadDestroy,
    Output,
    HostInfo,
    HookInsert,
    Embed,
    I18n,
    EmuGameInfo,
);

fn text(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0;
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}
fn utf8(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

/// What the callbacks need to know about each process we were asked to attach.
#[derive(Default)]
struct Shared {
    connected: HashMap<u32, Instant>,
    engine: HashMap<u32, String>,
}
static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

extern "C" fn on_connect(pid: u32) {
    shared().connected.insert(pid, Instant::now());
    emit("connected", json!({ "pid": pid }));
}
extern "C" fn on_disconnect(pid: u32) {
    shared().connected.remove(&pid);
    emit("disconnected", json!({ "pid": pid }));
}
extern "C" fn on_create(hookcode: *const u16, name: *const c_char, tp: ThreadParam, _embed: bool) {
    thread_event("thread", &tp.into(), &text(hookcode), &utf8(name));
}
extern "C" fn on_destroy(hookcode: *const u16, name: *const c_char, tp: ThreadParam) {
    thread_event("thread_removed", &tp.into(), &text(hookcode), &utf8(name));
}
extern "C" fn on_output(_hookcode: *const u16, _name: *const c_char, tp: ThreadParam, output: *const u16) {
    let thread: Thread = tp.into();
    emit("text", json!({ "key": thread.key(), "pid": thread.pid, "text": text(output) }));
}
extern "C" fn on_info(kind: i32, message: *const u16) {
    let message = text(message);
    // HOSTINFO: Console, Warning, EmuWarning, EmuConnected, EngineType (include/const.h).
    let level = match kind {
        1 | 2 => "warning",
        3 => "emulator",
        4 => "engine",
        _ => "console",
    };
    if kind == 4 {
        note_engine(&message);
    }
    emit("info", json!({ "level": level, "text": message }));
}
extern "C" fn on_hook_insert(pid: u32, addr: u64, hookcode: *const u16) {
    emit("hook", json!({ "pid": pid, "addr": format!("{addr:x}"), "hookcode": text(hookcode) }));
}
extern "C" fn on_embed(_text: *const u16, _tp: ThreadParam) {}
extern "C" fn on_i18n(_text: *const u16) -> *mut u16 {
    std::ptr::null_mut()
}
extern "C" fn on_emu_game(id: *const u16, title: *const u16, version: *const u16) {
    emit("info", json!({ "level": "emulator", "text": format!("{} {} {}", text(id), text(title), text(version)) }));
}

pub struct Luna {
    library: Library,
    dir: PathBuf,
}

impl Luna {
    pub fn load(dir: &Path, flush_ms: i32) -> Result<Self, String> {
        let host = dir.join("LunaHost64.dll");
        // LOAD_WITH_ALTERED_SEARCH_PATH: the host's own dependencies (the Visual C++ runtime the
        // download carries) are looked for beside it first, so PCs without the runtime work.
        let library: Library = unsafe { libloading::os::windows::Library::load_with_flags(&host, 0x0000_0008) }
            .map_err(|e| format!("{}: {e}", host.display()))?
            .into();
        let luna = Luna { library, dir: dir.to_path_buf() };
        unsafe {
            let start: Symbol<Start> = luna.symbol(b"Luna_Start\0")?;
            start(
                on_connect,
                on_disconnect,
                on_create,
                on_destroy,
                on_output,
                on_info,
                on_hook_insert,
                on_embed,
                on_i18n,
                on_emu_game,
            );
            // flushDelay, default codepage (Shift-JIS), max buffer, max history, PC hooks on
            // connect. The generic API hooks are inserted per attach instead (`PcHooks`).
            let settings: Symbol<unsafe extern "C" fn(i32, i32, i32, i32, bool)> = luna.symbol(b"Luna_Settings\0")?;
            settings(flush_ms, 932, 3000, 100_000, false);
        }
        Ok(luna)
    }

    unsafe fn symbol<T>(&self, name: &[u8]) -> Result<Symbol<'_, T>, String> {
        self.library
            .get(name)
            .map_err(|e| format!("LunaHost64.dll has no {}: {e}", String::from_utf8_lossy(&name[..name.len() - 1])))
    }

    fn pid_call(&self, name: &[u8], pid: u32) -> Result<(), String> {
        unsafe { (self.symbol::<unsafe extern "C" fn(u32)>(name)?)(pid) };
        Ok(())
    }

    pub fn insert(&self, pid: u32, code: &str) -> Result<(), String> {
        let code = crate::wide(code);
        unsafe { (self.symbol::<unsafe extern "C" fn(u32, *const u16)>(b"Luna_InsertHookCode\0")?)(pid, code.as_ptr()) };
        Ok(())
    }

    pub fn pc_hooks(&self, pid: u32) -> Result<(), String> {
        let call = unsafe { self.symbol::<unsafe extern "C" fn(u32, i32)>(b"Luna_InsertPCHooks\0")? };
        unsafe {
            call(pid, 0);
            call(pid, 1);
        }
        Ok(())
    }

    pub fn detach(&self, pid: u32) -> Result<(), String> {
        self.pid_call(b"Luna_DetachProcess\0", pid)
    }

    /// Opens the pipes for `pid`, injects the hook DLL of the given bitness unless one is already
    /// loaded there, and waits for it to connect. On no connection it tries the other bitness
    /// once: the PE header can disagree with what actually runs (launchers, emulation layers).
    pub fn attach(&self, pid: u32, bits: u32, pc: PcHooks) -> Result<(), String> {
        self.pid_call(b"Luna_ConnectProcess\0", pid)?;
        let need_inject = unsafe { self.symbol::<unsafe extern "C" fn(u32) -> bool>(b"Luna_CheckIfNeedInject\0")? };
        // A hook DLL already in the game reconnects (an earlier helper quit without detaching), or
        // is on its way out: an earlier helper detached it moments ago (the app hooking another
        // window of the same game). That one unloads, and then a fresh one is injected.
        let mut need = unsafe { need_inject(pid) };
        if !need {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                if shared().connected.contains_key(&pid) {
                    emit("attached", json!({ "pid": pid, "bits": bits, "reused": true }));
                    break;
                }
                if unsafe { need_inject(pid) } {
                    need = true;
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("a hook is already loaded in this process but did not reconnect; restart the game".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if need {
            let mut errors = Vec::new();
            for bits in [bits, if bits == 32 { 64 } else { 32 }] {
                match self.inject(pid, bits) {
                    Ok(()) if self.wait_connected(pid, Duration::from_secs(6)) => {
                        emit("attached", json!({ "pid": pid, "bits": bits }));
                        errors.clear();
                        break;
                    }
                    Ok(()) => errors.push(format!("{bits}-bit hook loaded but never connected")),
                    Err(e) => errors.push(format!("{bits}-bit: {e}")),
                }
            }
            if !errors.is_empty() {
                return Err(errors.join("; "));
            }
        }
        match pc {
            PcHooks::On => self.pc_hooks(pid)?,
            PcHooks::Off => {}
            PcHooks::Auto => {
                // Engine detection reports `EngineType` shortly after connecting. A game Luna
                // has no engine hook for gets the generic text-API hooks instead.
                std::thread::sleep(Duration::from_millis(1500));
                if !shared().engine.contains_key(&pid) {
                    emit("info", json!({ "level": "console", "text": "no engine detected; inserting generic API hooks" }));
                    self.pc_hooks(pid)?;
                }
            }
        }
        Ok(())
    }

    fn wait_connected(&self, pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if shared().connected.contains_key(&pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn inject(&self, pid: u32, bits: u32) -> Result<(), String> {
        let dll = self.dir.join(if bits == 32 { "LunaHook32.dll" } else { "LunaHook64.dll" });
        if !dll.is_file() {
            return Err(format!("{} is missing", dll.display()));
        }
        crate::inject_with_bits(pid, bits, &dll)
    }
}

/// Remembers the engine Luna named for a process (`EngineType` host info carries no pid, so it
/// is credited to the most recently connected process).
pub fn note_engine(message: &str) {
    let mut shared = shared();
    if let Some((&pid, _)) = shared.connected.iter().max_by_key(|(_, at)| **at) {
        shared.engine.insert(pid, message.to_string());
    }
}
