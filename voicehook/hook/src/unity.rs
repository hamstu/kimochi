//! Unity (Mono) adapter: every `AudioSource.Play*` / `PlayOneShot` / `Stop`, with the
//! `AudioClip`'s name and, where Unity can give it, its PCM (`AudioClip.GetData`).
//!
//! How: Unity registers its engine functions with Mono through `mono_add_internal_call`, which
//! UnityPlayer.dll looks up with `GetProcAddress` when it loads Mono. Our `GetProcAddress` hook
//! (see `iat`) hands it a wrapper, and the wrapper registers our trampolines in place of the
//! AudioSource play/stop internal calls. A trampoline runs on the game's thread, records the
//! call, and calls Unity's function. No code is patched on this path.
//!
//! Internal-call arguments differ by version:
//! - Unity 2019-2022: managed objects (`PlayHelper(AudioSource, UInt64)`), used directly.
//! - Unity 6: native pointers (`PlayHelper_Injected(IntPtr, UInt64)`); the managed object is
//!   found by matching `UnityEngine.Object.m_CachedPtr` over
//!   `Resources.FindObjectsOfTypeAll(typeof(AudioSource|AudioClip))` (cached).
//!
//! With the managed objects, the managed getters (`clip`, `name`, `samples`, `channels`,
//! `frequency`, `loadType`, `GetData`) are called through `mono_runtime_invoke`.
//!
//! Limits:
//! - Registration happens at startup. Attached later (the usual case in Kimochi), the adapter
//!   takes each function from Mono's table and repoints the compiled wrapper that calls it
//!   (`late_attach`): a pointer-sized write into JIT code, the one patch this adapter makes.
//! - `GetData` only works for clips imported as *Decompress On Load*. For *Compressed In Memory*
//!   and *Streaming* clips the event still carries the clip name, length and timing, but no audio.
//! - IL2CPP games have no Mono and are not covered here.
use crate::iat::{self, Hook};
use crate::sink::{self, Ev};
use crate::util::{guard, hex, lock, log};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use windows_sys::Win32::Foundation::HMODULE;

type P = *mut c_void;

struct Mono {
    runtime_invoke: unsafe extern "C" fn(P, P, *mut P, *mut P) -> P,
    class_get_method_from_name: unsafe extern "C" fn(P, *const c_char, i32) -> P,
    object_get_class: unsafe extern "C" fn(P) -> P,
    class_get_parent: unsafe extern "C" fn(P) -> P,
    class_from_name: unsafe extern "C" fn(P, *const c_char, *const c_char) -> P,
    class_get_type: unsafe extern "C" fn(P) -> P,
    type_get_object: unsafe extern "C" fn(P, P) -> P,
    class_get_field_from_name: unsafe extern "C" fn(P, *const c_char) -> P,
    field_get_value: unsafe extern "C" fn(P, P, P),
    image_loaded: unsafe extern "C" fn(*const c_char) -> P,
    array_new: unsafe extern "C" fn(P, P, usize) -> P,
    array_length: unsafe extern "C" fn(P) -> usize,
    get_single_class: unsafe extern "C" fn() -> P,
    domain_get: unsafe extern "C" fn() -> P,
    string_to_utf8: unsafe extern "C" fn(P) -> *mut c_char,
    free: unsafe extern "C" fn(P),
    array_addr_with_size: unsafe extern "C" fn(P, i32, usize) -> *mut u8,
    method_desc_new: unsafe extern "C" fn(*const c_char, i32) -> P,
    method_desc_search_in_class: unsafe extern "C" fn(P, P) -> P,
    method_desc_free: unsafe extern "C" fn(P),
}

unsafe impl Send for Mono {}
unsafe impl Sync for Mono {}

