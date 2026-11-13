//! The writer thread: turns what the hooks saw into clips, one stream per DirectSound buffer or
//! XAudio2 source voice, and logs everything to `events.jsonl`.
//!
//! A stream's *pending* bytes are what it was given since its last clip. A clip is cut when:
//! - `eos`: an XAudio2 buffer flagged END_OF_STREAM was submitted;
//! - `stop` / `flush` / `destroy`: the game stopped, flushed or released the buffer/voice;
//! - `reload`: new data was written into a DirectSound one-shot buffer that already played;
//! - `gap`: data arrives after more than `GAP_MS` of nothing;
//! - `idle`: it has been quiet for `IDLE_MS` and the pending audio has had time to play out;
//! - `cap`: more than `CAP_S` seconds pending (a stream that never stops).
//!
//! Trailing digital silence (exact zeros) is trimmed off clips; all-silent clips are logged but
//! not written. Times are Unix ms.
use crate::util::{hex, lock, log, now_ms};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use vh_common::{Fmt, WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_PCM};

const GAP_MS: f64 = 2000.0;
const IDLE_MS: f64 = 800.0;
const CAP_S: f64 = 120.0;

/// Clips longer than this are logged but not written (0: no limit). Set under Kimochi, where music
/// would only fill the disk: voice lines are far shorter.
static MAX_FILE_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const APP_MAX_FILE_SECS: f64 = 30.0;

pub fn set_app_mode() {
    MAX_FILE_SECS.store(APP_MAX_FILE_SECS.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

fn too_long(secs: f64) -> bool {
    let max = f64::from_bits(MAX_FILE_SECS.load(std::sync::atomic::Ordering::Relaxed));
    max > 0.0 && secs > max
}

/// (API family, object pointer): 1 = DirectSound buffer, 2 = XAudio2 source voice, 3 = waveOut
/// device, 4 = SDL_mixer channel, 5 = Unity AudioSource, 6 = Ren'Py channel, 7 = FMOD channel,
/// 8 = CRI player.
pub type Key = (u8, usize);

pub enum Ev {
    Create {
        key: Key,
        api: &'static str,
        fmt: Vec<u8>,
        info: Value,
    },
    Data {
        key: Key,
        bytes: Vec<u8>,
        eos: bool,
        looping: bool,
        region: Option<(u32, u32)>,
        info: Value,
    },
    Play {
        key: Key,
        looping: bool,
        info: Value,
    },
    Stop {
        key: Key,
    },
    Flush {
        key: Key,
    },
    Destroy {
        key: Key,
    },
    /// A logged event tied to a stream (seek, ...).
    Mark {
        key: Key,
        what: &'static str,
        info: Value,
    },
    /// A whole sound at once, from adapters that see the complete clip when it starts (Unity
    /// AudioClip, SDL_mixer Mix_Chunk, Ren'Py's file): written as a clip immediately.
    /// `ext: None` = PCM in `fmt`, written as WAV; `Some("ogg")` etc. = the original encoded file.
    Whole {
        key: Key,
        api: &'static str,
        fmt: Vec<u8>,
        bytes: Vec<u8>,
        ext: Option<String>,
        source: Option<String>,
        dur: Option<f64>,
        at: Option<f64>,
        info: Value,
    },
    /// What the stream is playing now (file or cue name); goes on its next clips.
    Source {
        key: Key,
        source: Option<String>,
    },
    Note(Value),
}

struct Msg {
    t: f64,
    ev: Ev,
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();
/// The writer and its queue. Its thread takes the lock only to drain; at process exit
/// (`drain_at_exit`, from DllMain) whatever is still pending is written out.
static STATE: Mutex<Option<(Writer, Receiver<Msg>)>> = Mutex::new(None);

pub fn send(ev: Ev) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg { t: now_ms(), ev });
    }
}

