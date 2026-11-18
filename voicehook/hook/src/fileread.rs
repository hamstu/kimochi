//! File reads: the voice file as the game loads it from disk, for engines that mix every sound
//! themselves and play the mix through one stream (AliceSoft System4: one DirectSound buffer for
//! everything), where no audio API sees a voice on its own.
//!
//! How: `CreateFileW`/`CreateFileA` are hooked through the callers' import tables (see `iat`), and
//! the handles of files whose path names voices (`voice`, `koe`, `ボイス`...) are kept. A
//! `ReadFile` on one of them that starts with an Ogg page (`OggS`) or a WAV header (`RIFF…WAVE`)
//! starts a clip; later reads on the handle add to it until the Ogg stream ends (its last page) or
//! the WAV's size is reached. The clip is the original file, timed at its first read, which is
//! when the engine starts decoding it to play. Reads that start mid-file, and archives that
//! compress or encrypt their entries, give nothing; such engines are left to the other adapters.
//!
//! Chromium-based games (Electron, NW.js: TyranoScript, RPG Maker MV/MZ) play sounds through Web
//! Audio or `<audio>` in a sandboxed renderer, which then plays the mix through Chromium's audio
//! service: no audio API sees a voice on its own, and the DLL cannot load in the renderer. But the
//! renderer asks the browser process for every sound by URL, and the browser process reads it from
//! disk with `ReadFile` (a synchronous handle, the offset passed in an `OVERLAPPED`), at the moment
//! the game loads it to play. So in the browser process:
//! - reads of `app.asar` (Electron) that start where an audio entry starts are that sound: the
//!   entry, named by its path in the archive, is read whole from the archive (`asar`);
//! - in a Chromium game (its Chromium resource packs next to the exe), any audio file read from
//!   its first byte is a sound, named by its path under the game's folder;
//! - RPG Maker's encrypted audio is decrypted with the key in the game's `System.json`.
//!
//! Each becomes one clip, named for its file, so the classifier groups them by folder (and a
//! name that says voice puts a sound in a `voice` group of its own).
use crate::asar::{self, Archive};
use crate::iat::{self, Hook};
use crate::sink::{self, Ev};
use crate::util::{guard, lock};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

static O_CREATE_W: AtomicUsize = AtomicUsize::new(0);
static O_CREATE_A: AtomicUsize = AtomicUsize::new(0);
static O_READ: AtomicUsize = AtomicUsize::new(0);
static O_CLOSE: AtomicUsize = AtomicUsize::new(0);

/// A voice file opened by the game: its name, and the clip being read from it.
struct Open {
    name: String,
    clip: Option<Partial>,
    clips: u64,
    /// A sound file of a Chromium game (one sound per file): its path under the game's folder,
    /// and its full path (for RPG Maker's key).
    web: Option<(String, String)>,
}

/// Archives (`app.asar`) the game has open, by handle.
static ASARS: LazyLock<Mutex<HashMap<usize, Arc<Archive>>>> = LazyLock::new(Default::default);
/// Sounds sent from archives lately, by archive and offset (a sound read twice in a row, as a
/// media element's range requests do, is one play).
static ASAR_SENT: LazyLock<Mutex<HashMap<(usize, u64), f64>>> = LazyLock::new(Default::default);
static WEB_CLIPS: AtomicUsize = AtomicUsize::new(0);

/// The game's folder, if it is a Chromium-based game (Electron, NW.js, CEF): Chromium's resource
/// packs are next to its executable.
fn chromium_dir() -> Option<&'static str> {
    static DIR: OnceLock<Option<String>> = OnceLock::new();
    DIR.get_or_init(|| {
        let exe = crate::util::module_path(std::ptr::null_mut());
        let dir = exe.parent()?;
        let packs = ["resources.pak", "nw.pak", "chrome_100_percent.pak", "nw_100_percent.pak", "cef.pak"];
        packs.iter().any(|p| dir.join(p).is_file()).then(|| {
            let d = dir.display().to_string().to_lowercase().replace('/', "\\");
            crate::util::log(&format!("file: a Chromium-based game in {d}: its sound files are watched"));
            d
        })
    })
    .as_deref()
}

