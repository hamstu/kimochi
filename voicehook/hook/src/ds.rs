//! DirectSound: every secondary buffer is a stream. Data is taken at `Unlock` (what the game
//! just wrote), playback from `Play`/`Stop`, and the buffer's end from its last `Release`.
//!
//! Install: create our own devices (DirectSoundCreate8 and DirectSoundCreate) and a few kinds
//! of secondary buffer, and patch their vtables. Buffers the game creates later of a class we did
//! not anticipate are patched as they come out of the (hooked) CreateSoundBuffer /
//! DuplicateSoundBuffer / QueryInterface.
use crate::sink::{self, Ev, Key};
use crate::util::{copy_in, guard, hex, lock, log, wide};
use crate::{internal, vt};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::{LazyLock, Mutex};
use vh_common::ds::*;
use vh_common::*;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows_sys::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

/// Buffers seen: pointer → is the primary buffer (never recorded).
static KNOWN: LazyLock<Mutex<HashMap<usize, bool>>> = LazyLock::new(Default::default);
/// Buffers whose contents we have seen written (or read back).
static HAS_DATA: LazyLock<Mutex<std::collections::HashSet<usize>>> = LazyLock::new(Default::default);
/// Last Lock per buffer: (offset, first pointer), to log where each Unlock wrote.
static LOCKS: LazyLock<Mutex<HashMap<usize, (u32, usize)>>> = LazyLock::new(Default::default);

type FnQi = unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT;
type FnRelease = unsafe extern "system" fn(*mut c_void) -> u32;
type FnCreateSb = unsafe extern "system" fn(*mut c_void, *const DSBUFFERDESC, *mut *mut c_void, *mut c_void) -> HRESULT;
type FnDup = unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT;
type FnLock = unsafe extern "system" fn(
    *mut c_void,
    u32,
    u32,
    *mut *mut c_void,
    *mut u32,
    *mut *mut c_void,
    *mut u32,
    u32,
) -> HRESULT;
type FnUnlock = unsafe extern "system" fn(*mut c_void, *mut c_void, u32, *mut c_void, u32) -> HRESULT;
type FnPlay = unsafe extern "system" fn(*mut c_void, u32, u32, u32) -> HRESULT;
type FnStop = unsafe extern "system" fn(*mut c_void) -> HRESULT;
type FnSetPos = unsafe extern "system" fn(*mut c_void, u32) -> HRESULT;
type FnCreate = unsafe extern "system" fn(*const GUID, *mut *mut c_void, *mut c_void) -> HRESULT;

fn key(p: *mut c_void) -> Key {
    (1, p as usize)
}

macro_rules! original {
    ($this:expr, $idx:expr, $kind:expr, $ty:ty, $fail:expr) => {{
        let o = vt::orig($this, $idx, $kind);
        if o == 0 {
            return $fail;
        }
        std::mem::transmute::<usize, $ty>(o)
    }};
}

unsafe fn hook_device(dev: *mut c_void) {
    let v = vt::vtable(dev);
    vt::hook(v, QUERY_INTERFACE, vt::DS_DEVICE, dev_qi as *const () as usize);
    vt::hook(v, CREATE_SOUND_BUFFER, vt::DS_DEVICE, dev_create_sound_buffer as *const () as usize);
    vt::hook(v, DUPLICATE_SOUND_BUFFER, vt::DS_DEVICE, dev_duplicate as *const () as usize);
}

unsafe fn hook_buffer(buf: *mut c_void) {
    let v = vt::vtable(buf);
    vt::hook(v, QUERY_INTERFACE, vt::DS_BUFFER, buf_qi as *const () as usize);
    vt::hook(v, RELEASE, vt::DS_BUFFER, buf_release as *const () as usize);
    vt::hook(v, LOCK, vt::DS_BUFFER, buf_lock as *const () as usize);
    vt::hook(v, PLAY, vt::DS_BUFFER, buf_play as *const () as usize);
    vt::hook(v, SET_CURRENT_POSITION, vt::DS_BUFFER, buf_set_position as *const () as usize);
    vt::hook(v, STOP, vt::DS_BUFFER, buf_stop as *const () as usize);
    vt::hook(v, UNLOCK, vt::DS_BUFFER, buf_unlock as *const () as usize);
}

unsafe fn get_format(buf: *mut c_void) -> Vec<u8> {
    let mut b = [0u8; 512];
    let mut size = 0u32;
    // Slot 5 is never patched: the vtable holds the original.
    let hr = vcall!(buf, GET_FORMAT, fn(*mut u8, u32, *mut u32) -> HRESULT, b.as_mut_ptr(), b.len() as u32, &mut size);
    if hr < 0 {
        return Vec::new();
    }
    let n = (size as usize).clamp(16, b.len());
    let mut v = b[..n].to_vec();
    if v.len() < 18 {
        v.resize(18, 0);
    }
    v
}