pub fn start(dir: &Path) {
    let (tx, rx) = channel::<Msg>();
    if TX.set(tx).is_err() {
        return;
    }
    let events = match File::create(dir.join("events.jsonl")) {
        Ok(f) => BufWriter::new(f),
        Err(e) => {
            log(&format!("cannot write events.jsonl: {e}"));
            return;
        }
    };
    let w = Writer {
        dir: dir.to_path_buf(),
        events,
        streams: HashMap::new(),
        next_id: 1,
        seq: 0,
        saved: VecDeque::new(),
        saved_bytes: 0,
    };
    *lock(&STATE) = Some((w, rx));
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(50));
        let mut g = lock(&STATE);
        let Some((w, rx)) = g.as_mut() else { break };
        while let Ok(m) = rx.try_recv() {
            w.handle(m);
        }
        w.tick(now_ms());
        let _ = w.events.flush();
    });
}

/// At process exit (other threads are gone): handle what is queued and cut every pending clip.
/// `try_lock`, because a thread killed while holding the lock would leave it held for good.
pub fn drain_at_exit() {
    let Ok(mut g) = STATE.try_lock() else { return };
    let Some((w, rx)) = g.as_mut() else { return };
    while let Ok(m) = rx.try_recv() {
        w.handle(m);
    }
    let t = now_ms();
    let keys: Vec<Key> = w.streams.keys().copied().collect();
    for key in keys {
        let mut s = w.streams.remove(&key).unwrap();
        w.flush(&mut s, "exit", t);
    }
    w.write(json!({"ev": "exit", "t": t}));
    let _ = w.events.flush();
}

struct Stream {
    id: u32,
    api: &'static str,
    ptr: usize,
    fmt_bytes: Vec<u8>,
    fmt: Option<Fmt>,
    pending: Vec<u8>,
    /// DirectSound buffer size: a looping buffer refilled past it is a stream ring, not a loop.
    buffer_bytes: usize,
    t_data0: f64,
    t_last: f64,
    t_play: Option<f64>,
    /// Played since its data was loaded (DirectSound one-shots) / started (XAudio2).
    played: bool,
    looping: bool,
    /// Filled and stopped before it ever played: either a stream ring being primed (filled
    /// again before it plays) or a one-shot loaded and then started from the top.
    primed: bool,
    clips: u32,
    last_clip: Option<u32>,
    source: Option<String>,
}

impl Stream {
    fn ds(&self) -> bool {
        self.api == "dsound"
    }
    fn pending_secs(&self) -> f64 {
        self.fmt.map_or(0.0, |f| f.seconds(self.pending.len()))
    }
    /// When what is pending will have finished playing (if it plays from `clip_start`).
    fn played_out_at(&self) -> f64 {
        self.clip_start() + self.pending_secs() * 1000.0
    }
    fn clip_start(&self) -> f64 {
        match self.t_play {
            Some(p) if p > self.t_data0 => p,
            _ => self.t_data0,
        }
    }
}

struct Writer {
    dir: PathBuf,
    events: BufWriter<File>,
    streams: HashMap<Key, Stream>,
    next_id: u32,
    seq: u32,
    saved: VecDeque<(PathBuf, u64)>,
    saved_bytes: u64,
}

impl Writer {
    fn write(&mut self, v: Value) {
        // A DLL stays loaded until the game exits, even if Kimochi detaches or closes.
        // Bound its clip storage independently of the app's reader.
        if MAX_FILE_SECS.load(std::sync::atomic::Ordering::Relaxed) != 0 {
            if let Some(file) = v["file"].as_str().filter(|_| v["ev"] == "clip") {
                let path = self.dir.join(file);
                let bytes = path.metadata().map(|m| m.len()).unwrap_or(0);
                self.saved.push_back((path, bytes));
                self.saved_bytes += bytes;
                while self.saved.len() > 256 || self.saved_bytes > 128 * 1024 * 1024 {
                    if let Some((path, bytes)) = self.saved.pop_front() {
                        let _ = std::fs::remove_file(path);
                        self.saved_bytes = self.saved_bytes.saturating_sub(bytes);
                    } else {
                        break;
                    }
                }
            }
        }
        let _ = writeln!(self.events, "{v}");
    }

