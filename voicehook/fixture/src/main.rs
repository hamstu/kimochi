//! vh-fixture: plays a scripted scene through DirectSound and XAudio2 (2.9, 2.8, 2.7) the way
//! engines do (streamed looping BGM, SFX, voice lines as one-shots, pooled buffers, queued and
//! streamed chunks, a PlayBegin/PlayLength region), and checks a capture against it.
//!
//! ```text
//! vh-fixture play <expected.json> [ds] [dss] [xa9] [xa8] [xa7] [wo] [sdl]   (default: all)
//! vh-fixture check <capture dir> <expected.json>
//! ```
//! Each voice line is a distinct synthetic "speech" signal; `expected.json` holds the FNV hash of
//! its PCM (trailing zeros trimmed), and `check` passes when every line came out as a clip of
//! exactly those bytes: no BGM, no SFX, nothing missing.
#![allow(clippy::missing_safety_doc)]
use serde_json::{json, Value};
use std::f32::consts::TAU;
use std::ffi::{c_void, CString};
use std::process::ExitCode;
use std::ptr::{null, null_mut};
use std::thread::sleep;
use std::time::{Duration, Instant};
use vh_common::*;
use windows_sys::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows_sys::Win32::System::Console::GetConsoleWindow;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows_sys::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn ms(n: u64) {
    sleep(Duration::from_millis(n));
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
    }
}

/// Pseudo-speech: a wandering pitch with harmonics under a syllable envelope, plus breath noise.
fn voice_line(seed: u32, secs: f32, rate: u32) -> Vec<i16> {
    let n = (secs * rate as f32) as usize;
    let mut rng = Rng(seed as u64 * 7919 + 17);
    let (mut phase, s) = (0f32, seed as f32);
    let fade = rate as f32 * 0.02;
    (0..n)
        .map(|i| {
            let t = i as f32 / rate as f32;
            let f0 = 150.0 + 45.0 * (t * 2.3 + s).sin() + 12.0 * (t * 7.1 + s * 0.3).sin();
            phase = (phase + TAU * f0 / rate as f32) % TAU;
            let syllable = (0.5 - 0.5 * (TAU * (3.5 + (s % 3.0)) * t + s).cos()).powf(1.5);
            let mut v = 0.0;
            for h in 1..=10 {
                let formant = 1.0 / (1.0 + ((h as f32 * f0 - 700.0 - 200.0 * (s % 2.0)) / 500.0).powi(2));
                v += (phase * h as f32).sin() * formant / h as f32;
            }
            let edge = (i as f32 / fade).min((n - i) as f32 / fade).min(1.0);
            ((v * syllable + 0.03 * rng.next()) * edge * 12_000.0) as i16
        })
        .collect()
}

fn sfx(seed: u32, rate: u32) -> Vec<i16> {
    let n = rate as usize / 4;
    let mut rng = Rng(seed as u64 + 99);
    (0..n).map(|i| (rng.next() * (-(i as f32) / (n as f32 / 5.0)).exp() * 9000.0) as i16).collect()
}

/// A chord, continuous across calls (stereo interleaved).
struct Bgm {
    i: usize,
    rate: u32,
}
impl Bgm {
    fn fill(&mut self, out: &mut [i16]) {
        for frame in out.chunks_exact_mut(2) {
            let t = self.i as f32 / self.rate as f32;
            let v = [220.0f32, 277.2, 329.6].iter().map(|f| (TAU * f * t).sin()).sum::<f32>() * 2500.0;
            frame[0] = v as i16;
            frame[1] = (v * 0.8) as i16;
            self.i += 1;
        }
    }
}

fn bytes(v: &[i16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2) }
}

/// Bytes hashed as a line's "head": a clip that starts like a line but is not exactly it is a
/// duplicate fragment (a primed-and-discarded fill, or a line cut in pieces).
const HEAD: usize = 2048;

fn expect(api: &str, name: &str, pcm: &[i16], rate: u32) -> Value {
    let data = trim_zeros(bytes(pcm));
    json!({
        "api": api, "line": name, "hash": format!("{:016x}", fnv64(data)),
        "head": format!("{:016x}", fnv64(&data[..HEAD.min(data.len())])),
        "secs": pcm.len() as f64 / rate as f64,
    })
}

// ---------------------------------------------------------------- DirectSound

unsafe fn ds_buffer(dev: *mut c_void, fmt: &WAVEFORMATEX, size: u32, flags: u32) -> Result<*mut c_void, String> {
    let desc = DSBUFFERDESC {
        dwSize: std::mem::size_of::<DSBUFFERDESC>() as u32,
        dwFlags: flags,
        dwBufferBytes: size,
        dwReserved: 0,
        lpwfxFormat: fmt,
        guid3DAlgorithm: GUID::default(),
    };
    let mut buf = null_mut();
    let hr = vcall!(
        dev,
        ds::CREATE_SOUND_BUFFER,
        fn(*const DSBUFFERDESC, *mut *mut c_void, *mut c_void) -> HRESULT,
        &desc,
        &mut buf,
        null_mut()
    );
    if hr < 0 {
        return Err(format!("CreateSoundBuffer failed ({hr:#x})"));
    }
    Ok(buf)
}