/// A Chromium game's sound file, as a path under its folder (`www/audio/voice/a1.rpgmvo`).
fn web_sound(path: &str) -> Option<String> {
    let dir = chromium_dir()?;
    let p = path.trim_start_matches(r"\\?\").replace('/', "\\");
    let lower = p.to_lowercase();
    if lower.len() != p.len() || !lower.starts_with(dir) || lower.as_bytes().get(dir.len()) != Some(&b'\\') {
        return None;
    }
    let rel = p.get(dir.len() + 1..)?.replace('\\', "/");
    asar::is_audio(&rel).then_some(rel)
}

struct Partial {
    bytes: Vec<u8>,
    at: f64,
    kind: Kind,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Ogg,
    /// The whole file's length, from its RIFF header.
    Wav(usize),
}

static OPEN: LazyLock<Mutex<HashMap<usize, Open>>> = LazyLock::new(Default::default);
/// Files and kinds of read already logged, once each.
static LOGGED: LazyLock<Mutex<std::collections::HashSet<String>>> = LazyLock::new(Default::default);
/// A clip larger than this is music or a whole archive read at once, not a voice.
const MAX_CLIP_BYTES: usize = 8 << 20;

pub fn register() {
    let hooks: [(&'static str, usize, &'static AtomicUsize); 4] = [
        ("CreateFileW", create_w as *const () as usize, &O_CREATE_W),
        ("CreateFileA", create_a as *const () as usize, &O_CREATE_A),
        ("ReadFile", read as *const () as usize, &O_READ),
        ("CloseHandle", close as *const () as usize, &O_CLOSE),
    ];
    for (name, hook, orig) in hooks {
        // Imported from kernel32, or through the API sets newer toolchains link against.
        for dll in ["kernel32", "api-ms-win-core-file", "api-ms-win-core-handle"] {
            iat::register(Hook { dll, name, hook, orig });
        }
    }
}

/// Whether a path names voice files: a voice folder or archive.
pub(crate) fn voice_path(path: &str) -> bool {
    let p = path.to_lowercase().replace('/', "\\");
    let file = p.rsplit('\\').next().unwrap_or(&p);
    let dirs = &p[..p.len() - file.len()];
    // Archives and folders named for voices; the file's own name for loose files.
    ["voice", "koe", "ボイス", "音声", "\\vo\\", "serif"].iter().any(|w| dirs.contains(w) || file.contains(w))
        && !["bgm", "music", "movie", ".exe", ".dll", ".ini", ".sav", "config"].iter().any(|w| file.contains(w))
}

type Create = unsafe extern "system" fn(*const c_void, u32, u32, *const c_void, u32, u32, *mut c_void) -> *mut c_void;

unsafe extern "system" fn create_w(
    name: *const u16,
    access: u32,
    share: u32,
    sa: *const c_void,
    disp: u32,
    flags: u32,
    tmpl: *mut c_void,
) -> *mut c_void {
    let o: Create = std::mem::transmute(O_CREATE_W.load(Ordering::SeqCst));
    let h = o(name as *const c_void, access, share, sa, disp, flags, tmpl);
    guard(|| unsafe {
        if !name.is_null() {
            let len = (0..).take_while(|&i| *name.add(i) != 0).count();
            opened(h, String::from_utf16_lossy(std::slice::from_raw_parts(name, len)));
        }
    });
    h
}

unsafe extern "system" fn create_a(
    name: *const u8,
    access: u32,
    share: u32,
    sa: *const c_void,
    disp: u32,
    flags: u32,
    tmpl: *mut c_void,
) -> *mut c_void {
    let o: Create = std::mem::transmute(O_CREATE_A.load(Ordering::SeqCst));
    let h = o(name as *const c_void, access, share, sa, disp, flags, tmpl);
    guard(|| unsafe {
        if !name.is_null() {
            let bytes = std::ffi::CStr::from_ptr(name as *const std::ffi::c_char).to_bytes();
            opened(h, crate::util::from_ansi(bytes));
        }
    });
    h
}

fn opened(h: *mut c_void, path: String) {
    const INVALID: usize = usize::MAX;
    if h.is_null() || h as usize == INVALID {
        return;
    }
    if path.to_ascii_lowercase().ends_with(".asar") {
        if let Some(a) = asar::archive(&path) {
            lock(&ASARS).insert(h as usize, a);
        }
        return;
    }
    let web = web_sound(&path);
    if web.is_none() && !voice_path(&path) {
        return;
    }
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
    if web.is_none() && lock(&LOGGED).insert(name.clone()) {
        crate::util::log(&format!("file: watching reads of {path}"));
    }
    let web = web.map(|rel| (rel, path));
    lock(&OPEN).insert(h as usize, Open { name, clip: None, clips: 0, web });
}

unsafe extern "system" fn read(h: *mut c_void, buf: *mut u8, n: u32, got: *mut u32, ov: *mut c_void) -> i32 {
    let o: unsafe extern "system" fn(*mut c_void, *mut u8, u32, *mut u32, *mut c_void) -> i32 =
        std::mem::transmute(O_READ.load(Ordering::SeqCst));
    let ok = o(h, buf, n, got, ov);
    // A read that returned its data now: synchronous, or (`OVERLAPPED` on a synchronous handle,
    // as Chromium's `base::File::Read` does) at the offset it names. Reads still pending complete
    // later and are not looked at.
    if ok != 0 && !got.is_null() && *got > 0 {
        let len = *got as usize;
        let offset = if ov.is_null() {
            None
        } else {
            // OVERLAPPED: Internal, InternalHigh, then the offset's low and high halves.
            let p = (ov as *const u8).add(2 * std::mem::size_of::<usize>()) as *const u32;
            Some(u64::from(*p) | (u64::from(*p.add(1)) << 32))
        };
        guard(|| unsafe { known(h) });
        if let Some(a) = lock(&ASARS).get(&(h as usize)).cloned() {
            guard(|| on_asar_read(h as usize, &a, offset.or_else(|| unsafe { before(h, len) })));
            return ok;
        }
        // A loose file read with an OVERLAPPED offset: only reads from its start, or that carry on
        // from where the clip being read is, are its bytes in order.
        guard(|| unsafe { on_read(h as usize, std::slice::from_raw_parts(buf, len), offset) });
    }
    ok
}

/// Where a synchronous read of `len` bytes on `h` started (the file pointer, moved past it).
unsafe fn before(h: *mut c_void, len: usize) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::{SetFilePointerEx, FILE_CURRENT};
    let mut pos = 0i64;
    (SetFilePointerEx(h, 0, &mut pos, FILE_CURRENT) != 0).then(|| (pos as u64).saturating_sub(len as u64))
}