    fn new_stream(&mut self, key: Key, api: &'static str, fmt_bytes: Vec<u8>, t: f64, info: Value) {
        if let Some(mut old) = self.streams.remove(&key) {
            self.flush(&mut old, "replaced", t);
        }
        let id = self.next_id;
        self.next_id += 1;
        let fmt = Fmt::parse(&fmt_bytes);
        let buffer_bytes = info["buffer_bytes"].as_u64().unwrap_or(0) as usize;
        self.write(json!({
            "ev": "stream", "t": t, "s": id, "api": api, "ptr": hex(key.1),
            "fmt": fmt.map(|f| f.summary()), "info": info,
        }));
        self.streams.insert(
            key,
            Stream {
                id,
                api,
                ptr: key.1,
                fmt_bytes,
                fmt,
                pending: Vec::new(),
                buffer_bytes,
                t_data0: t,
                t_last: t,
                t_play: None,
                played: false,
                looping: false,
                primed: false,
                clips: 0,
                last_clip: None,
                source: None,
            },
        );
    }

    fn stream(&mut self, key: Key, t: f64) -> &mut Stream {
        if !self.streams.contains_key(&key) {
            let api = match key.0 {
                1 => "dsound",
                2 => "xaudio2",
                3 => "waveout",
                4 => "sdl_mixer",
                5 => "unity",
                6 => "renpy",
                7 => "fmod",
                8 => "cri",
                _ => "other",
            };
            self.new_stream(key, api, Vec::new(), t, json!({"unannounced": true}));
        }
        self.streams.get_mut(&key).unwrap()
    }

