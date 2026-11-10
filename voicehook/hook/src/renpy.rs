//! Ren'Py adapter: every file Ren'Py starts on a channel (`voice`, `music`, `sound`, ...), as
//! the original encoded bytes (Ogg Vorbis/Opus, MP3, WAV) with the channel and file name.
//!
//! How: Ren'Py embeds CPython (`libpython3.x.dll` in Ren'Py 8, `python27.dll` in 6/7), which
//! exports the C API. Once the interpreter is up, our thread takes the GIL and runs a few lines
//! of Python (`PATCH`) that wrap `renpy.audio.renpysound.play/queue/stop/dequeue`. The wrapper
//! reads the exact bytes Ren'Py hands its mixer (`tell`, `read`, `seek` back on the same file
//! object) and passes them, with a JSON description, to `voicehook_emit` in this DLL through
//! `ctypes`. Nothing in the game is patched outside Python.
//!
//! Works with launch and attach alike (it waits for `renpy.audio.audio` to be imported).
use crate::sink::{self, Ev};
use crate::util::{log, now_ms};
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::Foundation::HMODULE;

static INSTALLED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
/// Last file started per channel number.
static LAST_FILE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<usize, String>>> = std::sync::LazyLock::new(Default::default);

/// The Python side. `{OUT}` and `{DLL}` are filled in. Python 2 and 3 compatible.
const PATCH: &str = r#####"
def _voicehook_install():
    import sys
    rs = sys.modules.get('renpy.audio.renpysound')
    au = sys.modules.get('renpy.audio.audio')
    if rs is None or au is None or not hasattr(rs, 'play') or not hasattr(au, 'all_channels'):
        return
    if getattr(rs, '_voicehook', False):
        return
    import ctypes, json
    dll = ctypes.CDLL(r'''{DLL}''')
    emit = dll.voicehook_emit
    emit.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
    emit.restype = ctypes.c_int

    def send(meta, data):
        m = json.dumps(meta)
        if not isinstance(m, bytes):
            m = m.encode('utf-8')
        if data is None:
            data = b''
        emit(m, data, len(data))

    def num(c):
        # Ren'Py 8 assigns a channel's mixer number lazily, on first read of .number: never read
        # it here, or we would hand out numbers ourselves.
        d = getattr(c, '__dict__', {})
        return d.get('_number', d.get('number'))

    def cname(n):
        try:
            for c in au.all_channels:
                if num(c) == n:
                    return c.name
        except Exception:
            pass
        return str(n)

    def wrap(op, orig):
        def f(channel, file, name, *a, **k):
            try:
                data = None
                try:
                    pos = file.tell()
                    data = file.read()
                    file.seek(pos)
                except Exception:
                    data = None
                meta = {'op': op, 'channel': cname(channel), 'number': channel, 'file': str(name)}
                for key in ('start', 'end', 'fadein', 'tight', 'relative_volume'):
                    if key in k:
                        try:
                            meta[key] = float(k[key])
                        except Exception:
                            pass
                send(meta, data)
            except Exception:
                pass
            return orig(channel, file, name, *a, **k)
        return f

    def wrap_stop(op, orig):
        def f(channel, *a, **k):
            try:
                send({'op': op, 'channel': cname(channel), 'number': channel}, None)
            except Exception:
                pass
            return orig(channel, *a, **k)
        return f

    rs.play = wrap('play', rs.play)
    rs.queue = wrap('queue', rs.queue)
    if hasattr(rs, 'stop'):
        rs.stop = wrap_stop('stop', rs.stop)
    if hasattr(rs, 'dequeue'):
        rs.dequeue = wrap_stop('dequeue', rs.dequeue)
    rs._voicehook = True
    version = getattr(sys.modules.get('renpy'), 'version', '?')
    chans = []
    try:
        chans = [[str(c.name), num(c)] for c in au.all_channels]
    except Exception:
        pass
    send({'op': 'installed', 'renpy': str(version), 'python': sys.version.split()[0], 'channels': chans}, None)

try:
    _voicehook_install()
except Exception:
    pass
"#####;

struct Py {
    is_initialized: unsafe extern "C" fn() -> i32,
    gil_ensure: unsafe extern "C" fn() -> i32,
    gil_release: unsafe extern "C" fn(i32),
    run_simple_string: unsafe extern "C" fn(*const c_char) -> i32,
}

