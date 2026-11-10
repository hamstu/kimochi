//! Unity (IL2CPP) adapter: every `AudioSource.Play*` / `PlayOneShot` / `Stop`, with the
//! `AudioClip`'s name and, where Unity can give it, its PCM (`AudioClip.GetData`), as the Mono
//! adapter (`unity.rs`) gives them, in the same events.
//!
//! How: UnityPlayer.dll registers its engine functions with IL2CPP by name
//! (`il2cpp_add_internal_call`). The game's generated code (GameAssembly.dll) looks each one up the
//! first time a call site runs (`il2cpp_resolve_icall`) and keeps the function's address in a
//! static of its own. So, once IL2CPP is up: each watched `AudioSource` function is resolved by name,
//! our trampoline is registered under that name (for call sites not run yet), and every copy of the
//! function's address in GameAssembly's writable data (call sites already run) is replaced with
//! the trampoline's. Pointer writes only; no code is patched. A trampoline runs on the game's
//! thread, records the call and calls Unity's function.
//!
//! The clip's name, length and PCM come from the managed getters, called with
//! `il2cpp_runtime_invoke`; an `Il2CppObject`, `Il2CppString` and boxed value have Mono's layout.
//!
//! Limits: Unity 6's `_Injected` calls (native pointers) are found but their PCM is not read yet;
//! getters a game's build stripped (never used by its scripts) leave their field out.
use crate::sink::{self, Ev};
use crate::util::{guard, hex, lock, log};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use windows_sys::Win32::Foundation::HMODULE;

type P = *mut c_void;

struct Il2Cpp {
    module: usize,
    resolve_icall: unsafe extern "C" fn(*const c_char) -> P,
    add_internal_call: unsafe extern "C" fn(*const c_char, P),
    domain_get: unsafe extern "C" fn() -> P,
    runtime_invoke: unsafe extern "C" fn(P, P, *mut P, *mut P) -> P,
    object_get_class: unsafe extern "C" fn(P) -> P,
    class_get_parent: unsafe extern "C" fn(P) -> P,
    class_get_method_from_name: unsafe extern "C" fn(P, *const c_char, i32) -> P,
    class_get_methods: unsafe extern "C" fn(P, *mut P) -> P,
    method_get_name: unsafe extern "C" fn(P) -> *const c_char,
    method_get_param_count: unsafe extern "C" fn(P) -> u32,
    method_get_param: unsafe extern "C" fn(P, u32) -> P,
    type_get_name: unsafe extern "C" fn(P) -> *mut c_char,
    class_from_name: unsafe extern "C" fn(P, *const c_char, *const c_char) -> P,
    get_corlib: unsafe extern "C" fn() -> P,
    array_new: unsafe extern "C" fn(P, usize) -> P,
}

unsafe impl Send for Il2Cpp {}
unsafe impl Sync for Il2Cpp {}

