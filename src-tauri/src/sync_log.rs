//! The sync log: the last `CAPACITY` things Sync did (pulls, pushes, merges, conflicts, errors,
//! going offline and online, profile switches), newest last. Kept in memory and appended to
//! `<AppLocalData>/sync-log.jsonl`, which is compacted back to `CAPACITY` lines once it grows past
//! a quarter more, so it survives restarts without growing. Each entry's text is cut to
//! `MAX_TEXT` characters. Never holds a token or file contents beyond a short quote.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CAPACITY: usize = 2000;
pub const MAX_TEXT: usize = 600;
pub const FILE: &str = "sync-log.jsonl";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// Epoch milliseconds.
    pub t: u64,
    /// `info`, `pull`, `push`, `merge`, `conflict`, `error`, `net`, `profile`.
    pub kind: String,
    pub text: String,
}

pub struct SyncLog {
    path: PathBuf,
    entries: Mutex<(VecDeque<Entry>, usize)>,
}

fn clip(text: &str) -> String {
    let text = text.replace(['\r', '\n'], " ");
    if text.chars().count() <= MAX_TEXT {
        text
    } else {
        format!("{}…", text.chars().take(MAX_TEXT).collect::<String>())
    }
}

impl SyncLog {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(FILE);
        let mut entries = VecDeque::new();
        let mut lines = 0;
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                lines += 1;
                if let Ok(entry) = serde_json::from_str::<Entry>(line) {
                    entries.push_back(entry);
                    if entries.len() > CAPACITY {
                        entries.pop_front();
                    }
                }
            }
        }
        Self { path, entries: Mutex::new((entries, lines)) }
    }

    /// Add an entry; returns it as stored.
    pub fn push(&self, t: u64, kind: &str, text: &str) -> Entry {
        let entry = Entry { t, kind: kind.to_string(), text: clip(text) };
        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let (entries, lines) = &mut *guard;
        entries.push_back(entry.clone());
        while entries.len() > CAPACITY {
            entries.pop_front();
        }
        *lines += 1;
        if *lines > CAPACITY + CAPACITY / 4 {
            // Compact: rewrite only what is kept.
            let body: String = entries
                .iter()
                .filter_map(|e| serde_json::to_string(e).ok())
                .map(|l| l + "\n")
                .collect();
            let tmp = self.path.with_extension("jsonl.tmp");
            if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &self.path).is_ok() {
                *lines = entries.len();
            }
        } else if let Ok(line) = serde_json::to_string(&entry) {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) {
                let _ = writeln!(file, "{line}");
            }
        }
        entry
    }

    pub fn entries(&self) -> Vec<Entry> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).0.iter().cloned().collect()
    }

    pub fn clear(&self) {
        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        guard.0.clear();
        guard.1 = 0;
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_is_bounded_persisted_and_clipped() {
        let dir = std::env::temp_dir().join(format!("kimochi-sync-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = SyncLog::open(&dir);
        for i in 0..(CAPACITY + 700) {
            log.push(i as u64, "info", &format!("entry {i}"));
        }
        let long = log.push(1, "error", &"x\n".repeat(2000));
        assert!(long.text.chars().count() <= MAX_TEXT + 1 && !long.text.contains('\n'));
        let entries = log.entries();
        assert_eq!(entries.len(), CAPACITY);
        assert_eq!(entries[0].text, format!("entry {}", 701));
        let reopened = SyncLog::open(&dir);
        assert_eq!(reopened.entries(), entries, "survives a restart");
        let lines = std::fs::read_to_string(dir.join(FILE)).unwrap().lines().count();
        assert!(lines <= CAPACITY + CAPACITY / 4, "compacted: {lines}");
        reopened.clear();
        assert!(SyncLog::open(&dir).entries().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