static API: OnceLock<Mono> = OnceLock::new();
static ADD_ICALL: AtomicUsize = AtomicUsize::new(0);
static WRAPPED: AtomicUsize = AtomicUsize::new(0);
static LATE_LOGGED: AtomicBool = AtomicBool::new(false);
/// (class ptr, method name, nargs) → MonoMethod*.
static METHODS: LazyLock<Mutex<HashMap<(usize, &'static str, i32), usize>>> = LazyLock::new(Default::default);
/// Native object pointer → managed object (Unity 6), per class name.
static MANAGED: LazyLock<Mutex<HashMap<usize, usize>>> = LazyLock::new(Default::default);
/// Last (clip, time) per source, to drop a second internal call made for the same Play.
static LAST: LazyLock<Mutex<HashMap<usize, (usize, f64)>>> = LazyLock::new(Default::default);

/// Clips longer than this are taken as music: name and timing only, no PCM copy.
const MAX_PCM_SECS: f64 = 30.0;

/// Registers the `mono_add_internal_call` hook. Call before the first `iat::rescan`.
pub fn register() {
    iat::register(Hook { dll: "mono", name: "mono_add_internal_call", hook: add_icall as *const () as usize, orig: &ADD_ICALL });
}

/// The first time a Mono runtime module is seen: resolve the API we call.
pub fn on_mono(m: HMODULE, name: &str) {
    if API.get().is_some() {
        return;
    }
    let Some(api) = (unsafe { resolve(m) }) else {
        log(&format!("unity: {name} lacks part of the Mono API; adapter off"));
        return;
    };
    let _ = API.set(api);
    log(&format!("unity: Mono API resolved from {name}"));
    let late = unsafe { resolve_late(m) };
    // Attached to a running game, the internal calls were registered without us: patch them where
    // they are now (see `late`). Launched, registration comes through `add_icall` first.
    std::thread::spawn(move || {
        let Some(late) = late else {
            log("unity: no late-attach API in this Mono; Unity voices need `voicehook launch`");
            return;
        };
        let started = std::time::Instant::now();
        // Often at first (the app may hold its text hooker back until the text watch is in), then
        // every few seconds.
        let mut wait = std::time::Duration::from_millis(500);
        let (mut audio, mut text, mut reader) = (false, false, false);
        while !(audio && text && reader) {
            std::thread::sleep(wait);
            if started.elapsed().as_secs() >= 20 {
                wait = std::time::Duration::from_secs(3);
            }
            let giving_up = started.elapsed().as_secs() >= 300;
            if !audio && WRAPPED.load(Ordering::SeqCst) > 0 {
                audio = true;
            }
            if !audio {
                match unsafe { attached(&late, || late_patch(API.get().unwrap(), &late)) } {
                    Ok(n) => {
                        log(&format!("unity: patched {n} AudioSource internal calls in place (late attach)"));
                        audio = true;
                    }
                    Err(e) if !giving_up => {
                        if !LATE_LOGGED.swap(true, Ordering::SeqCst) {
                            log(&format!("unity: late attach not possible yet ({e}); retrying"));
                        }
                    }
                    Err(e) => {
                        log(&format!("unity: late attach gave up: {e}"));
                        audio = true;
                    }
                }
            }
            // Only when the app asks (for a Unity game, or when its text hooker could not hook
            // this one), and from then on until each setter's assembly has loaded.
            if !text && text_wanted() {
                text = unsafe { attached(&late, || Ok::<_, String>(text_watch(API.get().unwrap(), &late))) }.unwrap_or(false) || giving_up;
            }
            if !reader {
                match unsafe { attached(&late, || reader_watch(API.get().unwrap())) } {
                    Ok(n) => {
                        log(&format!("unity: watching PCM reader clips ({n} mono_runtime_invoke slots)"));
                        reader = true;
                    }
                    Err(e) if giving_up => {
                        log(&format!("unity: PCM reader clips not watched: {e}"));
                        reader = true;
                    }
                    Err(_) => {}
                }
            }
        }
    });
}

// ------------------------------------------------------------------ clips the game fills itself

// A clip made with `AudioClip.Create(name, length, channels, frequency, stream: true, reader)` is
// filled by the game's own code as it plays: an engine that decodes its voices itself (NVorbis, its
// own archives) hands Unity no data to read with `GetData`, and its clips' length is a placeholder.
// Unity asks for each next block through `AudioClip.InvokePCMReaderCallback_Internal(float[])`, a
// managed method it calls with `mono_runtime_invoke` through a pointer it keeps (resolved with
// `GetProcAddress` when it loaded Mono). That pointer, wherever it is in UnityPlayer's data, is
// pointed at ours: after the call, the block the game wrote is the clip's next PCM.

/// `AudioClip.InvokePCMReaderCallback_Internal`.
static PCM_METHOD: AtomicUsize = AtomicUsize::new(0);
static O_INVOKE: AtomicUsize = AtomicUsize::new(0);
/// Clips whose blocks we have seen since they were last played (announced as streams).
static READER_CLIPS: LazyLock<Mutex<std::collections::HashSet<usize>>> = LazyLock::new(Default::default);
/// The clip each AudioSource last played, to end a filled clip's stream when its source stops.
static SOURCE_CLIP: LazyLock<Mutex<HashMap<usize, usize>>> = LazyLock::new(Default::default);

fn reader_key(clip: usize) -> sink::Key {
    (11, clip)
}

unsafe fn reader_watch(a: &Mono) -> Result<usize, String> {
    let clip_class = class(a, c"UnityEngine.AudioModule", c"AudioClip");
    if clip_class.is_null() {
        return Err("no AudioClip class yet".into());
    }
    let m = method(a, clip_class, "InvokePCMReaderCallback_Internal", 1);
    if m.is_null() {
        return Err("no AudioClip.InvokePCMReaderCallback_Internal".into());
    }
    let player = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(crate::util::wide("UnityPlayer.dll").as_ptr());
    // Before Unity 2017 the player is the game's exe.
    let player = if player.is_null() { windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null()) } else { player };
    let real = a.runtime_invoke as usize;
    O_INVOKE.store(real, Ordering::SeqCst);
    PCM_METHOD.store(m as usize, Ordering::SeqCst);
    let mut n = 0;
    for (start, len) in crate::il2cpp::writable_sections(player as usize) {
        n += crate::il2cpp::repoint_all(start, len, real, t_runtime_invoke as *const () as usize);
    }
    if n == 0 {
        return Err("mono_runtime_invoke not found in the player's data".into());
    }
    sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "unity-reader", "slots": n})));
    Ok(n)
}

/// Unity's every call into managed code goes through here: one compare on the way out.
unsafe extern "C" fn t_runtime_invoke(method: P, obj: P, params: *mut P, exc: *mut P) -> P {
    let o: unsafe extern "C" fn(P, P, *mut P, *mut P) -> P = std::mem::transmute(O_INVOKE.load(Ordering::SeqCst));
    let r = o(method, obj, params, exc);
    if method as usize == PCM_METHOD.load(Ordering::Relaxed) && !obj.is_null() && !params.is_null() {
        let data = *params;
        guard(|| unsafe { reader_block(obj, data) });
    }
    r
}

unsafe fn reader_block(clip: P, data: P) {
    let Some(a) = API.get() else { return };
    if data.is_null() {
        return;
    }
    let n = (a.array_length)(data);
    if n == 0 {
        return;
    }
    let bytes = std::slice::from_raw_parts((a.array_addr_with_size)(data, 4, 0), n * 4).to_vec();
    let key = reader_key(clip as usize);
    if lock(&READER_CLIPS).insert(clip as usize) {
        let get_i32 = |name: &'static str| -> i32 { unsafe { invoke(a, clip, std::ptr::null_mut(), name, &mut []).and_then(|b| unbox(b)).unwrap_or(0) } };
        let (channels, freq) = (get_i32("get_channels"), get_i32("get_frequency"));
        let name = invoke(a, clip, std::ptr::null_mut(), "get_name", &mut []).and_then(|s| string(a, s));
        // Grouped by the shape of the clip's name, as CRI cues are (`sln_co_0001`, `lea_co_0002`
        // apart from `se_21_140`): no folder, and every clip its own stream.
        let channel = name.as_deref().map(|n| format!("clip:{}", crate::cri::shape(n)));
        sink::send(Ev::Create {
            key,
            api: "unity",
            fmt: float_fmt(channels.max(1) as u16, freq.max(1) as u32),
            info: json!({"reader": true, "clip_ptr": hex(clip as usize), "channel": channel}),
        });
        sink::send(Ev::Source { key, source: name.clone() });
        sink::send(Ev::Play { key, looping: false, info: json!({"clip": name}) });
    }
    sink::send(Ev::Data { key, bytes, eos: false, looping: false, region: None, info: serde_json::Value::Null });
}