static API: OnceLock<Il2Cpp> = OnceLock::new();
/// (class ptr, method name, nargs) → MethodInfo*.
static METHODS: LazyLock<Mutex<HashMap<(usize, &'static str, i32), usize>>> = LazyLock::new(Default::default);
/// Last (clip, time) per source, to drop a second call made for the same Play.
static LAST: LazyLock<Mutex<HashMap<usize, (usize, f64)>>> = LazyLock::new(Default::default);
static SOURCE_NAMES: LazyLock<Mutex<HashMap<usize, Option<String>>>> = LazyLock::new(Default::default);
/// Unity 6 (`_Injected` names): the arguments are native pointers.
static INJECTED: AtomicBool = AtomicBool::new(false);

/// Clips longer than this are taken as music: name and timing only, no PCM copy.
const MAX_PCM_SECS: f64 = 30.0;

macro_rules! tramp {
    ($orig:ident, $f:ident, ($($a:ident: $t:ty),*), $ret:ty, $what:literal, $src:ident, $clip:expr) => {
        static $orig: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "C" fn $f($($a: $t),*) -> $ret {
            guard(|| unsafe { seen($what, $src as P, $clip) });
            let o: unsafe extern "C" fn($($t),*) -> $ret = std::mem::transmute($orig.load(Ordering::SeqCst));
            o($($a),*)
        }
    };
}

tramp!(O_PLAY_HELPER, t_play_helper, (src: P, delay: u64), (), "PlayHelper", src, std::ptr::null_mut());
tramp!(O_PLAY, t_play, (src: P, delay: f64), (), "Play", src, std::ptr::null_mut());
tramp!(O_ONE_SHOT, t_one_shot, (src: P, clip: P, volume: f32), (), "PlayOneShot", src, clip);
tramp!(O_STOP, t_stop, (src: P, one_shots: u8), (), "Stop", src, std::ptr::null_mut());
tramp!(O_PAUSE, t_pause, (src: P), (), "Pause", src, std::ptr::null_mut());
tramp!(O_IS_PLAYING, t_is_playing, (src: P), u8, "tick", src, std::ptr::null_mut());

/// The watched `AudioSource` functions: base name, the slot keeping Unity's function, our
/// trampoline.
fn watched() -> [(&'static str, &'static AtomicUsize, usize); 6] {
    [
        ("PlayHelper", &O_PLAY_HELPER, t_play_helper as *const () as usize),
        ("Play", &O_PLAY, t_play as *const () as usize),
        ("PlayOneShotHelper", &O_ONE_SHOT, t_one_shot as *const () as usize),
        ("Stop", &O_STOP, t_stop as *const () as usize),
        ("Pause", &O_PAUSE, t_pause as *const () as usize),
        ("get_isPlaying", &O_IS_PLAYING, t_is_playing as *const () as usize),
    ]
}

/// The first time GameAssembly.dll is seen: resolve the API, then wait for IL2CPP to start and
/// Unity to register its functions, and redirect the watched ones.
pub fn on_il2cpp(m: HMODULE, name: &str) {
    if API.get().is_some() {
        return;
    }
    let Some(api) = (unsafe { resolve(m) }) else {
        log(&format!("il2cpp: {name} lacks part of the IL2CPP API; adapter off"));
        return;
    };
    let _ = API.set(api);
    log(&format!("il2cpp: API resolved from {name}"));
    std::thread::spawn(|| {
        let started = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            match unsafe { redirect(API.get().unwrap()) } {
                Ok(n) => {
                    log(&format!("il2cpp: redirected {n} AudioSource internal calls"));
                    return;
                }
                Err(e) if started.elapsed().as_secs() < 300 => {
                    if started.elapsed().as_millis() < 600 {
                        log(&format!("il2cpp: not ready yet ({e}); retrying"));
                    }
                }
                Err(e) => {
                    log(&format!("il2cpp: gave up: {e}"));
                    return;
                }
            }
        }
    });
}

unsafe fn resolve(m: HMODULE) -> Option<Il2Cpp> {
    macro_rules! s {
        ($n:literal) => {
            std::mem::transmute::<usize, _>(match crate::iat::real_gpa(m, $n) {
                0 => return None,
                f => f,
            })
        };
    }
    Some(Il2Cpp {
        module: m as usize,
        resolve_icall: s!(c"il2cpp_resolve_icall"),
        add_internal_call: s!(c"il2cpp_add_internal_call"),
        domain_get: s!(c"il2cpp_domain_get"),
        runtime_invoke: s!(c"il2cpp_runtime_invoke"),
        object_get_class: s!(c"il2cpp_object_get_class"),
        class_get_parent: s!(c"il2cpp_class_get_parent"),
        class_get_method_from_name: s!(c"il2cpp_class_get_method_from_name"),
        class_get_methods: s!(c"il2cpp_class_get_methods"),
        method_get_name: s!(c"il2cpp_method_get_name"),
        method_get_param_count: s!(c"il2cpp_method_get_param_count"),
        method_get_param: s!(c"il2cpp_method_get_param"),
        type_get_name: s!(c"il2cpp_type_get_name"),
        class_from_name: s!(c"il2cpp_class_from_name"),
        get_corlib: s!(c"il2cpp_get_corlib"),
        array_new: s!(c"il2cpp_array_new"),
    })
}

/// Unity's function for `UnityEngine.AudioSource::<base>`, and whether it is Unity 6's
/// `_Injected` form.
unsafe fn unity_function(a: &Il2Cpp, base: &str) -> Option<(usize, String, bool)> {
    for (suffix, injected) in [("", false), ("_Injected", true)] {
        let name = format!("UnityEngine.AudioSource::{base}{suffix}");
        let c = CString::new(name.clone()).ok()?;
        let f = (a.resolve_icall)(c.as_ptr()) as usize;
        if f != 0 {
            return Some((f, name, injected));
        }
    }
    None
}