    fn handle(&mut self, m: Msg) {
        let t = m.t;
        match m.ev {
            Ev::Create { key, api, fmt, info } => self.new_stream(key, api, fmt, t, info),
            Ev::Data { key, mut bytes, eos, looping, region, info } => {
                let mut s = self.take(key, t);
                if s.primed {
                    // Filled again before it played: the first fill was a stream ring's priming
                    // (SiglusEngine fills it, stops, rewinds and fills it again). Not a sound.
                    self.write(json!({"ev": "discard", "t": t, "s": s.id, "bytes": s.pending.len()}));
                    s.pending.clear();
                    s.primed = false;
                }
                if let (Some((begin, len)), Some(f)) = (region, s.fmt) {
                    if f.is_linear() && f.block_align > 0 {
                        let a = f.block_align as usize;
                        let from = (begin as usize * a).min(bytes.len());
                        let to = if len == 0 { bytes.len() } else { (from + len as usize * a).min(bytes.len()) };
                        bytes = bytes[from..to].to_vec();
                    }
                }
                if s.ds() && s.played && !s.looping {
                    self.flush(&mut s, "reload", t);
                    s.played = false;
                    s.t_play = None;
                } else if !s.pending.is_empty() && t - s.t_last > GAP_MS && t > s.played_out_at() {
                    // A pause in the data alone is not the end: a streaming ring is refilled
                    // once per half (4 s in SiglusEngine) while it plays what it was given.
                    self.flush(&mut s, "gap", t);
                }
                if s.pending.is_empty() {
                    s.t_data0 = t;
                    // XAudio2 loops per buffer; a DirectSound buffer loops per Play.
                    if !s.ds() {
                        s.looping = false;
                    }
                }
                s.looping |= looping;
                s.pending.extend_from_slice(&bytes);
                s.t_last = t;
                let mut ev = json!({"ev": "data", "t": t, "s": s.id, "n": bytes.len()});
                merge(&mut ev, info);
                if eos {
                    ev["eos"] = json!(true);
                }
                self.write(ev);
                if eos {
                    self.flush(&mut s, "eos", t);
                } else if s.pending_secs() > CAP_S {
                    self.flush(&mut s, "cap", t);
                }
                self.streams.insert(key, s);
            }
            Ev::Play { key, looping, info } => {
                let mut s = self.take(key, t);
                // What was loaded before a stop plays now (BGI loads a voice, stops the buffer,
                // rewinds and plays it).
                s.primed = false;
                if s.ds() {
                    s.looping = looping;
                    if s.played && !looping && !s.pending.is_empty() {
                        // Restarted before its clip was cut: what it played so far is a clip.
                        self.flush(&mut s, "restart", t);
                    }
                    if s.pending.is_empty() && s.last_clip.is_some() && !looping {
                        let of = s.last_clip;
                        self.write(json!({"ev": "replay", "t": t, "s": s.id, "clip": of}));
                    }
                    s.played = true;
                    s.t_play = Some(t);
                } else {
                    s.played = true;
                    s.t_play.get_or_insert(t);
                }
                let mut ev = json!({"ev": "play", "t": t, "s": s.id, "looping": looping});
                merge(&mut ev, info);
                self.write(ev);
                self.streams.insert(key, s);
            }
            Ev::Stop { key } => {
                let mut s = self.take(key, t);
                self.write(json!({"ev": "stop", "t": t, "s": s.id}));
                if s.ds() && !s.played && s.t_play.is_none() && !s.pending.is_empty() {
                    // Filled and stopped without ever playing: kept until the buffer is either
                    // played (a one-shot) or filled again (a stream ring being primed).
                    s.primed = true;
                    self.streams.insert(key, s);
                    return;
                }
                self.flush(&mut s, "stop", t);
                s.played = false;
                s.t_play = None;
                self.streams.insert(key, s);
            }
            Ev::Flush { key } => {
                let mut s = self.take(key, t);
                self.write(json!({"ev": "flushbuffers", "t": t, "s": s.id}));
                self.flush(&mut s, "flush", t);
                self.streams.insert(key, s);
            }
            Ev::Destroy { key } => {
                if let Some(mut s) = self.streams.remove(&key) {
                    if s.primed {
                        s.pending.clear();
                    }
                    self.flush(&mut s, "destroy", t);
                    self.write(json!({"ev": "destroy", "t": t, "s": s.id, "clips": s.clips}));
                }
            }
            Ev::Mark { key, what, info } => {
                let id = self.stream(key, t).id;
                let mut ev = json!({"ev": what, "t": t, "s": id});
                merge(&mut ev, info);
                self.write(ev);
            }
            Ev::Source { key, source } => {
                let s = self.stream(key, t);
                s.source = source;
            }
            Ev::Whole { key, api, fmt, bytes, ext, source, dur, at, info } => {
                let t = at.unwrap_or(t);
                if !self.streams.contains_key(&key) || self.streams[&key].fmt_bytes != fmt {
                    self.new_stream(key, api, fmt.clone(), t, json!({}));
                }
                let mut s = self.streams.remove(&key).unwrap();
                s.source = source;
                s.t_data0 = t;
                s.t_play = Some(t);
                self.whole(&mut s, bytes, ext, dur, info, t);
                self.streams.insert(key, s);
            }
            Ev::Note(mut v) => {
                if v.get("t").is_none() {
                    v["t"] = json!(t);
                }
                self.write(v);
            }
        }
    }

    fn take(&mut self, key: Key, t: f64) -> Stream {
        self.stream(key, t);
        self.streams.remove(&key).unwrap()
    }