/// A read of an archive at `offset`: if an audio entry starts there, the game is loading that
/// sound; it is read whole from the archive and sent as a clip.
fn on_asar_read(h: usize, a: &Arc<Archive>, offset: Option<u64>) {
    let Some(offset) = offset else { return };
    let Some(e) = a.at(offset).filter(|e| asar::is_audio(&e.path)) else { return };
    let now = crate::util::now_ms();
    {
        let id = Arc::as_ptr(a) as usize;
        let mut sent = lock(&ASAR_SENT);
        sent.retain(|_, t| now - *t < 2000.0);
        if sent.insert((id, offset), now).is_some() {
            return;
        }
    }
    let _ = h;
    if e.size as usize > MAX_CLIP_BYTES {
        if lock(&LOGGED).insert(format!("big:{}", e.path)) {
            crate::util::log(&format!("asar: {} is {} bytes (music): not kept", e.path, e.size));
        }
        return;
    }
    let bytes = match a.read(e) {
        Ok(b) => b,
        Err(err) => {
            crate::util::log(&format!("asar: reading {}: {err}", e.path));
            return;
        }
    };
    let key = || a.rpgm_key();
    send_web(
        &e.path,
        bytes,
        now,
        key,
        json!({ "archive": a.path.file_name().map(|n| n.to_string_lossy().into_owned()), "entry": e.path }),
    );
}

