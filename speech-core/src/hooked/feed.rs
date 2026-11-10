//! Incrementally reads the capture log and decodes its completed audio clips.
use super::HookClip;
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};
pub const KEEP_MS: f64 = 600_000.0;
#[derive(Default)]
struct Stream {
    channel: Option<String>,
    api: String,
    fmt: Option<String>,
    start: Option<f64>,
    last: f64,
}
pub struct Feed {
    dir: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    dropping: bool,
    streams: BTreeMap<u64, Stream>,
    clips: VecDeque<HookClip>,
    pub adapters: Vec<String>,
    pub clips_seen: u64,
    pub last_event: Option<f64>,
    /// The game's executable, from the capture's `start` event.
    pub exe: Option<String>,
}
impl Feed {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, offset: 0, partial: Vec::new(), dropping: false, streams: BTreeMap::new(), clips: VecDeque::new(), adapters: Vec::new(), clips_seen: 0, last_event: None, exe: None }
    }
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    pub fn clips(&self) -> &VecDeque<HookClip> {
        &self.clips
    }
    /// Missing logs are normal before capture starts. Each poll reads at most 4 MiB.
    pub fn poll(&mut self, now: f64) -> Result<usize, String> {
        let mut f = match std::fs::File::open(self.dir.join("events.jsonl")) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.to_string()),
        };
        if f.metadata().map_err(|e| e.to_string())?.len() < self.offset {
            self.offset = 0;
            self.partial.clear();
            self.dropping = false;
            self.streams.clear();
            self.clips.clear();
        }
        f.seek(SeekFrom::Start(self.offset)).map_err(|e| e.to_string())?;
        let before = self.clips_seen;
        let mut bytes = Vec::new();
        f.take(4 * 1024 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        self.offset += bytes.len() as u64;
        for b in bytes {
            if b == b'\n' {
                if !self.dropping {
                    if let Ok(e) = serde_json::from_slice::<Value>(&self.partial) {
                        self.event(e);
                    }
                }
                self.partial.clear();
                self.dropping = false;
            } else if !self.dropping {
                if self.partial.len() == 1024 * 1024 {
                    self.partial.clear();
                    self.dropping = true;
                } else {
                    self.partial.push(b);
                }
            }
        }
        self.prune(now);
        Ok((self.clips_seen - before) as usize)
    }
    fn event(&mut self, e: Value) {
        let t = e["t"].as_f64().unwrap_or(0.0);
        self.last_event = Some(t);
        let id = e["s"].as_u64().unwrap_or(0);
        match e["ev"].as_str().unwrap_or("") {
            "start" => self.exe = e["exe"].as_str().map(str::to_owned),
            "adapter" => {
                if let Some(n) = e["name"].as_str().or(e["api"].as_str()) {
                    if !self.adapters.iter().any(|a| a == n) {
                        self.adapters.push(n.into());
                    }
                }
            }
            "stream" => {
                self.streams.insert(id, Stream {
                    channel: e["info"]["channel"].as_str().map(str::to_owned),
                    api: e["api"].as_str().unwrap_or("").into(),
                    fmt: e["fmt"].as_str().map(str::to_owned),
                    last: t,
                    ..Default::default()
                });
            }
            "data" | "play" => {
                let s = self.streams.entry(id).or_default();
                s.start.get_or_insert(t);
                s.last = t;
            }
            "stop" | "discard" | "flushbuffers" => {
                if let Some(s) = self.streams.get_mut(&id) {
                    s.start = None;
                }
            }
            "destroy" => {
                self.streams.remove(&id);
            }
            "exit" => self.streams.clear(),
            "clip" => {
                let s = self.streams.entry(id).or_default();
                s.start = None;
                s.last = t;
                self.clips_seen += 1;
                if e["silent"].as_bool() == Some(true) {
                    return;
                }
                self.clips.push_back(HookClip {
                    seq: e["seq"].as_u64().unwrap_or(0),
                    stream: id,
                    api: e["api"].as_str().unwrap_or("").into(),
                    start: e["start"].as_f64().unwrap_or(t),
                    dur: e["dur"].as_f64().unwrap_or(0.0),
                    file: e["file"].as_str().map(str::to_owned),
                    source: e["source"].as_str().map(str::to_owned),
                    fmt: e["fmt"].as_str().map(str::to_owned),
                    looping: e["looping"].as_bool().unwrap_or(false),
                    channel: e["meta"]["channel"].as_str().map(str::to_owned).or_else(|| s.channel.clone()),
                });
            }
            _ => {}
        }
    }
    pub fn open_starts(&self, now: f64) -> Vec<f64> {
        self.open(now).into_iter().map(|(start, _)| start).collect()
    }
    /// Sounds still playing (heard from within 15 s): when each started, and its group as a clip
    /// of it will have (`HookClip::group`, for adapters that name no source file).
    pub fn open(&self, now: f64) -> Vec<(f64, String)> {
        self.streams
            .values()
            .filter(|s| now - s.last <= 15_000.0)
            .filter_map(|s| Some((s.start?, format!("{} | {} | {}", s.api, s.fmt.as_deref().unwrap_or("?"), s.channel.clone().unwrap_or_default()))))
            .collect()
    }
    fn prune(&mut self, now: f64) {
        let mut kept = VecDeque::new();
        while let Some(c) = self.clips.pop_front() {
            if now - (c.start + c.dur * 1000.0) > KEEP_MS {
                if let Some(p) = c.file.as_deref().and_then(|n| self.clip_path(n).ok()) {
                    let _ = std::fs::remove_file(p);
                }
            } else {
                kept.push_back(c);
            }
        }
        self.clips = kept;
        self.streams.retain(|_, s| now - s.last <= KEEP_MS);
    }
    /// Reject traversal and symlinks pointing outside this capture before reading or pruning.
    pub fn clip_path(&self, name: &str) -> Result<PathBuf, String> {
        let p = Path::new(name);
        if p.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err("invalid clip path".into());
        }
        let root = self.dir.canonicalize().map_err(|e| e.to_string())?;
        let p = root.join(p).canonicalize().map_err(|e| e.to_string())?;
        if !p.starts_with(root) {
            return Err("clip outside capture".into());
        }
        Ok(p)
    }
    pub fn decode(&self, c: &HookClip) -> Result<(Vec<f32>, u32), String> {
        decode(&self.clip_path(c.file.as_deref().ok_or("clip has no file")?)?)
    }
}
/// The pages of an Ogg file's first logical stream. Some games' encoder (vorbis.acm) interleaves empty pages of a second stream; the decoder takes that stream's start
/// for a new chain link and fails on its missing headers. Bytes that are not a clean run of pages
/// are kept as they are.
fn first_stream(bytes: Vec<u8>) -> Vec<u8> {
    let page = |at: usize| -> Option<(u32, usize)> {
        let head = bytes.get(at..at + 27)?;
        if &head[..4] != b"OggS" {
            return None;
        }
        let segments = usize::from(head[26]);
        let body: usize = bytes.get(at + 27..at + 27 + segments)?.iter().map(|&b| usize::from(b)).sum();
        let end = at + 27 + segments + body;
        (end <= bytes.len()).then(|| (u32::from_le_bytes([head[14], head[15], head[16], head[17]]), end))
    };
    let Some((serial, _)) = page(0) else { return bytes };
    let mut kept = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let Some((s, end)) = page(at) else {
            kept.extend_from_slice(&bytes[at..]);
            break;
        };
        if s == serial {
            kept.extend_from_slice(&bytes[at..end]);
        }
        at = end;
    }
    kept
}