/// Redirects the watched functions (see the module comment). Err while IL2CPP is not up or Unity
/// has not registered its audio functions yet.
unsafe fn redirect(a: &Il2Cpp) -> Result<usize, String> {
    if (a.domain_get)().is_null() {
        return Err("IL2CPP not initialised".into());
    }
    let found: Vec<_> = watched().into_iter().filter_map(|(base, slot, tramp)| unity_function(a, base).map(|f| (base, slot, tramp, f))).collect();
    if !found.iter().any(|(base, ..)| base.starts_with("Play")) {
        return Err("no AudioSource play function registered".into());
    }
    let data = writable_sections(a.module);
    let mut n = 0;
    for (base, slot, tramp, (f, name, injected)) in found {
        if slot.compare_exchange(0, f, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            continue;
        }
        INJECTED.store(injected, Ordering::Relaxed);
        // Call sites that run from now on.
        let c = CString::new(name.clone()).unwrap();
        (a.add_internal_call)(c.as_ptr(), tramp as P);
        // Call sites that already ran keep Unity's address in GameAssembly's data.
        let mut copies = 0;
        for &(start, len) in &data {
            copies += repoint_all(start, len, f, tramp);
        }
        n += 1;
        log(&format!("il2cpp: {name} at {} -> trampoline ({copies} cached copies repointed)", hex(f)));
        sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "unity-il2cpp", "icall": name, "base": base, "cached": copies, "injected": injected})));
    }
    Ok(n)
}

/// The module's writable, non-executable sections: (start, length).
pub(crate) unsafe fn writable_sections(module: usize) -> Vec<(usize, usize)> {
    const WRITE: u32 = 0x8000_0000;
    const EXECUTE: u32 = 0x2000_0000;
    let pe = module + *((module + 0x3c) as *const u32) as usize;
    let sections = *((pe + 6) as *const u16) as usize;
    let optional = *((pe + 20) as *const u16) as usize;
    let first = pe + 24 + optional;
    (0..sections)
        .filter_map(|i| {
            let s = first + i * 40;
            let size = *((s + 8) as *const u32) as usize;
            let va = *((s + 12) as *const u32) as usize;
            let flags = *((s + 36) as *const u32);
            (flags & WRITE != 0 && flags & EXECUTE == 0 && size > 0).then_some((module + va, size))
        })
        .collect()
}

/// Every pointer-aligned `from` in `[start, start + len)` becomes `to`. How many.
pub(crate) unsafe fn repoint_all(start: usize, len: usize, from: usize, to: usize) -> usize {
    let w = std::mem::size_of::<usize>();
    let mut n = 0;
    let mut p = (start + w - 1) / w * w;
    while p + w <= start + len {
        let slot = p as *mut usize;
        if std::ptr::read_volatile(slot) == from {
            // Writable already (a data section); an atomic store, as the game may read it now.
            (*(slot as *const AtomicUsize)).store(to, Ordering::SeqCst);
            n += 1;
        }
        p += w;
    }
    n
}

// ------------------------------------------------------------------ managed helpers

unsafe fn method(a: &Il2Cpp, class: P, name: &'static str, nargs: i32) -> P {
    if let Some(&m) = lock(&METHODS).get(&(class as usize, name, nargs)) {
        return m as P;
    }
    let cname = CString::new(name).unwrap();
    let mut c = class;
    let mut found = std::ptr::null_mut();
    while !c.is_null() {
        found = (a.class_get_method_from_name)(c, cname.as_ptr(), nargs);
        if !found.is_null() {
            break;
        }
        c = (a.class_get_parent)(c);
    }
    lock(&METHODS).insert((class as usize, name, nargs), found as usize);
    found
}

/// `AudioClip.GetData(float[], int)` exactly (Unity 6 also has a `Span<float>` overload).
unsafe fn get_data_method(a: &Il2Cpp, clip_class: P) -> P {
    if let Some(&m) = lock(&METHODS).get(&(clip_class as usize, "GetData(single[],int)", 2)) {
        return m as P;
    }
    let mut found: P = std::ptr::null_mut();
    let mut c = clip_class;
    while !c.is_null() && found.is_null() {
        let mut iter: P = std::ptr::null_mut();
        loop {
            let m = (a.class_get_methods)(c, &mut iter);
            if m.is_null() {
                break;
            }
            let name = CStr::from_ptr((a.method_get_name)(m));
            if name.to_bytes() != b"GetData" || (a.method_get_param_count)(m) != 2 {
                continue;
            }
            let ty = (a.method_get_param)(m, 0);
            let tn = if ty.is_null() { std::ptr::null_mut() } else { (a.type_get_name)(ty) };
            if !tn.is_null() && CStr::from_ptr(tn).to_bytes() == b"System.Single[]" {
                found = m;
                break;
            }
        }
        c = (a.class_get_parent)(c);
    }
    lock(&METHODS).insert((clip_class as usize, "GetData(single[],int)", 2), found as usize);
    found
}