/// Writes `data` at `offset` (wrapping), through Lock/Unlock.
unsafe fn ds_write(buf: *mut c_void, offset: u32, data: &[u8], entire: bool) -> Result<(), String> {
    let (mut p1, mut n1, mut p2, mut n2) = (null_mut::<c_void>(), 0u32, null_mut::<c_void>(), 0u32);
    let flags = if entire { ds::DSBLOCK_ENTIREBUFFER } else { 0 };
    let hr = vcall!(
        buf,
        ds::LOCK,
        fn(u32, u32, *mut *mut c_void, *mut u32, *mut *mut c_void, *mut u32, u32) -> HRESULT,
        offset,
        data.len() as u32,
        &mut p1,
        &mut n1,
        &mut p2,
        &mut n2,
        flags
    );
    if hr < 0 {
        return Err(format!("Lock failed ({hr:#x})"));
    }
    let a = (n1 as usize).min(data.len());
    std::ptr::copy_nonoverlapping(data.as_ptr(), p1 as *mut u8, a);
    if entire {
        std::ptr::write_bytes((p1 as *mut u8).add(a), 0, n1 as usize - a);
    }
    if !p2.is_null() && n2 > 0 {
        let b = (n2 as usize).min(data.len() - a);
        std::ptr::copy_nonoverlapping(data.as_ptr().add(a), p2 as *mut u8, b);
    }
    let hr = vcall!(buf, ds::UNLOCK, fn(*mut c_void, u32, *mut c_void, u32) -> HRESULT, p1, n1, p2, n2);
    if hr < 0 {
        return Err(format!("Unlock failed ({hr:#x})"));
    }
    Ok(())
}

unsafe fn play_ds(expected: &mut Vec<Value>) -> Result<(), String> {
    let m = LoadLibraryW(wide("dsound.dll").as_ptr());
    let create = GetProcAddress(m, c"DirectSoundCreate8".as_ptr().cast()).ok_or("no DirectSoundCreate8")?;
    let create: unsafe extern "system" fn(*const GUID, *mut *mut c_void, *mut c_void) -> HRESULT =
        std::mem::transmute(create);
    let mut dev = null_mut();
    let hr = create(null(), &mut dev, null_mut());
    if hr < 0 {
        return Err(format!("DirectSoundCreate8 failed ({hr:#x})"));
    }
    let mut hwnd = GetConsoleWindow();
    if hwnd.is_null() {
        hwnd = GetDesktopWindow();
    }
    vcall!(dev, ds::SET_COOPERATIVE_LEVEL, fn(*mut c_void, u32) -> HRESULT, hwnd, ds::DSSCL_PRIORITY);
    let common = ds::DSBCAPS_GLOBALFOCUS | ds::DSBCAPS_CTRLVOLUME;

    // BGM: a 1 s looping ring, refilled behind the play cursor.
    let stereo = WAVEFORMATEX::pcm(2, 44100, 16);
    let ring = stereo.nAvgBytesPerSec;
    let bgm = ds_buffer(dev, &stereo, ring, common | ds::DSBCAPS_GETCURRENTPOSITION2)?;
    vcall!(bgm, ds::SET_VOLUME, fn(i32) -> HRESULT, -1200);
    let mut gen = Bgm { i: 0, rate: 44100 };
    let mut chunk = vec![0i16; ring as usize / 2];
    gen.fill(&mut chunk);
    ds_write(bgm, 0, bytes(&chunk), false)?;
    let mut write_pos = 0u32;
    vcall!(bgm, ds::PLAY, fn(u32, u32, u32) -> HRESULT, 0, 0, ds::DSBPLAY_LOOPING);

    let mono = WAVEFORMATEX::pcm(1, 24000, 16);
    let sfx_fmt = WAVEFORMATEX::pcm(1, 22050, 16);
    let pool = ds_buffer(dev, &mono, mono.nAvgBytesPerSec * 6, common)?;
    let lines = [(0.5f32, 2.0f32, 0u32), (3.0, 2.5, 1), (6.0, 1.8, 2), (8.5, 2.2, 3)];
    // Line 5 is preloaded now and played near the end (engines that load a scene's voices up
    // front; and, attached mid-scene, a buffer whose data the hook never saw written).
    let pre = voice_line(105, 1.2, 24000);
    let preloaded = ds_buffer(dev, &mono, (pre.len() * 2) as u32, common | ds::DSBCAPS_STATIC)?;
    ds_write(preloaded, 0, bytes(&pre), false)?;
    let mut pre_played = false;
    let sfx_at = [1.2f32, 6.6, 9.4];
    let mut keep = Vec::new();
    let (mut next_line, mut next_sfx) = (0, 0);
    let start = Instant::now();
    while start.elapsed().as_secs_f32() < 12.0 {
        let t = start.elapsed().as_secs_f32();
        // Refill the BGM ring up to the play cursor.
        let (mut play, mut wr) = (0u32, 0u32);
        vcall!(bgm, ds::GET_CURRENT_POSITION, fn(*mut u32, *mut u32) -> HRESULT, &mut play, &mut wr);
        let free = ((play + ring - write_pos) % ring) & !3;
        if free > 0 {
            let mut c = vec![0i16; free as usize / 2];
            gen.fill(&mut c);
            ds_write(bgm, write_pos, bytes(&c), false)?;
            write_pos = (write_pos + free) % ring;
        }
        if next_line < lines.len() && t >= lines[next_line].0 {
            let (_, secs, n) = lines[next_line];
            let pcm = voice_line(100 + n, secs, 24000);
            let name = format!("line{}", n + 1);
            if n < 2 {
                // One-shot: a buffer per line, exactly its size.
                let b = ds_buffer(dev, &mono, (pcm.len() * 2) as u32, common | ds::DSBCAPS_STATIC)?;
                ds_write(b, 0, bytes(&pcm), false)?;
                vcall!(b, ds::PLAY, fn(u32, u32, u32) -> HRESULT, 0, 0, 0);
                keep.push(b);
                println!("  ds  {name}: one-shot buffer, {secs:.1} s");
            } else {
                // Pooled: the engine's voice channel, rewritten (rest zeroed) and replayed.
                ds_write(pool, 0, bytes(&pcm), true)?;
                vcall!(pool, ds::SET_CURRENT_POSITION, fn(u32) -> HRESULT, 0);
                vcall!(pool, ds::PLAY, fn(u32, u32, u32) -> HRESULT, 0, 0, 0);
                println!("  ds  {name}: pooled buffer, {secs:.1} s");
            }
            expected.push(expect("dsound", &name, &pcm, 24000));
            next_line += 1;
        }
        if !pre_played && t >= 10.2 {
            vcall!(preloaded, ds::PLAY, fn(u32, u32, u32) -> HRESULT, 0, 0, 0);
            expected.push(expect("dsound", "line5", &pre, 24000));
            println!("  ds  line5: preloaded at start, played now");
            keep.push(preloaded);
            pre_played = true;
        }
        if next_sfx < sfx_at.len() && t >= sfx_at[next_sfx] {
            let pcm = sfx(next_sfx as u32, 22050);
            let b = ds_buffer(dev, &sfx_fmt, (pcm.len() * 2) as u32, common)?;
            ds_write(b, 0, bytes(&pcm), false)?;
            vcall!(b, ds::PLAY, fn(u32, u32, u32) -> HRESULT, 0, 0, 0);
            keep.push(b);
            next_sfx += 1;
        }
        ms(20);
    }
    vcall!(bgm, ds::STOP, fn() -> HRESULT);
    vcall!(pool, ds::STOP, fn() -> HRESULT);
    for b in keep.into_iter().chain([bgm, pool]) {
        vcall!(b, ds::RELEASE, fn() -> u32);
    }
    vcall!(dev, ds::RELEASE, fn() -> u32);
    Ok(())
}

