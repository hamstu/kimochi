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

/// Whether a hooker thread is LunaHook's own hook on TextMeshPro's text setter
/// (`EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY`): the setter the DLL watches
/// too. The hooker's thread mixes every text object's text with layout's (`m\nmm\n…`, a
/// typewriter's frames), where the DLL's threads are each object's settled text; while the DLL
/// reads the game's text, it is the hooker's that goes unused.
pub fn is_hooker_tmp_setter(hookcode: &str) -> bool {
    !is_unity(hookcode) && hookcode.contains(":TMP_Text:set_text") && hookcode.ends_with(":JIT:UNITY")
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
        && dir
            .join(format!("{}_Data", stem.to_string_lossy()))
            .join("Managed")
            .join("UnityEngine.CoreModule.dll")
            .is_file()
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
        .max_by_key(|e| e.file_name().to_string_lossy().trim_start_matches(&prefix).parse::<u64>().unwrap_or(0))
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
                    if let (Some(obj), Some(text)) = (event["obj"].as_str(), event["text"].as_str()) {
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
            if std::fs::read_to_string(dir.join("events.jsonl")).is_ok_and(|e| e.contains("\"adapter\":\"unity-text\""))
            {
                return true;
            }
            if std::fs::read_to_string(dir.join("voicehook.log"))
                .is_ok_and(|l| l.contains("unity: no text watch") || l.contains("no late-attach API"))
            {
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
        let settled: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, (_, last, _))| now.saturating_sub(*last) >= SETTLE_MS)
            .map(|(obj, _)| obj.clone())
            .collect();
        let mut out = std::mem::take(&mut self.done);
        out.extend(settled.into_iter().filter_map(|obj| self.pending.remove(&obj).map(|(text, ..)| text)));
        out
    }
}

/// What the object a line assembled from glyph objects is sent as starts with (`Glyphs`), then
/// the first object of its pool.
pub const GLYPH_LINE: &str = "glyphs:";

/// Longest pause between two glyphs of one line: a game that draws each character as its own text
/// object sets them all in one frame, a few milliseconds at most (emulated, under load).
const GLYPH_GAP_MS: u64 = 30;

/// Lines from games that draw each character as its own text object (Unity CatSystem: a
/// TextMeshPro object per glyph, pooled and given a new character for each line). No object holds
/// the line, but the game sets every glyph of it in one frame, in reading order, just as the line
/// begins to show: such a burst is the line on screen, at the moment it shows. Every text still
/// reaches `Settle` as well; this only adds the line.
///
/// Each pool of glyph objects is a text of its own (the objects of one burst are one pool): the
/// game's backlog draws its lines from a pool of its own, several lines a burst.
#[derive(Default)]
pub struct Glyphs {
    /// The burst so far: the objects in it, the line, when it began and when the last glyph came.
    objs: Vec<String>,
    line: String,
    method: String,
    start: u64,
    last: u64,
    /// Objects that have held more than a character (a text box, a label): never a glyph object.
    whole: std::collections::BTreeSet<String>,
    /// Per glyph object, an earlier object of its pool (the first object of a pool, itself).
    pools: std::collections::HashMap<String, String>,
    done: Vec<Text>,
}

impl Glyphs {
    pub fn push(&mut self, text: &Text, now: u64) {
        let at = text.at.unwrap_or(now);
        let glyph = text.text.chars().count() == 1 && !text.text.trim().is_empty();
        if !glyph {
            self.whole.insert(text.obj.clone());
        }
        // A pause, a second glyph on one object (the same object again is a typewriter measuring
        // its text), or a whole text: the burst so far has ended.
        if !self.objs.is_empty()
            && (!glyph || at.saturating_sub(self.last) > GLYPH_GAP_MS || self.objs.contains(&text.obj))
        {
            self.end();
        }
        if glyph && !self.whole.contains(&text.obj) {
            if self.objs.is_empty() {
                self.start = at;
                self.method = text.method.clone();
            }
            self.objs.push(text.obj.clone());
            self.line.push_str(&text.text);
            self.last = at;
        }
    }

    fn end(&mut self) {
        let objs = std::mem::take(&mut self.objs);
        let line = std::mem::take(&mut self.line);
        // A glyph or two from labels changed together (a counter, a menu's marks) is no line.
        if objs.len() >= GLYPH_MIN && objs.iter().all(|o| !self.whole.contains(o)) {
            // The burst's objects join the pool of the first of them that has one.
            let first = objs.iter().find(|o| self.pools.contains_key(*o)).unwrap_or(&objs[0]);
            let pool = self.pool(first);
            for obj in &objs {
                let other = self.pool(obj);
                if other != pool {
                    self.pools.insert(other, pool.clone());
                }
            }
            self.done.push(Text {
                obj: format!("{GLYPH_LINE}{pool}"),
                method: std::mem::take(&mut self.method),
                text: line,
                at: Some(self.start),
            });
        }
    }