/// An AudioSource played `clip` (or stopped, `clip` None): a filled clip it was playing before
/// ends. The clip it starts keeps the blocks Unity read for it just before (at Play, ahead of it).
fn reader_source(src: usize, clip: Option<usize>) {
    let before = match clip {
        Some(c) => lock(&SOURCE_CLIP).insert(src, c),
        None => lock(&SOURCE_CLIP).remove(&src),
    };
    if let Some(c) = before.filter(|&b| Some(b) != clip) {
        if lock(&READER_CLIPS).remove(&c) {
            sink::send(Ev::Stop { key: reader_key(c) });
        }
    }
}

/// Runs `f` on this thread attached to Mono's root domain, detaching after.
unsafe fn attached<T>(l: &Late, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let root = (l.get_root_domain)();
    if root.is_null() {
        return Err("Mono not initialised".into());
    }
    let thread = (l.thread_attach)(root);
    let r = f();
    if !thread.is_null() {
        (l.thread_detach)(thread);
    }
    r
}

// ------------------------------------------------------------------ dialogue text

/// A text setter watched for dialogue: its class (in any of these assemblies) and how its events
/// name it.
struct Setter {
    images: fn() -> Vec<String>,
    namespace: &'static CStr,
    class: &'static CStr,
    label: &'static str,
}

/// TextMeshPro's assembly: `Unity.TextMeshPro` since the package, `TextMeshPro-<version>` before.
fn tmp_images() -> Vec<String> {
    let mut names = vec!["Unity.TextMeshPro".to_string()];
    let exe = crate::util::module_path(std::ptr::null_mut());
    if let (Some(dir), Some(stem)) = (exe.parent(), exe.file_stem()) {
        let managed = dir.join(format!("{}_Data", stem.to_string_lossy())).join("Managed");
        for e in std::fs::read_dir(managed).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.strip_suffix(".dll").filter(|s| s.starts_with("TextMeshPro")) {
                names.push(stem.to_string());
            }
        }
    }
    names
}

fn ui_images() -> Vec<String> {
    vec!["UnityEngine.UI".to_string()]
}

/// TextMeshPro's text boxes, then Unity's older UI text.
const SETTERS: &[Setter] = &[
    Setter { images: tmp_images, namespace: c"TMPro", class: c"TMP_Text", label: "TMP_Text.set_text" },
    Setter { images: ui_images, namespace: c"UnityEngine.UI", class: c"Text", label: "UI.Text.set_text" },
];

/// Per setter: 0 not yet found (its assembly not loaded), 1 watched, 2 left alone.
static SETTER_STATE: [AtomicUsize; 2] = [AtomicUsize::new(0), AtomicUsize::new(0)];

/// A breakpoint in: the setter's entry, the bytes after its first instruction as they were (to
/// know a copy of it), and which setter.
struct Watch {
    entry: usize,
    after: [u8; COPY_MATCH],
    label: &'static str,
}

static WATCHES: Mutex<Vec<Watch>> = Mutex::new(Vec::new());
static HANDLER: AtomicBool = AtomicBool::new(false);
/// The last text per object, to drop repeats (UI code sets the same text every frame).
static TEXT_LAST: LazyLock<Mutex<HashMap<usize, Vec<u16>>>> = LazyLock::new(Default::default);
/// Longest text sent as one event, in UTF-16 units.
const TEXT_MAX: usize = 4096;
/// How many of the setter's bytes after its first instruction are kept, to know a copy of them.
const COPY_MATCH: usize = 16;

/// Watches the text setters dialogue boxes go through (`SETTERS`), so the text of a Unity game
/// reaches Kimochi even where a text hooker cannot patch the game's JIT code (its patches need free
/// memory close to that code, which a grown Mono heap can leave none of). Each setter's first
/// instruction, `push rbp`/`push ebp` in Mono's prologue, becomes a breakpoint; our exception
/// handler reads the text, performs the push and resumes. No memory near the code is needed and
/// nothing is relocated. Anything else at an entry (another hooker's jump, a different prologue)
/// is left alone. True once every setter is watched or left alone; retried until then (an
/// assembly loads with the first scene that uses it).
unsafe fn text_watch(a: &Mono, l: &Late) -> bool {
    for (i, setter) in SETTERS.iter().enumerate() {
        if SETTER_STATE[i].load(Ordering::SeqCst) != 0 {
            continue;
        }
        match watch_setter(a, l, setter) {
            Ok(None) => {}
            Ok(Some(at)) => {
                SETTER_STATE[i].store(1, Ordering::SeqCst);
                log(&format!("unity: watching {} (breakpoint at {})", setter.label, hex(at)));
                sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "unity-text", "method": setter.label, "at": hex(at)})));
            }
            Err(e) => {
                SETTER_STATE[i].store(2, Ordering::SeqCst);
                log(&format!("unity: not watching {}: {e}", setter.label));
            }
        }
    }
    let done = SETTER_STATE.iter().all(|s| s.load(Ordering::SeqCst) != 0);
    if done && !SETTER_STATE.iter().any(|s| s.load(Ordering::SeqCst) == 1) {
        log("unity: no text watch: no setter could be watched");
    }
    done
}

/// The setter's entry once watched; `None` while its assembly is not loaded.
unsafe fn watch_setter(a: &Mono, l: &Late, setter: &Setter) -> Result<Option<usize>, String> {
    let Some(img) = (setter.images)().into_iter().find_map(|name| {
        let name = CString::new(name).ok()?;
        let img = (a.image_loaded)(name.as_ptr());
        (!img.is_null()).then_some(img)
    }) else {
        return Ok(None);
    };
    let class = (a.class_from_name)(img, setter.namespace.as_ptr(), setter.class.as_ptr());
    if class.is_null() {
        return Err("no such class".into());
    }
    let m = (a.class_get_method_from_name)(class, c"set_text".as_ptr(), 1);
    if m.is_null() {
        return Err("no set_text(string)".into());
    }
    let code = (l.compile_method)(m) as usize;
    if code == 0 || readable(code, COPY_MATCH + 1) < COPY_MATCH + 1 {
        return Err("not compiled".into());
    }
    let first = *(code as *const u8);
    if first != 0x55 {
        return Err(format!("starts with {first:02x}, not push rbp (hooked by another tool?)"));
    }
    use windows_sys::Win32::System::Diagnostics::Debug::{AddVectoredExceptionHandler, FlushInstructionCache};
    use windows_sys::Win32::System::Memory::{VirtualProtect, PAGE_EXECUTE_READWRITE};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    if !HANDLER.load(Ordering::SeqCst) {
        if AddVectoredExceptionHandler(1, Some(on_break)).is_null() {
            return Err("no exception handler".into());
        }
        HANDLER.store(true, Ordering::SeqCst);
    }
    let mut after = [0u8; COPY_MATCH];
    after.copy_from_slice(std::slice::from_raw_parts((code + 1) as *const u8, COPY_MATCH));
    // Known to the handler before the breakpoint can be hit.
    lock(&WATCHES).push(Watch { entry: code, after, label: setter.label });
    let mut old = 0u32;
    if VirtualProtect(code as *const c_void, 1, PAGE_EXECUTE_READWRITE, &mut old) == 0 {
        lock(&WATCHES).retain(|w| w.entry != code);
        return Err("VirtualProtect failed".into());
    }
    *(code as *mut u8) = 0xCC;
    VirtualProtect(code as *const c_void, 1, old, &mut old);
    FlushInstructionCache(GetCurrentProcess(), code as *const c_void, 1);
    Ok(Some(code))
}