/// Records a buffer we have not seen being created (made before injection, or by a path we do
/// not hook). False for the primary buffer.
unsafe fn ensure_known(buf: *mut c_void) -> bool {
    if let Some(&primary) = lock(&KNOWN).get(&(buf as usize)) {
        return !primary;
    }
    // Its size and flags, as a creation would have told: a buffer refilled past its size is a
    // stream ring, not a loop (KiriKiri streams voices through a 1 s ring), which the sink can
    // only tell knowing the size. Kimochi attaches to games already running, so this is usual.
    let mut caps = DSBCAPS {
        dwSize: std::mem::size_of::<DSBCAPS>() as u32,
        dwFlags: 0,
        dwBufferBytes: 0,
        dwUnlockTransferRate: 0,
        dwPlayCpuOverhead: 0,
    };
    // Slot 3 is never patched: the vtable holds the original.
    let known = vcall!(buf, GET_CAPS, fn(*mut DSBCAPS) -> HRESULT, &mut caps) >= 0;
    let primary = known && caps.dwFlags & DSBCAPS_PRIMARYBUFFER != 0;
    lock(&KNOWN).insert(buf as usize, primary);
    if primary {
        return false;
    }
    let info = if known {
        json!({"lazy": true, "flags": caps.dwFlags, "buffer_bytes": caps.dwBufferBytes})
    } else {
        json!({"lazy": true})
    };
    sink::send(Ev::Create { key: key(buf), api: "dsound", fmt: get_format(buf), info });
    true
}

unsafe extern "system" fn dev_qi(this: *mut c_void, riid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    let f = original!(this, QUERY_INTERFACE, vt::DS_DEVICE, FnQi, E_FAIL);
    let hr = f(this, riid, out);
    if hr >= 0 && !riid.is_null() && !out.is_null() && !(*out).is_null() {
        let iid = *riid;
        if iid == IID_IDIRECTSOUND || iid == IID_IDIRECTSOUND8 {
            hook_device(*out);
        }
    }
    hr
}

unsafe extern "system" fn dev_create_sound_buffer(
    this: *mut c_void,
    desc: *const DSBUFFERDESC,
    out: *mut *mut c_void,
    outer: *mut c_void,
) -> HRESULT {
    let f = original!(this, CREATE_SOUND_BUFFER, vt::DS_DEVICE, FnCreateSb, E_FAIL);
    let hr = f(this, desc, out, outer);
    if hr >= 0 && !desc.is_null() && !out.is_null() && !(*out).is_null() {
        let buf = *out;
        guard(|| {
            let d = &*desc;
            let primary = d.dwFlags & DSBCAPS_PRIMARYBUFFER != 0;
            lock(&KNOWN).insert(buf as usize, primary);
            if primary {
                if !internal() {
                    sink::send(Ev::Note(json!({"ev": "dsound_primary", "ptr": hex(buf as usize)})));
                }
                return;
            }
            hook_buffer(buf);
            if !internal() {
                let fmt = if d.lpwfxFormat.is_null() { get_format(buf) } else { wfx_bytes(d.lpwfxFormat) };
                sink::send(Ev::Create {
                    key: key(buf),
                    api: "dsound",
                    fmt,
                    info: json!({"flags": d.dwFlags, "buffer_bytes": d.dwBufferBytes}),
                });
            }
        });
    }
    hr
}

unsafe extern "system" fn dev_duplicate(this: *mut c_void, original: *mut c_void, out: *mut *mut c_void) -> HRESULT {
    let f = original!(this, DUPLICATE_SOUND_BUFFER, vt::DS_DEVICE, FnDup, E_FAIL);
    let hr = f(this, original, out);
    if hr >= 0 && !out.is_null() && !(*out).is_null() {
        let buf = *out;
        guard(|| {
            hook_buffer(buf);
            lock(&KNOWN).insert(buf as usize, false);
            if !internal() {
                sink::send(Ev::Create {
                    key: key(buf),
                    api: "dsound",
                    fmt: get_format(buf),
                    info: json!({"duplicate_of": hex(original as usize)}),
                });
            }
        });
    }
    hr
}