/// Sends a Chromium game's sound file (`rel`: its path in the archive or under the game's folder)
/// as a clip started at `at`, if it is an Ogg or WAV (RPG Maker's decrypted with `key`).
fn send_web(rel: &str, bytes: Vec<u8>, at: f64, key: impl FnOnce() -> Option<[u8; 16]>, mut info: serde_json::Value) {
    let bytes = if bytes.starts_with(asar::RPGM_HEADER) {
        match key().and_then(|k| asar::rpgm_decrypt(&bytes, &k)) {
            Some(plain) => plain,
            None => {
                if lock(&LOGGED).insert("rpgm-key".into()) {
                    crate::util::log(&format!("file: {rel} is RPG Maker-encrypted and its key was not found"));
                }
                return;
            }
        }
    } else {
        bytes
    };
    let Some(kind) = starts_file(&bytes) else {
        if lock(&LOGGED).insert(format!("kind:{}", rel.rsplit('.').next().unwrap_or(""))) {
            let head: Vec<String> = bytes.iter().take(8).map(|b| format!("{b:02x}")).collect();
            crate::util::log(&format!(
                "file: {rel} is not Ogg or WAV ({}); sounds like it are not kept",
                head.join(" ")
            ));
        }
        return;
    };
    let (bytes, ext, dur) = match kind {
        Kind::Ogg => {
            let end = ogg_end(&bytes).unwrap_or(bytes.len());
            let b = bytes[..end].to_vec();
            let d = ogg_seconds(&b);
            (b, "ogg", d)
        }
        Kind::Wav(size) => {
            let b = bytes[..size.min(bytes.len())].to_vec();
            let d = wav_seconds(&b);
            (b, "wav", d)
        }
    };
    if says_voice(rel) {
        info["channel"] = json!("voice");
    }
    let n = WEB_CLIPS.fetch_add(1, Ordering::SeqCst);
    sink::send(Ev::Whole {
        key: (10, n),
        api: "file",
        fmt: Vec::new(),
        bytes,
        ext: Some(ext.into()),
        source: Some(rel.to_string()),
        dur,
        at: Some(at),
        info,
    });
}

/// Handles read from that were opened before we were in: their path, looked up once each.
static CHECKED: LazyLock<Mutex<std::collections::HashSet<usize>>> = LazyLock::new(Default::default);

/// A handle the game opened before we attached (an archive opened at start): watched from its
/// first read if its path names voices.
unsafe fn known(h: *mut c_void) {
    if lock(&OPEN).contains_key(&(h as usize)) || !lock(&CHECKED).insert(h as usize) {
        return;
    }
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buf = [0u16; 1024];
    let n = GetFinalPathNameByHandleW(h, buf.as_mut_ptr(), buf.len() as u32, 0) as usize;
    if n > 0 && n < buf.len() {
        opened(h, String::from_utf16_lossy(&buf[..n]));
    }
}

unsafe extern "system" fn close(h: *mut c_void) -> i32 {
    let o: unsafe extern "system" fn(*mut c_void) -> i32 = std::mem::transmute(O_CLOSE.load(Ordering::SeqCst));
    guard(|| {
        lock(&CHECKED).remove(&(h as usize));
        lock(&ASARS).remove(&(h as usize));
        if let Some(mut f) = lock(&OPEN).remove(&(h as usize)) {
            finish(&mut f, false);
        }
    });
    o(h)
}

