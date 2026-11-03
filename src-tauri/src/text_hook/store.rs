//! The text hookers, downloaded on demand and never bundled (they are several megabytes each,
//! and injectors are what antivirus software quarantines, so they stay out of the installer).
//!
//! `src-tauri/texthook-manifest.json` (written by `scripts/texthook-package.mjs`, compiled in
//! here) pins each engine to one upstream release: every file's name, size and SHA-256, and the
//! places it can come from, tried in order. A source is either a plain file (our mirror) or an
//! entry of an upstream release zip on GitHub; a zip entry is read with HTTP range requests (the
//! zip's directory, then that entry's bytes), so only a few megabytes of a large release are
//! fetched. Whatever the source, the file must have the manifest's size and SHA-256.
//!
//! ```text
//! <app local data>/texthook/
//!   luna-12.1.3.8/         the verified files; the directory's existence is the commit
//!   .staging-luna-…        while downloading; removed when found at the next attempt
//!   games.json             the thread chosen for each game (`super::Memory`)
//! ```
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MANIFEST_JSON: &str = include_str!("../../texthook-manifest.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub url: String,
    /// The path of the file inside the zip at `url`; absent for a plain file.
    #[serde(rename = "zipEntry")]
    pub zip_entry: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct File {
    /// Relative path under the engine's directory (`x64/TextractorCLI.exe`).
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub sources: Vec<Source>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Engine {
    pub name: String,
    pub version: String,
    #[allow(dead_code)] // shown in NOTICE and the manifest; kept for the record
    pub project: String,
    #[allow(dead_code)]
    pub license: String,
    pub files: Vec<File>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub engines: BTreeMap<String, Engine>,
}

fn safe_relative(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && !name.starts_with('/')
        && name.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains(':'))
}

impl Manifest {
    /// Parses and checks a manifest: plain relative names, real hashes, sizes, HTTPS only.
    pub fn parse(json: &str) -> Result<Self, String> {
        let manifest: Manifest = serde_json::from_str(json).map_err(|e| e.to_string())?;
        for (id, engine) in &manifest.engines {
            if engine.files.is_empty() {
                return Err(format!("{id} lists no files"));
            }
            for file in &engine.files {
                if !safe_relative(&file.name) {
                    return Err(format!("{:?} is not a safe relative path", file.name));
                }
                if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    return Err(format!("{} has no valid SHA-256", file.name));
                }
                if file.size == 0 || file.sources.is_empty() {
                    return Err(format!("{} has no size or no source", file.name));
                }
                if file.sources.iter().any(|s| !s.url.starts_with("https://")) {
                    return Err(format!("{} has a source not served over HTTPS", file.name));
                }
            }
        }
        Ok(manifest)
    }
}

pub fn manifest() -> &'static Manifest {
    static MANIFEST: std::sync::OnceLock<Manifest> = std::sync::OnceLock::new();
    MANIFEST.get_or_init(|| Manifest::parse(MANIFEST_JSON).expect("texthook-manifest.json is valid"))
}

/// Byte ranges over HTTP. `None` is the whole body, `Some((first, last))` an inclusive range.
/// (GitHub's asset host refuses suffix ranges, `bytes=-n`, so the size is asked for first.)
pub trait Fetch: Send + Sync {
    fn get(&self, url: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>, String>;
    /// The resource's size in bytes.
    fn size(&self, url: &str) -> Result<u64, String>;
}

pub struct HttpFetch {
    client: reqwest::blocking::Client,
}

impl HttpFetch {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent(concat!("Kimochi/", env!("CARGO_PKG_VERSION"), " (text hooker download)"))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(HttpFetch { client })
    }
}

/// The largest body accepted when a server ignores a range request and sends everything.
const WHOLE_LIMIT: u64 = 256 * 1024 * 1024;