unsafe extern "system" fn buf_qi(this: *mut c_void, riid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    let f = original!(this, QUERY_INTERFACE, vt::DS_BUFFER, FnQi, E_FAIL);
    let hr = f(this, riid, out);
    if hr >= 0 && !riid.is_null() && !out.is_null() && !(*out).is_null() {
        let iid = *riid;
        // Only buffer interfaces share this layout (not IDirectSound3DBuffer, IKsPropertySet, ...).
        if (iid == IID_IDIRECTSOUNDBUFFER || iid == IID_IDIRECTSOUNDBUFFER8) && *out != this {
            let primary = lock(&KNOWN).get(&(this as usize)).copied().unwrap_or(false);
            if !primary {
                hook_buffer(*out);
            }
        }
    }
    hr
}

unsafe extern "system" fn buf_release(this: *mut c_void) -> u32 {
    let f = original!(this, RELEASE, vt::DS_BUFFER, FnRelease, 0);
    let refs = f(this);
    if refs == 0 {
        guard(|| {
            let was = lock(&KNOWN).remove(&(this as usize));
            lock(&LOCKS).remove(&(this as usize));
            lock(&HAS_DATA).remove(&(this as usize));
            if was == Some(false) && !internal() {
                sink::send(Ev::Destroy { key: key(this) });
            }
        });
    }
    refs
}

unsafe extern "system" fn buf_lock(
    this: *mut c_void,
    offset: u32,
    bytes: u32,
    p1: *mut *mut c_void,
    n1: *mut u32,
    p2: *mut *mut c_void,
    n2: *mut u32,
    flags: u32,
) -> HRESULT {
    let f = original!(this, LOCK, vt::DS_BUFFER, FnLock, E_FAIL);
    let hr = f(this, offset, bytes, p1, n1, p2, n2, flags);
    if hr >= 0 && !p1.is_null() && !internal() {
        let off = if flags & DSBLOCK_ENTIREBUFFER != 0 { 0 } else { offset };
        lock(&LOCKS).insert(this as usize, (off, *p1 as usize));
    }
    hr
}

unsafe extern "system" fn buf_unlock(this: *mut c_void, p1: *mut c_void, n1: u32, p2: *mut c_void, n2: u32) -> HRESULT {
    let f = original!(this, UNLOCK, vt::DS_BUFFER, FnUnlock, E_FAIL);
    if !internal() && (n1 > 0 || n2 > 0) {
        // Copied before the original Unlock: the bytes the game just wrote.
        guard(|| {
            if !ensure_known(this) {
                return;
            }
            let mut bytes = Vec::with_capacity((n1 + n2) as usize);
            if !p1.is_null() && n1 > 0 {
                bytes.extend(copy_in(p1 as *const u8, n1 as usize, "dsound unlock"));
            }
            if !p2.is_null() && n2 > 0 {
                bytes.extend(copy_in(p2 as *const u8, n2 as usize, "dsound unlock"));
            }
            lock(&HAS_DATA).insert(this as usize);
            let off = lock(&LOCKS).get(&(this as usize)).filter(|l| l.1 == p1 as usize).map(|l| l.0);
            sink::send(Ev::Data {
                key: key(this),
                bytes,
                eos: false,
                looping: false,
                region: None,
                info: json!({"off": off, "wrap": n2}),
            });
        });
    }
    f(this, p1, n1, p2, n2)
}

unsafe extern "system" fn buf_play(this: *mut c_void, reserved: u32, priority: u32, flags: u32) -> HRESULT {
    let f = original!(this, PLAY, vt::DS_BUFFER, FnPlay, E_FAIL);
    if !internal() {
        guard(|| {
            if ensure_known(this) {
                if flags & DSBPLAY_LOOPING == 0 && !lock(&HAS_DATA).contains(&(this as usize)) {
                    snapshot(this);
                }
                sink::send(Ev::Play {
                    key: key(this),
                    looping: flags & DSBPLAY_LOOPING != 0,
                    info: json!({"flags": flags, "priority": priority}),
                });
            }
        });
    }
    f(this, reserved, priority, flags)
}

/// A one-shot played whose contents we never saw written (loaded before we attached, or written
/// without Lock/Unlock): read the whole buffer back through the original Lock/Unlock.
unsafe fn snapshot(buf: *mut c_void) {
    let (lock_fn, unlock_fn) = (vt::orig(buf, LOCK, vt::DS_BUFFER), vt::orig(buf, UNLOCK, vt::DS_BUFFER));
    if lock_fn == 0 || unlock_fn == 0 {
        return;
    }
    let (lock_fn, unlock_fn): (FnLock, FnUnlock) = (std::mem::transmute(lock_fn), std::mem::transmute(unlock_fn));
    let (mut p1, mut n1, mut p2, mut n2) = (null_mut(), 0u32, null_mut(), 0u32);
    if lock_fn(buf, 0, 0, &mut p1, &mut n1, &mut p2, &mut n2, DSBLOCK_ENTIREBUFFER) < 0 || p1.is_null() {
        return;
    }
    let bytes = copy_in(p1 as *const u8, n1 as usize, "dsound snapshot");
    unlock_fn(buf, p1, n1, p2, n2);
    lock(&HAS_DATA).insert(buf as usize);
    sink::send(Ev::Data {
        key: key(buf),
        bytes,
        eos: false,
        looping: false,
        region: None,
        info: json!({"snapshot": true}),
    });
}

