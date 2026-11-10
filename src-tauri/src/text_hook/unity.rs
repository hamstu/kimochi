//! Unity text without the hooker: when LunaHook finds a Unity (Mono) game's text methods but
//! cannot patch them (its patch needs free memory close to the method's JIT code, and a grown
//! Mono heap can leave none; this is what "restart the game and hook again" sometimes gets past),
//! the voice hook DLL reads the text instead. Kimochi creates the event
//! `Local\voicehook_text_<pid>`, which tells the DLL to watch `TMPro.TMP_Text.set_text`, injects
//! the DLL if sentence audio has not already, and reads the `text` events it writes to its capture
//! (`events.jsonl`). Each `TMP_Text` object is a text thread, chosen like any other.
use super::{Hook, Thread};
use serde_json::Value;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What the hook codes of the threads this makes start with (then the setter, `TMP_Text.set_text`).
const HOOKCODE: &str = "UNITY:";

/// Whether a thread is a Unity text object read by the DLL.
pub fn is_unity(hookcode: &str) -> bool {
    hookcode.starts_with(HOOKCODE)
}

/// Whether a thread can be known again in the next run by its signature. A Unity thread's context
/// is its text object's address, which is new each run: a thread remembered by it would be some
/// other text object next time (a menu label as often as the dialogue), so the screen chooses.
pub fn remembers_by_signature(hookcode: &str) -> bool {
    !is_unity(hookcode)
}

/// A text the DLL read: the object it was set on, the setter, the text, and when (Unix ms).
#[derive(Debug, PartialEq)]
pub struct Text {
    pub obj: String,
    pub method: String,
    pub text: String,
    pub at: Option<u64>,
}

/// Whether a hook the hooker could not insert is one of its Unity (Mono JIT) hooks.
pub fn is_unity_failure(code: &str) -> bool {
    code.ends_with(":JIT:UNITY")
}

/// Whether `exe` is a Unity game on Mono (not IL2CPP, which has no Mono to read through): Unity's
/// player beside it, and its managed assemblies in `<name>_Data/Managed`.
pub fn is_mono_game(exe: &Path) -> bool {
    let (Some(dir), Some(stem)) = (exe.parent(), exe.file_stem()) else { return false };
    dir.join("UnityPlayer.dll").is_file()
        && dir.join(format!("{}_Data", stem.to_string_lossy())).join("Managed").join("UnityEngine.CoreModule.dll").is_file()
}

/// A Unity game built with IL2CPP: its scripts are compiled into GameAssembly.dll beside the exe.
pub fn is_il2cpp_game(exe: &Path) -> bool {
    exe.parent().is_some_and(|dir| dir.join("UnityPlayer.dll").is_file() && dir.join("GameAssembly.dll").is_file())
}

/// The request to the DLL, held for as long as the session wants the text.
pub struct Request {
    #[cfg(windows)]
    event: windows::Win32::Foundation::HANDLE,
}

// The handle is only closed, from whichever thread drops the session.
unsafe impl Send for Request {}

impl Drop for Request {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.event);
        }
    }
}

/// Asks the voice hook DLL in `pid` for the game's text.
#[cfg(windows)]
pub fn request(pid: u32) -> Result<Request, String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Threading::CreateEventW;
    let name = HSTRING::from(format!("Local\\voicehook_text_{pid}"));
    let event = unsafe { CreateEventW(None, true, true, &name) }.map_err(|e| e.to_string())?;
    Ok(Request { event })
}

#[cfg(not(windows))]
pub fn request(_pid: u32) -> Result<Request, String> {
    Err("Unity text is read this way on Windows only.".into())
}

/// The newest capture of `pid` under `base` (`<pid>-<time>`).
pub fn capture_dir(base: &Path, pid: u32) -> Option<PathBuf> {
    let prefix = format!("{pid}-");
    std::fs::read_dir(base)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .max_by_key(|e| {
            e.file_name()
                .to_string_lossy()
                .trim_start_matches(&prefix)
                .parse::<u64>()
                .unwrap_or(0)
        })
        .map(|e| e.path())
}