    fn tick(&mut self, now: f64) {
        let keys: Vec<Key> = self
            .streams
            .iter()
            .filter(|(_, s)| {
                !s.pending.is_empty()
                    && !s.primed
                    && now - s.t_last > IDLE_MS
                    && now > s.clip_start() + s.pending_secs() * 1000.0 + IDLE_MS
            })
            .map(|(k, _)| *k)
            .collect();
        for key in keys {
            let mut s = self.streams.remove(&key).unwrap();
            self.flush(&mut s, "idle", now);
            self.streams.insert(key, s);
        }
    }

    fn whole(&mut self, s: &mut Stream, bytes: Vec<u8>, ext: Option<String>, dur: Option<f64>, info: Value, t: f64) {
        self.seq += 1;
        s.clips += 1;
        s.last_clip = Some(self.seq);
        let pcm = ext.is_none();
        let data: &[u8] = if pcm {
            let align = s.fmt.map_or(1, |f| f.block_align.max(1) as usize);
            &bytes[..(vh_common::trim_zeros(&bytes).len().div_ceil(align) * align).min(bytes.len())]
        } else {
            &bytes
        };
        let stats = if pcm { s.fmt.map(|f| level(&f, data)) } else { None };
        let silent = matches!(stats, Some((peak, _)) if peak < 1e-4);
        let secs =
            if pcm && !data.is_empty() { s.fmt.map_or(0.0, |f| f.seconds(data.len())) } else { dur.unwrap_or(0.0) };
        let file = if silent || data.is_empty() || too_long(secs) {
            None
        } else {
            let stem = s.source.as_deref().map(file_stem).unwrap_or_default();
            let ext = ext.as_deref().unwrap_or("wav");
            let name = format!("{:05}_{}_s{}{}.{ext}", self.seq, s.api.replace('.', ""), s.id, stem);
            let path = self.dir.join("clips").join(&name);
            let r = if pcm { write_wav(&path, &s.fmt_bytes, data) } else { std::fs::write(&path, data) };
            match r {
                Ok(()) => Some(format!("clips/{name}")),
                Err(e) => {
                    log(&format!("clip {name}: {e}"));
                    None
                }
            }
        };
        let mut ev = json!({
            "ev": "clip", "t": t, "seq": self.seq, "s": s.id, "api": s.api, "why": "whole",
            "start": t, "data_at": t, "dur": secs, "bytes": data.len(), "looping": false, "played": true,
            "peak": stats.map(|x| x.0), "rms": stats.map(|x| x.1), "silent": silent,
            "fmt": if pcm { s.fmt.map(|f| f.summary()) } else { ext.clone() }, "file": file, "source": s.source,
        });
        if !info.is_null() && info != json!({}) {
            ev["meta"] = info;
        }
        self.write(ev);
    }

    fn flush(&mut self, s: &mut Stream, why: &str, t: f64) {
        if s.pending.is_empty() {
            return;
        }
        let data = std::mem::take(&mut s.pending);
        // A DirectSound ring refilled past its size is streaming one sound (SiglusEngine plays
        // everything that way, with the LOOPING flag): not a loop. A real loop is a buffer
        // played round and round on the same data.
        let streamed = s.ds() && s.buffer_bytes > 0 && data.len() > s.buffer_bytes;
        let wrapped =
            s.buffer_bytes == 0 || s.fmt.is_none_or(|f| t - s.clip_start() > f.seconds(s.buffer_bytes) * 1050.0);
        let looping = s.looping && !streamed && wrapped;
        let align = s.fmt.map_or(1, |f| f.block_align.max(1) as usize);
        let trimmed = vh_common::trim_zeros(&data).len().div_ceil(align) * align;
        let data = &data[..trimmed.min(data.len())];
        let stats = s.fmt.map(|f| level(&f, data));
        let silent = matches!(stats, Some((peak, _)) if peak < 1e-4);
        self.seq += 1;
        s.clips += 1;
        s.last_clip = Some(self.seq);
        let secs = s.fmt.map_or(0.0, |f| f.seconds(data.len()));
        let file = if silent || data.is_empty() || too_long(secs) {
            None
        } else {
            let name = format!("{:05}_{}_s{}_{:x}.wav", self.seq, s.api.replace('.', ""), s.id, s.ptr);
            match write_wav(&self.dir.join("clips").join(&name), &s.fmt_bytes, data) {
                Ok(()) => Some(format!("clips/{name}")),
                Err(e) => {
                    log(&format!("clip {name}: {e}"));
                    None
                }
            }
        };
        let start = s.clip_start();
        self.write(json!({
            "ev": "clip", "t": t, "seq": self.seq, "s": s.id, "api": s.api, "why": why,
            "start": start, "data_at": s.t_data0, "dur": secs, "bytes": data.len(),
            "looping": looping, "streamed": streamed, "played": s.played || s.t_play.is_some(),
            "peak": stats.map(|x| x.0), "rms": stats.map(|x| x.1), "silent": silent,
            "fmt": s.fmt.map(|f| f.summary()), "file": file, "source": s.source,
        }));
    }
}