/// The setter a breakpoint at `at` belongs to: ours at its entry, or a copy of ours that a hooker
/// patching the setter after us made in its trampoline.
unsafe fn watched_at(at: usize) -> Option<&'static str> {
    let watches = lock(&WATCHES);
    if let Some(w) = watches.iter().find(|w| w.entry == at) {
        return Some(w.label);
    }
    let len = readable(at, 1 + COPY_MATCH + 14);
    if len < 1 + 1 + 5 || *(at as *const u8) != 0xCC {
        return None;
    }
    let code = std::slice::from_raw_parts((at + 1) as *const u8, len - 1);
    watches.iter().find(|w| copy_of(code, at + 1, &w.after, w.entry).is_some()).map(|w| w.label)
}

/// A trampoline holding a copy of our breakpoint: the first `k` of the setter's bytes after it
/// (`after`, from `entry + 1`), then a jump back to `entry + 1 + k`, the first byte the hooker
/// did not overwrite. `code` is what follows the breakpoint, at address `base`. MinHook (LunaHook)
/// jumps back with `E9 rel32` on x86 and `FF 25 00000000 <address>` on x64. It copies only the
/// instructions its jump overwrites, a few bytes in an x86 prologue: a fixed-length match missed
/// it live (an x86 Unity game), and the breakpoint it copied crashed the game.
fn copy_of(code: &[u8], base: usize, after: &[u8], entry: usize) -> Option<usize> {
    (1..=after.len().min(code.len())).find(|&k| {
        code[..k] == after[..k] && jump_target(&code[k..], base + k) == Some(entry + 1 + k)
    })
}

/// Where the jump at the start of `code` (at address `at`) goes.
fn jump_target(code: &[u8], at: usize) -> Option<usize> {
    match code {
        [0xE9, a, b, c, d, ..] => Some((at + 5).wrapping_add(i32::from_le_bytes([*a, *b, *c, *d]) as isize as usize)),
        [0xFF, 0x25, 0, 0, 0, 0, rest @ ..] if rest.len() >= 8 && usize::BITS == 64 => {
            Some(u64::from_le_bytes(rest[..8].try_into().ok()?) as usize)
        }
        _ => None,
    }
}

unsafe extern "system" fn on_break(info: *mut windows_sys::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS) -> i32 {
    const CONTINUE_SEARCH: i32 = 0;
    const CONTINUE_EXECUTION: i32 = -1;
    const BREAKPOINT: i32 = 0x8000_0003_u32 as i32;
    let rec = &*(*info).ExceptionRecord;
    if rec.ExceptionCode != BREAKPOINT {
        return CONTINUE_SEARCH;
    }
    let at = rec.ExceptionAddress as usize;
    let Some(label) = watched_at(at) else {
        return CONTINUE_SEARCH;
    };
    let ctx = &mut *(*info).ContextRecord;
    #[cfg(target_arch = "x86_64")]
    {
        // Managed calls on x64 Windows: this in rcx, the string in rdx.
        let (this, value) = (ctx.Rcx as usize, ctx.Rdx as usize);
        guard(|| unsafe { text_seen(label, this, value) });
        ctx.Rsp -= 8;
        *(ctx.Rsp as *mut u64) = ctx.Rbp;
        ctx.Rip = at as u64 + 1;
    }
    #[cfg(target_arch = "x86")]
    {
        // Mono's x86 managed convention passes everything on the stack.
        let sp = ctx.Esp as usize;
        let (this, value) = (*((sp + 4) as *const usize), *((sp + 8) as *const usize));
        guard(|| unsafe { text_seen(label, this, value) });
        ctx.Esp -= 4;
        *(ctx.Esp as *mut u32) = ctx.Ebp;
        ctx.Eip = at as u32 + 1;
    }
    CONTINUE_EXECUTION
}

/// Whether the app asked for the game's text: it creates the event `Local\voicehook_text_<pid>`
/// for Unity games, and when its own text hooker could not hook one.
pub(crate) fn text_wanted() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenEventW};
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let name = crate::util::wide(&format!("Local\\voicehook_text_{}", unsafe { GetCurrentProcessId() }));
    unsafe {
        let event = OpenEventW(SYNCHRONIZE, 0, name.as_ptr());
        if event.is_null() {
            return false;
        }
        CloseHandle(event);
    }
    true
}

/// A `MonoString`: object header (vtable, sync), `int32` length, then UTF-16.
unsafe fn text_seen(label: &'static str, this: usize, s: usize) {
    if this == 0 || s == 0 {
        return;
    }
    let w = std::mem::size_of::<usize>();
    let len = std::ptr::read_unaligned((s + 2 * w) as *const i32);
    if len <= 0 || len as usize > TEXT_MAX {
        return;
    }
    let chars = std::slice::from_raw_parts((s + 2 * w + 4) as *const u16, len as usize).to_vec();
    {
        let mut last = lock(&TEXT_LAST);
        if last.get(&this) == Some(&chars) {
            return;
        }
        if last.len() > 512 {
            last.clear();
        }
        last.insert(this, chars.clone());
    }
    let text = String::from_utf16_lossy(&chars);
    sink::send(Ev::Note(json!({"ev": "text", "api": "unity", "method": label, "obj": hex(this), "text": text})));
}