/// Reads new complete lines of `events.jsonl` from `offset`; the `text` events among them as
/// (object, text, when the game set it in Unix ms).
pub fn read_texts(file: &Path, offset: &mut u64) -> Vec<Text> {
    let Ok(mut f) = std::fs::File::open(file) else {
        return Vec::new();
    };
    if f.seek(SeekFrom::Start(*offset)).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut reader = BufReader::new(f);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            // A line still being written: read again next time.
            Ok(_) if !line.ends_with('\n') => break,
            Ok(n) => {
                *offset += n as u64;
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if event["ev"] == "text" {
                    if let (Some(obj), Some(text)) = (event["obj"].as_str(), event["text"].as_str())
                    {
                        out.push(Text {
                            obj: obj.to_string(),
                            method: event["method"].as_str().unwrap_or("TMP_Text.set_text").to_string(),
                            text: text.to_string(),
                            at: event["t"].as_f64().map(|t| t as u64),
                        });
                    }
                }
            }
        }
    }
    out
}

/// Waits until the DLL in `pid` watches the text (`true`), says it cannot, or `limit` passes.
pub fn wait_for_watch(base: &Path, pid: u32, limit: Duration) -> bool {
    let until = std::time::Instant::now() + limit;
    while std::time::Instant::now() < until {
        // The live capture, not an earlier game's under a reused process id: its DLL writes to it
        // every few seconds at least.
        let fresh = capture_dir(base, pid).filter(|d| {
            std::fs::metadata(d.join("voicehook.log"))
                .and_then(|m| m.modified())
                .is_ok_and(|t| t.elapsed().is_ok_and(|e| e < Duration::from_secs(60)))
        });
        if let Some(dir) = fresh {
            if std::fs::read_to_string(dir.join("events.jsonl")).is_ok_and(|e| e.contains("\"adapter\":\"unity-text\"")) {
                return true;
            }
            if std::fs::read_to_string(dir.join("voicehook.log")).is_ok_and(|l| l.contains("unity: no text watch") || l.contains("no late-attach API")) {
                return false;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// How long an object's text stays unchanged before it is sent: a game that types its lines out
/// sets every longer prefix (and, measuring for line breaks, single characters in between).
const SETTLE_MS: u64 = 300;

/// Texts per object, each sent once it has stayed the same for `SETTLE_MS`, timed by the first
/// text of its burst: when the line began to show, which is when its voice starts.
#[derive(Default)]
pub struct Settle {
    /// Per object: the text so far, when anything was last set, and when the text last changed.
    pending: std::collections::BTreeMap<String, (Text, u64, u64)>,
    /// Texts that settled because the next line began (`push`), for the next `take`.
    done: Vec<Text>,
}

/// How long a text must have held for a different one to be the next line rather than more of a
/// burst (a game measuring text sets it several times within a millisecond or two).
const HELD_MS: u64 = 100;

impl Settle {
    /// A text the DLL read, at `now` (Unix ms) if it says no time of its own.
    pub fn push(&mut self, text: Text, now: u64) {
        let changed = text.at.unwrap_or(now);
        match self.pending.get_mut(&text.obj) {
            Some((pending, last, since)) => {
                *last = changed;
                // A piece of the text so far (its start, or a character), set to measure it: the text stays.
                if pending.text.contains(text.text.as_str()) {
                    return;
                }
                // More of it, typed out.
                if text.text.starts_with(&pending.text) {
                    pending.text = text.text;
                    *since = changed;
                    return;
                }
                // The next line, begun before the last was quiet for long enough to settle (a
                // reader who clicks as soon as a line is typed out): the last settles now.
                if changed.saturating_sub(*since) >= HELD_MS {
                    let (finished, ..) = self.pending.remove(&text.obj).unwrap();
                    self.done.push(finished);
                    self.pending.insert(text.obj.clone(), (text, changed, changed));
                    return;
                }
                pending.text = text.text;
                *since = changed;
            }
            None => {
                self.pending.insert(text.obj.clone(), (text, changed, changed));
            }
        }
    }
    /// The texts that have settled by `now`, in the order they did.
    pub fn take(&mut self, now: u64) -> Vec<Text> {
        let settled: Vec<String> = self.pending.iter().filter(|(_, (_, last, _))| now.saturating_sub(*last) >= SETTLE_MS).map(|(obj, _)| obj.clone()).collect();
        let mut out = std::mem::take(&mut self.done);
        out.extend(settled.into_iter().filter_map(|obj| self.pending.remove(&obj).map(|(text, ..)| text)));
        out
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Feeds `pid`'s Unity text into the session until it ends or changes.
pub fn follow(hook: &'static Hook, generation: u64, pid: u32) {
    let base = crate::sentence_audio::voice_hook::base_dir();
    let mut dir = None;
    let mut offset = 0u64;
    let mut settle = Settle::default();
    loop {
        std::thread::sleep(Duration::from_millis(100));
        {
            let session = hook.lock();
            if session.generation != generation || !session.pids.contains(&pid) {
                return;
            }
        }
        if dir.is_none() {
            dir = capture_dir(&base, pid);
            continue;
        }
        let now = unix_ms();
        for text in read_texts(&dir.as_ref().unwrap().join("events.jsonl"), &mut offset) {
            settle.push(text, now);
        }
        let texts = settle.take(now);
        if texts.is_empty() {
            continue;
        }
        let mut session = hook.lock();
        if session.generation != generation {
            return;
        }
        for Text { obj, method, text, at } in texts {
            let key = format!("{pid}:unity:{obj}");
            if !session.threads.iter().any(|t| t.key == key) {
                session.threads.push(Thread {
                    key: key.clone(),
                    pid,
                    hookcode: format!("{HOOKCODE}{method}"),
                    name: method.trim_end_matches(".set_text").to_string(),
                    ctx: u64::from_str_radix(obj.trim_start_matches("0x"), 16).unwrap_or(0),
                    ctx2: 0,
                    text: String::new(),
                    count: 0,
                    noisy: 0,
                    recent: Default::default(),
                    last_at: None,
                });
                hook.publish(&session);
            }
            session.text_at = at;
            super::on_text(hook, &mut session, &key, &text);
            session.text_at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unity_text_object_is_never_taken_back_by_its_address() {
        assert!(!remembers_by_signature("UNITY:TMP_Text.set_text"));
        assert!(remembers_by_signature("HS-8@0:game.exe"));
    }

    #[test]
    fn only_the_hookers_unity_hooks_count() {
        assert!(is_unity_failure(
            "EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY"
        ));
        assert!(!is_unity_failure("HS0@4A2F10:game.exe"));
    }

    #[test]
    fn text_events_are_read_once_and_only_whole_lines() {
        let dir = std::env::temp_dir().join(format!("kimochi-unity-text-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("events.jsonl");
        std::fs::write(
            &file,
            concat!(
                "{\"ev\":\"start\",\"pid\":1}\n",
                "{\"ev\":\"text\",\"obj\":\"0x10\",\"t\":1000.4,\"text\":\"「おはよう」\"}\n",
                "{\"ev\":\"text\",\"obj\":\"0x20\",\"te"
            ),
        )
        .unwrap();
        let mut offset = 0;
        assert_eq!(
            read_texts(&file, &mut offset),
            vec![Text { obj: "0x10".into(), method: "TMP_Text.set_text".into(), text: "「おはよう」".into(), at: Some(1000) }]
        );
        assert_eq!(read_texts(&file, &mut offset), vec![]);
        std::fs::write(
            &file,
            concat!(
                "{\"ev\":\"start\",\"pid\":1}\n",
                "{\"ev\":\"text\",\"obj\":\"0x10\",\"t\":1000.4,\"text\":\"「おはよう」\"}\n",
                "{\"ev\":\"text\",\"obj\":\"0x20\",\"method\":\"UI.Text.set_text\",\"text\":\"花子\"}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            read_texts(&file, &mut offset),
            vec![Text { obj: "0x20".into(), method: "UI.Text.set_text".into(), text: "花子".into(), at: None }]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn set(obj: &str, text: &str, at: u64) -> Text {
        Text { obj: obj.into(), method: "UI.Text.set_text".into(), text: text.into(), at: Some(at) }
    }

    #[test]
    fn a_typed_out_line_is_sent_once_settled_and_timed_by_its_start() {
        // Live Unity: the box is set to every longer prefix, with single characters set
        // in between to measure them for line breaks; one Log line came of each set.
        let mut settle = Settle::default();
        for (i, text) in ["「", "「メ", "イ", "「メイ", "「メ", "「メイド", "「メイドです」"].iter().enumerate() {
            settle.push(set("0x10", text, 1000 + 50 * i as u64), 0);
        }
        settle.push(set("0x20", "選択", 1000), 0);
        assert_eq!(settle.take(1500), vec![set("0x20", "選択", 1000)]);
        assert_eq!(settle.take(1599), vec![]);
        assert_eq!(settle.take(1600), vec![set("0x10", "「メイドです」", 1000)]);
        assert_eq!(settle.take(5000), vec![]);
        // Set whole (other Unity games): sent as soon as it has settled, timed as it was set.
        settle.push(set("0x10", "「次の台詞」", 6000), 0);
        assert_eq!(settle.take(6300), vec![set("0x10", "「次の台詞」", 6000)]);
    }

    #[test]
    fn the_next_line_begun_before_the_last_settled_still_ends_it() {
        // Live Unity: clicked 260 ms after a line was typed out, it and the next were
        // one pending text, sent as the next line with the first one's start.
        let mut settle = Settle::default();
        settle.push(set("0x10", "「一つ目」", 1000), 0);
        settle.push(set("0x10", "「", 1260), 0);
        settle.push(set("0x10", "「二", 1300), 0);
        settle.push(set("0x10", "「二つ目」", 1340), 0);
        assert_eq!(settle.take(1400), vec![set("0x10", "「一つ目」", 1000)]);
        assert_eq!(settle.take(1700), vec![set("0x10", "「二", 1300)].into_iter().map(|t| Text { text: "「二つ目」".into(), ..t }).collect::<Vec<_>>());
        // Set for measuring within a millisecond: one burst, not lines.
        settle.push(set("0x20", "m m", 5000), 0);
        settle.push(set("0x20", "mm", 5001), 0);
        settle.push(set("0x20", "「三」", 5002), 0);
        assert_eq!(settle.take(5400), vec![Text { text: "「三」".into(), ..set("0x20", "m m", 5000) }]);
    }

    #[test]
    fn unity_mono_games_are_told_by_their_player_and_managed_assemblies() {
        let base = std::env::temp_dir().join(format!("kimochi-unity-game-{}", std::process::id()));
        let managed = base.join("Game_Data").join("Managed");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(base.join("UnityPlayer.dll"), b"").unwrap();
        assert!(!is_mono_game(&base.join("Game.exe")), "IL2CPP: no managed assemblies");
        std::fs::write(managed.join("UnityEngine.CoreModule.dll"), b"").unwrap();
        assert!(is_mono_game(&base.join("Game.exe")));
        assert!(!is_mono_game(&base.join("Other.exe")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_newest_capture_of_the_game_is_read() {
        let base = std::env::temp_dir().join(format!("kimochi-unity-caps-{}", std::process::id()));
        for name in ["42-100", "42-300", "421-900", "7-500"] {
            std::fs::create_dir_all(base.join(name)).unwrap();
        }
        assert_eq!(
            capture_dir(&base, 42).unwrap().file_name().unwrap(),
            "42-300"
        );
        assert_eq!(capture_dir(&base, 9), None);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
