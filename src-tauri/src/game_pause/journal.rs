//! The on-disk record of what is suspended, so a game outlives a crash of Kimochi *and* of its
//! guard. The guard writes it before it stops anything (the whole plan) and again after (what was
//! stopped), and clears it once everything is resumed. Recovery resumes each recorded process
//! whose identity still matches; a pid that now names another process is never touched.
use super::backend::{Backend, GameRef, ProcIdentity, Suspended};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The journal's file name in the app data folder.
pub const FILE: &str = "game-pause-journal.json";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub game: GameRef,
    pub members: Vec<ProcIdentity>,
    pub mechanism: String,
    /// Wall clock, ms since the epoch, when the pause began.
    pub at: u64,
    /// The guard process that owns it.
    pub guard: u32,
}

impl Entry {
    pub fn suspended(&self) -> Suspended {
        Suspended {
            game: self.game.clone(),
            members: self.members.clone(),
            mechanism: self.mechanism.clone(),
            results: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Journal {
    path: PathBuf,
}

/// One process recovery resumed or skipped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    pub pid: u32,
    pub exe: String,
    /// "resumed", "gone", "reused" (the pid is another process now) or "failed: …".
    pub outcome: String,
    /// When the orphaned pause began (ms since the epoch).
    pub since: u64,
}

impl Journal {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Journal { path: path.into() }
    }
    pub fn in_dir(dir: &Path) -> Self {
        Journal::new(dir.join(FILE))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Option<Entry> {
        let text = std::fs::read(&self.path).ok()?;
        serde_json::from_slice(&text).ok()
    }

    /// Atomically replaces the journal (write a sibling, flush, rename).
    pub fn write(&self, entry: &Entry) -> std::io::Result<()> {
        use std::io::Write;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&serde_json::to_vec(entry).map_err(std::io::Error::other)?)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
    }

    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.path);
    }

    /// Resumes whatever a previous run left suspended and clears the journal. `skip_guard`: a live
    /// guard's own entry (the app restarting while its guard still runs) is left alone.
    pub fn recover(&self, backend: &dyn Backend, skip_guard: Option<u32>) -> Vec<Recovered> {
        let Some(entry) = self.read() else {
            // An unreadable journal is removed: it can name nothing safely.
            if self.path.exists() {
                self.clear();
            }
            return Vec::new();
        };
        if skip_guard.is_some_and(|guard| guard == entry.guard) {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut live = Vec::new();
        for member in &entry.members {
            let outcome = match backend.identity(member.pid) {
                None => "gone".to_string(),
                Some(now) if !member.same_process(&now) => "reused".to_string(),
                Some(_) => {
                    live.push(member.clone());
                    continue;
                }
            };
            out.push(Recovered { pid: member.pid, exe: member.exe.clone(), outcome, since: entry.at });
        }
        if !live.is_empty() {
            let suspended = Suspended { members: live.clone(), ..entry.suspended() };
            let error = backend.resume(&suspended).err();
            for member in live {
                let outcome = match &error {
                    Some(e) if e.pid == Some(member.pid) => format!("failed: {e}"),
                    _ => "resumed".to_string(),
                };
                out.push(Recovered { pid: member.pid, exe: member.exe, outcome, since: entry.at });
            }
        }
        self.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::backend::{fake::Fake, Backend, GameRef};
    use super::*;

    fn tmp(name: &str) -> Journal {
        let dir = std::env::temp_dir().join(format!("kimochi-journal-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Journal::in_dir(&dir)
    }

    #[test]
    fn recovery_resumes_matching_and_skips_reused_pids() {
        let fake = Fake::new();
        fake.spawn(10, 100, None);
        fake.spawn(11, 101, Some(10));
        fake.spawn(12, 102, Some(10));
        let plan = fake.plan(&GameRef { pid: Some(10), ..Default::default() }).unwrap();
        let s = fake.suspend(&plan).unwrap();
        let journal = tmp("reuse");
        journal.write(&Entry { game: s.game, members: s.members, mechanism: s.mechanism, at: 1, guard: 999 }).unwrap();
        // 11 exited and its pid now names another (stopped by someone else) process; 12 is gone.
        fake.exit(11);
        fake.spawn(11, 555, None);
        fake.state.lock().unwrap().procs.get_mut(&11).unwrap().stopped = true;
        fake.exit(12);
        let out = journal.recover(&fake, None);
        assert!(!fake.stopped(10));
        assert!(fake.stopped(11), "a reused pid is never resumed");
        let outcome = |pid| out.iter().find(|r| r.pid == pid).unwrap().outcome.clone();
        assert_eq!(outcome(10), "resumed");
        assert_eq!(outcome(11), "reused");
        assert_eq!(outcome(12), "gone");
        assert!(journal.read().is_none());
    }

    #[test]
    fn live_guard_entry_is_left_alone_and_garbage_is_removed() {
        let journal = tmp("guard");
        let entry = Entry { guard: 42, ..Default::default() };
        journal.write(&entry).unwrap();
        assert!(Fake::new().identity(1).is_none());
        assert!(journal.recover(&Fake::new(), Some(42)).is_empty());
        assert_eq!(journal.read(), Some(entry));
        std::fs::write(journal.path(), b"{not json").unwrap();
        assert!(journal.recover(&Fake::new(), None).is_empty());
        assert!(!journal.path().exists());
    }
}
