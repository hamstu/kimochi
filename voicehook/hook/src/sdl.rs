//! SDL_mixer (ONScripter family, many ports): every `Mix_PlayChannel*` / `Mix_FadeInChannel*`
//! hands over a `Mix_Chunk`, whose `abuf` is the whole sound already decoded to the mixer's
//! output format. So each play is a clean clip at once, per mixer channel. File names come from
//! `SDL_RWFromFile` → `Mix_LoadWAV_RW` (chunks loaded from memory, like ONScripter's archives,
//! have none). `Mix_PlayMusic` is noted with its file name (music is streamed, not captured).
//!
//! Hooked through the callers' import tables / GetProcAddress (see `iat`).
use crate::iat::{self, Hook};
use crate::sink::{self, Ev};
use crate::util::{copy_in, guard, lock};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

#[repr(C)]
struct MixChunk {
    allocated: c_int,
    abuf: *mut u8,
    alen: u32,
    volume: u8,
}

static O_RWFROMFILE: AtomicUsize = AtomicUsize::new(0);
static O_LOADWAV_RW: AtomicUsize = AtomicUsize::new(0);
static O_PLAY: AtomicUsize = AtomicUsize::new(0);
static O_PLAY_TIMED: AtomicUsize = AtomicUsize::new(0);
static O_FADE: AtomicUsize = AtomicUsize::new(0);
static O_FADE_TIMED: AtomicUsize = AtomicUsize::new(0);
static O_HALT: AtomicUsize = AtomicUsize::new(0);
static O_LOADMUS: AtomicUsize = AtomicUsize::new(0);
static O_PLAYMUS: AtomicUsize = AtomicUsize::new(0);
/// The real `Mix_QuerySpec`, looked up from the mixer module when first needed.
static QUERY_SPEC: AtomicUsize = AtomicUsize::new(0);

/// SDL_RWops* → file name; Mix_Chunk* / Mix_Music* → file name.
static RW_NAMES: LazyLock<Mutex<HashMap<usize, String>>> = LazyLock::new(Default::default);
static NAMES: LazyLock<Mutex<HashMap<usize, String>>> = LazyLock::new(Default::default);