// ------------------------------------------------------------------ late attach

/// The Mono API the late path needs on top of [`Mono`].
struct Late {
    get_root_domain: unsafe extern "C" fn() -> P,
    thread_attach: unsafe extern "C" fn(P) -> P,
    thread_detach: unsafe extern "C" fn(P),
    class_get_methods: unsafe extern "C" fn(P, *mut P) -> P,
    method_get_name: unsafe extern "C" fn(P) -> *const c_char,
    method_get_flags: unsafe extern "C" fn(P, *mut u32) -> u32,
    lookup_internal_call: unsafe extern "C" fn(P) -> P,
    compile_method: unsafe extern "C" fn(P) -> P,
    add_internal_call: unsafe extern "C" fn(*const c_char, *const c_void),
}

unsafe impl Send for Late {}

unsafe fn resolve_late(m: HMODULE) -> Option<Late> {
    macro_rules! s {
        ($n:literal) => {
            std::mem::transmute::<usize, _>(match iat::real_gpa(m, $n) {
                0 => return None,
                f => f,
            })
        };
    }
    Some(Late {
        get_root_domain: s!(c"mono_get_root_domain"),
        thread_attach: s!(c"mono_thread_attach"),
        thread_detach: s!(c"mono_thread_detach"),
        class_get_methods: s!(c"mono_class_get_methods"),
        method_get_name: s!(c"mono_method_get_name"),
        method_get_flags: s!(c"mono_method_get_flags"),
        lookup_internal_call: s!(c"mono_lookup_internal_call"),
        compile_method: s!(c"mono_compile_method"),
        add_internal_call: s!(c"mono_add_internal_call"),
    })
}

/// `METHOD_IMPL_ATTRIBUTE_INTERNAL_CALL`.
const IMPL_INTERNAL_CALL: u32 = 0x1000;

/// The internal call (by base name) → our trampoline and the slot keeping Unity's function.
fn watched(base: &[u8]) -> Option<(&'static AtomicUsize, usize)> {
    Some(match base {
        b"PlayHelper" => (&O_PLAY_HELPER, t_play_helper as *const () as usize),
        b"Play" => (&O_PLAY, t_play as *const () as usize),
        b"PlayOneShotHelper" => (&O_ONE_SHOT, t_one_shot as *const () as usize),
        b"Stop" => (&O_STOP, t_stop as *const () as usize),
        b"Pause" => (&O_PAUSE, t_pause as *const () as usize),
        b"get_isPlaying" => (&O_IS_PLAYING, t_is_playing as *const () as usize),
        _ => return None,
    })
}

/// Attached after Unity registered its internal calls: for each watched `AudioSource` internal
/// call, take Unity's function from Mono's table, register our trampoline under the same name
/// (for wrappers not compiled yet), and repoint the already compiled wrapper, which holds the
/// function's address as an immediate (x64 `mov r11, imm64`; x86 `call rel32` or `mov r, imm32`).
/// Managed callers all go through that one wrapper. Returns how many calls were repointed. Runs
/// attached to Mono (`attached`).
unsafe fn late_patch(a: &Mono, l: &Late) -> Result<usize, String> {
    let source = class(a, c"UnityEngine.AudioModule", c"AudioSource");
    if source.is_null() {
        return Err("UnityEngine.AudioSource not loaded".into());
    }
    let mut found = Vec::new();
    let mut iter: P = std::ptr::null_mut();
    loop {
        let m = (l.class_get_methods)(source, &mut iter);
        if m.is_null() {
            break;
        }
        let mut iflags = 0u32;
        (l.method_get_flags)(m, &mut iflags);
        if iflags & IMPL_INTERNAL_CALL == 0 {
            continue;
        }
        let name = CStr::from_ptr((l.method_get_name)(m)).to_bytes().to_vec();
        let (base, injected) = match name.strip_suffix(b"_Injected") {
            Some(b) => (b.to_vec(), true),
            None => (name.clone(), false),
        };
        if let Some((slot, tramp)) = watched(&base) {
            found.push((m, name, injected, slot, tramp));
        }
    }
    if found.is_empty() {
        return Err("no AudioSource internal calls found".into());
    }
    let mut patched = 0;
    for (m, name, injected, slot, tramp) in found {
        let shown = format!("UnityEngine.AudioSource::{}", String::from_utf8_lossy(&name));
        let func = (l.lookup_internal_call)(m) as usize;
        if func == 0 || func == tramp {
            log(&format!("unity: {shown}: no registered function"));
            continue;
        }
        if slot.compare_exchange(0, func, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            continue;
        }
        INJECTED.store(injected, Ordering::Relaxed);
        let cname = CString::new(shown.clone()).unwrap();
        (l.add_internal_call)(cname.as_ptr(), tramp as *const c_void);
        let code = (l.compile_method)(m) as usize;
        let how = if code == 0 { Err("not compiled".to_string()) } else { repoint(code, func, tramp) };
        match how {
            Ok(at) => {
                patched += 1;
                WRAPPED.fetch_add(1, Ordering::SeqCst);
                log(&format!("unity: late-wrapped {shown} (wrapper {} +{at})", hex(code)));
                sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "unity-mono", "icall": shown, "late": true})));
            }
            Err(e) => {
                // The wrapper may still be compiled fresh from the table, now holding `tramp`.
                let fresh = code != 0 && find_target(code, tramp).is_some();
                if fresh {
                    patched += 1;
                    WRAPPED.fetch_add(1, Ordering::SeqCst);
                    log(&format!("unity: late-wrapped {shown} (fresh wrapper)"));
                } else {
                    log(&format!("unity: {shown}: wrapper not repointed ({e}); first bytes {}", dump(code)));
                }
            }
        }
    }
    if patched == 0 {
        return Err("no wrapper could be repointed".into());
    }
    Ok(patched)
}

/// How far into a wrapper to look for the call to the internal function.
const SCAN: usize = 1024;

/// Where `code` calls or loads `target`: (offset, absolute immediate?).
unsafe fn find_target(code: usize, target: usize) -> Option<(usize, bool)> {
    let len = readable(code, SCAN);
    let bytes = std::slice::from_raw_parts(code as *const u8, len);
    let w = std::mem::size_of::<usize>();
    for i in 0..len.saturating_sub(w) {
        if std::ptr::read_unaligned(bytes.as_ptr().add(i) as *const usize) == target {
            return Some((i, true));
        }
    }
    if w == 4 {
        for i in 0..len.saturating_sub(5) {
            if bytes[i] == 0xE8 {
                let rel = std::ptr::read_unaligned(bytes.as_ptr().add(i + 1) as *const i32);
                if (code + i + 5).wrapping_add(rel as isize as usize) == target {
                    return Some((i + 1, false));
                }
            }
        }
    }
    None
}