unsafe extern "system" fn buf_stop(this: *mut c_void) -> HRESULT {
    let f = original!(this, STOP, vt::DS_BUFFER, FnStop, E_FAIL);
    if !internal() {
        guard(|| {
            if ensure_known(this) {
                sink::send(Ev::Stop { key: key(this) });
            }
        });
    }
    f(this)
}

unsafe extern "system" fn buf_set_position(this: *mut c_void, pos: u32) -> HRESULT {
    let f = original!(this, SET_CURRENT_POSITION, vt::DS_BUFFER, FnSetPos, E_FAIL);
    if !internal() {
        guard(|| {
            if ensure_known(this) {
                sink::send(Ev::Mark { key: key(this), what: "seek", info: json!({"pos": pos}) });
            }
        });
    }
    f(this, pos)
}

/// Hooks DirectSound through dummy devices and buffers. Returns how many vtables were patched.
pub unsafe fn install() -> Result<usize, String> {
    let module = LoadLibraryW(wide("dsound.dll").as_ptr());
    if module.is_null() {
        return Err("dsound.dll did not load".into());
    }
    let mut devices = 0;
    for name in [c"DirectSoundCreate8", c"DirectSoundCreate"] {
        let Some(create) = GetProcAddress(module, name.as_ptr().cast()) else { continue };
        let create: FnCreate = std::mem::transmute(create);
        let mut dev = null_mut();
        let hr = create(std::ptr::null(), &mut dev, null_mut());
        if hr < 0 || dev.is_null() {
            log(&format!("dsound: {} failed ({hr:#x})", name.to_string_lossy()));
            continue;
        }
        devices += 1;
        hook_device(dev);
        vcall!(dev, SET_COOPERATIVE_LEVEL, fn(*mut c_void, u32) -> HRESULT, GetDesktopWindow(), DSSCL_PRIORITY);
        let mono = WAVEFORMATEX::pcm(1, 22050, 16);
        // The kinds of secondary buffer games make; each may be its own class.
        for flags in [
            DSBCAPS_GLOBALFOCUS
                | DSBCAPS_GETCURRENTPOSITION2
                | DSBCAPS_CTRLVOLUME
                | DSBCAPS_CTRLPAN
                | DSBCAPS_CTRLFREQUENCY,
            DSBCAPS_STATIC | DSBCAPS_CTRLVOLUME,
            DSBCAPS_CTRL3D | DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLFREQUENCY,
            DSBCAPS_CTRLFX | DSBCAPS_CTRLVOLUME,
        ] {
            let desc = DSBUFFERDESC {
                dwSize: std::mem::size_of::<DSBUFFERDESC>() as u32,
                dwFlags: flags,
                dwBufferBytes: mono.nAvgBytesPerSec,
                dwReserved: 0,
                lpwfxFormat: &mono,
                guid3DAlgorithm: GUID::default(),
            };
            let mut buf = null_mut();
            let hr = vcall!(
                dev,
                CREATE_SOUND_BUFFER,
                fn(*const DSBUFFERDESC, *mut *mut c_void, *mut c_void) -> HRESULT,
                &desc,
                &mut buf,
                null_mut()
            );
            if hr < 0 || buf.is_null() {
                log(&format!("dsound: dummy buffer {flags:#x} failed ({hr:#x})"));
                continue;
            }
            hook_buffer(buf);
            let mut buf8 = null_mut();
            if vcall!(
                buf,
                QUERY_INTERFACE,
                fn(*const GUID, *mut *mut c_void) -> HRESULT,
                &IID_IDIRECTSOUNDBUFFER8,
                &mut buf8
            ) >= 0
                && !buf8.is_null()
            {
                hook_buffer(buf8);
                vcall!(buf8, RELEASE, fn() -> u32);
            }
            vcall!(buf, RELEASE, fn() -> u32);
        }
        vcall!(dev, RELEASE, fn() -> u32);
    }
    if devices == 0 {
        return Err("no DirectSound device could be created (no audio output?)".into());
    }
    Ok(vt::count(vt::DS_DEVICE) + vt::count(vt::DS_BUFFER))
}