/// Called the first time a Python runtime module is seen (see `iat::on_module`).
pub fn on_python(m: HMODULE, name: &str) {
    if STARTED.load(Ordering::SeqCst) {
        return;
    }
    let sym = |n: &CStr| unsafe { crate::iat::real_gpa(m, n) };
    let (a, b, c, d) = (sym(c"Py_IsInitialized"), sym(c"PyGILState_Ensure"), sym(c"PyGILState_Release"), sym(c"PyRun_SimpleString"));
    if a == 0 || b == 0 || c == 0 || d == 0 {
        return; // librenpython.dll and friends: not the interpreter
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let py = unsafe {
        Py {
            is_initialized: std::mem::transmute::<usize, _>(a),
            gil_ensure: std::mem::transmute::<usize, _>(b),
            gil_release: std::mem::transmute::<usize, _>(c),
            run_simple_string: std::mem::transmute::<usize, _>(d),
        }
    };
    let dll = crate::util::module_path(crate::MODULE.load(Ordering::SeqCst) as HMODULE);
    let code = PATCH.replace("{DLL}", &dll.display().to_string());
    let code = CString::new(code).unwrap();
    let name = name.to_string();
    log(&format!("renpy: Python runtime {name}; waiting for renpy.audio"));
    std::thread::spawn(move || {
        // Ren'Py imports renpy.audio a few seconds in; keep trying for 10 minutes.
        for i in 0..1200 {
            std::thread::sleep(std::time::Duration::from_millis(if i < 60 { 250 } else { 500 }));
            if INSTALLED.load(Ordering::SeqCst) {
                return;
            }
            unsafe {
                if (py.is_initialized)() == 0 {
                    continue;
                }
                let g = (py.gil_ensure)();
                (py.run_simple_string)(code.as_ptr());
                (py.gil_release)(g);
            }
        }
        log(&format!("renpy: gave up waiting for renpy.audio in {name}"));
    });
}

/// Called from the Python wrapper (ctypes). `meta` is JSON; `data` the file's bytes, if any.
#[no_mangle]
pub unsafe extern "C" fn voicehook_emit(meta: *const c_char, data: *const u8, len: usize) -> i32 {
    let mut rc = 0;
    crate::util::guard(|| unsafe {
        let Ok(meta) = serde_json::from_slice::<Value>(CStr::from_ptr(meta).to_bytes()) else {
            rc = -1;
            return;
        };
        let op = meta["op"].as_str().unwrap_or("").to_string();
        if op == "installed" {
            INSTALLED.store(true, Ordering::SeqCst);
            log(&format!("renpy: installed (Ren'Py {}, Python {}), channels {}", meta["renpy"], meta["python"], meta["channels"]));
            sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "renpy", "renpy": meta["renpy"], "python": meta["python"], "channels": meta["channels"]})));
            return;
        }
        let number = meta["number"].as_u64().unwrap_or(0) as usize;
        let key = (6u8, number);
        match op.as_str() {
            "play" | "queue" => {
                let file = meta["file"].as_str().unwrap_or("").to_string();
                {
                    // A looping track re-queues the same file each time round: mark it, no copy.
                    let mut last = crate::util::lock(&LAST_FILE);
                    if op == "queue" && last.get(&number) == Some(&file) {
                        drop(last);
                        sink::send(Ev::Mark { key, what: "renpy_loop", info: json!({"file": file}) });
                        return;
                    }
                    last.insert(number, file.clone());
                }
                let bytes = crate::util::copy_in(data, len, "renpy sound");
                let ext = sniff_ext(&bytes, &file);
                let dur = audio_duration(&bytes);
                sink::send(Ev::Whole {
                    key,
                    api: "renpy",
                    fmt: Vec::new(),
                    bytes,
                    ext: Some(ext),
                    source: Some(file),
                    dur,
                    at: Some(now_ms()),
                    info: meta,
                });
            }
            _ => sink::send(Ev::Mark { key, what: "renpy_stop", info: meta }),
        }
    });
    rc
}

fn sniff_ext(b: &[u8], name: &str) -> String {
    if b.starts_with(b"OggS") {
        if b.windows(8).take(200).any(|w| w == b"OpusHead") {
            return "opus".into();
        }
        return "ogg".into();
    }
    if b.starts_with(b"RIFF") {
        return "wav".into();
    }
    if b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && b[1] & 0xE0 == 0xE0) {
        return "mp3".into();
    }
    if b.starts_with(b"fLaC") {
        return "flac".into();
    }
    let stem = name.rsplit('>').next().unwrap_or(name);
    stem.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).filter(|e| e.len() <= 4).unwrap_or_else(|| "bin".into())
}

/// Length of an Ogg Vorbis/Opus file from its last granule position, or a PCM WAV from its
/// header. None for anything else.
pub fn audio_duration(b: &[u8]) -> Option<f64> {
    if b.starts_with(b"RIFF") {
        let f = vh_common::Fmt::parse(riff_chunk(b, b"fmt ")?)?;
        return Some(f.seconds(riff_chunk(b, b"data")?.len()));
    }
    if !b.starts_with(b"OggS") {
        return None;
    }
    let (rate, preskip) = if let Some(i) = find(b, b"OpusHead") {
        (48000.0, u16::from_le_bytes([*b.get(i + 10)?, *b.get(i + 11)?]) as f64)
    } else {
        let i = find(b, b"\x01vorbis")?;
        (u32::from_le_bytes(b.get(i + 12..i + 16)?.try_into().ok()?) as f64, 0.0)
    };
    // The last page header: "OggS", version, flags, then the 64-bit granule position.
    let start = b.len().saturating_sub(65536);
    let last = (start..b.len().saturating_sub(14)).rev().find(|&i| &b[i..i + 4] == b"OggS")?;
    let granule = u64::from_le_bytes(b[last + 6..last + 14].try_into().ok()?);
    (rate > 0.0).then(|| ((granule as f64 - preskip) / rate).max(0.0))
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).take(4096).position(|w| w == n)
}

fn riff_chunk<'a>(b: &'a [u8], id: &[u8; 4]) -> Option<&'a [u8]> {
    let mut i = 12;
    while i + 8 <= b.len() {
        let n = u32::from_le_bytes(b[i + 4..i + 8].try_into().ok()?) as usize;
        if &b[i..i + 4] == id {
            return b.get(i + 8..(i + 8 + n).min(b.len()));
        }
        i += 8 + n + n % 2;
    }
    None
}