/// Invokes `name` on `obj`. None when the build has no such method, or it threw.
unsafe fn invoke(a: &Il2Cpp, obj: P, name: &'static str, args: &mut [P]) -> Option<P> {
    if obj.is_null() {
        return None;
    }
    let m = method(a, (a.object_get_class)(obj), name, args.len() as i32);
    if m.is_null() {
        return None;
    }
    let mut exc: P = std::ptr::null_mut();
    let r = (a.runtime_invoke)(m, obj, if args.is_empty() { std::ptr::null_mut() } else { args.as_mut_ptr() }, &mut exc);
    exc.is_null().then_some(r)
}

/// The value inside a boxed value type (after the object header: klass, monitor).
unsafe fn unbox<T: Copy>(boxed: P) -> Option<T> {
    (!boxed.is_null()).then(|| std::ptr::read_unaligned((boxed as *const u8).add(2 * std::mem::size_of::<usize>()) as *const T))
}

/// An `Il2CppString`: header (klass, monitor), `int32` length, then UTF-16.
unsafe fn string(s: P) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let w = std::mem::size_of::<usize>();
    let len = std::ptr::read_unaligned((s as usize + 2 * w) as *const i32);
    if !(0..=4096).contains(&len) {
        return None;
    }
    let chars = std::slice::from_raw_parts((s as usize + 2 * w + 4) as *const u16, len as usize);
    Some(String::from_utf16_lossy(chars))
}

/// The name of the GameObject an AudioSource is on (cached per source): games that make a source
/// per sound often name it for the asset, whose folder tells the voice apart (see `unity.rs`).
unsafe fn source_name(a: &Il2Cpp, src: P) -> Option<String> {
    if let Some(n) = lock(&SOURCE_NAMES).get(&(src as usize)) {
        return n.clone();
    }
    let name = invoke(a, src, "get_gameObject", &mut [])
        .filter(|go| !go.is_null())
        .and_then(|go| invoke(a, go, "get_name", &mut []))
        .and_then(|s| string(s))
        .filter(|s| !s.is_empty());
    let mut names = lock(&SOURCE_NAMES);
    if names.len() > 4096 {
        names.clear();
    }
    names.insert(src as usize, name.clone());
    name
}

// ------------------------------------------------------------------ the event

unsafe fn seen(what: &'static str, src: P, clip: P) {
    let Some(a) = API.get() else { return };
    retry_pending(a);
    if src.is_null() || what == "tick" {
        return;
    }
    let key = (5u8, src as usize);
    if what == "Stop" || what == "Pause" {
        sink::send(Ev::Mark { key, what: "unity_stop", info: json!({"method": what}) });
        return;
    }
    if INJECTED.load(Ordering::Relaxed) {
        // Native pointers: finding their managed objects is not done for IL2CPP yet.
        sink::send(Ev::Mark { key, what: "unity_play_unknown", info: json!({"method": what, "injected": true}) });
        return;
    }
    let clip_obj = if clip.is_null() { invoke(a, src, "get_clip", &mut []).unwrap_or(std::ptr::null_mut()) } else { clip };
    if clip_obj.is_null() {
        sink::send(Ev::Mark { key, what: "unity_play_unknown", info: json!({"method": what}) });
        return;
    }
    let now = crate::util::now_ms();
    {
        let mut last = lock(&LAST);
        if let Some(&(c, t)) = last.get(&(src as usize)) {
            if c == clip_obj as usize && now - t < 30.0 {
                return;
            }
        }
        last.insert(src as usize, (clip_obj as usize, now));
    }
    let get_i32 = |name: &'static str| -> i32 { unsafe { invoke(a, clip_obj, name, &mut []).and_then(|b| unbox(b)).unwrap_or(0) } };
    let clip_name = invoke(a, clip_obj, "get_name", &mut []).and_then(|s| string(s));
    let (samples, channels, freq) = (get_i32("get_samples"), get_i32("get_channels"), get_i32("get_frequency"));
    let load_type: i32 = invoke(a, clip_obj, "get_loadType", &mut []).and_then(|b| unbox(b)).unwrap_or(-1);
    let secs = if freq > 0 { samples as f64 / freq as f64 } else { 0.0 };
    let n = samples.max(0) as usize * channels.max(0) as usize;
    let mut late = false;
    let result = if samples <= 0 || channels <= 0 || freq <= 0 {
        Err("no length")
    } else if secs > MAX_PCM_SECS {
        Err("long (music)")
    } else if load_type == 2 {
        Err("streaming clip")
    } else {
        match read_pcm(a, clip_obj, n) {
            Err(REFUSED) => {
                let _ = invoke(a, clip_obj, "LoadAudioData", &mut []);
                let r = read_pcm(a, clip_obj, n);
                late = r == Err(REFUSED);
                r
            }
            r => r,
        }
    };
    let p = Pending {
        key,
        clip: clip_obj as usize,
        n,
        fmt: crate::unity::float_fmt(channels.max(1) as u16, freq.max(1) as u32),
        name: source_name(a, src).filter(|n| n.contains(['/', '\\'])).or(clip_name),
        secs,
        at: now,
        info: json!({
            "method": what, "clip_ptr": hex(clip_obj as usize), "load_type": load_type,
            "samples": samples, "channels": channels, "freq": freq, "runtime": "il2cpp",
        }),
    };
    if late {
        lock(&PENDING).push(p);
        HAVE_PENDING.store(true, Ordering::SeqCst);
    } else {
        p.send(result, false);
    }
}

