//! Electron's `app.asar` and RPG Maker MV/MZ's encrypted audio: what the file adapter needs to
//! name and open a sound that a Chromium-based game (Electron, NW.js) serves itself from disk.
//!
//! - An asar archive is a JSON header (a Chromium pickle: `[4][header size][payload size][json
//!   length][json]`) followed by the files' bytes; each file's `offset` is from the end of the
//!   header. The game's browser process reads an entry by reading the archive at that offset, so
//!   a read that starts exactly where an audio entry starts is that sound being loaded.
//! - RPG Maker MV/MZ encrypt audio (`.rpgmvo`, `.ogg_`, `.m4a_`) with a 16-byte `RPGMV` header and
//!   the first 16 bytes of the file XOR'd with `encryptionKey` from `data/System.json`.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

/// A sound in an archive: its path in the archive and where its bytes are in the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub path: String,
    pub offset: u64,
    pub size: u64,
}

#[derive(Debug)]
pub struct Archive {
    pub path: PathBuf,
    /// Audio entries (and `System.json`, for RPG Maker's key), by offset.
    entries: Vec<Entry>,
}

/// Extensions of the sounds kept from an archive's index; what each one holds is checked when it
/// is read (`media`).
const AUDIO: &[&str] = &["ogg", "opus", "wav", "m4a", "mp3", "aac", "rpgmvo", "ogg_", "m4a_", "rpgmvm"];

pub fn is_audio(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    l.rsplit_once('.').is_some_and(|(_, ext)| AUDIO.contains(&ext))
}

/// The entries of an archive's header (`head`: the file's first bytes, at least the whole header):
/// audio and RPG Maker's `System.json`, with absolute offsets, sorted by offset.
pub fn parse(head: &[u8]) -> Option<Vec<Entry>> {
    let u32_at = |at: usize| head.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize);
    if u32_at(0)? != 4 {
        return None;
    }
    let base = 8 + u32_at(4)? as u64;
    let len = u32_at(12)?;
    let json: serde_json::Value = serde_json::from_slice(head.get(16..16 + len)?).ok()?;
    let mut out = Vec::new();
    fn walk(node: &serde_json::Value, prefix: &str, base: u64, out: &mut Vec<Entry>) {
        let Some(files) = node.get("files").and_then(|f| f.as_object()) else { return };
        for (name, v) in files {
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if v.get("files").is_some() {
                walk(v, &path, base, out);
                continue;
            }
            if v.get("unpacked").and_then(|u| u.as_bool()) == Some(true) {
                continue;
            }
            let keep = is_audio(&path) || path.to_ascii_lowercase().ends_with("data/system.json");
            let offset = v.get("offset").and_then(|o| o.as_str()?.parse::<u64>().ok());
            let size = v.get("size").and_then(|s| s.as_u64());
            if let (true, Some(offset), Some(size)) = (keep, offset, size) {
                out.push(Entry { path, offset: base + offset, size });
            }
        }
    }
    walk(&json, "", base, &mut out);
    out.sort_by_key(|e| e.offset);
    Some(out)
}

impl Archive {
    pub fn open(path: &Path) -> Option<Archive> {
        let mut f = std::fs::File::open(path).ok()?;
        let mut pre = [0u8; 16];
        f.read_exact(&mut pre).ok()?;
        let len = u32::from_le_bytes(pre[12..16].try_into().unwrap()) as usize;
        if len > 64 << 20 {
            return None;
        }
        let mut head = pre.to_vec();
        head.resize(16 + len, 0);
        f.read_exact(&mut head[16..]).ok()?;
        Some(Archive { path: path.to_path_buf(), entries: parse(&head)? })
    }

    /// The entry that starts at `offset`.
    pub fn at(&self, offset: u64) -> Option<&Entry> {
        self.entries.binary_search_by_key(&offset, |e| e.offset).ok().map(|i| &self.entries[i])
    }

    pub fn audio_count(&self) -> usize {
        self.entries.iter().filter(|e| is_audio(&e.path)).count()
    }

    pub fn read(&self, e: &Entry) -> std::io::Result<Vec<u8>> {
        let mut f = std::fs::File::open(&self.path)?;
        f.seek(SeekFrom::Start(e.offset))?;
        let mut buf = vec![0; e.size as usize];
        f.read_exact(&mut buf)?;
        Ok(buf)
    }

    /// RPG Maker's audio key from the archive's own `System.json`.
    pub fn rpgm_key(&self) -> Option<[u8; 16]> {
        let e = self.entries.iter().find(|e| e.path.to_ascii_lowercase().ends_with("data/system.json"))?;
        key_from_system_json(&self.read(e).ok()?)
    }
}

/// Archives opened once each, by path (`None`: not an archive we can read).
static ARCHIVES: LazyLock<Mutex<HashMap<String, Option<Arc<Archive>>>>> = LazyLock::new(Default::default);