fn on_read(h: usize, data: &[u8], offset: Option<u64>) {
    let mut open = lock(&OPEN);
    let Some(f) = open.get_mut(&h) else { return };
    if let Some((rel, path)) = f.web.clone() {
        // A Chromium game's sound file: one sound, read from its start to its end.
        if offset.unwrap_or(0) == 0 && f.clip.is_none() {
            f.clip = Some(Partial { bytes: Vec::new(), at: crate::util::now_ms(), kind: Kind::Ogg });
        }
        let Some(p) = f.clip.as_mut() else { return };
        if offset.is_some_and(|o| o != p.bytes.len() as u64) {
            return;
        }
        p.bytes.extend_from_slice(data);
        if p.bytes.len() > MAX_CLIP_BYTES {
            f.clip = None;
            return;
        }
        // Whole once the file's size is in (the browser reads to the end, then once more for 0).
        let size = file_size(h);
        if size.is_some_and(|s| p.bytes.len() as u64 >= s) {
            let p = f.clip.take().unwrap();
            f.clips += 1;
            drop(open);
            send_web(&rel, p.bytes, p.at, || asar::rpgm_key_near(&path), json!({}));
        }
        return;
    }
    if let Some(kind) = starts_file(data) {
        // A new file starts: whatever was being read is done.
        finish(f, false);
        f.clip = Some(Partial { bytes: Vec::new(), at: crate::util::now_ms(), kind });
    }
    let Some(p) = f.clip.as_mut() else {
        if lock(&LOGGED).insert(format!("read:{}", f.name)) {
            let head: Vec<String> = data.iter().take(8).map(|b| format!("{b:02x}")).collect();
            crate::util::log(&format!(
                "file: a read of {} ({} bytes) that starts no file: {}",
                f.name,
                data.len(),
                head.join(" ")
            ));
        }
        return;
    };
    p.bytes.extend_from_slice(data);
    let done = match p.kind {
        Kind::Ogg => ogg_end(&p.bytes).map(|end| p.bytes.truncate(end)).is_some(),
        Kind::Wav(size) => {
            if p.bytes.len() >= size {
                p.bytes.truncate(size);
                true
            } else {
                false
            }
        }
    };
    if done {
        finish(f, true);
    } else if p.bytes.len() > MAX_CLIP_BYTES {
        f.clip = None;
    }
}

/// Sends the clip being read, if it is a whole file (`complete`) or an Ogg stream cut short.
fn finish(f: &mut Open, complete: bool) {
    let Some(p) = f.clip.take() else { return };
    if f.web.is_some() {
        // A Chromium game's sound closed before it was read to the end: not a whole sound.
        return;
    }
    let (ext, dur) = match p.kind {
        Kind::Ogg => ("ogg", ogg_seconds(&p.bytes)),
        Kind::Wav(_) => ("wav", wav_seconds(&p.bytes)),
    };
    if !complete && dur.is_none() {
        return;
    }
    f.clips += 1;
    let source = format!("{}#{}", f.name, f.clips);
    sink::send(Ev::Whole {
        key: (9, f.clips as usize),
        api: "file",
        fmt: Vec::new(),
        bytes: p.bytes,
        ext: Some(ext.into()),
        source: Some(source),
        dur,
        at: Some(p.at),
        info: json!({ "archive": f.name, "complete": complete }),
    });
}

/// Whether a sound's path says voice (its folder or name), for its clips' channel.
fn says_voice(rel: &str) -> bool {
    let l = format!("/{}", rel.to_lowercase());
    ["voice", "/vo/", "vo_", "_vo", "koe", "/v/", "voc_", "vox", "serif", "セリフ", "ボイス", "音声"]
        .iter()
        .any(|w| l.contains(w))
}

/// The size of the file open as `h`.
fn file_size(h: usize) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetFileSizeEx;
    let mut size = 0i64;
    (unsafe { GetFileSizeEx(h as *mut c_void, &mut size) } != 0).then_some(size as u64)
}

/// The kind of file `data` starts with.
fn starts_file(data: &[u8]) -> Option<Kind> {
    if data.len() >= 4 && &data[..4] == b"OggS" {
        return Some(Kind::Ogg);
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        let size = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize + 8;
        return Some(Kind::Wav(size));
    }
    None
}

/// The Ogg pages in `data`: (offset, header type, granule position, page length).
fn ogg_pages(data: &[u8]) -> impl Iterator<Item = (usize, u8, i64, usize)> + '_ {
    let mut at = 0;
    std::iter::from_fn(move || {
        if at + 27 > data.len() || &data[at..at + 4] != b"OggS" {
            return None;
        }
        let segments = data[at + 26] as usize;
        if at + 27 + segments > data.len() {
            return None;
        }
        let body: usize = data[at + 27..at + 27 + segments].iter().map(|&s| s as usize).sum();
        let len = 27 + segments + body;
        if at + len > data.len() {
            return None;
        }
        let page = (at, data[at + 5], i64::from_le_bytes(data[at + 6..at + 14].try_into().ok()?), len);
        at += len;
        Some(page)
    })
}

/// Where the Ogg stream at the start of `data` ends, once its last page (end of stream) is in.
fn ogg_end(data: &[u8]) -> Option<usize> {
    ogg_pages(data).find(|&(_, flags, _, _)| flags & 0x04 != 0).map(|(at, _, _, len)| at + len)
}