/// `_<name>` from a source path or cue, safe for a file name (at most 40 chars), or "".
fn file_stem(src: &str) -> String {
    let base = src.rsplit(['/', '\\']).next().unwrap_or(src);
    let base = base.rsplit_once('.').map_or(base, |(a, _)| a);
    let clean: String =
        base.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(40).collect();
    if clean.is_empty() {
        String::new()
    } else {
        format!("_{clean}")
    }
}

fn merge(into: &mut Value, extra: Value) {
    if let (Some(a), Value::Object(b)) = (into.as_object_mut(), extra) {
        for (k, v) in b {
            a.insert(k, v);
        }
    }
}

/// Peak and RMS in 0..1 for linear formats; (1, 1) for anything we cannot read (never "silent").
fn level(f: &Fmt, data: &[u8]) -> (f64, f64) {
    let samples: Box<dyn Iterator<Item = f64>> = match (f.kind, f.bits) {
        (WAVE_FORMAT_PCM, 16) => {
            Box::new(data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0))
        }
        (WAVE_FORMAT_PCM, 8) => Box::new(data.iter().map(|&b| (b as f64 - 128.0) / 128.0)),
        (WAVE_FORMAT_PCM, 24) => Box::new(
            data.chunks_exact(3).map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f64 / 8_388_608.0),
        ),
        (WAVE_FORMAT_PCM, 32) => Box::new(
            data.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64 / 2_147_483_648.0),
        ),
        (WAVE_FORMAT_IEEE_FLOAT, 32) => {
            Box::new(data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64))
        }
        _ => return (1.0, 1.0),
    };
    let (mut peak, mut sum, mut n) = (0f64, 0f64, 0usize);
    for x in samples {
        peak = peak.max(x.abs());
        sum += x * x;
        n += 1;
    }
    (peak, if n == 0 { 0.0 } else { (sum / n as f64).sqrt() })
}

/// A RIFF WAVE file with the stream's own format chunk, so ADPCM and float clips stay valid too.
fn write_wav(path: &Path, fmt: &[u8], data: &[u8]) -> std::io::Result<()> {
    let fmt: Vec<u8> = if fmt.len() >= 16 { fmt.to_vec() } else { vh_common::WAVEFORMATEX::pcm(1, 22050, 16).bytes() };
    let pad = data.len() % 2;
    let riff = 4 + (8 + fmt.len() + fmt.len() % 2) + (8 + data.len() + pad);
    let mut f = BufWriter::new(File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(riff as u32).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&(fmt.len() as u32).to_le_bytes())?;
    f.write_all(&fmt)?;
    if fmt.len() % 2 == 1 {
        f.write_all(&[0])?;
    }
    f.write_all(b"data")?;
    f.write_all(&(data.len() as u32).to_le_bytes())?;
    f.write_all(data)?;
    if pad == 1 {
        f.write_all(&[0])?;
    }
    f.flush()
}