pub fn archive(path: &str) -> Option<Arc<Archive>> {
    let key = path.trim_start_matches(r"\\?\").to_lowercase();
    let mut all = crate::util::lock(&ARCHIVES);
    if let Some(a) = all.get(&key) {
        return a.clone();
    }
    let a = Archive::open(Path::new(path.trim_start_matches(r"\\?\"))).map(Arc::new);
    match &a {
        Some(a) => crate::util::log(&format!("asar: {} has {} sounds", a.path.display(), a.audio_count())),
        None => crate::util::log(&format!("asar: {path} could not be read")),
    }
    all.insert(key, a.clone());
    a
}

pub const RPGM_HEADER: &[u8] = b"RPGMV\0\0\0";

/// `encryptionKey` (32 hex digits) from RPG Maker's `System.json`.
pub fn key_from_system_json(json: &[u8]) -> Option<[u8; 16]> {
    let text = String::from_utf8_lossy(json);
    let text = text.trim_start_matches('\u{feff}');
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let hex = v.get("encryptionKey")?.as_str()?;
    if hex.len() != 32 {
        return None;
    }
    let mut key = [0u8; 16];
    for (i, k) in key.iter_mut().enumerate() {
        *k = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(key)
}

/// RPG Maker's key for a loose file: `data/System.json` in a folder above it (`www/audio/voice/x`
/// → `www/data/System.json`), cached per folder.
pub fn rpgm_key_near(file: &str) -> Option<[u8; 16]> {
    static KEYS: LazyLock<Mutex<HashMap<PathBuf, Option<[u8; 16]>>>> = LazyLock::new(Default::default);
    let file = Path::new(file.trim_start_matches(r"\\?\"));
    for dir in file.ancestors().skip(1).take(6) {
        if let Some(k) = crate::util::lock(&KEYS).get(dir) {
            return *k;
        }
        let system = dir.join("data").join("System.json");
        if system.is_file() {
            let key = std::fs::read(&system).ok().and_then(|j| key_from_system_json(&j));
            crate::util::lock(&KEYS).insert(dir.to_path_buf(), key);
            return key;
        }
    }
    None
}

/// The plain file inside RPG Maker's encryption (`bytes` starting with its header), if `key` is
/// given: the header dropped and the first 16 bytes un-XOR'd.
pub fn rpgm_decrypt(bytes: &[u8], key: &[u8; 16]) -> Option<Vec<u8>> {
    if bytes.len() < 32 || !bytes.starts_with(RPGM_HEADER) {
        return None;
    }
    let mut out = bytes[16..].to_vec();
    for (b, k) in out.iter_mut().zip(key) {
        *b ^= k;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive_bytes(json: &str, body: &[u8]) -> Vec<u8> {
        let j = json.as_bytes();
        let padded = (j.len() + 3) & !3;
        let mut v = Vec::new();
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(&((padded + 8) as u32).to_le_bytes());
        v.extend_from_slice(&((padded + 4) as u32).to_le_bytes());
        v.extend_from_slice(&(j.len() as u32).to_le_bytes());
        v.extend_from_slice(j);
        v.resize(16 + padded, 0);
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn an_archive_lists_its_sounds_where_their_bytes_are() {
        let json = r#"{"files":{"index.html":{"size":3,"offset":"0"},"data":{"files":{
            "sound":{"files":{"v_001.ogg":{"size":4,"offset":"3"},"big.ogg":{"size":1,"unpacked":true}}},
            "System.json":{"size":2,"offset":"7"}}}}}"#;
        let bytes = archive_bytes(json, b"abcOggS{}");
        let entries = parse(&bytes).unwrap();
        let base = (bytes.len() - 9) as u64;
        assert_eq!(
            entries,
            vec![
                Entry { path: "data/sound/v_001.ogg".into(), offset: base + 3, size: 4 },
                Entry { path: "data/System.json".into(), offset: base + 7, size: 2 },
            ]
        );
        assert_eq!(&bytes[entries[0].offset as usize..][..4], b"OggS");
        assert!(parse(b"not an archive at all").is_none());
    }

    #[test]
    fn rpg_maker_audio_is_decrypted_with_the_key_from_system_json() {
        let key = key_from_system_json(br#"{"encryptionKey":"000102030405060708090a0b0c0d0e0f","x":1}"#).unwrap();
        assert_eq!(key[15], 15);
        let plain = b"OggS\0\x02 a vorbis stream and more bytes".to_vec();
        let mut enc = RPGM_HEADER.to_vec();
        enc.extend_from_slice(&[0; 8]);
        let mut body = plain.clone();
        for (b, k) in body.iter_mut().zip(&key) {
            *b ^= k;
        }
        enc.extend_from_slice(&body);
        assert_eq!(rpgm_decrypt(&enc, &key).unwrap(), plain);
        assert!(rpgm_decrypt(&plain, &key).is_none());
    }

    #[test]
    fn sounds_are_told_by_their_extension() {
        assert!(is_audio("data/sound/a.OGG"));
        assert!(is_audio("audio/voice/a1.rpgmvo"));
        assert!(is_audio("audio/se/x.ogg_"));
        assert!(!is_audio("data/scenario/first.ks"));
    }
}
