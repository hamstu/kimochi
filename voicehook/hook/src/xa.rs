//! XAudio2: every source voice is a stream. Data is taken at `SubmitSourceBuffer` (the game
//! hands XAudio2 a pointer it must keep valid until played, so copying at submit is safe),
//! playback from `Start`/`Stop`, clip ends from END_OF_STREAM, `FlushSourceBuffers` and
//! `DestroyVoice`.
//!
//! Install, per XAudio2 implementation: 2.9 and 2.8 (system DLLs, loaded by us), 2.9 redist
//! (`xaudio2_9redist.dll`, shipped with the game: hooked once it is loaded), and 2.7 (COM).
//! A dummy engine gives `CreateSourceVoice` (to learn each voice's format); a dummy source voice
//! gives the source-voice vtable. Voices created before we got there are still hooked (shared
//! vtable); their format is guessed from `GetVoiceDetails` as 16-bit PCM.
use crate::sink::{self, Ev, Key};
use crate::util::{copy_in, guard, lock, log, wide};
use crate::{internal, vt};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::{LazyLock, Mutex};
use vh_common::xa::*;
use vh_common::*;
use windows_sys::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};

/// vtable → XAudio2 minor version (7, 8, 9), for engines and for source voices.
static ENGINE_VER: LazyLock<Mutex<HashMap<usize, u8>>> = LazyLock::new(Default::default);
static VOICE_VER: LazyLock<Mutex<HashMap<usize, u8>>> = LazyLock::new(Default::default);
static KNOWN: LazyLock<Mutex<HashSet<usize>>> = LazyLock::new(Default::default);
/// Implementations already hooked: module names, and "2.7".
static DONE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

type FnCsv = unsafe extern "system" fn(
    *mut c_void,
    *mut *mut c_void,
    *const WAVEFORMATEX,
    u32,
    f32,
    *mut c_void,
    *const XAUDIO2_VOICE_SENDS,
    *const c_void,
) -> HRESULT;
type FnSubmit = unsafe extern "system" fn(*mut c_void, *const XAUDIO2_BUFFER, *const c_void) -> HRESULT;
type FnStartStop = unsafe extern "system" fn(*mut c_void, u32, u32) -> HRESULT;
type FnFlush = unsafe extern "system" fn(*mut c_void) -> HRESULT;
type FnDestroy = unsafe extern "system" fn(*mut c_void);
type FnCreate = unsafe extern "system" fn(*mut *mut c_void, u32, u32) -> HRESULT;

fn key(p: *mut c_void) -> Key {
    (2, p as usize)
}

fn api(ver: u8) -> &'static str {
    match ver {
        7 => "xaudio2.7",
        8 => "xaudio2.8",
        _ => "xaudio2.9",
    }
}

unsafe fn ver_of(map: &Mutex<HashMap<usize, u8>>, obj: *mut c_void) -> u8 {
    lock(map).get(&(vt::vtable(obj) as usize)).copied().unwrap_or(9)
}

unsafe fn hook_engine(engine: *mut c_void, ver: u8) {
    let v = vt::vtable(engine);
    // On Windows 10+ xaudio2_8.dll runs 2.9's implementation: one vtable, first label kept.
    let had = *lock(&ENGINE_VER).entry(v as usize).or_insert(ver);
    if had != ver {
        log(&format!("{} shares {}'s implementation", api(ver), api(had)));
    }
    vt::hook(v, create_source_voice(ver == 7), vt::XA_ENGINE, create_source_voice_hook as *const () as usize);
}

unsafe fn hook_voice(voice: *mut c_void, ver: u8) {
    let v = vt::vtable(voice);
    lock(&VOICE_VER).entry(v as usize).or_insert(ver);
    vt::hook(v, DESTROY_VOICE, vt::XA_VOICE, destroy_hook as *const () as usize);
    vt::hook(v, START, vt::XA_VOICE, start_hook as *const () as usize);
    vt::hook(v, STOP, vt::XA_VOICE, stop_hook as *const () as usize);
    vt::hook(v, SUBMIT_SOURCE_BUFFER, vt::XA_VOICE, submit_hook as *const () as usize);
    vt::hook(v, FLUSH_SOURCE_BUFFERS, vt::XA_VOICE, flush_hook as *const () as usize);
}

/// A voice created before our hooks: its channels and rate from GetVoiceDetails, assumed PCM16.
unsafe fn ensure_known(voice: *mut c_void) {
    if lock(&KNOWN).contains(&(voice as usize)) {
        return;
    }
    lock(&KNOWN).insert(voice as usize);
    let ver = ver_of(&VOICE_VER, voice);
    let mut d = [0u32; 4];
    vcall!(voice, GET_VOICE_DETAILS, fn(*mut u32) -> (), d.as_mut_ptr());
    // 2.7: {CreationFlags, InputChannels, InputSampleRate}; 2.8+: {CreationFlags, ActiveFlags, ...}.
    let (channels, rate) = if ver == 7 { (d[1], d[2]) } else { (d[2], d[3]) };
    let fmt = WAVEFORMATEX::pcm(channels.clamp(1, 8) as u16, rate.clamp(1000, 384_000), 16).bytes();
    sink::send(Ev::Create { key: key(voice), api: api(ver), fmt, info: json!({"lazy": true, "assumed": "pcm16"}) });
}