impl Fetch for HttpFetch {
    fn get(&self, url: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>, String> {
        let mut request = self.client.get(url);
        if let Some((first, last)) = range {
            request = request.header(reqwest::header::RANGE, format!("bytes={first}-{last}"));
        }
        let response = request.send().map_err(|e| format!("network error: {}", e.without_url()))?;
        let status = response.status();
        if !status.is_success() {
            let host = response.url().host_str().unwrap_or("the server").to_string();
            return Err(format!("{host} answered HTTP {}", status.as_u16()));
        }
        if range.is_some() && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err("the server does not serve byte ranges".into());
        }
        let mut body = Vec::new();
        response
            .take(WHOLE_LIMIT)
            .read_to_end(&mut body)
            .map_err(|e| format!("network error: {e}"))?;
        Ok(body)
    }

    fn size(&self, url: &str) -> Result<u64, String> {
        let response = self
            .client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
            .map_err(|e| format!("network error: {}", e.without_url()))?;
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!("the server does not serve byte ranges (HTTP {})", response.status().as_u16()));
        }
        response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| "the server did not say how large the file is".to_string())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn u16_at(b: &[u8], at: usize) -> Result<u16, String> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| "corrupt zip (truncated)".into())
}
fn u32_at(b: &[u8], at: usize) -> Result<u32, String> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| "corrupt zip (truncated)".into())
}

/// Where one entry lives in a remote zip, from its central directory.
#[derive(Debug, Clone, PartialEq)]
struct Located {
    method: u16,
    crc: u32,
    compressed: u64,
    size: u64,
    local: u64,
}

