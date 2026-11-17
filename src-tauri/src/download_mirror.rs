//! Kimochi's own download mirror, `downloads.kimochiapp.com` (Cloudflare R2), tried before the
//! upstream host for every pinned download, with the upstream URL as the fallback.
//!
//! Every third-party file the app downloads at runtime is pinned by SHA-256 (the OCR and speech
//! models in `ocr-models.json`, the dictionary engines in `extensions/<id>.source.json`, the text
//! hookers in `texthook-manifest.json`, the Yomitan API helper in `reader/yomitan_install.rs`).
//! `.github/workflows/download-mirror.yml` (`scripts/download-mirror.mjs`) copies each pinned file
//! from upstream to the mirror after checking that hash, at a path derived from the pin alone:
//!
//! ```text
//! https://downloads.kimochiapp.com/files/sha256/<sha256>/<the upstream URL's file name>
//! ```
//!
//! So the app needs no list of what is mirrored: it asks the mirror first, and on any failure (an
//! error, a timeout, a 404 for a file not mirrored yet, the wrong size or hash) asks upstream. The
//! same size and SHA-256 checks apply to both, so the mirror is trusted no more than GitHub.
//!
//! Only files from the hosts in [`MIRRORED_HOSTS`] are mirrored (Screen AI's Google package is
//! not ours to redistribute, so it is fetched from Google only).
//!
//! `KIMOCHI_DOWNLOAD_MIRROR` overrides the mirror for testing: `off` skips it, a URL replaces
//! `https://downloads.kimochiapp.com` (for example a local `python3 -m http.server`).
//!
//! The app's own updates use the mirror too (`updater.rs`, [`github_release_url`]).
use crate::model_store::{download_file as download_from, Fetch, ModelFile, Progress, Stop};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{atomic::AtomicU8, OnceLock},
};

/// The mirror's origin. Its layout is documented in `DOWNLOADS_MIRROR.md`.
pub const MIRROR: &str = "https://downloads.kimochiapp.com";
/// Where the app's own releases live upstream; `app/v<version>/<file>` on the mirror is a copy.
pub const GITHUB_RELEASES: &str = "https://github.com/hamstu/kimochi/releases/download/";
/// Upstream hosts whose pinned files are copied to the mirror (`scripts/download-mirror.mjs`
/// keeps the same list).
pub const MIRRORED_HOSTS: &[&str] = &["github.com", "huggingface.co", "raw.githubusercontent.com"];

/// Where fallbacks and failures are reported (`record` in main.rs: the Debug panel and
/// `evidence.jsonl`).
static REPORT: OnceLock<Box<dyn Fn(Value) + Send + Sync>> = OnceLock::new();

pub fn set_report(report: impl Fn(Value) + Send + Sync + 'static) {
    let _ = REPORT.set(Box::new(report));
}

fn report(value: Value) {
    eprintln!("kimochi: {value}");
    if let Some(report) = REPORT.get() {
        report(value);
    }
}

/// The mirror's origin, without a trailing slash, or `None` when `KIMOCHI_DOWNLOAD_MIRROR=off`.
/// Off in unit tests, whose fake networks serve upstream URLs only (this module's own tests pass
/// the mirror explicitly).
pub fn base() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    base_from(std::env::var("KIMOCHI_DOWNLOAD_MIRROR").ok().as_deref())
}

fn base_from(setting: Option<&str>) -> Option<String> {
    match setting.map(str::trim) {
        None | Some("") => Some(MIRROR.to_string()),
        Some(off) if off.eq_ignore_ascii_case("off") || off == "0" => None,
        Some(url) => Some(url.trim_end_matches('/').to_string()),
    }
}

pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

fn is_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The last path segment of `url`, kept to `[A-Za-z0-9._-]` (anything else becomes `_`), as the
/// mirror's file name. Must match `fileName` in `scripts/download-mirror.mjs`.
fn file_name(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or("");
    let name: String =
        last.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        "file".into()
    } else {
        name
    }
}