unsafe extern "system" fn create_source_voice_hook(
    this: *mut c_void,
    out: *mut *mut c_void,
    format: *const WAVEFORMATEX,
    flags: u32,
    max_ratio: f32,
    callback: *mut c_void,
    sends: *const XAUDIO2_VOICE_SENDS,
    effects: *const c_void,
) -> HRESULT {
    let ver = ver_of(&ENGINE_VER, this);
    let o = vt::orig(this, create_source_voice(ver == 7), vt::XA_ENGINE);
    if o == 0 {
        return E_FAIL;
    }
    let f: FnCsv = std::mem::transmute(o);
    let hr = f(this, out, format, flags, max_ratio, callback, sends, effects);
    if hr >= 0 && !out.is_null() && !(*out).is_null() {
        let voice = *out;
        guard(|| {
            hook_voice(voice, ver);
            lock(&KNOWN).insert(voice as usize);
            if !internal() {
                sink::send(Ev::Create {
                    key: key(voice),
                    api: api(ver),
                    fmt: wfx_bytes(format),
                    info: json!({"flags": flags, "callback": !callback.is_null(), "max_ratio": max_ratio}),
                });
            }
        });
    }
    hr
}

unsafe extern "system" fn submit_hook(this: *mut c_void, buffer: *const XAUDIO2_BUFFER, wma: *const c_void) -> HRESULT {
    let o = vt::orig(this, SUBMIT_SOURCE_BUFFER, vt::XA_VOICE);
    if o == 0 {
        return E_FAIL;
    }
    if !internal() && !buffer.is_null() {
        guard(|| {
            ensure_known(this);
            let b = std::ptr::read_unaligned(buffer);
            let (p, n) = (b.pAudioData, b.AudioBytes);
            if p.is_null() || n == 0 {
                return;
            }
            let (begin, len, count) = (b.PlayBegin, b.PlayLength, b.LoopCount);
            sink::send(Ev::Data {
                key: key(this),
                bytes: copy_in(p, n as usize, "xaudio2 submit"),
                eos: b.Flags & END_OF_STREAM != 0,
                looping: count > 0,
                region: (begin > 0 || len > 0).then_some((begin, len)),
                info: json!({"play_begin": begin, "play_length": len, "loop_count": count, "wma": !wma.is_null()}),
            });
        });
    }
    let f: FnSubmit = std::mem::transmute(o);
    f(this, buffer, wma)
}

unsafe extern "system" fn start_hook(this: *mut c_void, flags: u32, operation_set: u32) -> HRESULT {
    let o = vt::orig(this, START, vt::XA_VOICE);
    if o == 0 {
        return E_FAIL;
    }
    if !internal() {
        guard(|| {
            ensure_known(this);
            sink::send(Ev::Play { key: key(this), looping: false, info: json!({"flags": flags, "op": operation_set}) });
        });
    }
    let f: FnStartStop = std::mem::transmute(o);
    f(this, flags, operation_set)
}

unsafe extern "system" fn stop_hook(this: *mut c_void, flags: u32, operation_set: u32) -> HRESULT {
    let o = vt::orig(this, STOP, vt::XA_VOICE);
    if o == 0 {
        return E_FAIL;
    }
    if !internal() {
        guard(|| {
            ensure_known(this);
            sink::send(Ev::Stop { key: key(this) });
        });
    }
    let f: FnStartStop = std::mem::transmute(o);
    f(this, flags, operation_set)
}

unsafe extern "system" fn flush_hook(this: *mut c_void) -> HRESULT {
    let o = vt::orig(this, FLUSH_SOURCE_BUFFERS, vt::XA_VOICE);
    if o == 0 {
        return E_FAIL;
    }
    if !internal() {
        guard(|| {
            ensure_known(this);
            sink::send(Ev::Flush { key: key(this) });
        });
    }
    let f: FnFlush = std::mem::transmute(o);
    f(this)
}

unsafe extern "system" fn destroy_hook(this: *mut c_void) {
    let o = vt::orig(this, DESTROY_VOICE, vt::XA_VOICE);
    if o == 0 {
        return;
    }
    guard(|| {
        if lock(&KNOWN).remove(&(this as usize)) && !internal() {
            sink::send(Ev::Destroy { key: key(this) });
        }
    });
    let f: FnDestroy = std::mem::transmute(o);
    f(this)
}