/// Repoints the wrapper at `code` from `from` to `to`; the offset patched.
unsafe fn repoint(code: usize, from: usize, to: usize) -> Result<usize, String> {
    use windows_sys::Win32::System::Diagnostics::Debug::FlushInstructionCache;
    use windows_sys::Win32::System::Memory::{VirtualProtect, PAGE_EXECUTE_READWRITE};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let (at, absolute) = find_target(code, from).ok_or("call not found")?;
    let p = code + at;
    let value = if absolute { to } else { to.wrapping_sub(p + 4) };
    let w = if absolute { std::mem::size_of::<usize>() } else { 4 };
    let mut old = 0u32;
    if VirtualProtect(p as *const c_void, w, PAGE_EXECUTE_READWRITE, &mut old) == 0 {
        return Err("VirtualProtect failed".into());
    }
    if absolute {
        std::ptr::write_unaligned(p as *mut usize, value);
    } else {
        std::ptr::write_unaligned(p as *mut u32, value as u32);
    }
    VirtualProtect(p as *const c_void, w, old, &mut old);
    FlushInstructionCache(GetCurrentProcess(), p as *const c_void, w);
    Ok(at)
}

/// How many of the `want` bytes at `p` are committed, readable memory.
unsafe fn readable(p: usize, want: usize) -> usize {
    use windows_sys::Win32::System::Memory::{VirtualQuery, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS};
    let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
    if VirtualQuery(p as *const c_void, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) == 0
        || info.State != MEM_COMMIT
        || info.Protect & (PAGE_GUARD | PAGE_NOACCESS) != 0
    {
        return 0;
    }
    want.min(info.BaseAddress as usize + info.RegionSize - p)
}

unsafe fn dump(code: usize) -> String {
    if code == 0 {
        return "-".into();
    }
    std::slice::from_raw_parts(code as *const u8, readable(code, 96)).iter().map(|b| format!("{b:02x}")).collect()
}

/// `mono_array_length` where Mono does not export it (the legacy `mono.dll` of Unity 5 to 2018's
/// old runtime): a `MonoArray` keeps its length after the object header (vtable, sync) and
/// `bounds`, in every Mono Unity ships.
unsafe extern "C" fn array_length_field(array: P) -> usize {
    *(array as *const usize).add(3)
}

unsafe fn resolve(m: HMODULE) -> Option<Mono> {
    macro_rules! s {
        ($n:literal) => {
            std::mem::transmute::<usize, _>(match iat::real_gpa(m, $n) {
                0 => return None,
                f => f,
            })
        };
        // The first of these that Mono exports, else `$fallback`.
        ($n:literal, $alt:literal, $fallback:expr) => {
            match (iat::real_gpa(m, $n), iat::real_gpa(m, $alt)) {
                (0, 0) => $fallback,
                (0, f) | (f, _) => std::mem::transmute::<usize, _>(f),
            }
        };
    }
    Some(Mono {
        runtime_invoke: s!(c"mono_runtime_invoke"),
        class_get_method_from_name: s!(c"mono_class_get_method_from_name"),
        object_get_class: s!(c"mono_object_get_class"),
        class_get_parent: s!(c"mono_class_get_parent"),
        class_from_name: s!(c"mono_class_from_name"),
        class_get_type: s!(c"mono_class_get_type"),
        type_get_object: s!(c"mono_type_get_object"),
        class_get_field_from_name: s!(c"mono_class_get_field_from_name"),
        field_get_value: s!(c"mono_field_get_value"),
        image_loaded: s!(c"mono_image_loaded"),
        array_new: s!(c"mono_array_new"),
        array_length: s!(c"mono_array_length", c"mono_array_length", array_length_field as unsafe extern "C" fn(P) -> usize),
        get_single_class: s!(c"mono_get_single_class"),
        domain_get: s!(c"mono_domain_get"),
        string_to_utf8: s!(c"mono_string_to_utf8"),
        // The legacy runtime frees what it allocates with glib's `g_free`.
        free: s!(c"mono_free", c"g_free", return None),
        array_addr_with_size: s!(c"mono_array_addr_with_size"),
        method_desc_new: s!(c"mono_method_desc_new"),
        method_desc_search_in_class: s!(c"mono_method_desc_search_in_class"),
        method_desc_free: s!(c"mono_method_desc_free"),
    })
}

// ------------------------------------------------------------------ internal-call trampolines

macro_rules! tramp {
    ($orig:ident, $f:ident, ($($a:ident: $t:ty),*), $what:literal, $src:ident, $clip:expr) => {
        static $orig: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "C" fn $f($($a: $t),*) {
            let injected = INJECTED.load(Ordering::Relaxed);
            guard(|| unsafe { seen($what, $src as P, $clip, injected) });
            let o: unsafe extern "C" fn($($t),*) = std::mem::transmute($orig.load(Ordering::SeqCst));
            o($($a),*)
        }
    };
}

/// Unity 6 (`_Injected` names): the arguments are native pointers.
static INJECTED: AtomicBool = AtomicBool::new(false);

tramp!(O_PLAY_HELPER, t_play_helper, (src: P, delay: u64), "PlayHelper", src, std::ptr::null_mut());
tramp!(O_PLAY, t_play, (src: P, delay: f64), "Play", src, std::ptr::null_mut());
tramp!(O_ONE_SHOT, t_one_shot, (src: P, clip: P, volume: f32), "PlayOneShot", src, clip);
tramp!(O_STOP, t_stop, (src: P, one_shots: u8), "Stop", src, std::ptr::null_mut());
tramp!(O_PAUSE, t_pause, (src: P), "Pause", src, std::ptr::null_mut());

/// `isPlaying`, polled every frame by many engines: a chance to retry clips not loaded at Play.
static O_IS_PLAYING: AtomicUsize = AtomicUsize::new(0);
unsafe extern "C" fn t_is_playing(src: P) -> u8 {
    guard(|| unsafe { seen("tick", src, std::ptr::null_mut(), false) });
    let o: unsafe extern "C" fn(P) -> u8 = std::mem::transmute(O_IS_PLAYING.load(Ordering::SeqCst));
    o(src)
}

