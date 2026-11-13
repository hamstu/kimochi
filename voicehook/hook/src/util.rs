use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;

static LOG: OnceLock<Mutex<File>> = OnceLock::new();

/// Unix time in ms, the clock Kimochi's Log and sentence audio use.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn log_init(path: &Path) {
    if let Ok(f) = File::create(path) {
        let _ = LOG.set(Mutex::new(f));
    }
}

pub fn log(line: &str) {
    if let Some(f) = LOG.get() {
        let mut f = lock(f);
        let _ = writeln!(f, "{:.0} {line}", now_ms());
        let _ = f.flush();
    }
}

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn from_wide(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

pub fn module_path(module: HMODULE) -> PathBuf {
    let mut buf = vec![0u16; 1024];
    let n = unsafe { GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    PathBuf::from(String::from_utf16_lossy(&buf[..n]))
}

/// Runs bookkeeping inside a hook without letting a panic cross into the game.
pub fn guard(f: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        log("a hook's bookkeeping panicked (ignored)");
    }
}

/// How many of the `len` bytes at `p` are committed, readable memory, from `p` on.
pub unsafe fn readable_len(p: usize, len: usize) -> usize {
    use std::ffi::c_void;
    use windows_sys::Win32::System::Memory::{
        VirtualQuery, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS,
    };
    let end = p.saturating_add(len);
    let mut at = p;
    while at < end {
        let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
        if VirtualQuery(at as *const c_void, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) == 0
            || info.State != MEM_COMMIT
            || info.Protect & (PAGE_NOACCESS | PAGE_GUARD) != 0
            || info.Protect == 0
        {
            break;
        }
        at = info.BaseAddress as usize + info.RegionSize;
    }
    at.min(end) - p
}

/// A copy of the `len` bytes a game handed us at `p`. The pointer and length come from the game
/// (or the audio API on its behalf) and are copied on the game's thread, so a stale or short
/// buffer must cost a clip, not the game: whatever is not readable is left out and logged.
/// One `VirtualQuery` per buffer.
pub unsafe fn copy_in(p: *const u8, len: usize, what: &str) -> Vec<u8> {
    if p.is_null() || len == 0 {
        return Vec::new();
    }
    let ok = readable_len(p as usize, len);
    if ok < len {
        log(&format!("{what}: {len} bytes at {} but only {ok} readable; copied those", hex(p as usize)));
    }
    std::slice::from_raw_parts(p, ok).to_vec()
}

pub fn hex(p: usize) -> String {
    format!("{p:#x}")
}

/// Text in the system's ANSI code page (Shift-JIS on a Japanese system).
pub fn from_ansi(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
    if bytes.is_empty() {
        return String::new();
    }
    let mut out = vec![0u16; bytes.len()];
    let n = unsafe {
        MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, out.as_mut_ptr(), out.len() as i32)
    };
    String::from_utf16_lossy(&out[..n.max(0) as usize])
}