/// The mirror's path for a pinned upstream file, or `None` when it is not mirrored.
pub fn mirror_path(url: &str, sha256: &str) -> Option<String> {
    if !url.starts_with("https://") || !is_sha256(sha256) || !MIRRORED_HOSTS.contains(&host_of(url)) {
        return None;
    }
    Some(format!("files/sha256/{sha256}/{}", file_name(url)))
}

/// The URLs to try for a pinned file, in order: the mirror's copy (when mirrored and the mirror
/// is on), then `url` itself.
pub fn sources(url: &str, sha256: &str) -> Vec<String> {
    sources_with(base().as_deref(), url, sha256)
}

fn sources_with(base: Option<&str>, url: &str, sha256: &str) -> Vec<String> {
    let mut urls = Vec::with_capacity(2);
    if let (Some(base), Some(path)) = (base, mirror_path(url, sha256)) {
        urls.push(format!("{base}/{path}"));
    }
    urls.push(url.to_string());
    urls
}

/// Puts mirror URLs first in an explicit source list, and replaces the default mirror with the
/// configured one (or drops it when the mirror is off). Upstream URLs keep their order.
pub fn order<T: Clone>(sources: &[T], url_of: impl Fn(&T) -> &str, with_url: impl Fn(&T, String) -> T) -> Vec<T> {
    order_with(base().as_deref(), sources, url_of, with_url)
}

fn order_with<T: Clone>(
    base: Option<&str>,
    sources: &[T],
    url_of: impl Fn(&T) -> &str,
    with_url: impl Fn(&T, String) -> T,
) -> Vec<T> {
    let default = format!("{MIRROR}/");
    let mut mirrored = Vec::new();
    let mut upstream = Vec::new();
    for source in sources {
        let url = url_of(source);
        match url.strip_prefix(&default) {
            Some(path) => {
                if let Some(base) = base {
                    mirrored.push(with_url(source, format!("{base}/{path}")));
                }
            }
            None => upstream.push(source.clone()),
        }
    }
    mirrored.extend(upstream);
    mirrored
}

/// [`crate::model_store::download_file`] over [`sources`]: the mirror first, then upstream. A
/// pause or cancel stops at once; a failure moves on to the next source (the `.part` carries over
/// when it is a prefix of the same pinned bytes, and is discarded by the size and hash checks
/// when it is not). The error is the last source's.
pub fn download_file(
    fetch: &dyn Fetch,
    dir: &Path,
    file: &ModelFile,
    control: &AtomicU8,
    progress: &mut dyn FnMut(Progress),
) -> Result<(), Stop> {
    download_file_with(base().as_deref(), fetch, dir, file, control, progress)
}

fn download_file_with(
    base: Option<&str>,
    fetch: &dyn Fetch,
    dir: &Path,
    file: &ModelFile,
    control: &AtomicU8,
    progress: &mut dyn FnMut(Progress),
) -> Result<(), Stop> {
    let urls = sources_with(base, &file.url, &file.sha256);
    let last = urls.len() - 1;
    for (i, url) in urls.into_iter().enumerate() {
        let attempt = ModelFile { url: url.clone(), ..file.clone() };
        match download_from(fetch, dir, &attempt, control, progress) {
            Err(Stop::Failed(reason)) if i < last => {
                report(json!({
                    "check": "download-mirror",
                    "status": "fallback",
                    "file": file.name,
                    "from": host_of(&url),
                    "to": host_of(&file.url),
                    "detail": reason,
                }));
            }
            Ok(()) => {
                if i > 0 {
                    report(json!({
                        "check": "download-mirror",
                        "status": "ok",
                        "file": file.name,
                        "source": host_of(&url),
                    }));
                }
                return Ok(());
            }
            other => return other,
        }
    }
    unreachable!("sources always ends with the upstream URL")
}