/// One sound streamed through its own looping two-half ring, the way SiglusEngine (and KiriKiri's
/// streaming WaveSoundBuffer) do it: prime both halves, Stop, rewind, prime half 0 again, Play
/// looping, rewrite half 1 at once, then refill each half as the play cursor leaves it; zeros
/// after the end, and Stop + Release once they have played.
struct DsStream {
    buf: *mut c_void,
    half: usize,
    data: Vec<u8>,
    pos: usize,
    /// The half to refill next (the one the cursor is not in).
    next: u32,
    zero_halves: u32,
    looped: bool,
}

impl DsStream {
    unsafe fn chunk(&mut self) -> Vec<u8> {
        let mut c = vec![0u8; self.half];
        if self.looped {
            for b in c.iter_mut() {
                *b = self.data[self.pos % self.data.len()];
                self.pos += 1;
            }
        } else {
            let n = self.half.min(self.data.len().saturating_sub(self.pos));
            c[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            if n == 0 {
                self.zero_halves += 1;
            }
        }
        c
    }

    unsafe fn start(
        dev: *mut c_void,
        fmt: &WAVEFORMATEX,
        half_secs: f32,
        data: Vec<u8>,
        looped: bool,
    ) -> Result<Self, String> {
        let align = fmt.nBlockAlign as usize;
        let half = (fmt.nAvgBytesPerSec as f32 * half_secs) as usize / align * align;
        let flags = ds::DSBCAPS_GLOBALFOCUS | ds::DSBCAPS_CTRLVOLUME | ds::DSBCAPS_GETCURRENTPOSITION2;
        let buf = ds_buffer(dev, fmt, (half * 2) as u32, flags)?;
        let mut s = DsStream { buf, half, data, pos: 0, next: 1, zero_halves: 0, looped };
        // Priming pass, thrown away.
        let (a, b) = (s.chunk(), s.chunk());
        ds_write(buf, 0, &a, false)?;
        ds_write(buf, half as u32, &b, false)?;
        vcall!(buf, ds::STOP, fn() -> HRESULT);
        vcall!(buf, ds::SET_CURRENT_POSITION, fn(u32) -> HRESULT, 0);
        s.pos = 0;
        s.zero_halves = 0;
        let a = s.chunk();
        ds_write(buf, 0, &a, false)?;
        vcall!(buf, ds::PLAY, fn(u32, u32, u32) -> HRESULT, 0, 0, ds::DSBPLAY_LOOPING);
        let b = s.chunk();
        ds_write(buf, half as u32, &b, false)?;
        s.next = 0;
        Ok(s)
    }

    /// Refills behind the cursor. True once it has played out and been released.
    unsafe fn pump(&mut self) -> Result<bool, String> {
        let (mut play, mut wr) = (0u32, 0u32);
        vcall!(self.buf, ds::GET_CURRENT_POSITION, fn(*mut u32, *mut u32) -> HRESULT, &mut play, &mut wr);
        let in_half = if (play as usize) < self.half { 0 } else { 1 };
        if in_half != self.next {
            if self.zero_halves >= 2 {
                self.release();
                return Ok(true);
            }
            let c = self.chunk();
            ds_write(self.buf, self.next * self.half as u32, &c, false)?;
            self.next = 1 - self.next;
        }
        Ok(false)
    }

    unsafe fn release(&mut self) {
        if !self.buf.is_null() {
            vcall!(self.buf, ds::STOP, fn() -> HRESULT);
            vcall!(self.buf, ds::RELEASE, fn() -> u32);
            self.buf = null_mut();
        }
    }
}

/// SiglusEngine/KiriKiri-style scene: BGM and every voice line streamed through rings.
unsafe fn play_dss(expected: &mut Vec<Value>) -> Result<(), String> {
    let m = LoadLibraryW(wide("dsound.dll").as_ptr());
    let create = GetProcAddress(m, c"DirectSoundCreate8".as_ptr().cast()).ok_or("no DirectSoundCreate8")?;
    let create: unsafe extern "system" fn(*const GUID, *mut *mut c_void, *mut c_void) -> HRESULT =
        std::mem::transmute(create);
    let mut dev = null_mut();
    if create(null(), &mut dev, null_mut()) < 0 {
        return Err("DirectSoundCreate8 failed".into());
    }
    let mut hwnd = GetConsoleWindow();
    if hwnd.is_null() {
        hwnd = GetDesktopWindow();
    }
    vcall!(dev, ds::SET_COOPERATIVE_LEVEL, fn(*mut c_void, u32) -> HRESULT, hwnd, ds::DSSCL_PRIORITY);
    let stereo = WAVEFORMATEX::pcm(2, 44100, 16);
    let mut chord = vec![0i16; 44100 * 2 * 3];
    Bgm { i: 0, rate: 44100 }.fill(&mut chord);
    let mut bgm = DsStream::start(dev, &stereo, 2.5, bytes(&chord).to_vec(), true)?;
    let mono = WAVEFORMATEX::pcm(1, 44100, 16);
    // Halves of 2.5 s (Siglus uses 4 s), longer than the hook's 2 s gap. (start s, length s, seed):
    // a line over three halves, one over two, and one shorter than a half.
    let lines = [(0.3f32, 6.0f32, 0u32), (8.0, 3.3, 1), (14.0, 0.7, 2)];
    let mut live: Vec<DsStream> = Vec::new();
    let mut next = 0;
    let start = Instant::now();
    while start.elapsed().as_secs_f32() < 19.0 {
        let t = start.elapsed().as_secs_f32();
        if next < lines.len() && t >= lines[next].0 {
            let (_, secs, n) = lines[next];
            let pcm = voice_line(300 + n, secs, 44100);
            let name = format!("line{}", n + 1);
            expected.push(expect("dsound", &format!("s{name}"), &pcm, 44100));
            println!("  dss s{name}: streamed through a ring, {secs:.1} s");
            live.push(DsStream::start(dev, &mono, 2.5, bytes(&pcm).to_vec(), false)?);
            next += 1;
        }
        bgm.pump()?;
        let mut i = 0;
        while i < live.len() {
            if live[i].pump()? {
                live.remove(i);
            } else {
                i += 1;
            }
        }
        ms(15);
    }
    for mut s in live.into_iter().chain([bgm]) {
        s.release();
    }
    vcall!(dev, ds::RELEASE, fn() -> u32);
    Ok(())
}

// ---------------------------------------------------------------- winmm waveOut

mod wo {
    use super::*;
    use windows_sys::Win32::Media::Audio::{
        waveOutClose, waveOutOpen, waveOutPrepareHeader, waveOutReset, waveOutUnprepareHeader, waveOutWrite,
        CALLBACK_NULL, HWAVEOUT, WAVEHDR, WAVE_MAPPER, WHDR_DONE,
    };

