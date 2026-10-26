//! Clips: a decided line's voice cut out of the recording, levelled, faded and encoded, and the
//! last few kept on disk (`ClipStore`) so the Log can play them and a card made later still gets
//! its audio, without the recording having to reach that far back.
use crate::listener::{How, Voice};
use crate::{encode, trim};
use kimochi_capture::audio::AudioRing;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

const INDEX: &str = "clips.json";
/// Word clips: a little around the word's characters, so its first and last sounds are whole.
const WORD_PAD_BEFORE_MS: f64 = 80.0;
const WORD_PAD_AFTER_MS: f64 = 150.0;
const WORD_FADE_MS: f64 = 15.0;

/// A clip ready to keep or send.
pub struct Rendered {
    pub mp3: Vec<u8>,
    /// What was encoded, kept to cut a word out of later.
    pub pcm: Vec<f32>,
    pub sample_rate: u32,
    /// Where the clip starts, in Unix ms.
    pub start_ms: f64,
    pub duration_ms: f64,
}

/// Cut `voice` out of `ring`, level it, fade its ends and encode it.
pub fn render(ring: &AudioRing, voice: &Voice) -> Result<Rendered, String> {
    let clip = ring.snapshot(voice.from_ms, voice.to_ms).ok_or("The line's audio is no longer held.")?;
    if clip.samples.len() < clip.sample_rate as usize / 10 {
        return Err("The clip came out empty: check the offsets in Settings → Anki.".into());
    }
    let mut samples = clip.samples;
    trim::level(&mut samples);
    trim::fade(&mut samples, clip.sample_rate);
    let mp3 = encode::mp3(&samples, clip.sample_rate)?;
    Ok(Rendered {
        mp3,
        duration_ms: samples.len() as f64 * 1000.0 / clip.sample_rate as f64,
        pcm: samples,
        sample_rate: clip.sample_rate,
        start_ms: clip.start_ms,
    })
}

/// The audio of one word, `from_ms..to_ms` (from `matching::word_span`), cut out of a line's clip.
pub fn render_word(pcm: &[f32], sample_rate: u32, clip_start_ms: f64, from_ms: f64, to_ms: f64) -> Result<Vec<u8>, String> {
    let at = |ms: f64| (((ms - clip_start_ms) * sample_rate as f64 / 1000.0).max(0.0) as usize).min(pcm.len());
    let (a, b) = (at(from_ms - WORD_PAD_BEFORE_MS), at(to_ms + WORD_PAD_AFTER_MS));
    if b <= a + sample_rate as usize / 20 {
        return Err("The word's audio came out empty.".into());
    }
    let mut samples = pcm[a..b].to_vec();
    let n = ((WORD_FADE_MS * sample_rate as f64 / 1000.0) as usize).min(samples.len() / 2);
    let len = samples.len();
    for i in 0..n {
        let gain = i as f32 / n as f32;
        samples[i] *= gain;
        samples[len - 1 - i] *= gain;
    }
    encode::mp3(&samples, sample_rate)
}

/// What the Log and a card need to know about a kept clip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub uid: String,
    /// The line's text, which `char_ms` times.
    #[serde(default)]
    pub text: String,
    pub file: String,
    pub duration_ms: f64,
    /// `matched` (by its words) or `timed`.
    pub how: String,
    /// What the recogniser heard over the match.
    #[serde(default)]
    pub heard: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    /// Where the clip starts, Unix ms, and the line's character boundaries (matched clips),
    /// for cutting words out of it.
    pub start_ms: f64,
    #[serde(default)]
    pub char_ms: Option<Vec<f64>>,
}

impl ClipInfo {
    pub fn new(uid: &str, text: &str, file: String, voice: &Voice, rendered: &Rendered) -> Self {
        let (how, heard, score, char_ms) = match &voice.how {
            How::Matched(m) => ("matched", Some(m.heard.clone()), Some(m.score), Some(m.char_ms.clone())),
            How::Timed => ("timed", None, None, None),
        };
        Self {
            uid: uid.to_string(),
            text: text.to_string(),
            file,
            duration_ms: rendered.duration_ms,
            how: how.into(),
            heard,
            score,
            start_ms: rendered.start_ms,
            char_ms,
        }
    }
}

struct Kept {
    info: ClipInfo,
    /// The clip's audio, for word clips (not kept across restarts).
    pcm: Option<(Vec<i16>, u32)>,
}

/// The last `keep` clips, as MP3 files in `dir` with an index, newest last. Clips outlive the
/// recording and the app: the Log can play a line's voice after a restart.
pub struct ClipStore {
    dir: PathBuf,
    keep: usize,
    kept: VecDeque<Kept>,
    counter: u64,
}

impl ClipStore {
    /// Open (or start) the store in `dir`, keeping what an earlier run left that is still there.
    pub fn open(dir: PathBuf, keep: usize) -> Self {
        let mut kept = VecDeque::new();
        if let Ok(text) = std::fs::read_to_string(dir.join(INDEX)) {
            if let Ok(infos) = serde_json::from_str::<Vec<ClipInfo>>(&text) {
                kept.extend(infos.into_iter().filter(|i| dir.join(&i.file).is_file()).map(|info| Kept { info, pcm: None }));
            }
        }
        let counter = crate::now_ms() as u64;
        let mut store = Self { dir, keep: keep.max(1), kept, counter };
        store.prune();
        store
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn set_keep(&mut self, keep: usize) {
        self.keep = keep.max(1);
        self.prune();
        self.save();
    }

    /// Keep `rendered` as `uid`'s clip (replacing one it had), dropping the oldest beyond `keep`.
    pub fn put(&mut self, uid: &str, text: &str, voice: &Voice, rendered: &Rendered) -> Result<ClipInfo, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        self.counter += 1;
        let file = format!("clip-{}.mp3", self.counter);
        std::fs::write(self.dir.join(&file), &rendered.mp3).map_err(|e| e.to_string())?;
        self.remove(uid);
        let info = ClipInfo::new(uid, text, file, voice, rendered);
        let pcm = rendered.pcm.iter().map(|s| (s.clamp(-1.0, 1.0) * 32_767.0) as i16).collect();
        self.kept.push_back(Kept { info: info.clone(), pcm: Some((pcm, rendered.sample_rate)) });
        self.prune();
        self.save();
        Ok(info)
    }

