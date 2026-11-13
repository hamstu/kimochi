//! winmm `waveOut*`: one stream per opened device handle. Data is taken at `waveOutWrite`
//! (the buffer the game queues), the format at `waveOutOpen`, and `waveOutReset` / `waveOutClose`
//! end the stream's clip. Older engines open a device per sound (then each is clean); engines that
//! mix into one device give one mixed stream, which the census then explains.
//!
//! Hooked through the callers' import tables / GetProcAddress (see `iat`).
use crate::iat::{self, Hook};
use crate::sink::{self, Ev};
use crate::util::{copy_in, guard};
use serde_json::json;

use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use vh_common::WAVEFORMATEX;

static O_OPEN: AtomicUsize = AtomicUsize::new(0);
static O_WRITE: AtomicUsize = AtomicUsize::new(0);
static O_RESET: AtomicUsize = AtomicUsize::new(0);
static O_CLOSE: AtomicUsize = AtomicUsize::new(0);
static O_PAUSE: AtomicUsize = AtomicUsize::new(0);
static O_RESTART: AtomicUsize = AtomicUsize::new(0);

const WAVE_FORMAT_QUERY: u32 = 0x1;
const WHDR_BEGINLOOP: u32 = 0x4;

#[repr(C)]
struct WaveHdr {
    data: *mut u8,
    buffer_length: u32,
    bytes_recorded: u32,
    user: usize,
    flags: u32,
    loops: u32,
    next: *mut WaveHdr,
    reserved: usize,
}

pub fn register() {
    let hooks: [(&'static str, usize, &'static AtomicUsize); 6] = [
        ("waveOutOpen", open as *const () as usize, &O_OPEN),
        ("waveOutWrite", write as *const () as usize, &O_WRITE),
        ("waveOutReset", reset as *const () as usize, &O_RESET),
        ("waveOutClose", close as *const () as usize, &O_CLOSE),
        ("waveOutPause", pause as *const () as usize, &O_PAUSE),
        ("waveOutRestart", restart as *const () as usize, &O_RESTART),
    ];
    for (name, hook, orig) in hooks {
        iat::register(Hook { dll: "winmm", name, hook, orig });
    }
}

fn key(h: *mut c_void) -> sink::Key {
    (3, h as usize)
}

unsafe extern "system" fn open(
    out: *mut *mut c_void,
    dev: u32,
    fmt: *const WAVEFORMATEX,
    cb: usize,
    inst: usize,
    flags: u32,
) -> u32 {
    let o: unsafe extern "system" fn(*mut *mut c_void, u32, *const WAVEFORMATEX, usize, usize, u32) -> u32 =
        std::mem::transmute(O_OPEN.load(Ordering::SeqCst));
    let r = o(out, dev, fmt, cb, inst, flags);
    if r == 0 && flags & WAVE_FORMAT_QUERY == 0 && !out.is_null() && !crate::internal() {
        guard(|| unsafe {
            let h = *out;
            sink::send(Ev::Create {
                key: key(h),
                api: "waveout",
                fmt: vh_common::wfx_bytes(fmt),
                info: json!({"device": dev}),
            });
        });
    }
    r
}

unsafe extern "system" fn write(h: *mut c_void, hdr: *mut WaveHdr, size: u32) -> u32 {
    guard(|| unsafe {
        if !hdr.is_null() && !(*hdr).data.is_null() && (*hdr).buffer_length > 0 {
            let bytes = copy_in((*hdr).data, (*hdr).buffer_length as usize, "waveout write");
            let looping = (*hdr).flags & WHDR_BEGINLOOP != 0 && (*hdr).loops > 1;
            sink::send(Ev::Data { key: key(h), bytes, eos: false, looping, region: None, info: json!({}) });
        }
    });
    let o: unsafe extern "system" fn(*mut c_void, *mut WaveHdr, u32) -> u32 =
        std::mem::transmute(O_WRITE.load(Ordering::SeqCst));
    o(h, hdr, size)
}

macro_rules! simple {
    ($f:ident, $orig:ident, $ev:expr) => {
        unsafe extern "system" fn $f(h: *mut c_void) -> u32 {
            guard(|| sink::send($ev(key(h))));
            let o: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute($orig.load(Ordering::SeqCst));
            o(h)
        }
    };
}

simple!(reset, O_RESET, |k| Ev::Stop { key: k });
simple!(close, O_CLOSE, |k| Ev::Destroy { key: k });
simple!(pause, O_PAUSE, |k| Ev::Mark { key: k, what: "pause", info: json!({}) });
simple!(restart, O_RESTART, |k| Ev::Mark { key: k, what: "restart", info: json!({}) });