/// WAV PCM 8/16/24/32 or float, and Ogg Vorbis; average channels to mono.
/// Requires hound = "3.5" and lewton = "0.10" in the consuming crate.
pub fn decode(path: &Path) -> Result<(Vec<f32>, u32), String> {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("ogg")) {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let mut r = lewton::inside_ogg::OggStreamReader::new(std::io::Cursor::new(first_stream(bytes))).map_err(|e| e.to_string())?;
        let rate = r.ident_hdr.audio_sample_rate;
        let channels = usize::from(r.ident_hdr.audio_channels);
        if channels == 0 || rate == 0 {
            return Err("invalid Ogg format".into());
        }
        let mut mono = Vec::new();
        loop {
            let p = match r.read_dec_packet_itl() {
                Ok(Some(p)) => p,
                Ok(None) => break,
                // A file cut short (the game read only part of it): what decoded is the clip.
                Err(_) if !mono.is_empty() => break,
                Err(e) => return Err(e.to_string()),
            };
            mono.extend(p.chunks_exact(channels).map(|f| f.iter().map(|s| *s as f32 / 32768.0).sum::<f32>() / channels as f32));
        }
        return Ok((mono, rate));
    }
    let mut r = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = r.spec();
    if spec.channels == 0 || spec.sample_rate == 0 || !(1..=32).contains(&spec.bits_per_sample) {
        return Err("invalid WAV format".into());
    }
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.map(|v| if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 })).collect::<Result<_, _>>(),
        hound::SampleFormat::Int => {
            let scale = 2f32.powi(i32::from(spec.bits_per_sample) - 1);
            r.samples::<i32>().map(|s| s.map(|v| v as f32 / scale)).collect::<Result<_, _>>()
        }
    }
    .map_err(|e| e.to_string())?;
    let channels = usize::from(spec.channels);
    if !samples.len().is_multiple_of(channels) {
        return Err("incomplete WAV frame".into());
    }
    Ok((samples.chunks_exact(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect(), spec.sample_rate))
}

#[cfg(test)]
mod tests {
    use super::first_stream;

    fn page(serial: u32, body: &[u8]) -> Vec<u8> {
        let mut p = b"OggS".to_vec();
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(&[0; 8]);
        p.extend_from_slice(&serial.to_le_bytes());
        p.extend_from_slice(&[0; 8]);
        p.push(1);
        p.push(body.len() as u8);
        p.extend_from_slice(body);
        p
    }

    #[test]
    fn empty_pages_of_another_stream_are_dropped() {
        let (a, pad, b) = (page(0, b"one"), page(u32::MAX, b""), page(0, b"two"));
        let file = [a.clone(), pad.clone(), b.clone(), pad].concat();
        assert_eq!(first_stream(file), [a.clone(), b.clone()].concat());
        // A file cut part way through a page keeps the cut page as it is.
        let cut = [a.clone(), b[..10].to_vec()].concat();
        assert_eq!(first_stream(cut.clone()), cut);
    }
}