    /// Forget `uid`'s clip, if it has one (its line was decided again).
    pub fn remove(&mut self, uid: &str) {
        if let Some(i) = self.kept.iter().position(|k| k.info.uid == uid) {
            let gone = self.kept.remove(i).unwrap();
            let _ = std::fs::remove_file(self.dir.join(&gone.info.file));
            self.save();
        }
    }

    pub fn get(&self, uid: &str) -> Option<&ClipInfo> {
        self.kept.iter().find(|k| k.info.uid == uid).map(|k| &k.info)
    }

    pub fn all(&self) -> impl Iterator<Item = &ClipInfo> {
        self.kept.iter().map(|k| &k.info)
    }

    pub fn read(&self, uid: &str) -> Option<Vec<u8>> {
        std::fs::read(self.dir.join(&self.get(uid)?.file)).ok()
    }

    /// The audio of `word` in `uid`'s clip, as MP3: when the clip was matched by its words and
    /// its audio is still in memory.
    pub fn word(&self, uid: &str, word: &str) -> Option<Vec<u8>> {
        let info = self.get(uid)?;
        let (from, to) = crate::matching::word_span(&info.text, word, info.char_ms.as_deref()?)?;
        let (pcm, rate) = self.pcm(uid)?;
        render_word(&pcm, rate, info.start_ms, from, to).ok()
    }

    /// The audio of `uid`'s clip, while it is still in memory.
    pub fn pcm(&self, uid: &str) -> Option<(Vec<f32>, u32)> {
        let (pcm, rate) = self.kept.iter().find(|k| k.info.uid == uid)?.pcm.as_ref()?;
        Some((pcm.iter().map(|&s| s as f32 / 32_768.0).collect(), *rate))
    }

    /// Remove every clip (the setting was turned off).
    pub fn clear(&mut self) {
        for kept in self.kept.drain(..) {
            let _ = std::fs::remove_file(self.dir.join(&kept.info.file));
        }
        let _ = std::fs::remove_file(self.dir.join(INDEX));
    }

    fn prune(&mut self) {
        while self.kept.len() > self.keep {
            if let Some(gone) = self.kept.pop_front() {
                let _ = std::fs::remove_file(self.dir.join(&gone.info.file));
            }
        }
        // Files nobody lists (a crash between writing a clip and the index).
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("clip-") && name.ends_with(".mp3") && !self.kept.iter().any(|k| k.info.file == name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    fn save(&self) {
        let infos: Vec<&ClipInfo> = self.kept.iter().map(|k| &k.info).collect();
        if let Ok(json) = serde_json::to_string(&infos) {
            let _ = std::fs::create_dir_all(&self.dir);
            let tmp = self.dir.join(format!("{INDEX}.tmp"));
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(tmp, self.dir.join(INDEX));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice() -> Voice {
        Voice { from_ms: 1_000.0, to_ms: 2_000.0, how: How::Timed }
    }

    fn rendered(seconds: f64) -> Rendered {
        let pcm = vec![0.1; (seconds * 16_000.0) as usize];
        Rendered { mp3: vec![1, 2, 3], pcm, sample_rate: 16_000, start_ms: 1_000.0, duration_ms: seconds * 1000.0 }
    }

    #[test]
    fn the_store_keeps_the_newest_clips_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("kimochi-clips-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = ClipStore::open(dir.clone(), 2);
        for uid in ["a", "b", "c"] {
            store.put(uid, "一", &voice(), &rendered(1.0)).unwrap();
        }
        assert_eq!(store.all().map(|c| c.uid.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3, "two clips and the index");
        store.put("b", "二", &voice(), &rendered(2.0)).unwrap();
        assert_eq!(store.all().map(|c| c.uid.as_str()).collect::<Vec<_>>(), vec!["c", "b"], "a new clip for b replaces its old one");
        assert!(store.pcm("b").is_some());
        let reopened = ClipStore::open(dir.clone(), 2);
        assert_eq!(reopened.get("b").unwrap().duration_ms, 2_000.0);
        assert_eq!(reopened.read("c").unwrap(), vec![1, 2, 3]);
        assert!(reopened.pcm("b").is_none(), "audio for words is not kept across restarts");
        let mut reopened = reopened;
        reopened.set_keep(1);
        assert_eq!(reopened.all().count(), 1);
        reopened.clear();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_word_is_cut_out_of_a_clip() {
        let pcm = vec![0.2; 16_000 * 2];
        let mp3 = render_word(&pcm, 16_000, 10_000.0, 10_500.0, 10_900.0).unwrap();
        assert!(!mp3.is_empty());
        assert!(render_word(&pcm, 16_000, 10_000.0, 20_000.0, 20_100.0).is_err(), "outside the clip");
    }
}