/// The length of a Vorbis or Opus stream: the last page's granule position over the sample rate.
fn ogg_seconds(data: &[u8]) -> Option<f64> {
    let first = ogg_pages(data).next()?;
    let body = &data[first.0 + 27 + data[first.0 + 26] as usize..first.0 + first.3];
    let rate = if body.len() >= 16 && &body[1..7] == b"vorbis" {
        u32::from_le_bytes(body[12..16].try_into().ok()?) as f64
    } else if body.starts_with(b"OpusHead") {
        48000.0
    } else {
        return None;
    };
    let last = ogg_pages(data).filter(|p| p.2 > 0).last()?;
    (rate > 0.0).then(|| last.2 as f64 / rate)
}

/// A WAV's length: its data chunk over the byte rate in its fmt chunk.
fn wav_seconds(data: &[u8]) -> Option<f64> {
    let mut at = 12;
    let mut byte_rate = 0u32;
    while at + 8 <= data.len() {
        let id = &data[at..at + 4];
        let size = u32::from_le_bytes(data[at + 4..at + 8].try_into().ok()?) as usize;
        if id == b"fmt " && at + 16 <= data.len() {
            byte_rate = u32::from_le_bytes(data[at + 16..at + 20].try_into().ok()?);
        } else if id == b"data" && byte_rate > 0 {
            return Some(size as f64 / byte_rate as f64);
        }
        at += 8 + size + (size & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An Ogg page: header type, granule, one body segment.
    fn page(flags: u8, granule: i64, body: &[u8]) -> Vec<u8> {
        let mut p = b"OggS".to_vec();
        p.push(0);
        p.push(flags);
        p.extend_from_slice(&granule.to_le_bytes());
        p.extend_from_slice(&[0; 12]);
        p.push(1);
        p.push(body.len() as u8);
        p.extend_from_slice(body);
        p
    }

    fn vorbis_head(rate: u32) -> Vec<u8> {
        let mut b = vec![1];
        b.extend_from_slice(b"vorbis");
        b.extend_from_slice(&[0, 0, 0, 0, 1]);
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&[0; 14]);
        b
    }

    #[test]
    fn an_ogg_stream_ends_at_its_last_page_and_has_its_length() {
        let mut data = page(0x02, 0, &vorbis_head(44100));
        data.extend(page(0, 44100, b"audio"));
        let end = data.len() + page(0x04, 88200, b"end").len();
        data.extend(page(0x04, 88200, b"end"));
        data.extend_from_slice(b"OggS-next file in the archive");
        assert_eq!(ogg_end(&data), Some(end));
        assert_eq!(ogg_seconds(&data[..end]), Some(2.0));
        assert_eq!(starts_file(&data), Some(Kind::Ogg));
        // Not yet in: no end.
        assert_eq!(ogg_end(&data[..end - 1]), None);
    }

    #[test]
    fn a_wav_has_its_size_and_length() {
        let mut w = b"RIFF".to_vec();
        w.extend_from_slice(&(36u32 + 8).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&[1, 0, 1, 0]);
        w.extend_from_slice(&8000u32.to_le_bytes());
        w.extend_from_slice(&16000u32.to_le_bytes());
        w.extend_from_slice(&[2, 0, 16, 0]);
        w.extend_from_slice(b"data");
        w.extend_from_slice(&8u32.to_le_bytes());
        w.extend_from_slice(&[0; 8]);
        assert_eq!(starts_file(&w), Some(Kind::Wav(52)));
        assert_eq!(wav_seconds(&w), Some(0.0005));
    }

    #[test]
    fn voice_files_are_told_apart_by_their_path() {
        assert!(voice_path("C:\\Games\\VN\\GameTrialVoice.afa"));
        assert!(voice_path("D:/vn/voice/ch01_0003.ogg"));
        assert!(voice_path("C:\\VN\\koe\\a.ovk"));
        assert!(!voice_path("C:\\VN\\GameTrialSound.afa"));
        assert!(!voice_path("C:\\VN\\voice\\bgm01.ogg"));
        assert!(!voice_path("C:\\VN\\VoiceConfig.ini"));
    }
}