    /// The first object of `obj`'s pool; an object seen for the first time starts one.
    fn pool(&mut self, obj: &str) -> String {
        let mut at = obj.to_string();
        while let Some(up) = self.pools.get(&at).filter(|up| **up != at) {
            at = up.clone();
        }
        self.pools.insert(obj.to_string(), at.clone());
        at
    }

    /// The lines whose bursts have ended by `now`.
    pub fn take(&mut self, now: u64) -> Vec<Text> {
        if !self.objs.is_empty() && now.saturating_sub(self.last) > GLYPH_GAP_MS {
            self.end();
        }
        std::mem::take(&mut self.done)
    }
}

/// Fewest glyph objects in a burst for it to be a line.
const GLYPH_MIN: usize = 3;

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Feeds `pid`'s Unity text into the session until it ends or changes.
pub fn follow(hook: &'static Hook, generation: u64, pid: u32) {
    let base = crate::sentence_audio::voice_hook::base_dir();
    let mut dir = None;
    let mut offset = 0u64;
    let mut settle = Settle::default();
    let mut glyphs = Glyphs::default();
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
            glyphs.push(&text, now);
            settle.push(text, now);
        }
        let mut texts = settle.take(now);
        texts.extend(glyphs.take(now));
        texts.sort_by_key(|t| t.at.unwrap_or(now));
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
                let name = method.trim_end_matches(".set_text");
                session.threads.push(Thread {
                    key: key.clone(),
                    pid,
                    hookcode: format!("{HOOKCODE}{method}"),
                    name: if obj.starts_with(GLYPH_LINE) {
                        format!("{name} (a glyph per object)")
                    } else {
                        name.to_string()
                    },
                    ctx: u64::from_str_radix(obj.trim_start_matches(GLYPH_LINE).trim_start_matches("0x"), 16)
                        .unwrap_or(0),
                    ctx2: 0,
                    text: String::new(),
                    count: 0,
                    noisy: 0,
                    glyphs: 0,
                    recent: Default::default(),
                    last_at: None,
                    japanese: false,
                    foreign: 0,
                    box_start: String::new(),
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
    fn the_hookers_own_tmp_setter_is_told_apart() {
        assert!(is_hooker_tmp_setter("EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY"));
        assert!(!is_hooker_tmp_setter("UNITY:TMP_Text.set_text"));
        assert!(!is_hooker_tmp_setter("EHMF2@UnityEngine.UI:UnityEngine.UI:Text:set_text:1:JIT:UNITY"));
        assert!(!is_hooker_tmp_setter("HMF1@mscorlib:System:String:IndexOf:1:JIT:UNITY"));
    }

    #[test]
    fn a_unity_text_object_is_never_taken_back_by_its_address() {
        assert!(!remembers_by_signature("UNITY:TMP_Text.set_text"));
        assert!(remembers_by_signature("HS-8@0:game.exe"));
    }

    #[test]
    fn only_the_hookers_unity_hooks_count() {
        assert!(is_unity_failure("EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY"));
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
            vec![Text {
                obj: "0x10".into(),
                method: "TMP_Text.set_text".into(),
                text: "「おはよう」".into(),
                at: Some(1000)
            }]
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
        for (i, text) in ["「", "「メ", "イ", "「メイ", "「メ", "「メイド", "「メイドです」"].iter().enumerate()
        {
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
        assert_eq!(
            settle.take(1700),
            vec![set("0x10", "「二", 1300)]
                .into_iter()
                .map(|t| Text { text: "「二つ目」".into(), ..t })
                .collect::<Vec<_>>()
        );
        // Set for measuring within a millisecond: one burst, not lines.
        settle.push(set("0x20", "m m", 5000), 0);
        settle.push(set("0x20", "mm", 5001), 0);
        settle.push(set("0x20", "「三」", 5002), 0);
        assert_eq!(settle.take(5400), vec![Text { text: "「三」".into(), ..set("0x20", "m m", 5000) }]);
    }

    fn glyph(obj: &str, text: &str, at: u64) -> Text {
        Text { obj: obj.into(), method: "TMP_Text.set_text".into(), text: text.into(), at: Some(at) }
    }

    fn line(pool: &str, text: &str, at: u64) -> Text {
        Text { obj: format!("{GLYPH_LINE}{pool}"), ..glyph("", text, at) }
    }

    #[test]
    fn a_line_drawn_a_glyph_per_object_is_the_burst_in_order() {
        // Live Unity CatSystem: a pool of objects, each given one character of the line in the
        // frame the line begins to show; the next line a few seconds later reuses them (in another
        // order), the same character on the same object included.
        let mut glyphs = Glyphs::default();
        for (i, c) in "名前「おはよう」".chars().enumerate() {
            glyphs.push(&glyph(&format!("0x{}", 10 + i), &c.to_string(), 1000 + i as u64), 0);
        }
        assert_eq!(glyphs.take(1010), vec![]);
        assert_eq!(glyphs.take(1050), vec![line("0x10", "名前「おはよう」", 1000)]);
        for (i, c) in "今日も晴れ。".chars().enumerate() {
            glyphs.push(&glyph(&format!("0x{}", 15 - i), &c.to_string(), 4000 + i as u64), 0);
        }
        // The next line ends the last at once, without waiting for a pause.
        for (i, c) in "雨です。".chars().enumerate() {
            glyphs.push(&glyph(&format!("0x{}", 10 + i), &c.to_string(), 4100 + i as u64), 0);
        }
        assert_eq!(glyphs.take(4103), vec![line("0x10", "今日も晴れ。", 4000)]);
        assert_eq!(glyphs.take(5000), vec![line("0x10", "雨です。", 4100)]);
        // A longer line takes more of the pool: the same pool. The backlog's lines, from objects
        // of its own: another.
        for (i, c) in "長い台詞がここに続いていく。".chars().enumerate() {
            glyphs.push(&glyph(&format!("0x{}", 10 + i), &c.to_string(), 7000 + i as u64), 0);
        }
        for (i, c) in "雨です。今日も晴れ。".chars().enumerate() {
            glyphs.push(&glyph(&format!("0x{}", 90 + i), &c.to_string(), 9000 + i as u64), 0);
        }
        assert_eq!(
            glyphs.take(9500),
            vec![line("0x10", "長い台詞がここに続いていく。", 7000), line("0x90", "雨です。今日も晴れ。", 9000)]
        );
    }

    #[test]
    fn text_boxes_and_labels_are_no_glyph_line() {
        let mut glyphs = Glyphs::default();
        // A typewriter: one object, the characters it measures between prefixes.
        for (i, text) in ["「", "「メ", "イ", "「メイ", "「メイド」"].iter().enumerate() {
            glyphs.push(&glyph("0x10", text, 1000 + 10 * i as u64), 0);
        }
        // Two labels changed together (a page counter).
        glyphs.push(&glyph("0x20", "1", 2000), 0);
        glyphs.push(&glyph("0x21", "2", 2001), 0);
        // Boxes that begin typing in the same frame, each from a character: once they hold more,
        // they are text boxes, not glyphs.
        glyphs.push(&glyph("0x30", "花", 3000), 0);
        glyphs.push(&glyph("0x31", "「", 3001), 0);
        glyphs.push(&glyph("0x32", "あ", 3001), 0);
        glyphs.push(&glyph("0x31", "「あ", 3010), 0);
        for (i, c) in "花「い".chars().enumerate() {
            glyphs.push(&glyph(&format!("0x3{i}"), &c.to_string(), 6000 + i as u64), 0);
        }
        assert_eq!(glyphs.take(9000), vec![]);
    }

    /// What `follow` makes of a capture's text (`KIMOCHI_UNITY_REPLAY=<events.jsonl>`), each text
    /// with its object and when it was set: `cargo test unity_replay -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn unity_replay() {
        let Some(file) = std::env::var_os("KIMOCHI_UNITY_REPLAY") else { return };
        let mut offset = 0;
        let (mut settle, mut glyphs) = (Settle::default(), Glyphs::default());
        let mut out = Vec::new();
        for text in read_texts(std::path::Path::new(&file), &mut offset) {
            let now = text.at.unwrap_or(0);
            // `follow` reads every 100 ms: what had settled by then.
            out.extend(settle.take(now));
            out.extend(glyphs.take(now));
            glyphs.push(&text, now);
            settle.push(text, now);
        }
        out.extend(settle.take(u64::MAX));
        out.extend(glyphs.take(u64::MAX));
        out.sort_by_key(|t| t.at);
        for t in out {
            println!("{}\t{}\t{}", t.at.unwrap_or(0), t.obj, t.text.replace('\n', "\\n"));
        }
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
        assert_eq!(capture_dir(&base, 42).unwrap().file_name().unwrap(), "42-300");
        assert_eq!(capture_dir(&base, 9), None);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
