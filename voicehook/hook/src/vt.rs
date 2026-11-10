//! Vtable slot patching. Each patched slot remembers its original function, keyed by the vtable
//! it was in, so a hook finds the original through `this`'s own vtable (different interfaces or
//! API versions can share a hook function but not an original).
use crate::util::lock;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use windows_sys::Win32::System::Memory::{VirtualProtect, PAGE_EXECUTE_READWRITE, PAGE_READWRITE};

pub const DS_DEVICE: u8 = 1;
pub const DS_BUFFER: u8 = 2;
pub const XA_ENGINE: u8 = 3;
pub const XA_VOICE: u8 = 4;

struct Entry {
    vtbl: usize,
    idx: usize,
    kind: u8,
    orig: usize,
}

static ORIG: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

pub unsafe fn vtable(obj: *mut c_void) -> *mut usize {
    *(obj as *const *mut usize)
}

/// Points slot `idx` of `vtbl` at `hook`. False when it already was (or could not be).
pub unsafe fn hook(vtbl: *mut usize, idx: usize, kind: u8, hook: usize) -> bool {
    let slot = vtbl.add(idx);
    let current = std::ptr::read_volatile(slot);
    if current == hook {
        return false;
    }
    {
        let mut g = lock(&ORIG);
        if g.iter().any(|e| e.vtbl == vtbl as usize && e.idx == idx) {
            return false;
        }
        // Recorded before the patch, so the hook can always find its original.
        g.push(Entry { vtbl: vtbl as usize, idx, kind, orig: current });
    }
    let mut old = 0u32;
    let size = std::mem::size_of::<usize>();
    if VirtualProtect(slot as *const c_void, size, PAGE_READWRITE, &mut old) == 0
        && VirtualProtect(slot as *const c_void, size, PAGE_EXECUTE_READWRITE, &mut old) == 0
    {
        lock(&ORIG).retain(|e| !(e.vtbl == vtbl as usize && e.idx == idx));
        return false;
    }
    (*(slot as *const AtomicUsize)).store(hook, Ordering::SeqCst);
    VirtualProtect(slot as *const c_void, size, old, &mut old);
    true
}

/// The original of slot `idx` for `this`. Falls back to the same slot of any vtable of the same
/// kind (never expected); 0 when there is none.
pub unsafe fn orig(this: *mut c_void, idx: usize, kind: u8) -> usize {
    let vtbl = vtable(this) as usize;
    let g = lock(&ORIG);
    g.iter()
        .find(|e| e.vtbl == vtbl && e.idx == idx)
        .or_else(|| g.iter().find(|e| e.kind == kind && e.idx == idx))
        .map_or(0, |e| e.orig)
}

pub fn count(kind: u8) -> usize {
    let g = lock(&ORIG);
    let mut v: Vec<usize> = g.iter().filter(|e| e.kind == kind).map(|e| e.vtbl).collect();
    v.sort_unstable();
    v.dedup();
    v.len()
}