/// Our `mono_add_internal_call`: swaps in trampolines for the AudioSource calls we watch.
unsafe extern "C" fn add_icall(name: *const c_char, method: *const c_void) {
    let real: unsafe extern "C" fn(*const c_char, *const c_void) = std::mem::transmute(ADD_ICALL.load(Ordering::SeqCst));
    let mut use_fn = method;
    guard(|| unsafe {
        let n = CStr::from_ptr(name).to_bytes();
        let Some(rest) = n.strip_prefix(b"UnityEngine.AudioSource::") else { return };
        let base = rest.split(|&c| c == b'(').next().unwrap_or(rest);
        let (base, injected) = match base.strip_suffix(b"_Injected") {
            Some(b) => (b, true),
            None => (base, false),
        };
        let Some((slot, tramp)) = watched(base) else { return };
        if slot.compare_exchange(0, method as usize, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            INJECTED.store(injected, Ordering::Relaxed);
            use_fn = tramp as *const c_void;
            WRAPPED.fetch_add(1, Ordering::SeqCst);
            let shown = String::from_utf8_lossy(n).into_owned();
            log(&format!("unity: wrapped internal call {shown}"));
            sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "unity-mono", "icall": shown})));
        }
    });
    real(name, use_fn)
}

// ------------------------------------------------------------------ managed helpers

unsafe fn method(a: &Mono, class: P, name: &'static str, nargs: i32) -> P {
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

/// `AudioClip.GetData(float[], int)` exactly: Unity 6 also has a `Span<float>` overload.
unsafe fn get_data_method(a: &Mono, clip_class: P) -> P {
    if let Some(&m) = lock(&METHODS).get(&(clip_class as usize, "GetData(single[],int)", 2)) {
        return m as P;
    }
    let mut found: P = std::ptr::null_mut();
    let mut c = clip_class;
    while !c.is_null() && found.is_null() {
        let desc = (a.method_desc_new)(c":GetData(single[],int)".as_ptr(), 0);
        if !desc.is_null() {
            found = (a.method_desc_search_in_class)(desc, c);
            (a.method_desc_free)(desc);
        }
        c = (a.class_get_parent)(c);
    }
    lock(&METHODS).insert((clip_class as usize, "GetData(single[],int)", 2), found as usize);
    found
}

/// Invokes `name` on `obj` (or a static on `class` when `obj` is null). None on failure.
unsafe fn invoke(a: &Mono, obj: P, class: P, name: &'static str, args: &mut [P]) -> Option<P> {
    let class = if obj.is_null() { class } else { (a.object_get_class)(obj) };
    let m = method(a, class, name, args.len() as i32);
    if m.is_null() {
        return None;
    }
    let mut exc: P = std::ptr::null_mut();
    let r = (a.runtime_invoke)(m, obj, if args.is_empty() { std::ptr::null_mut() } else { args.as_mut_ptr() }, &mut exc);
    exc.is_null().then_some(r)
}

/// The value inside a boxed value type (after the MonoObject header: vtable, sync).
unsafe fn unbox<T: Copy>(boxed: P) -> Option<T> {
    (!boxed.is_null()).then(|| std::ptr::read_unaligned((boxed as *const u8).add(2 * std::mem::size_of::<usize>()) as *const T))
}

unsafe fn string(a: &Mono, s: P) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let p = (a.string_to_utf8)(s);
    if p.is_null() {
        return None;
    }
    let out = CStr::from_ptr(p).to_string_lossy().into_owned();
    (a.free)(p as P);
    Some(out)
}

unsafe fn class(a: &Mono, image: &CStr, name: &CStr) -> P {
    let mut img = (a.image_loaded)(image.as_ptr());
    if img.is_null() {
        img = (a.image_loaded)(c"UnityEngine".as_ptr());
    }
    if img.is_null() {
        return std::ptr::null_mut();
    }
    (a.class_from_name)(img, c"UnityEngine".as_ptr(), name.as_ptr())
}

unsafe fn cached_ptr(a: &Mono, obj: P) -> usize {
    let object = class(a, c"UnityEngine.CoreModule", c"Object");
    if object.is_null() {
        return 0;
    }
    let field = (a.class_get_field_from_name)(object, c"m_CachedPtr".as_ptr());
    if field.is_null() {
        return 0;
    }
    let mut v: usize = 0;
    (a.field_get_value)(obj, field, &mut v as *mut usize as P);
    v
}

/// The managed object of a native Unity object pointer (Unity 6 internal calls).
unsafe fn managed(a: &Mono, native: P, image: &CStr, name: &CStr) -> P {
    if native.is_null() {
        return native;
    }
    if let Some(&m) = lock(&MANAGED).get(&(native as usize)) {
        if cached_ptr(a, m as P) == native as usize {
            return m as P;
        }
    }
    let klass = class(a, image, name);
    let resources = class(a, c"UnityEngine.CoreModule", c"Resources");
    if klass.is_null() || resources.is_null() {
        return std::ptr::null_mut();
    }
    let ty = (a.type_get_object)((a.domain_get)(), (a.class_get_type)(klass));
    let Some(arr) = invoke(a, std::ptr::null_mut(), resources, "FindObjectsOfTypeAll", &mut [ty]) else {
        return std::ptr::null_mut();
    };
    if arr.is_null() {
        return arr;
    }
    let mut map = lock(&MANAGED);
    let mut hit = std::ptr::null_mut();
    for i in 0..(a.array_length)(arr) {
        let obj = *((a.array_addr_with_size)(arr, std::mem::size_of::<usize>() as i32, i) as *const P);
        if obj.is_null() {
            continue;
        }
        let p = cached_ptr(a, obj);
        map.insert(p, obj as usize);
        if p == native as usize {
            hit = obj;
        }
    }
    hit
}

// ------------------------------------------------------------------ the event

/// The name of the GameObject an AudioSource is on, per source (cached). Games that make a source
/// per sound often name it for the asset (`Sound/Voice/ch01_003.ogg`,
/// `Sound/SE/door.ogg`): taken as the clip's source, its folder tells the voice apart from the
/// first line on and keeps effects of the same format out of its group.
static SOURCE_NAMES: LazyLock<Mutex<HashMap<usize, Option<String>>>> = LazyLock::new(Default::default);

