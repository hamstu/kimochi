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
/// The dialogue text wrapper is in (`_voicehook_text_install`).
static TEXT_INSTALLED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
/// Last file started per channel number.
static LAST_FILE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<usize, String>>> =
    std::sync::LazyLock::new(Default::default);

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

def _voicehook_text_install():
    # The dialogue as shown: each say's text up to where it is shown so far (a `{w}`/`{p}` pause
    # shows a line in parts), with its speaker, sent as it is put on screen.
    import sys, re
    ch = sys.modules.get('renpy.character')
    rp = sys.modules.get('renpy')
    if ch is None or rp is None or not hasattr(ch, 'display_say'):
        return
    # Not while Ren'Py is still importing itself (it is started once its interface is up).
    if getattr(getattr(rp, 'game', None), 'interface', None) is None:
        return
    if getattr(ch, '_voicehook_text', False):
        return
    import ctypes, json
    dll = ctypes.CDLL(r'''{DLL}''')
    emit = dll.voicehook_emit
    emit.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
    emit.restype = ctypes.c_int
    try:
        text_type = unicode
    except NameError:
        text_type = str

    def send(meta):
        m = json.dumps(meta)
        if not isinstance(m, bytes):
            m = m.encode('utf-8')
        emit(m, b'', 0)

    tag_re = re.compile(r'\{\{|\{[^{}]*\}')
    # Text inside these is not drawn in the line: ruby readings (drawn above it) and alt text
    # (for screen readers only).
    hidden = ('rt', 'alt')

    def plain(s):
        # The text as drawn: text tags out, `{p}` a line break, nothing after `{done}` (laid out,
        # not shown: the rest of a line paused at `{w}`, or `extend`s still to come).
        if s is None:
            return None
        if not isinstance(s, text_type):
            try:
                s = s.decode('utf-8')
            except Exception:
                s = text_type(s)
        out = []
        hide = 0
        pos = 0
        for m in tag_re.finditer(s):
            if not hide:
                out.append(s[pos:m.start()])
            pos = m.end()
            t = m.group(0)
            if t == '{{':
                if not hide:
                    out.append('{')
                continue
            name = t[1:-1].split('=', 1)[0].strip()
            if name == 'done':
                pos = len(s)
                break
            if name in hidden:
                hide += 1
            elif name[:1] == '/' and name[1:] in hidden:
                hide = max(0, hide - 1)
            elif name == 'p' and not hide:
                out.append('\n')
        if not hide:
            out.append(s[pos:])
        return ''.join(out)

    stack = []

    def shown(st):
        # The `what` widget's text up to where display_say has it shown (`end`), when it holds
        # what display_say gave it; else all of what was given.
        w = st.get('w')
        if isinstance(w, tuple):
            try:
                w = rp.display.screen.get_widget(w[0], w[1], w[2])
            except Exception:
                w = None
        given = st.get('given')
        t = getattr(w, 'text', None)
        if isinstance(t, list) and t and isinstance(t[0], (text_type, str)) and given is not None and t[0].startswith(given):
            end = getattr(w, 'end', None)
            return t[0][:end] if end is not None else t[0]
        return given if given is not None else st['what']

    def on_event(event, interact=True, **kw):
        try:
            if event != 'show_done' or not stack:
                return
            st = stack[-1]
            st['seg'] += 1
            send({'op': 'text', 'obj': 'say', 'kind': str(kw.get('type', '')), 'seg': st['seg'],
                  'interact': bool(interact), 'who': plain(st['who']), 'text': plain(shown(st))})
        except Exception:
            pass

    orig = ch.display_say

    def display_say(who, what, show_function, *a, **k):
        st = {'who': who, 'what': what, 'w': None, 'given': None, 'seg': 0}

        def show(*sa, **sk):
            rv = show_function(*sa, **sk)
            try:
                st['w'] = rv
                st['given'] = sa[1] if len(sa) > 1 else sk.get('what')
            except Exception:
                pass
            return rv

        try:
            cbs = rp.config.all_character_callbacks
            if on_event not in cbs:
                rp.config.all_character_callbacks = list(cbs) + [on_event]
        except Exception:
            pass
        stack.append(st)
        try:
            return orig(who, what, show, *a, **k)
        finally:
            stack.pop()

    ex = sys.modules.get('renpy.exports')
    orig_show_screen = getattr(ex, 'show_screen', None)
    # The choice menu last shown, sent as its interaction starts: Ren'Py 7 shows the menu screen
    # once per choice as it adds them, so only the last list is the menu.
    menu_shown = []

    def send_menu():
        try:
            if menu_shown:
                send(menu_shown.pop())
            del menu_shown[:]
        except Exception:
            pass

    def show_screen(_screen_name, *a, **k):
        # A choice menu: display_menu shows its screen with the choices as `items`, entries with a
        # `caption`. (Not by wrapping display_menu: the store holds it as `menu`, and a function of
        # ours in the store would be saved with the game.)
        try:
            items = k.get('items')
            if isinstance(items, list) and items and all(hasattr(i, 'caption') for i in items):
                labels = []
                for i in items:
                    label = i.caption
                    try:
                        label = rp.substitutions.substitute(label)[0]
                    except Exception:
                        pass
                    label = plain(label)
                    if label:
                        labels.append(label)
                if labels:
                    menu_shown[:] = [{'op': 'text', 'obj': 'menu', 'kind': 'menu', 'text': '\n'.join(labels)}]
                    cbs = rp.config.start_interact_callbacks
                    if send_menu not in cbs:
                        rp.config.start_interact_callbacks = list(cbs) + [send_menu]
        except Exception:
            pass
        return orig_show_screen(_screen_name, *a, **k)

    # Every Ren'Py module that holds display_say by name (renpy.exports imports it). Never the
    # store's: what is changed there is saved with the game.
    for name, m in list(sys.modules.items()):
        if m is None or not (name == 'renpy' or name.startswith('renpy.')):
            continue
        try:
            if getattr(m, 'display_say', None) is orig:
                m.display_say = display_say
        except Exception:
            pass
    if orig_show_screen is not None:
        ex.show_screen = show_screen
    ch._voicehook_text = True
    send({'op': 'text_installed', 'renpy': str(getattr(rp, 'version', '?'))})