/// Hooks an engine we created, then creates and destroys a mastering voice and a source voice
/// on it to reach the source-voice vtable.
unsafe fn install_engine(engine: *mut c_void, ver: u8) -> Result<(), String> {
    let v27 = ver == 7;
    hook_engine(engine, ver);
    let mut master = null_mut();
    let hr = if v27 {
        vcall!(engine, create_mastering_voice(true), fn(*mut *mut c_void, u32, u32, u32, u32, *const c_void) -> HRESULT,
            &mut master, 0, 0, 0, 0, null())
    } else {
        vcall!(engine, create_mastering_voice(false),
            fn(*mut *mut c_void, u32, u32, u32, *const u16, *const c_void, u32) -> HRESULT,
            &mut master, 0, 0, 0, null(), null(), 6)
    };
    if hr < 0 {
        log(&format!("{}: no mastering voice ({hr:#x}); trying a voice with no sends", api(ver)));
        master = null_mut();
    }
    let fmt = WAVEFORMATEX::pcm(1, 22050, 16);
    let no_sends = XAUDIO2_VOICE_SENDS { SendCount: 0, pSends: null() };
    let sends: *const XAUDIO2_VOICE_SENDS = if master.is_null() { &no_sends } else { null() };
    let mut voice = null_mut();
    // Through the hooked CreateSourceVoice, which hooks the voice's vtable.
    let hr = vcall!(engine, create_source_voice(v27),
        fn(*mut *mut c_void, *const WAVEFORMATEX, u32, f32, *mut c_void, *const XAUDIO2_VOICE_SENDS, *const c_void) -> HRESULT,
        &mut voice, &fmt, 0, 2.0, null_mut(), sends, null());
    let result = if hr < 0 || voice.is_null() {
        Err(format!("dummy source voice failed ({hr:#x})"))
    } else {
        vcall!(voice, DESTROY_VOICE, fn() -> ());
        Ok(())
    };
    if !master.is_null() {
        vcall!(master, DESTROY_VOICE, fn() -> ());
    }
    vcall!(engine, ENGINE_RELEASE, fn() -> u32);
    result
}

unsafe fn install_module(name: &str, ver: u8, load: bool) {
    if lock(&DONE).contains(name) {
        return;
    }
    let w = wide(name);
    let module = if load { LoadLibraryW(w.as_ptr()) } else { GetModuleHandleW(w.as_ptr()) };
    if module.is_null() {
        if load {
            lock(&DONE).insert(name.to_string());
            log(&format!("{name}: not available"));
        }
        return;
    }
    lock(&DONE).insert(name.to_string());
    let create = GetProcAddress(module, c"XAudio2Create".as_ptr().cast())
        .or_else(|| GetProcAddress(module, c"XAudio2CreateWithVersionInfo".as_ptr().cast()));
    let Some(create) = create else {
        log(&format!("{name}: no XAudio2Create export"));
        return;
    };
    // XAudio2CreateWithVersionInfo takes a fourth argument (NTDDI version); passing 3 to it would
    // leave that one undefined, so prefer XAudio2Create, present in every 2.8/2.9 build.
    let create: FnCreate = std::mem::transmute(create);
    let mut engine = null_mut();
    let hr = create(&mut engine, 0, DEFAULT_PROCESSOR);
    if hr < 0 || engine.is_null() {
        log(&format!("{name}: XAudio2Create failed ({hr:#x})"));
        return;
    }
    match install_engine(engine, ver) {
        Ok(()) => log(&format!("{name}: hooked ({})", api(ver))),
        Err(e) => log(&format!("{name}: engine hooked, voices not: {e}")),
    }
}

unsafe fn install_27() {
    if lock(&DONE).contains("2.7") {
        return;
    }
    lock(&DONE).insert("2.7".into());
    let mut engine = null_mut();
    let hr = CoCreateInstance(
        &CLSID_XAUDIO2_7 as *const GUID as *const _,
        null_mut(),
        CLSCTX_INPROC_SERVER,
        &IID_IXAUDIO2_7 as *const GUID as *const _,
        &mut engine,
    );
    if hr < 0 || engine.is_null() {
        log(&format!("xaudio2_7: not available ({hr:#x})"));
        return;
    }
    // Keep xaudio2_7.dll loaded for good: unloading it under a live engine thread crashes.
    LoadLibraryW(wide("xaudio2_7.dll").as_ptr());
    let hr = vcall!(engine, INITIALIZE_27, fn(u32, u32) -> HRESULT, 0, DEFAULT_PROCESSOR);
    if hr < 0 {
        log(&format!("xaudio2_7: Initialize failed ({hr:#x})"));
        vcall!(engine, ENGINE_RELEASE, fn() -> u32);
        return;
    }
    match install_engine(engine, 7) {
        Ok(()) => log("xaudio2_7: hooked (xaudio2.7)"),
        Err(e) => log(&format!("xaudio2_7: engine hooked, voices not: {e}")),
    }
}

/// Called at start and then twice a second: hooks each XAudio2 implementation once, the
/// system ones up front and a game's own redist DLL when it shows up.
pub unsafe fn install() {
    install_module("xaudio2_9.dll", 9, true);
    install_module("xaudio2_8.dll", 8, true);
    install_module("xaudio2_9redist.dll", 9, false);
    install_27();
}
