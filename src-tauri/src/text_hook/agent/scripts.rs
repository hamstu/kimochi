//! The Agent scripts collection, downloaded on demand at the pinned commit (`index.rs`): GitHub's
//! archive of that commit, unpacked into a staging folder and kept only if every file is exactly
//! the pinned one (an archive's bytes may change; its files may not).
//!
//! ```text
//! <app local data>/texthook/agent-scripts-<commit>/   the verified collection
//! ```
use super::index::index;
use crate::text_hook::store::Fetch;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const VERIFIED_MARKER: &str = ".verified";

pub fn dir(root: &Path) -> PathBuf {
    root.join(format!("agent-scripts-{}", &index().commit[..12]))
}

/// Fast check for UI status / target polling: checks the verified marker written after a full
/// SHA-256 unpack plus `libLoader.js`, falling back once to the full 600-file size scan for
/// directories unpacked before the marker existed.
pub fn installed_fast(root: &Path) -> Option<PathBuf> {
    let dir = dir(root);
    if !dir.is_dir() {
        return None;
    }
    let marker = dir.join(VERIFIED_MARKER);
    if fs::read_to_string(&marker).ok().as_deref().map(str::trim) == Some(index().commit.as_str()) {
        let loader_ok = index()
            .files
            .iter()
            .find(|(name, _, _)| name == "libLoader.js")
            .is_some_and(|(name, size, _)| fs::metadata(dir.join(name)).map(|m| m.len() == *size).unwrap_or(false));
        if loader_ok {
            return Some(dir);
        }
    }
    let verified = installed(root)?;
    let _ = fs::write(&marker, &index().commit);
    Some(verified)
}

/// The collection's folder, when it is there whole (each file at its size; the hashes were checked
/// when it was unpacked, and the folder only exists once they all passed).
pub fn installed(root: &Path) -> Option<PathBuf> {
    let dir = dir(root);
    if !dir.is_dir() {
        return None;
    }
    let complete = index()
        .files
        .iter()
        .all(|(name, size, _)| fs::metadata(dir.join(name)).map(|m| m.len() == *size).unwrap_or(false));
    complete.then_some(dir)
}

/// The bytes a download of the collection takes.
pub fn download_size() -> u64 {
    index().archive.size
}

/// Downloads and unpacks the collection. `progress` hears the bytes received of `download_size`.
pub fn install(fetch: &dyn Fetch, root: &Path, progress: &dyn Fn(u64)) -> Result<PathBuf, String> {
    let target = dir(root);
    if let Some(dir) = installed(root) {
        return Ok(dir);
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    for url in &index().archive.urls {
        match fetch.get_streamed(url, progress).and_then(|archive| unpack(&archive, root, &target)) {
            Ok(()) => return Ok(target),
            Err(e) => {
                errors.push(format!("{}: {e}", url.trim_start_matches("https://").split('/').next().unwrap_or(url)))
            }
        }
    }
    Err(format!("The Agent scripts could not be downloaded ({})", errors.join("; ")))
}

/// Unpacks `archive` (everything under one top folder, as GitHub's archives have it) into `target`,
/// through a staging folder, if its files are exactly the pinned ones.
fn unpack(archive: &[u8], root: &Path, target: &Path) -> Result<(), String> {
    use crate::extension_store::{unpack as unpack_zip, zip_entries};
    use crate::model_store::Stop;
    let top = zip_entries(archive)?
        .first()
        .and_then(|e| e.name.split('/').next().map(str::to_string))
        .ok_or("the archive is empty")?;
    let expected: BTreeMap<String, String> =
        index().files.iter().map(|(name, _, sha)| (name.clone(), sha.clone())).collect();
    let staging = root.join(format!(".staging-agent-scripts-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let control = std::sync::atomic::AtomicU8::new(0);
    let result = unpack_zip(archive, &staging, &top, &expected, &control)
        .map_err(|stop| match stop {
            Stop::Failed(e) => e,
            _ => "stopped".to_string(),
        })
        .and_then(|()| {
            fs::write(staging.join(VERIFIED_MARKER), &index().commit).map_err(|e| e.to_string())?;
            let _ = fs::remove_dir_all(target);
            crate::extension_store::rename_with_retry(&staging, target).map_err(|e| e.to_string())
        });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}