def _voicehook_ready():
    # Ren'Py is up (its interface made, before any sound or line): never while it is still
    # importing itself, which running code beside it on another thread could break (a Ren'Py 8
    # game launched with the hook in quit within a second, before its log, now and then).
    import sys
    g = sys.modules.get('renpy.game')
    return g is not None and getattr(g, 'interface', None) is not None

def _voicehook_error(where):
    # Each different failure once, to the log.
    try:
        import sys, traceback, ctypes, json
        e = traceback.format_exc()[-800:]
        seen = sys.__dict__.setdefault('_voicehook_errors', set())
        if e in seen:
            return
        seen.add(e)
        m = json.dumps({'op': 'error', 'where': where, 'error': e})
        if not isinstance(m, bytes):
            m = m.encode('utf-8')
        ctypes.CDLL(r'''{DLL}''').voicehook_emit(m, b'', 0)
    except Exception:
        pass

if _voicehook_ready():
    try:
        _voicehook_install()
    except Exception:
        _voicehook_error('audio')
    try:
        _voicehook_text_install()
    except Exception:
        _voicehook_error('text')
"#####;

struct Py {
    is_initialized: unsafe extern "C" fn() -> i32,
    gil_ensure: unsafe extern "C" fn() -> i32,
    gil_release: unsafe extern "C" fn(i32),
    run_simple_string: unsafe extern "C" fn(*const c_char) -> i32,
    /// `PyEval_ThreadsInitialized` (Python 2.7 to 3.12): before the game starts a thread, Python 2
    /// has no GIL, and taking it from ours while the game runs Python crashes the game. Always
    /// there from 3.7 (and gone in 3.13).
    threads_initialized: Option<unsafe extern "C" fn() -> i32>,
}

/// Called the first time a Python runtime module is seen (see `iat::on_module`).
pub fn on_python(m: HMODULE, name: &str) {
    if STARTED.load(Ordering::SeqCst) {
        return;
    }
    let sym = |n: &CStr| unsafe { crate::iat::real_gpa(m, n) };
    let (a, b, c, d) =
        (sym(c"Py_IsInitialized"), sym(c"PyGILState_Ensure"), sym(c"PyGILState_Release"), sym(c"PyRun_SimpleString"));
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
            threads_initialized: Some(sym(c"PyEval_ThreadsInitialized"))
                .filter(|&f| f != 0)
                .map(|f| std::mem::transmute::<usize, unsafe extern "C" fn() -> i32>(f)),
        }
    };
    let dll = crate::util::module_path(crate::MODULE.load(Ordering::SeqCst) as HMODULE);
    let code = PATCH.replace("{DLL}", &dll.display().to_string());
    let code = CString::new(code).unwrap();
    let name = name.to_string();
    log(&format!("renpy: Python runtime {name}; waiting for renpy.audio"));
    std::thread::spawn(move || {
        // Ren'Py imports renpy.audio a few seconds in; keep trying for 10 minutes. Once in, the
        // patch runs again now and then: it does nothing while its wrappers are in place, and puts
        // them back after Ren'Py reloads its modules (which restores them to how they were).
        let mut i = 0u32;
        loop {
            let both = INSTALLED.load(Ordering::SeqCst) && TEXT_INSTALLED.load(Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(if both {
                2000
            } else if i < 60 {
                250
            } else {
                500
            }));
            i = i.saturating_add(1);
            if !both && i >= 1200 {
                break;
            }
            unsafe {
                if (py.is_initialized)() == 0 || py.threads_initialized.is_some_and(|f| f() == 0) {
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
            log(&format!(
                "renpy: installed (Ren'Py {}, Python {}), channels {}",
                meta["renpy"], meta["python"], meta["channels"]
            ));
            sink::send(Ev::Note(
                json!({"ev": "adapter", "adapter": "renpy", "renpy": meta["renpy"], "python": meta["python"], "channels": meta["channels"]}),
            ));
            return;
        }
        if op == "error" {
            log(&format!("renpy: {} patch failed: {}", meta["where"].as_str().unwrap_or("?"), meta["error"].as_str().unwrap_or("")));
            return;
        }
        if op == "text_installed" {
            TEXT_INSTALLED.store(true, Ordering::SeqCst);
            log(&format!("renpy: dialogue text wrapped (Ren'Py {})", meta["renpy"]));
            sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "renpy-text", "renpy": meta["renpy"]})));
            return;
        }
        if op == "text" {
            // Under Kimochi, only when it asked for the game's text (as for Unity's).
            if sink::app_mode() && !crate::unity::text_wanted() {
                return;
            }
            sink::send(Ev::Note(json!({
                "ev": "text", "api": "renpy", "method": "renpy.say", "t": now_ms(),
                "obj": meta["obj"], "kind": meta["kind"], "seg": meta["seg"], "interact": meta["interact"],
                "who": meta["who"], "text": meta["text"],
            })));
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