/// Finds `entry` through the zip's end-of-central-directory record and central directory,
/// fetching only the zip's tail (and the directory, if it lies further back).
fn locate(fetch: &dyn Fetch, url: &str, entry: &str) -> Result<Located, String> {
    const TAIL: u64 = 64 * 1024 + 22;
    let size = fetch.size(url)?;
    let tail = fetch.get(url, Some((size.saturating_sub(TAIL), size - 1)))?;
    if tail.len() < 22 {
        return Err("not a zip file".into());
    }
    let eocd = (0..=tail.len() - 22)
        .rev()
        .find(|&i| u32_at(&tail, i) == Ok(0x0605_4b50))
        .ok_or("not a zip file (no end of central directory)")?;
    let directory_size = u32_at(&tail, eocd + 12)? as u64;
    let directory_start = u32_at(&tail, eocd + 16)? as u64;
    if directory_start == 0xffff_ffff {
        return Err("ZIP64 archives are not supported".into());
    }
    // The directory ends where the EOCD record starts.
    let directory = if eocd as u64 >= directory_size {
        tail[eocd - directory_size as usize..eocd].to_vec()
    } else {
        fetch.get(url, Some((directory_start, directory_start + directory_size - 1)))?
    };
    let mut at = 0usize;
    while at + 46 <= directory.len() {
        if u32_at(&directory, at)? != 0x0201_4b50 {
            return Err("corrupt zip central directory".into());
        }
        let flags = u16_at(&directory, at + 8)?;
        let method = u16_at(&directory, at + 10)?;
        let crc = u32_at(&directory, at + 16)?;
        let compressed = u32_at(&directory, at + 20)? as u64;
        let size = u32_at(&directory, at + 24)? as u64;
        let name_len = u16_at(&directory, at + 28)? as usize;
        let extra_len = u16_at(&directory, at + 30)? as usize;
        let comment_len = u16_at(&directory, at + 32)? as usize;
        let local = u32_at(&directory, at + 42)? as u64;
        let name = directory.get(at + 46..at + 46 + name_len).ok_or("corrupt zip (truncated)")?;
        if name == entry.as_bytes() {
            if flags & 1 != 0 {
                return Err(format!("{entry} is encrypted"));
            }
            if method != 0 && method != 8 {
                return Err(format!("{entry} uses unsupported compression {method}"));
            }
            return Ok(Located { method, crc, compressed, size, local });
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    Err(format!("the release has no {entry}"))
}

/// One zip entry's bytes, fetched by range, inflated and CRC-checked.
fn zip_entry(fetch: &dyn Fetch, url: &str, entry: &str, expected_size: u64) -> Result<Vec<u8>, String> {
    let located = locate(fetch, url, entry)?;
    if located.size != expected_size {
        return Err(format!("{entry} has another size in this release"));
    }
    let header = fetch.get(url, Some((located.local, located.local + 29)))?;
    if u32_at(&header, 0)? != 0x0403_4b50 {
        return Err(format!("corrupt local header for {entry}"));
    }
    let start = located.local + 30 + u16_at(&header, 26)? as u64 + u16_at(&header, 28)? as u64;
    let raw = if located.compressed == 0 {
        Vec::new()
    } else {
        fetch.get(url, Some((start, start + located.compressed - 1)))?
    };
    if raw.len() as u64 != located.compressed {
        return Err(format!("short read of {entry}"));
    }
    let data = if located.method == 0 {
        raw
    } else {
        let mut out = Vec::with_capacity(located.size as usize);
        flate2::read::DeflateDecoder::new(raw.as_slice())
            .take(located.size + 1)
            .read_to_end(&mut out)
            .map_err(|e| format!("could not inflate {entry}: {e}"))?;
        out
    };
    if data.len() as u64 != located.size || crc32fast::hash(&data) != located.crc {
        return Err(format!("{entry} failed its CRC check"));
    }
    Ok(data)
}

/// Fetches one manifest file from the first source that yields the right bytes.
pub fn fetch_file(fetch: &dyn Fetch, file: &File) -> Result<Vec<u8>, String> {
    let mut errors = Vec::new();
    for source in &file.sources {
        let result = match &source.zip_entry {
            Some(entry) => zip_entry(fetch, &source.url, entry, file.size),
            None => fetch.get(&source.url, None),
        }
        .and_then(|data| {
            if data.len() as u64 != file.size {
                return Err(format!("wrong size ({} bytes)", data.len()));
            }
            if hex(&Sha256::digest(&data)) != file.sha256 {
                return Err("SHA-256 mismatch".into());
            }
            Ok(data)
        });
        match result {
            Ok(data) => return Ok(data),
            Err(e) => errors.push(format!("{}: {e}", host_of(&source.url))),
        }
    }
    Err(format!("{}: {}", file.name, errors.join("; ")))
}

fn host_of(url: &str) -> &str {
    url.trim_start_matches("https://").split('/').next().unwrap_or(url)
}

pub fn engine_dir(root: &Path, id: &str, engine: &Engine) -> PathBuf {
    root.join(format!("{id}-{}", engine.version))
}

/// The engine's directory when every file is present with its size (hashes are checked when
/// installing; the directory only exists once they all passed).
pub fn installed(root: &Path, id: &str) -> Option<PathBuf> {
    let engine = manifest().engines.get(id)?;
    let dir = engine_dir(root, id, engine);
    let complete = engine.files.iter().all(|f| {
        fs::metadata(dir.join(&f.name)).map(|m| m.len() == f.size).unwrap_or(false)
    });
    complete.then_some(dir)
}

/// Downloads and verifies every file of `id` into a staging directory, then renames it into
/// place. `progress` gets (bytes done, bytes total) after each file.
pub fn install(
    fetch: &dyn Fetch,
    root: &Path,
    id: &str,
    progress: &dyn Fn(u64, u64),
) -> Result<PathBuf, String> {
    install_from(fetch, manifest(), root, id, progress)
}

fn install_from(
    fetch: &dyn Fetch,
    manifest: &Manifest,
    root: &Path,
    id: &str,
    progress: &dyn Fn(u64, u64),
) -> Result<PathBuf, String> {
    let engine = manifest.engines.get(id).ok_or_else(|| format!("no engine {id}"))?;
    let dir = engine_dir(root, id, engine);
    if dir.is_dir() {
        return Ok(dir);
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let staging = root.join(format!(".staging-{id}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let total: u64 = engine.files.iter().map(|f| f.size).sum();
    let mut done = 0;
    progress(0, total);
    let result = (|| {
        for file in &engine.files {
            let data = fetch_file(fetch, file)?;
            let path = staging.join(&file.name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&path, data).map_err(|e| e.to_string())?;
            done += file.size;
            progress(done, total);
        }
        fs::rename(&staging, &dir).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|()| dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serves files from memory and records the ranges asked for.
    struct Fake {
        files: BTreeMap<String, Vec<u8>>,
        asked: Mutex<Vec<String>>,
    }
    impl Fetch for Fake {
        fn get(&self, url: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>, String> {
            self.asked.lock().unwrap().push(format!("{url} {range:?}"));
            let body = self.files.get(url).ok_or("HTTP 404")?;
            Ok(match range {
                None => body.clone(),
                Some((first, last)) => body[first as usize..=(last as usize).min(body.len() - 1)].to_vec(),
            })
        }
        fn size(&self, url: &str) -> Result<u64, String> {
            Ok(self.files.get(url).ok_or("HTTP 404")?.len() as u64)
        }
    }

    /// A minimal zip writer: stored and deflated entries, as release zips have them.
    fn zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        use std::io::Write;
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in entries {
            let body = if *deflate {
                let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(data).unwrap();
                e.finish().unwrap()
            } else {
                data.to_vec()
            };
            let local = out.len() as u32;
            let method: u16 = if *deflate { 8 } else { 0 };
            let crc = crc32fast::hash(data);
            let mut header = Vec::new();
            header.extend(0x0403_4b50u32.to_le_bytes());
            header.extend([20, 0, 0, 0]);
            header.extend(method.to_le_bytes());
            header.extend([0; 4]);
            header.extend(crc.to_le_bytes());
            header.extend((body.len() as u32).to_le_bytes());
            header.extend((data.len() as u32).to_le_bytes());
            header.extend((name.len() as u16).to_le_bytes());
            header.extend(3u16.to_le_bytes());
            header.extend(name.as_bytes());
            header.extend([1, 2, 3]);
            out.extend(&header);
            out.extend(&body);
            central.extend(0x0201_4b50u32.to_le_bytes());
            central.extend([20, 0, 20, 0, 0, 0]);
            central.extend(method.to_le_bytes());
            central.extend([0; 4]);
            central.extend(crc.to_le_bytes());
            central.extend((body.len() as u32).to_le_bytes());
            central.extend((data.len() as u32).to_le_bytes());
            central.extend((name.len() as u16).to_le_bytes());
            central.extend([0; 12]);
            central.extend(local.to_le_bytes());
            central.extend(name.as_bytes());
        }
        let start = out.len() as u32;
        out.extend(&central);
        out.extend(0x0605_4b50u32.to_le_bytes());
        out.extend([0; 4]);
        out.extend((entries.len() as u16).to_le_bytes());
        out.extend((entries.len() as u16).to_le_bytes());
        out.extend((central.len() as u32).to_le_bytes());
        out.extend(start.to_le_bytes());
        out.extend([0, 0]);
        out
    }

    fn sha(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    fn manifest_for(files: &[(&str, &[u8], Vec<Source>)]) -> Manifest {
        Manifest {
            engines: BTreeMap::from([(
                "luna".to_string(),
                Engine {
                    name: "LunaHook".into(),
                    version: "1.0".into(),
                    project: String::new(),
                    license: String::new(),
                    files: files
                        .iter()
                        .map(|(name, data, sources)| File {
                            name: name.to_string(),
                            size: data.len() as u64,
                            sha256: sha(data),
                            sources: sources.clone(),
                        })
                        .collect(),
                },
            )]),
        }
    }

    /// The real thing: every engine from its first (upstream) source. Run by hand with
    /// `cargo test texthook_downloads_from_upstream -- --ignored`; it needs the network.
    #[test]
    #[ignore]
    fn texthook_downloads_from_upstream() {
        let root = std::env::temp_dir().join(format!("kimochi-texthook-live-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let fetch = HttpFetch::new().unwrap();
        for id in manifest().engines.keys() {
            let started = std::time::Instant::now();
            let bytes = Mutex::new(0u64);
            let dir = install(&fetch, &root, id, &|done, _| *bytes.lock().unwrap() = done).unwrap();
            assert_eq!(installed(&root, id), Some(dir));
            eprintln!("{id}: {} bytes in {:?}", bytes.lock().unwrap(), started.elapsed());
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_committed_manifest_parses() {
        let manifest = manifest();
        assert!(manifest.engines.contains_key("luna"));
        assert!(manifest.engines.contains_key("textractor"));
        for engine in manifest.engines.values() {
            for file in &engine.files {
                assert!(file.sources.len() >= 2, "{} has a mirror and an upstream source", file.name);
            }
        }
    }

    #[test]
    fn unsafe_names_and_plain_http_are_refused() {
        let base = r#"{"engines":{"x":{"name":"X","version":"1","project":"","license":"","files":[{"name":NAME,"size":1,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","sources":[{"url":URL}]}]}}}"#;
        let with = |name: &str, url: &str| base.replace("NAME", name).replace("URL", url);
        assert!(Manifest::parse(&with(r#""a/b.dll""#, r#""https://x""#)).is_ok());
        assert!(Manifest::parse(&with(r#""../b.dll""#, r#""https://x""#)).is_err());
        assert!(Manifest::parse(&with(r#""C:/b.dll""#, r#""https://x""#)).is_err());
        assert!(Manifest::parse(&with(r#""b.dll""#, r#""http://x""#)).is_err());
    }

    #[test]
    fn a_zip_entry_is_read_by_range_without_the_rest_of_the_zip() {
        let big = vec![7u8; 300_000];
        let host = b"host dll bytes".repeat(1000);
        let archive = zip(&[("pad.bin", &big, false), ("R/files/LunaHost64.dll", &host, true)]);
        let fake = Fake { files: BTreeMap::from([("https://gh/r.zip".to_string(), archive.clone())]), asked: Mutex::default() };
        let manifest = manifest_for(&[(
            "LunaHost64.dll",
            &host,
            vec![Source { url: "https://gh/r.zip".into(), zip_entry: Some("R/files/LunaHost64.dll".into()) }],
        )]);
        let root = std::env::temp_dir().join(format!("kimochi-texthook-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = install_from(&fake, &manifest, &root, "luna", &|_, _| {}).unwrap();
        assert_eq!(fs::read(dir.join("LunaHost64.dll")).unwrap(), host);
        // Never the whole archive: the tail, the local header and the entry.
        let asked = fake.asked.lock().unwrap().clone();
        assert!(asked.iter().all(|a| !a.ends_with("None")), "{asked:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bad_source_falls_through_to_the_next_and_a_wrong_hash_is_never_kept() {
        let good = b"the real file".to_vec();
        let fake = Fake {
            files: BTreeMap::from([
                ("https://mirror/tampered".to_string(), b"the fake file".to_vec()),
                ("https://mirror/good".to_string(), good.clone()),
            ]),
            asked: Mutex::default(),
        };
        let file = File {
            name: "a.dll".into(),
            size: good.len() as u64,
            sha256: sha(&good),
            sources: vec![
                Source { url: "https://gone/404".into(), zip_entry: None },
                Source { url: "https://mirror/tampered".into(), zip_entry: None },
                Source { url: "https://mirror/good".into(), zip_entry: None },
            ],
        };
        assert_eq!(fetch_file(&fake, &file).unwrap(), good);
        let only_bad = File { sources: file.sources[..2].to_vec(), ..file };
        let error = fetch_file(&fake, &only_bad).unwrap_err();
        assert!(error.contains("SHA-256 mismatch"), "{error}");
    }
}