    pub struct Dev {
        h: HWAVEOUT,
        hdrs: Vec<Box<WAVEHDR>>,
        bufs: Vec<Vec<u8>>,
    }

    impl Dev {
        pub unsafe fn open(fmt: &WAVEFORMATEX) -> Result<Dev, String> {
            let mut h: HWAVEOUT = null_mut();
            let r = waveOutOpen(&mut h, WAVE_MAPPER, fmt as *const WAVEFORMATEX as *const _, 0, 0, CALLBACK_NULL);
            if r != 0 {
                return Err(format!("waveOutOpen failed ({r})"));
            }
            Ok(Dev { h, hdrs: Vec::new(), bufs: Vec::new() })
        }
        /// Queues `data` (the device plays queued buffers in order).
        pub unsafe fn write(&mut self, data: &[u8]) -> Result<(), String> {
            self.reap();
            let buf = data.to_vec();
            let mut hdr: Box<WAVEHDR> = Box::new(std::mem::zeroed());
            hdr.lpData = buf.as_ptr() as *mut u8;
            hdr.dwBufferLength = buf.len() as u32;
            waveOutPrepareHeader(self.h, &mut *hdr, std::mem::size_of::<WAVEHDR>() as u32);
            let r = waveOutWrite(self.h, &mut *hdr, std::mem::size_of::<WAVEHDR>() as u32);
            if r != 0 {
                return Err(format!("waveOutWrite failed ({r})"));
            }
            self.hdrs.push(hdr);
            self.bufs.push(buf);
            Ok(())
        }
        /// Buffers still queued.
        pub unsafe fn pending(&mut self) -> usize {
            self.reap();
            self.hdrs.len()
        }
        unsafe fn reap(&mut self) {
            let mut i = 0;
            while i < self.hdrs.len() {
                if self.hdrs[i].dwFlags & WHDR_DONE != 0 {
                    waveOutUnprepareHeader(self.h, &mut *self.hdrs[i], std::mem::size_of::<WAVEHDR>() as u32);
                    self.hdrs.remove(i);
                    self.bufs.remove(i);
                } else {
                    i += 1;
                }
            }
        }
        pub unsafe fn close(mut self) {
            waveOutReset(self.h);
            self.reap();
            waveOutClose(self.h);
        }
    }
}

/// Older engines: a waveOut device per sound (and a reused voice device), BGM streamed in chunks.
unsafe fn play_wo(expected: &mut Vec<Value>) -> Result<(), String> {
    let stereo = WAVEFORMATEX::pcm(2, 44100, 16);
    let mono = WAVEFORMATEX::pcm(1, 22050, 16);
    let mut bgm = wo::Dev::open(&stereo)?;
    let mut gen = Bgm { i: 0, rate: 44100 };
    let chunk_frames = 44100 / 4;
    let start = Instant::now();
    // (start s, secs, seed, own device?)
    let lines = [(0.3f32, 1.8f32, 0u32, true), (3.0, 2.2, 1, true), (6.0, 1.4, 2, false), (9.0, 1.6, 3, false)];
    let mut next = 0;
    let mut live: Vec<wo::Dev> = Vec::new();
    let mut shared = wo::Dev::open(&mono)?;
    while start.elapsed().as_secs_f32() < 12.0 {
        while bgm.pending() < 3 {
            let mut c = vec![0i16; chunk_frames * 2];
            gen.fill(&mut c);
            for s in c.iter_mut() {
                *s /= 3;
            }
            bgm.write(bytes(&c))?;
        }
        if next < lines.len() && start.elapsed().as_secs_f32() >= lines[next].0 {
            let (_, secs, n, own) = lines[next];
            let pcm = voice_line(500 + n, secs, 22050);
            let name = format!("wline{}", n + 1);
            let half = pcm.len() / 2;
            if own {
                let mut d = wo::Dev::open(&mono)?;
                d.write(bytes(&pcm[..half]))?;
                d.write(bytes(&pcm[half..]))?;
                live.push(d);
                println!("  wo  {name}: own device, {secs:.1} s");
            } else {
                shared.write(bytes(&pcm[..half]))?;
                shared.write(bytes(&pcm[half..]))?;
                println!("  wo  {name}: shared voice device, {secs:.1} s");
            }
            expected.push(expect("waveout", &name, &pcm, 22050));
            next += 1;
        }
        // A finished per-sound device is closed, as engines do.
        let mut i = 0;
        while i < live.len() {
            if live[i].pending() == 0 {
                live.remove(i).close();
            } else {
                i += 1;
            }
        }
        ms(20);
    }
    for d in live.into_iter().chain([bgm, shared]) {
        d.close();
    }
    Ok(())
}

// ---------------------------------------------------------------- SDL_mixer (loaded at run time)

/// ONScripter-style: SDL2_mixer chunks loaded from files and played on mixer channels, BGM as
/// music. The libraries come from `fixture-libs\<arch>` next to the exe (fetch-fixture-libs.ps1).
/// Expected bytes are each chunk's decoded buffer (what SDL_mixer plays), plus its file name.
unsafe fn play_sdl(expected: &mut Vec<Value>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir =
        exe.parent().unwrap().join("fixture-libs").join(if cfg!(target_pointer_width = "64") { "x64" } else { "x86" });
    let sdl = LoadLibraryW(wide(&dir.join("SDL2.dll").display().to_string()).as_ptr());
    let mix = LoadLibraryW(wide(&dir.join("SDL2_mixer.dll").display().to_string()).as_ptr());
    if sdl.is_null() || mix.is_null() {
        return Err(format!("SDL2/SDL2_mixer not found in {} (run fetch-fixture-libs.ps1)", dir.display()));
    }
    macro_rules! f {
        ($m:expr, $n:literal, $t:ty) => {
            std::mem::transmute::<_, $t>(GetProcAddress($m, concat!($n, "\0").as_ptr()).ok_or(concat!("no ", $n))?)
        };
    }
    let sdl_init = f!(sdl, "SDL_Init", unsafe extern "C" fn(u32) -> i32);
    let rw_from_file = f!(sdl, "SDL_RWFromFile", unsafe extern "C" fn(*const u8, *const u8) -> *mut c_void);
    let open = f!(mix, "Mix_OpenAudio", unsafe extern "C" fn(i32, u16, i32, i32) -> i32);
    let load_wav = f!(mix, "Mix_LoadWAV_RW", unsafe extern "C" fn(*mut c_void, i32) -> *mut [usize; 3]);
    let play = f!(mix, "Mix_PlayChannel", unsafe extern "C" fn(i32, *mut [usize; 3], i32) -> i32);
    let playing = f!(mix, "Mix_Playing", unsafe extern "C" fn(i32) -> i32);
    let load_mus = f!(mix, "Mix_LoadMUS", unsafe extern "C" fn(*const u8) -> *mut c_void);
    let play_mus = f!(mix, "Mix_PlayMusic", unsafe extern "C" fn(*mut c_void, i32) -> i32);
    let halt_mus = f!(mix, "Mix_HaltMusic", unsafe extern "C" fn() -> i32);
    let close = f!(mix, "Mix_CloseAudio", unsafe extern "C" fn());
    if sdl_init(0x10) != 0 {
        return Err("SDL_Init(AUDIO) failed".into());
    }
    if open(44100, 0x8010, 2, 1024) != 0 {
        return Err("Mix_OpenAudio failed".into());
    }
    let tmp = std::env::temp_dir().join(format!("vh-fixture-sdl-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let path = |n: &str| CString::new(tmp.join(n).display().to_string()).unwrap();
    let mut chord = vec![0i16; 44100 * 2 * 3];
    Bgm { i: 0, rate: 44100 }.fill(&mut chord);
    std::fs::write(tmp.join("bgm.wav"), wav_file(&chord, 2, 44100)).map_err(|e| e.to_string())?;
    let music = load_mus(path("bgm.wav").as_ptr().cast());
    if !music.is_null() {
        play_mus(music, -1);
    }
    let sfxp = sfx(9, 22050);
    std::fs::write(tmp.join("se.wav"), wav_file(&sfxp, 1, 22050)).map_err(|e| e.to_string())?;
    let se = load_wav(rw_from_file(path("se.wav").as_ptr().cast(), c"rb".as_ptr().cast()), 1);
    ms(300);
    for (i, secs) in [1.7f32, 2.3, 1.2].iter().enumerate() {
        let pcm = voice_line(600 + i as u32, *secs, 22050);
        let name = format!("v{}.wav", i + 1);
        std::fs::write(tmp.join(&name), wav_file(&pcm, 1, 22050)).map_err(|e| e.to_string())?;
        let chunk = load_wav(rw_from_file(path(&name).as_ptr().cast(), c"rb".as_ptr().cast()), 1);
        if chunk.is_null() {
            return Err(format!("Mix_LoadWAV {name} failed"));
        }
        // Mix_Chunk { int allocated; Uint8 *abuf; Uint32 alen; ... }: abuf at [1], alen in [2].
        let abuf = (*chunk)[1] as *const u8;
        let alen = ((*chunk)[2] & 0xffff_ffff) as usize;
        let decoded = std::slice::from_raw_parts(abuf, alen);
        let data = trim_zeros(decoded);
        expected.push(json!({
            "api": "sdl_mixer", "line": format!("sline{}", i + 1), "source": name,
            "hash": format!("{:016x}", fnv64(data)), "head": format!("{:016x}", fnv64(&data[..HEAD.min(data.len())])),
            "secs": *secs,
        }));
        let ch = play(1, chunk, 0); // the engine's voice channel
        println!("  sdl sline{}: {name} on channel {ch}, {secs:.1} s", i + 1);
        if i == 1 && !se.is_null() {
            play(-1, se, 0);
        }
        while playing(1) != 0 {
            ms(20);
        }
        ms(600);
    }
    halt_mus();
    ms(200);
    close();
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

// ---------------------------------------------------------------- XAudio2

unsafe fn xa_engine(ver: u8) -> Result<*mut c_void, String> {
    let mut engine = null_mut();
    if ver == 7 {
        let hr = CoCreateInstance(
            &CLSID_XAUDIO2_7 as *const GUID as *const _,
            null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_IXAUDIO2_7 as *const GUID as *const _,
            &mut engine,
        );
        if hr < 0 {
            return Err(format!("XAudio2 2.7 is not installed ({hr:#x})"));
        }
        let hr = vcall!(engine, xa::INITIALIZE_27, fn(u32, u32) -> HRESULT, 0, xa::DEFAULT_PROCESSOR);
        if hr < 0 {
            return Err(format!("Initialize failed ({hr:#x})"));
        }
    } else {
        let name = if ver == 9 { "xaudio2_9.dll" } else { "xaudio2_8.dll" };
        let m = LoadLibraryW(wide(name).as_ptr());
        if m.is_null() {
            return Err(format!("{name} is not available"));
        }
        let create = GetProcAddress(m, c"XAudio2Create".as_ptr().cast()).ok_or("no XAudio2Create")?;
        let create: unsafe extern "system" fn(*mut *mut c_void, u32, u32) -> HRESULT = std::mem::transmute(create);
        let hr = create(&mut engine, 0, xa::DEFAULT_PROCESSOR);
        if hr < 0 {
            return Err(format!("XAudio2Create failed ({hr:#x})"));
        }
    }
    Ok(engine)
}

unsafe fn xa_voice(engine: *mut c_void, v27: bool, fmt: &WAVEFORMATEX) -> Result<*mut c_void, String> {
    let mut voice = null_mut();
    let hr = vcall!(
        engine,
        xa::create_source_voice(v27),
        fn(*mut *mut c_void, *const WAVEFORMATEX, u32, f32, *mut c_void, *const c_void, *const c_void) -> HRESULT,
        &mut voice,
        fmt,
        0,
        2.0,
        null_mut(),
        null(),
        null()
    );
    if hr < 0 {
        return Err(format!("CreateSourceVoice failed ({hr:#x})"));
    }
    Ok(voice)
}

unsafe fn xa_submit(
    voice: *mut c_void,
    data: &[u8],
    eos: bool,
    play: Option<(u32, u32)>,
    loops: u32,
) -> Result<(), String> {
    let (begin, len) = play.unwrap_or((0, 0));
    let b = XAUDIO2_BUFFER {
        Flags: if eos { xa::END_OF_STREAM } else { 0 },
        AudioBytes: data.len() as u32,
        pAudioData: data.as_ptr(),
        PlayBegin: begin,
        PlayLength: len,
        LoopBegin: 0,
        LoopLength: 0,
        LoopCount: loops,
        pContext: null_mut(),
    };
    let hr = vcall!(voice, xa::SUBMIT_SOURCE_BUFFER, fn(*const XAUDIO2_BUFFER, *const c_void) -> HRESULT, &b, null());
    if hr < 0 {
        return Err(format!("SubmitSourceBuffer failed ({hr:#x})"));
    }
    Ok(())
}

unsafe fn play_xa(ver: u8, expected: &mut Vec<Value>) -> Result<(), String> {
    let api = format!("xaudio2.{ver}");
    let v27 = ver == 7;
    let engine = xa_engine(ver)?;
    let mut master = null_mut();
    let hr = if v27 {
        vcall!(
            engine,
            xa::create_mastering_voice(true),
            fn(*mut *mut c_void, u32, u32, u32, u32, *const c_void) -> HRESULT,
            &mut master,
            0,
            0,
            0,
            0,
            null()
        )
    } else {
        vcall!(
            engine,
            xa::create_mastering_voice(false),
            fn(*mut *mut c_void, u32, u32, u32, *const u16, *const c_void, u32) -> HRESULT,
            &mut master,
            0,
            0,
            0,
            null(),
            null(),
            6
        )
    };
    if hr < 0 {
        return Err(format!("CreateMasteringVoice failed ({hr:#x})"));
    }
    // Buffers must outlive playback: everything submitted is kept here until the end.
    let mut hold: Vec<Vec<i16>> = Vec::new();
    let seed = 200 + ver as u32 * 10;

    let stereo = WAVEFORMATEX::pcm(2, 44100, 16);
    let bgm = xa_voice(engine, v27, &stereo)?;
    vcall!(bgm, 12, fn(f32, u32) -> HRESULT, 0.3, 0); // SetVolume
    let mut chord = vec![0i16; 44100 * 2 * 2];
    Bgm { i: 0, rate: 44100 }.fill(&mut chord);
    xa_submit(bgm, bytes(&chord), true, None, xa::LOOP_INFINITE)?;
    hold.push(chord);
    vcall!(bgm, xa::START, fn(u32, u32) -> HRESULT, 0, 0);

    let mono = WAVEFORMATEX::pcm(1, 24000, 16);
    let voice = xa_voice(engine, v27, &mono)?;
    vcall!(voice, xa::START, fn(u32, u32) -> HRESULT, 0, 0);
    let sfx_voice = xa_voice(engine, v27, &WAVEFORMATEX::pcm(1, 22050, 16))?;
    vcall!(sfx_voice, xa::START, fn(u32, u32) -> HRESULT, 0, 0);

    ms(400);
    // Line 1: one buffer, END_OF_STREAM.
    let l1 = voice_line(seed + 1, 2.0, 24000);
    xa_submit(voice, bytes(&l1), true, None, 0)?;
    expected.push(expect(&api, "line1", &l1, 24000));
    println!("  {api} line1: one buffer");
    hold.push(l1);
    ms(700);
    let s1 = sfx(seed + 5, 22050);
    xa_submit(sfx_voice, bytes(&s1), true, None, 0)?;
    hold.push(s1);
    ms(1800);

    // Line 2: four chunks queued at once, END_OF_STREAM on the last.
    let l2 = voice_line(seed + 2, 2.4, 24000);
    let parts: Vec<Vec<i16>> = l2.chunks(l2.len().div_ceil(4)).map(|c| c.to_vec()).collect();
    for (i, p) in parts.iter().enumerate() {
        xa_submit(voice, bytes(p), i == parts.len() - 1, None, 0)?;
    }
    expected.push(expect(&api, "line2", &l2, 24000));
    println!("  {api} line2: four queued chunks");
    hold.extend(parts);
    hold.push(l2);
    ms(2900);

    // Line 3: streamed, a chunk submitted as the previous one plays.
    let l3 = voice_line(seed + 3, 2.2, 24000);
    let parts: Vec<Vec<i16>> = l3.chunks(24000 * 4 / 10).map(|c| c.to_vec()).collect();
    for (i, p) in parts.iter().enumerate() {
        xa_submit(voice, bytes(p), i == parts.len() - 1, None, 0)?;
        ms(320);
    }
    expected.push(expect(&api, "line3", &l3, 24000));
    println!("  {api} line3: streamed chunks");
    hold.extend(parts);
    hold.push(l3);
    let s2 = sfx(seed + 6, 22050);
    xa_submit(sfx_voice, bytes(&s2), true, None, 0)?;
    hold.push(s2);
    ms(1200);

    // Line 4: the line sits inside a larger buffer; PlayBegin/PlayLength pick it out.
    let l4 = voice_line(seed + 4, 1.6, 24000);
    let pad = 24000 * 3 / 10;
    let mut rng = Rng(seed as u64);
    let mut padded: Vec<i16> = (0..pad).map(|_| (rng.next() * 4000.0) as i16).collect();
    padded.extend_from_slice(&l4);
    padded.extend((0..pad).map(|_| (rng.next() * 4000.0) as i16));
    xa_submit(voice, bytes(&padded), true, Some((pad as u32, l4.len() as u32)), 0)?;
    expected.push(expect(&api, "line4", &l4, 24000));
    println!("  {api} line4: PlayBegin/PlayLength region");
    hold.push(padded);
    hold.push(l4);
    ms(2200);

    vcall!(bgm, xa::STOP, fn(u32, u32) -> HRESULT, 0, 0);
    vcall!(bgm, xa::FLUSH_SOURCE_BUFFERS, fn() -> HRESULT);
    for v in [bgm, voice, sfx_voice, master] {
        vcall!(v, xa::DESTROY_VOICE, fn() -> ());
    }
    vcall!(engine, xa::ENGINE_RELEASE, fn() -> u32);
    drop(hold);
    Ok(())
}

// ---------------------------------------------------------------- check

fn wav_data(path: &std::path::Path) -> Option<Vec<u8>> {
    let b = std::fs::read(path).ok()?;
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let n = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if id == b"data" {
            return Some(b[i + 8..(i + 8 + n).min(b.len())].to_vec());
        }
        i += 8 + n + n % 2;
    }
    None
}

fn check(dir: &str, expected: &str) -> Result<bool, String> {
    let exp: Value = serde_json::from_str(&std::fs::read_to_string(expected).map_err(|e| format!("{expected}: {e}"))?)
        .map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(dir);
    let events = std::fs::read_to_string(dir.join("events.jsonl")).map_err(|e| format!("events.jsonl: {e}"))?;
    let mut clips: Vec<(String, String, String, String)> = Vec::new(); // (hash, file, api, head hash)
    let mut sources: std::collections::HashMap<String, String> = Default::default(); // file -> source
    for line in events.lines() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if e["ev"] == "clip" {
            if let Some(f) = e["file"].as_str() {
                if let Some(d) = wav_data(&dir.join(f)) {
                    if let Some(src) = e["source"].as_str() {
                        sources.insert(f.to_string(), src.to_string());
                    }
                    let t = trim_zeros(&d);
                    let head = format!("{:016x}", fnv64(&t[..HEAD.min(t.len())]));
                    clips.push((
                        format!("{:016x}", fnv64(t)),
                        f.to_string(),
                        e["api"].as_str().unwrap_or("").into(),
                        head,
                    ));
                }
            }
        }
    }
    let mut ok = true;
    let lines = exp["lines"].as_array().cloned().unwrap_or_default();
    for l in &lines {
        let hash = l["hash"].as_str().unwrap_or("");
        let hit: Vec<&(String, String, String, String)> = clips.iter().filter(|c| c.0 == hash).collect();
        let api = l["api"].as_str().unwrap_or("");
        // One clip per line: no second copy, no fragment that starts like it.
        let extra = clips.iter().filter(|c| l["head"].as_str() == Some(c.3.as_str())).count().saturating_sub(1);
        if extra > 0 && !hit.is_empty() {
            ok = false;
            println!(
                "FAIL  {api:<10} {:<6} recovered, but {extra} more clip(s) start like it (duplicate or fragment)",
                l["line"].as_str().unwrap_or("")
            );
            continue;
        }
        if let (Some(want), Some(c)) = (l["source"].as_str(), hit.first()) {
            let got = sources.get(&c.1).cloned().unwrap_or_default();
            if !got.replace('\\', "/").ends_with(want) {
                ok = false;
                println!(
                    "FAIL  {api:<10} {:<6} recovered, but its source is {got:?}, not {want:?}",
                    l["line"].as_str().unwrap_or("")
                );
                continue;
            }
        }
        match hit.first() {
            // xaudio2_8.dll is 2.9's implementation on Windows 10+, so its voices carry 2.9's label.
            Some(c)
                if c.2 == api
                    || (api.starts_with("xaudio2.")
                        && c.2.starts_with("xaudio2.")
                        && api != "xaudio2.7"
                        && c.2 != "xaudio2.7") =>
            {
                println!("PASS  {api:<10} {:<6} -> {}", l["line"].as_str().unwrap_or(""), c.1)
            }
            Some(c) => {
                ok = false;
                println!(
                    "FAIL  {api:<10} {:<6} matched a clip from {} ({})",
                    l["line"].as_str().unwrap_or(""),
                    c.2,
                    c.1
                )
            }
            None => {
                ok = false;
                println!("FAIL  {api:<10} {:<6} no clip has exactly its audio", l["line"].as_str().unwrap_or(""));
            }
        }
    }
    for s in exp["skipped"].as_array().cloned().unwrap_or_default() {
        println!("SKIP  {}", s.as_str().unwrap_or(""));
    }
    println!(
        "{} of {} voice lines recovered exactly; {} audible clips in all",
        lines.len() - lines.iter().filter(|l| !clips.iter().any(|c| Some(c.0.as_str()) == l["hash"].as_str())).count(),
        lines.len(),
        clips.len()
    );
    Ok(ok && !lines.is_empty())
}

// ---------------------------------------------------------------- engine fixtures (files)

/// A PCM16 WAV file's bytes.
fn wav_file(pcm: &[i16], channels: u16, rate: u32) -> Vec<u8> {
    let fmt = WAVEFORMATEX::pcm(channels, rate, 16).bytes();
    let data = bytes(pcm);
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((4 + 8 + 16 + 8 + data.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&fmt[..16]);
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// Writes a Ren'Py `game/` folder that plays voice lines (the `voice` statement and the voice
/// channel directly), BGM and SFX, then quits; the expected voice lines go to `expected`.
fn renpy_game(dir: &str, expected: &str) -> Result<(), String> {
    let game = std::path::Path::new(dir);
    std::fs::create_dir_all(game.join("voice")).map_err(|e| e.to_string())?;
    let w = |name: &str, b: Vec<u8>| std::fs::write(game.join(name), b).map_err(|e| format!("{name}: {e}"));
    let mut chord = vec![0i16; 44100 * 2 * 4];
    Bgm { i: 0, rate: 44100 }.fill(&mut chord);
    w("bgm.wav", wav_file(&chord, 2, 44100))?;
    w("sfx.wav", wav_file(&sfx(7, 22050), 1, 22050))?;
    let mut lines = Vec::new();
    for (i, secs) in [1.6f32, 2.2, 1.3].iter().enumerate() {
        let pcm = voice_line(400 + i as u32, *secs, 24000);
        w(&format!("voice/l{}.wav", i + 1), wav_file(&pcm, 1, 24000))?;
        lines.push(expect("renpy", &format!("rline{}", i + 1), &pcm, 24000));
    }
    let script = r#"
# vh-fixture: plays voice, BGM and SFX without input, then quits.
define config.has_autosave = False
define config.window_icon = None

# A second voice channel, as games with overlapping voices register (the voice channel itself is
# stopped at the start of every interaction, which renpy.pause is).
init python:
    renpy.music.register_channel("voice2", "voice", loop=False)

label splashscreen:
    play music "bgm.wav"
    $ renpy.pause(0.6, hard=True)
    $ renpy.music.play("voice/l1.wav", channel="voice2")
    $ renpy.pause(2.2, hard=True)
    play sound "sfx.wav"
    $ renpy.pause(0.5, hard=True)
    voice "voice/l2.wav"
    "Second line, voiced through the voice statement.{w=2.8}{nw}"
    voice "voice/l3.wav"
    "Third line.{w=1.8}{nw}"
    $ renpy.pause(0.5, hard=True)
    $ renpy.quit()
    return
"#;
    w("script.rpy", script.as_bytes().to_vec())?;
    let doc = json!({"bits": 64, "lines": lines, "skipped": []});
    std::fs::write(expected, serde_json::to_string_pretty(&doc).unwrap()).map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("play") if args.len() >= 3 => {
            let want: Vec<&str> = if args.len() > 3 {
                args[3..].iter().map(String::as_str).collect()
            } else {
                vec!["ds", "dss", "xa9", "xa8", "xa7", "wo", "sdl"]
            };
            unsafe { CoInitializeEx(null(), COINIT_MULTITHREADED as _) };
            let mut lines = Vec::new();
            let mut skipped = Vec::new();
            println!("vh-fixture ({}-bit)", usize::BITS);
            for w in want {
                let before = lines.len();
                let r = unsafe {
                    match w {
                        "ds" => play_ds(&mut lines),
                        "dss" => play_dss(&mut lines),
                        "xa9" => play_xa(9, &mut lines),
                        "xa8" => play_xa(8, &mut lines),
                        "xa7" => play_xa(7, &mut lines),
                        "wo" => play_wo(&mut lines),
                        "sdl" => play_sdl(&mut lines),
                        other => Err(format!("unknown scene {other}")),
                    }
                };
                if let Err(e) = r {
                    println!("  {w}: skipped: {e}");
                    skipped.push(format!("{w}: {e}"));
                    lines.truncate(before);
                }
                ms(1500); // let the hook's idle cut happen before the next scene
            }
            let doc = json!({"bits": usize::BITS, "lines": lines, "skipped": skipped});
            if let Err(e) = std::fs::write(&args[2], serde_json::to_string_pretty(&doc).unwrap()) {
                eprintln!("{}: {e}", args[2]);
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Some("renpy-game") if args.len() >= 4 => match renpy_game(&args[2], &args[3]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Some("check") if args.len() >= 4 => match check(&args[2], &args[3]) {
            Ok(true) => ExitCode::SUCCESS,
            Ok(false) => ExitCode::FAILURE,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("vh-fixture play <expected.json> [ds] [dss] [xa9] [xa8] [xa7] [wo] [sdl]\nvh-fixture check <capture dir> <expected.json>\nvh-fixture renpy-game <game dir> <expected.json>");
            ExitCode::from(2)
        }
    }
}