pub fn register() {
    let hooks: [(&'static str, &'static str, usize, &'static AtomicUsize); 9] = [
        ("sdl2", "SDL_RWFromFile", rw_from_file as *const () as usize, &O_RWFROMFILE),
        ("sdl2_mixer", "Mix_LoadWAV_RW", load_wav_rw as *const () as usize, &O_LOADWAV_RW),
        ("sdl2_mixer", "Mix_PlayChannel", play as *const () as usize, &O_PLAY),
        ("sdl2_mixer", "Mix_PlayChannelTimed", play_timed as *const () as usize, &O_PLAY_TIMED),
        ("sdl2_mixer", "Mix_FadeInChannel", fade as *const () as usize, &O_FADE),
        ("sdl2_mixer", "Mix_FadeInChannelTimed", fade_timed as *const () as usize, &O_FADE_TIMED),
        ("sdl2_mixer", "Mix_HaltChannel", halt as *const () as usize, &O_HALT),
        ("sdl2_mixer", "Mix_LoadMUS", load_mus as *const () as usize, &O_LOADMUS),
        ("sdl2_mixer", "Mix_PlayMusic", play_mus as *const () as usize, &O_PLAYMUS),
    ];
    for (dll, name, hook, orig) in hooks {
        iat::register(Hook { dll, name, hook, orig });
    }
    iat::on_module("sdl2_mixer", |m, _| unsafe {
        let f = iat::real_gpa(m, c"Mix_QuerySpec");
        let _ = QUERY_SPEC.compare_exchange(0, f, Ordering::SeqCst, Ordering::SeqCst);
    });
}

unsafe fn orig<T>(slot: &AtomicUsize) -> T {
    std::mem::transmute_copy(&slot.load(Ordering::SeqCst))
}

unsafe extern "C" fn rw_from_file(file: *const c_char, mode: *const c_char) -> *mut c_void {
    let o: unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_void = orig(&O_RWFROMFILE);
    let rw = o(file, mode);
    if !rw.is_null() && !file.is_null() {
        guard(|| unsafe {
            lock(&RW_NAMES).insert(rw as usize, CStr::from_ptr(file).to_string_lossy().into_owned());
        });
    }
    rw
}

unsafe extern "C" fn load_wav_rw(rw: *mut c_void, free: c_int) -> *mut MixChunk {
    let name = lock(&RW_NAMES).remove(&(rw as usize));
    let o: unsafe extern "C" fn(*mut c_void, c_int) -> *mut MixChunk = orig(&O_LOADWAV_RW);
    let chunk = o(rw, free);
    if let (false, Some(n)) = (chunk.is_null(), name) {
        lock(&NAMES).insert(chunk as usize, n);
    }
    chunk
}

unsafe extern "C" fn load_mus(file: *const c_char) -> *mut c_void {
    let o: unsafe extern "C" fn(*const c_char) -> *mut c_void = orig(&O_LOADMUS);
    let m = o(file);
    if !m.is_null() && !file.is_null() {
        lock(&NAMES).insert(m as usize, CStr::from_ptr(file).to_string_lossy().into_owned());
    }
    m
}

unsafe extern "C" fn play_mus(music: *mut c_void, loops: c_int) -> c_int {
    guard(|| {
        let name = lock(&NAMES).get(&(music as usize)).cloned();
        sink::send(Ev::Note(json!({"ev": "sdl_music", "source": name, "loops": loops})));
    });
    let o: unsafe extern "C" fn(*mut c_void, c_int) -> c_int = orig(&O_PLAYMUS);
    o(music, loops)
}

unsafe extern "C" fn halt(channel: c_int) -> c_int {
    guard(|| sink::send(Ev::Mark { key: (4, channel as usize), what: "sdl_halt", info: json!({"channel": channel}) }));
    let o: unsafe extern "C" fn(c_int) -> c_int = orig(&O_HALT);
    o(channel)
}

unsafe extern "C" fn play(channel: c_int, chunk: *mut MixChunk, loops: c_int) -> c_int {
    let o: unsafe extern "C" fn(c_int, *mut MixChunk, c_int) -> c_int = orig(&O_PLAY);
    let ch = o(channel, chunk, loops);
    guard(|| unsafe { played(ch, chunk, loops, "Mix_PlayChannel") });
    ch
}

unsafe extern "C" fn play_timed(channel: c_int, chunk: *mut MixChunk, loops: c_int, ticks: c_int) -> c_int {
    let o: unsafe extern "C" fn(c_int, *mut MixChunk, c_int, c_int) -> c_int = orig(&O_PLAY_TIMED);
    let ch = o(channel, chunk, loops, ticks);
    guard(|| unsafe { played(ch, chunk, loops, "Mix_PlayChannelTimed") });
    ch
}

unsafe extern "C" fn fade(channel: c_int, chunk: *mut MixChunk, loops: c_int, ms: c_int) -> c_int {
    let o: unsafe extern "C" fn(c_int, *mut MixChunk, c_int, c_int) -> c_int = orig(&O_FADE);
    let ch = o(channel, chunk, loops, ms);
    guard(|| unsafe { played(ch, chunk, loops, "Mix_FadeInChannel") });
    ch
}

unsafe extern "C" fn fade_timed(channel: c_int, chunk: *mut MixChunk, loops: c_int, ms: c_int, ticks: c_int) -> c_int {
    let o: unsafe extern "C" fn(c_int, *mut MixChunk, c_int, c_int, c_int) -> c_int = orig(&O_FADE_TIMED);
    let ch = o(channel, chunk, loops, ms, ticks);
    guard(|| unsafe { played(ch, chunk, loops, "Mix_FadeInChannelTimed") });
    ch
}

/// The mixer's output format as a WAVEFORMATEX (SDL_AudioFormat → PCM/float).
unsafe fn spec_fmt() -> Option<Vec<u8>> {
    let q = QUERY_SPEC.load(Ordering::SeqCst);
    if q == 0 {
        return None;
    }
    let q: unsafe extern "C" fn(*mut c_int, *mut u16, *mut c_int) -> c_int = std::mem::transmute(q);
    let (mut freq, mut format, mut channels) = (0, 0u16, 0);
    if q(&mut freq, &mut format, &mut channels) == 0 || freq <= 0 || channels <= 0 {
        return None;
    }
    let bits = (format & 0xFF) as u16;
    let float = format & 0x100 != 0;
    // Big-endian or unsigned 16-bit output never happens on Windows in practice; U8 is unsigned
    // in WAV anyway.
    let mut w = vh_common::WAVEFORMATEX::pcm(channels as u16, freq as u32, bits);
    if float {
        w.wFormatTag = vh_common::WAVE_FORMAT_IEEE_FLOAT;
    }
    Some(w.bytes())
}

unsafe fn played(ch: c_int, chunk: *mut MixChunk, loops: c_int, what: &str) {
    if ch < 0 || chunk.is_null() || (*chunk).abuf.is_null() {
        return;
    }
    let Some(fmt) = spec_fmt() else { return };
    let bytes = copy_in((*chunk).abuf, (*chunk).alen as usize, "sdl_mixer chunk");
    let name = lock(&NAMES).get(&(chunk as usize)).cloned();
    sink::send(Ev::Whole {
        key: (4, ch as usize),
        api: "sdl_mixer",
        fmt,
        bytes,
        ext: None,
        source: name,
        dur: None,
        at: None,
        info: json!({"channel": ch, "loops": loops, "call": what, "chunk": crate::util::hex(chunk as usize)}),
    });
}