const REFUSED: &str = "GetData refused (not loaded, or compressed in memory)";
const RETRY_MS: f64 = 8000.0;

struct Pending {
    key: sink::Key,
    clip: usize,
    n: usize,
    fmt: Vec<u8>,
    name: Option<String>,
    secs: f64,
    at: f64,
    info: serde_json::Value,
}

static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());
static HAVE_PENDING: AtomicBool = AtomicBool::new(false);

impl Pending {
    fn send(self, result: Result<Vec<u8>, &'static str>, late: bool) {
        let mut info = self.info;
        info["late"] = json!(late);
        let bytes = match result {
            Ok(b) => b,
            Err(e) => {
                info["no_pcm"] = json!(e);
                Vec::new()
            }
        };
        sink::send(Ev::Whole { key: self.key, api: "unity", fmt: self.fmt, bytes, ext: None, source: self.name, dur: Some(self.secs), at: Some(self.at), info });
    }
}

/// Clips not loaded when played: their PCM again (game thread only).
unsafe fn retry_pending(a: &Il2Cpp) {
    if !HAVE_PENDING.load(Ordering::Relaxed) {
        return;
    }
    let now = crate::util::now_ms();
    let list = std::mem::take(&mut *lock(&PENDING));
    let mut keep = Vec::new();
    for p in list {
        if now - p.at < 150.0 {
            keep.push(p);
            continue;
        }
        match read_pcm(a, p.clip as P, p.n) {
            Err(REFUSED) if now - p.at < RETRY_MS => keep.push(p),
            r => p.send(r, true),
        }
    }
    HAVE_PENDING.store(!keep.is_empty(), Ordering::SeqCst);
    lock(&PENDING).extend(keep);
}

/// `float[]` data: after the array header (klass, monitor, bounds, max_length), pointer-sized each.
unsafe fn array_data(arr: P) -> *const u8 {
    (arr as *const u8).add(4 * std::mem::size_of::<usize>())
}

unsafe fn read_pcm(a: &Il2Cpp, clip: P, n: usize) -> Result<Vec<u8>, &'static str> {
    let single = (a.class_from_name)((a.get_corlib)(), c"System".as_ptr(), c"Single".as_ptr());
    if single.is_null() {
        return Err("no System.Single");
    }
    let arr = (a.array_new)(single, n);
    let m = get_data_method(a, (a.object_get_class)(clip));
    if arr.is_null() {
        return Err("could not allocate float[]");
    }
    if m.is_null() {
        return Err("no GetData(float[], int)");
    }
    let mut offset: i32 = 0;
    let mut args = [arr, &mut offset as *mut i32 as P];
    let mut exc: P = std::ptr::null_mut();
    let r = (a.runtime_invoke)(m, clip, args.as_mut_ptr(), &mut exc);
    if !exc.is_null() {
        return Err("GetData threw");
    }
    match unbox::<u8>(r) {
        Some(1) => Ok(std::slice::from_raw_parts(array_data(arr), n * 4).to_vec()),
        _ => Err(REFUSED),
    }
}

#[cfg(test)]
mod tests {
    use super::repoint_all;

    #[test]
    fn every_cached_copy_of_the_function_is_repointed() {
        let mut data = vec![0usize, 0xABCD, 7, 0xABCD, 0xABC];
        let n = unsafe { repoint_all(data.as_mut_ptr() as usize, data.len() * std::mem::size_of::<usize>(), 0xABCD, 0x1234) };
        assert_eq!(n, 2);
        assert_eq!(data, vec![0, 0x1234, 7, 0x1234, 0xABC]);
    }
}
