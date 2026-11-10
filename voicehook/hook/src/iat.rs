//! Import-table hooks: the adapters for libraries reached through exports (winmm, SDL_mixer,
//! FMOD, CRI, Mono, Python...) patch the *callers'* import address tables, never code, for the
//! same reason the COM hooks patch vtables: it is a pointer write, so it also works in x64 games
//! emulated on ARM64 (ARM64X system DLLs).
//!
//! Two ways a call reaches a hooked export, both covered:
//! - a module imports it: every loaded module's IAT entry for it is pointed at the hook
//!   (`rescan` patches modules loaded later);
//! - a module looks it up with `GetProcAddress` (engines that load an audio library at run time,
//!   Unity loading Mono, Mono resolving P/Invoke): `GetProcAddress` itself is hooked in every
//!   module, and returns the hook instead.
//!
//! Each hook has an `AtomicUsize` that receives the original function; it is set before the
//! first patch, so a hook can always call through.
use crate::util::{from_wide, lock, log};
use std::collections::HashSet;
use std::ffi::{c_void, CStr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use windows_sys::Win32::Foundation::{CloseHandle, HMODULE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, GetProcAddress};
use windows_sys::Win32::System::Memory::{VirtualProtect, PAGE_READWRITE};

pub struct Hook {
    /// Lower-case substring of the exporting DLL's file name ("winmm", "sdl2_mixer", "mono").
    pub dll: &'static str,
    pub name: &'static str,
    pub hook: usize,
    pub orig: &'static AtomicUsize,
}

/// Called the first time a module whose name contains `dll` is seen (loaded or looked up).
pub struct OnModule {
    pub dll: &'static str,
    pub f: fn(HMODULE, &str),
}

static HOOKS: Mutex<Vec<Hook>> = Mutex::new(Vec::new());
static ON_MODULE: Mutex<Vec<OnModule>> = Mutex::new(Vec::new());
static PATCHED: LazyLock<Mutex<HashSet<usize>>> = LazyLock::new(Default::default);
static MODULES_SEEN: LazyLock<Mutex<HashSet<usize>>> = LazyLock::new(Default::default);
static REAL_GPA: AtomicUsize = AtomicUsize::new(0);

type FnGpa = unsafe extern "system" fn(HMODULE, *const u8) -> usize;

pub fn register(h: Hook) {
    lock(&HOOKS).push(h);
}

pub fn on_module(dll: &'static str, f: fn(HMODULE, &str)) {
    lock(&ON_MODULE).push(OnModule { dll, f });
}

pub fn module_name(m: HMODULE) -> String {
    let mut buf = vec![0u16; 520];
    let n = unsafe { GetModuleFileNameW(m, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    let path = String::from_utf16_lossy(&buf[..n]);
    path.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase()
}

/// The real `GetProcAddress` (never our hook).
pub unsafe fn real_gpa(m: HMODULE, name: &CStr) -> usize {
    match REAL_GPA.load(Ordering::SeqCst) {
        0 => GetProcAddress(m, name.as_ptr().cast()).map_or(0, |f| f as usize),
        f => std::mem::transmute::<usize, FnGpa>(f)(m, name.as_ptr().cast()),
    }
}

fn seen_module(m: HMODULE, name: &str) {
    if !lock(&MODULES_SEEN).insert(m as usize) {
        return;
    }
    let calls: Vec<fn(HMODULE, &str)> = lock(&ON_MODULE).iter().filter(|o| name.contains(o.dll)).map(|o| o.f).collect();
    for f in calls {
        f(m, name);
    }
}

unsafe extern "system" fn gpa_hook(m: HMODULE, name: *const u8) -> usize {
    let real: FnGpa = std::mem::transmute(REAL_GPA.load(Ordering::SeqCst));
    let f = real(m, name);
    // Ordinals (high word zero) pass straight through.
    if f == 0 || (name as usize) >> 16 == 0 {
        return f;
    }
    let mut out = f;
    crate::util::guard(|| {
        let n = CStr::from_ptr(name.cast()).to_bytes();
        let hooks = lock(&HOOKS);
        let Some(h) = hooks.iter().find(|h| h.name.as_bytes() == n) else {
            drop(hooks);
            let modname = module_name(m);
            seen_module(m, &modname);
            return;
        };
        let modname = module_name(m);
        if !modname.contains(h.dll) {
            return;
        }
        let _ = h.orig.compare_exchange(0, f, Ordering::SeqCst, Ordering::SeqCst);
        // Only hand out the hook when it calls through to this very function.
        if h.orig.load(Ordering::SeqCst) == f {
            out = h.hook;
        }
        drop(hooks);
        seen_module(m, &modname);
    });
    out
}

/// Every loaded module: (base, file name in lower case).
pub fn modules() -> Vec<(HMODULE, String)> {
    let mut v = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, 0);
        if snap == INVALID_HANDLE_VALUE {
            return v;
        }
        let mut e: MODULEENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        if Module32FirstW(snap, &mut e) != 0 {
            loop {
                v.push((e.hModule, from_wide(&e.szModule).to_ascii_lowercase()));
                if Module32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    v
}

unsafe fn rd<T: Copy>(base: usize, off: usize) -> T {
    std::ptr::read_unaligned((base + off) as *const T)
}

/// Whether `[p, p + len)` is committed, readable memory.
unsafe fn readable(p: usize, len: usize) -> bool {
    use windows_sys::Win32::System::Memory::{VirtualQuery, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS};
    let mut at = p;
    while at < p + len {
        let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
        if VirtualQuery(at as *const c_void, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) == 0
            || info.State != MEM_COMMIT
            || info.Protect & (PAGE_NOACCESS | PAGE_GUARD) != 0
            || info.Protect == 0
        {
            return false;
        }
        at = info.BaseAddress as usize + info.RegionSize;
    }
    true
}

/// A NUL-terminated name at `p`, of at most 255 bytes, inside the image (`end`).
unsafe fn name_at(p: usize, end: usize) -> Option<&'static [u8]> {
    let max = 256.min(end.saturating_sub(p));
    if max == 0 || !readable(p, max) {
        return None;
    }
    let bytes = std::slice::from_raw_parts(p as *const u8, max);
    bytes.iter().position(|&b| b == 0).map(|n| &bytes[..n])
}

/// Calls `f(dll name, function name, IAT slot)` for every by-name import of `base`. Every address
/// is checked against the image and its memory: packed or protected games (QLIE's Delphi exes)
/// carry import tables that do not hold up to being read as a linker writes them.
unsafe fn walk_imports(base: usize, mut f: impl FnMut(&str, &[u8], *mut usize)) {
    if !readable(base, 0x40) || rd::<u16>(base, 0) != 0x5A4D {
        return;
    }
    let nt = base + rd::<u32>(base, 0x3C) as usize;
    if !readable(nt, 24 + 0x78) || rd::<u32>(nt, 0) != 0x4550 {
        return;
    }
    let opt = nt + 24;
    let magic = rd::<u16>(opt, 0);
    let dir = match magic {
        0x20b => opt + 112, // PE32+
        0x10b => opt + 96,  // PE32
        _ => return,
    };
    if (magic == 0x20b) != cfg!(target_pointer_width = "64") || !readable(dir, 16) {
        return;
    }
    let image = rd::<u32>(opt, 56) as usize;
    let end = base + image;
    let inside = |rva: usize, len: usize| rva != 0 && rva.checked_add(len).is_some_and(|e| e <= image);
    let (imp_rva, imp_size) = (rd::<u32>(dir, 8) as usize, rd::<u32>(dir, 12) as usize);
    if imp_size == 0 || !inside(imp_rva, 20) {
        return;
    }
    let w = std::mem::size_of::<usize>();
    let mut desc = base + imp_rva;
    while desc + 20 <= end && readable(desc, 20) {
        let (oft, name_rva, ft) = (rd::<u32>(desc, 0) as usize, rd::<u32>(desc, 12) as usize, rd::<u32>(desc, 16) as usize);
        if name_rva == 0 || ft == 0 {
            break;
        }
        desc += 20;
        // Without its name table (OriginalFirstThunk) a descriptor's names are unknown: its address
        // table holds the resolved functions by now, not the names' addresses.
        if !inside(name_rva, 1) || !inside(oft, w) || !inside(ft, w) {
            continue;
        }
        let Some(dll) = name_at(base + name_rva, end) else { continue };
        let dll = String::from_utf8_lossy(dll).to_ascii_lowercase();
        let mut i = 0usize;
        while inside(oft + i * w, w) && inside(ft + i * w, w) && readable(base + oft + i * w, w) {
            let entry: usize = rd(base, oft + i * w);
            if entry == 0 {
                break;
            }
            let by_ordinal = entry >> (usize::BITS - 1) == 1;
            let rva = entry & 0x7fff_ffff;
            if !by_ordinal && inside(rva, 3) {
                if let Some(fname) = name_at(base + rva + 2, end) {
                    f(&dll, fname, (base + ft + i * w) as *mut usize);
                }
            }
            i += 1;
        }
    }
}

unsafe fn write_slot(slot: *mut usize, value: usize) -> bool {
    let mut old = 0u32;
    if VirtualProtect(slot as *const c_void, std::mem::size_of::<usize>(), PAGE_READWRITE, &mut old) == 0 {
        return false;
    }
    (*(slot as *const AtomicUsize)).store(value, Ordering::SeqCst);
    VirtualProtect(slot as *const c_void, std::mem::size_of::<usize>(), old, &mut old);
    true
}

/// Patches the import tables of modules not patched yet (and calls `on_module` watchers).
/// Cheap when nothing new has loaded; call it periodically.
pub fn rescan() {
    let me = crate::MODULE.load(Ordering::SeqCst);
    let mods = modules();
    for (m, name) in &mods {
        seen_module(*m, name);
    }
    let fresh: Vec<(HMODULE, String)> = {
        let mut p = lock(&PATCHED);
        mods.into_iter().filter(|(m, _)| *m as usize != me && p.insert(*m as usize)).collect()
    };
    if fresh.is_empty() {
        return;
    }
    let gpa = gpa_hook as *const () as usize;
    let mut n = 0;
    let hooks = lock(&HOOKS);
    for (m, modname) in &fresh {
        // System DLLs call each other through these exports too; leave them alone.
        if is_system(modname) {
            continue;
        }
        unsafe {
            walk_imports(*m as usize, |dll, fname, slot| {
                let current = std::ptr::read_volatile(slot);
                if fname == b"GetProcAddress" && (dll.starts_with("kernel32") || dll.contains("libraryloader")) {
                    if current != gpa {
                        let _ = REAL_GPA.compare_exchange(0, current, Ordering::SeqCst, Ordering::SeqCst);
                        if write_slot(slot, gpa) {
                            n += 1;
                        }
                    }
                    return;
                }
                for h in hooks.iter() {
                    if h.name.as_bytes() == fname && dll.contains(h.dll) && current != h.hook {
                        let _ = h.orig.compare_exchange(0, current, Ordering::SeqCst, Ordering::SeqCst);
                        if h.orig.load(Ordering::SeqCst) == current && write_slot(slot, h.hook) {
                            log(&format!("iat: {modname} -> {dll}!{} hooked", h.name));
                            n += 1;
                        } else if h.orig.load(Ordering::SeqCst) != current {
                            log(&format!(
                                "iat: {modname} -> {dll}!{} left alone: it points at {:#x}, the hook calls {:#x}",
                                h.name,
                                current,
                                h.orig.load(Ordering::SeqCst)
                            ));
                        }
                    }
                }
            });
        }
    }
    if n > 0 {
        log(&format!("iat: {n} import slots patched in {} new modules", fresh.len()));
    }
}

fn is_system(name: &str) -> bool {
    const SYS: &[&str] = &[
        "ntdll", "kernel32", "kernelbase", "user32", "gdi32", "win32u", "combase", "rpcrt4", "ole32", "oleaut32",
        "advapi32", "sechost", "msvcrt", "ucrtbase", "msvcp_win", "xtajit", "apphelp", "shell32", "shlwapi",
        "dsound", "xaudio2", "audioses", "mmdevapi", "winmmbase", "windows.", "api-ms-", "ext-ms-", "bcrypt",
        "cfgmgr32", "powrprof", "umpdc", "devobj", "clbcatq", "imm32", "msctf", "uxtheme", "dwmapi", "d3d", "dxgi",
        "dxcore", "nvoglv", "nvwgf", "igd", "amdx", "atiu", "opengl32", "glu32", "wintypes", "coremessaging",
        "textinputframework", "inputhost", "crypt", "wldp", "profapi", "kernel.appcore", "msasn1", "ntmarta",
    ];
    SYS.iter().any(|s| name.starts_with(s))
}