unsafe fn source_name(a: &Mono, key: usize, src_obj: P) -> Option<String> {
    if let Some(n) = lock(&SOURCE_NAMES).get(&key) {
        return n.clone();
    }
    if src_obj.is_null() {
        return None;
    }
    let name = invoke(a, src_obj, std::ptr::null_mut(), "get_gameObject", &mut [])
        .filter(|go| !go.is_null())
        .and_then(|go| invoke(a, go, std::ptr::null_mut(), "get_name", &mut []))
        .and_then(|s| string(a, s))
        .filter(|s| !s.is_empty());
    let mut names = lock(&SOURCE_NAMES);
    if names.len() > 4096 {
        names.clear();
    }
    names.insert(key, name.clone());
    name
}

unsafe fn seen(what: &'static str, src: P, clip: P, injected: bool) {
    let Some(a) = API.get() else { return };
    retry_pending(a);
    if src.is_null() || what == "tick" {
        return;
    }
    let key = (5u8, src as usize);
    if what == "Stop" || what == "Pause" {
        sink::send(Ev::Mark { key, what: "unity_stop", info: json!({"method": what}) });
        reader_source(src as usize, None);
        return;
    }
    let (src_obj, clip_obj) = if injected {
        (managed(a, src, c"UnityEngine.AudioModule", c"AudioSource"), managed(a, clip, c"UnityEngine.AudioModule", c"AudioClip"))
    } else {
        (src, clip)
    };
    let clip_obj = if !clip_obj.is_null() || src_obj.is_null() {
        clip_obj
    } else {
        invoke(a, src_obj, std::ptr::null_mut(), "get_clip", &mut []).unwrap_or(std::ptr::null_mut())
    };
    if clip_obj.is_null() {
        sink::send(Ev::Mark { key, what: "unity_play_unknown", info: json!({"method": what, "src_found": !src_obj.is_null()}) });
        return;
    }
    reader_source(src as usize, Some(clip_obj as usize));
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
    let get_i32 = |name: &'static str| -> i32 { unsafe { invoke(a, clip_obj, std::ptr::null_mut(), name, &mut []).and_then(|b| unbox(b)).unwrap_or(0) } };
    let clip_name = invoke(a, clip_obj, std::ptr::null_mut(), "get_name", &mut []).and_then(|s| string(a, s));
    let (samples, channels, freq) = (get_i32("get_samples"), get_i32("get_channels"), get_i32("get_frequency"));
    let load_type: i32 = invoke(a, clip_obj, std::ptr::null_mut(), "get_loadType", &mut []).and_then(|b| unbox(b)).unwrap_or(-1);
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
                // Not loaded yet (AssetBundle clips load on first Play): ask for it, try again.
                let _ = invoke(a, clip_obj, std::ptr::null_mut(), "LoadAudioData", &mut []);
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
        fmt: float_fmt(channels.max(1) as u16, freq.max(1) as u32),
        // A source named for the asset it plays (`Sound/Voice/ch01_003.ogg`) says more than the
        // clip name alone: its folder groups the voice and names it (see `source_name`).
        name: source_name(a, src as usize, src_obj).filter(|n| n.contains(['/', '\\'])).or(clip_name),
        secs,
        at: now,
        info: json!({
            "method": what, "clip_ptr": hex(clip_obj as usize), "load_type": load_type,
            "samples": samples, "channels": channels, "freq": freq,
        }),
    };
    if late {
        // Retried on the game thread from later AudioSource calls (see `retry_pending`).
        lock(&PENDING).push(p);
        HAVE_PENDING.store(true, Ordering::SeqCst);
    } else {
        p.send(result, false);
    }
}

const REFUSED: &str = "GetData refused (not loaded, or compressed in memory)";
/// How long a clip whose data was not loaded at Play is retried before giving up on its PCM.
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

/// Clips that were not loaded when played: try their PCM again (game thread only).
unsafe fn retry_pending(a: &Mono) {
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

unsafe fn read_pcm(a: &Mono, clip: P, n: usize) -> Result<Vec<u8>, &'static str> {
    let arr = (a.array_new)((a.domain_get)(), (a.get_single_class)(), n);
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
        Some(1) => Ok(std::slice::from_raw_parts((a.array_addr_with_size)(arr, 4, 0), n * 4).to_vec()),
        _ => Err(REFUSED),
    }
}

pub(crate) fn float_fmt(channels: u16, rate: u32) -> Vec<u8> {
    let mut w = vh_common::WAVEFORMATEX::pcm(channels, rate, 32);
    w.wFormatTag = vh_common::WAVE_FORMAT_IEEE_FLOAT;
    w.bytes()
}

#[cfg(test)]
mod tests {
    use super::copy_of;

    #[test]
    fn a_trampoline_copy_of_the_breakpoint_is_known_by_its_jump_back() {
        // x86 set_text: 55 | 8B EC 56 57 ...; MinHook overwrote 5 bytes (55 8B EC 56 57) and keeps
        // CC 8B EC 56 57 then E9 back to entry + 5.
        let entry = 0x1000_0000usize;
        let after = [0x8B, 0xEC, 0x56, 0x57, 0x83, 0xEC, 0x10, 0x8B, 0x45, 0x08, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90];
        let base = 0x2000_0001usize;
        let back = (entry + 5).wrapping_sub(base + 4 + 5) as u32;
        let mut code = vec![0x8B, 0xEC, 0x56, 0x57, 0xE9];
        code.extend_from_slice(&back.to_le_bytes());
        assert_eq!(copy_of(&code, base, &after, entry), Some(4));
        // The same bytes jumping elsewhere are not ours.
        let mut elsewhere = code.clone();
        elsewhere[5] ^= 1;
        assert_eq!(copy_of(&elsewhere, base, &after, entry), None);
        // x64: FF 25 00000000 <address>.
        let mut code = vec![0x48, 0x8B, 0xEC, 0xFF, 0x25, 0, 0, 0, 0];
        code.extend_from_slice(&((entry + 4) as u64).to_le_bytes());
        let after = [0x48, 0x8B, 0xEC, 0x48, 0x83, 0xEC, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        if usize::BITS == 64 {
            assert_eq!(copy_of(&code, base, &after, entry), Some(3));
        }
    }
}