/// The GitHub Releases URL a mirrored app-release URL copies
/// (`<mirror>/app/v1.2.3/<file>` → `https://github.com/hamstu/kimochi/releases/download/v1.2.3/<file>`),
/// for retrying an update download that failed on the mirror.
pub fn github_release_url(url: &str) -> Option<String> {
    let path = [MIRROR.to_string()]
        .into_iter()
        .chain(base())
        .find_map(|base| url.strip_prefix(&format!("{base}/app/")).map(str::to_string))?;
    let (tag, name) = path.split_once('/')?;
    if !tag.starts_with('v') || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(format!("{GITHUB_RELEASES}{tag}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_store::{Body, Opened, RUN};
    use sha2::{Digest, Sha256};
    use std::{collections::HashMap, io::Cursor, sync::Mutex};

    const HASH: &str = "69753a221e8cf472cf1a7e17ff51133c471511638934ef4414a102e9d4c0252d";

    #[test]
    fn mirror_paths_come_from_the_pin_alone() {
        assert_eq!(
            mirror_path(
                "https://github.com/birchill/10ten-ja-reader/releases/download/v1.29.0/10ten-ja-reader-1.29.0-chrome.zip",
                HASH
            )
            .as_deref(),
            Some(format!("files/sha256/{HASH}/10ten-ja-reader-1.29.0-chrome.zip").as_str())
        );
        assert_eq!(
            mirror_path("https://huggingface.co/a/b/resolve/abc/model%20v1.onnx?download=true", HASH).as_deref(),
            Some(format!("files/sha256/{HASH}/model_20v1.onnx").as_str())
        );
        // Not ours to redistribute, not pinned, or not https.
        assert_eq!(mirror_path("https://chrome-infra-packages.appspot.com/dl/x/+/y", HASH), None);
        assert_eq!(mirror_path("https://github.com/a/b.zip", "abc"), None);
        assert_eq!(mirror_path("http://github.com/a/b.zip", HASH), None);
        assert_eq!(file_name("https://github.com/a/.."), "file");
    }

    #[test]
    fn the_mirror_comes_first_unless_it_is_off() {
        let url = "https://github.com/a/b/releases/download/v1/x.zip";
        assert_eq!(
            sources_with(Some(MIRROR), url, HASH),
            vec![format!("{MIRROR}/files/sha256/{HASH}/x.zip"), url.to_string()]
        );
        assert_eq!(sources_with(None, url, HASH), vec![url.to_string()]);
        assert_eq!(sources_with(Some(MIRROR), "https://example.com/x.zip", HASH), vec!["https://example.com/x.zip"]);
        assert_eq!(base_from(Some("off")), None);
        assert_eq!(base_from(None).as_deref(), Some(MIRROR));
        assert_eq!(base_from(Some("http://127.0.0.1:8000/")).as_deref(), Some("http://127.0.0.1:8000"));
    }

    #[test]
    fn explicit_lists_put_the_mirror_first() {
        let list = vec![
            "https://github.com/x/r.zip".to_string(),
            format!("{MIRROR}/texthook/luna/1/a.dll"),
            "https://example.com/b".to_string(),
        ];
        let ordered = order_with(Some(MIRROR), &list, |s| s.as_str(), |_, url| url);
        assert_eq!(ordered[0], format!("{MIRROR}/texthook/luna/1/a.dll"));
        assert_eq!(ordered[1..], list[..1].iter().chain(&list[2..]).cloned().collect::<Vec<_>>()[..]);
        let local = order_with(Some("http://127.0.0.1:9"), &list, |s| s.as_str(), |_, url| url);
        assert_eq!(local[0], "http://127.0.0.1:9/texthook/luna/1/a.dll");
        let off = order_with(None, &list, |s| s.as_str(), |_, url| url);
        assert_eq!(off.len(), 2);
        assert!(off.iter().all(|u| !u.starts_with(MIRROR)));
    }

    #[test]
    fn app_release_urls_map_back_to_github() {
        assert_eq!(
            github_release_url(&format!("{MIRROR}/app/v0.9.0/Kimochi_0.9.0_x64-setup.exe")).as_deref(),
            Some("https://github.com/hamstu/kimochi/releases/download/v0.9.0/Kimochi_0.9.0_x64-setup.exe")
        );
        assert_eq!(github_release_url(&format!("{MIRROR}/app/latest.json")), None);
        assert_eq!(github_release_url("https://github.com/hamstu/kimochi/releases/download/v1/x"), None);
    }

    /// Serves fixed bytes per URL; anything else is a 404.
    struct Fake {
        files: HashMap<String, Vec<u8>>,
        requests: Mutex<Vec<String>>,
    }

    impl Fetch for Fake {
        fn open(&self, url: &str, offset: u64) -> Result<Opened, String> {
            self.requests.lock().unwrap().push(url.to_string());
            let data = self.files.get(url).ok_or_else(|| format!("{} answered HTTP 404", host_of(url)))?;
            let rest = data[offset as usize..].to_vec();
            Ok(Opened::Body(Body {
                partial: offset > 0,
                length: Some(rest.len() as u64),
                reader: Box::new(Cursor::new(rest)),
            }))
        }
    }

    fn pinned(data: &[u8]) -> ModelFile {
        let sha256: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
        ModelFile {
            name: "x.onnx".into(),
            repository: String::new(),
            revision: String::new(),
            url: "https://github.com/up/stream/releases/download/v1/x.onnx".into(),
            sha256,
            size: data.len() as u64,
            platforms: vec![],
            unpack: false,
        }
    }

    fn run(fake: &Fake, file: &ModelFile) -> (Result<(), Stop>, Vec<u8>) {
        let dir = std::env::temp_dir().join(format!(
            "kimochi-mirror-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let result = download_file_with(Some(MIRROR), fake, &dir, file, &AtomicU8::new(RUN), &mut |_| {});
        let bytes = std::fs::read(dir.join(&file.name)).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        (result, bytes)
    }

    #[test]
    fn a_good_mirror_is_used_and_upstream_is_not_asked() {
        let data = b"the pinned model".to_vec();
        let file = pinned(&data);
        let mirror = sources_with(Some(MIRROR), &file.url, &file.sha256)[0].clone();
        let fake = Fake { files: HashMap::from([(mirror.clone(), data.clone())]), requests: Mutex::default() };
        let (result, bytes) = run(&fake, &file);
        assert_eq!(result, Ok(()));
        assert_eq!(bytes, data);
        assert_eq!(*fake.requests.lock().unwrap(), vec![mirror]);
    }

    #[test]
    fn a_missing_or_tampered_mirror_falls_back_to_upstream() {
        let data = b"the pinned model".to_vec();
        let file = pinned(&data);
        let mirror = sources_with(Some(MIRROR), &file.url, &file.sha256)[0].clone();
        // Missing on the mirror (404).
        let fake = Fake { files: HashMap::from([(file.url.clone(), data.clone())]), requests: Mutex::default() };
        let (result, bytes) = run(&fake, &file);
        assert_eq!(result, Ok(()));
        assert_eq!(bytes, data);
        assert_eq!(*fake.requests.lock().unwrap(), vec![mirror.clone(), file.url.clone()]);
        // Same size, different bytes: the hash check discards it and upstream is asked.
        let fake = Fake {
            files: HashMap::from([(mirror, b"the tampered!!!!".to_vec()), (file.url.clone(), data.clone())]),
            requests: Mutex::default(),
        };
        let (result, bytes) = run(&fake, &file);
        assert_eq!(result, Ok(()));
        assert_eq!(bytes, data);
    }

    #[test]
    fn when_both_fail_the_error_is_upstreams() {
        let file = pinned(b"x");
        let fake = Fake { files: HashMap::new(), requests: Mutex::default() };
        let (result, _) = run(&fake, &file);
        assert_eq!(result, Err(Stop::Failed("could not download x.onnx: github.com answered HTTP 404".into())));
    }
}
