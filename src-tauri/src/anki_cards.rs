//! The cards made in each session, for the main window's Anki tab: a permanent record of what was
//! mined while reading, kept with the session (`<profile>/sessions/<sid>/anki.json`) and synced
//! with it (`sync_core`'s `anki` collection, `<sid>/<noteId>`).
//!
//! A card is recorded where its `addNote` is seen succeed, in Rust:
//!  - Kimochi's own pop-up (the Yomitan API pop-up) adds through `anki_add_note`, which names the
//!    term and its reading;
//!  - a dictionary extension (Built-in Yomitan, Hachidori) adds through the AnkiConnect relay
//!    (`anki_connect_relay`); its term is read from the note's fields.
//!
//! It goes in the session the Log has open (`sessions.json`'s `activeId`). When sentence audio
//! fills a card's fields afterwards (`sentence_audio`), the record notes it (`enhanced`). Each
//! change is announced as `anki-cards:changed` and pokes Sync. Nothing here talks to Anki: a
//! record is a reference (the note id) plus what the tab shows; Anki stays the card's owner.
//!
//! A card record: `{noteId, term, reading?, deck?, addedAt, via: "kimochi" | "extension", engine,
//! enhanced: ["sentenceAudio", "wordAudio"], deleted?, updatedAt}`. Deleting a card from the tab
//! keeps its record, marked `deleted`, so Sync carries the deletion (a record missing from a file is
//! never taken as one) and `merge` keeps it whichever side wins; the tab never lists it.
use crate::profile;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

pub const FILE: &str = "anki.json";
pub const EVENT: &str = "anki-cards:changed";
/// What Kimochi added to a card after it was made.
pub const SENTENCE_AUDIO: &str = "sentenceAudio";
pub const WORD_AUDIO: &str = "wordAudio";
/// The engine of a card added by Kimochi's own pop-up.
pub const KIMOCHI_ENGINE: &str = "yomitan-api";
/// A term longer than this is cut (an extension's note whose word could not be told apart).
const TERM_MAX: usize = 40;

/// Every read-modify-write of an `anki.json`: recording, enhancing and Sync's merge.
static LOCK: Mutex<()> = Mutex::new(());
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn path(dir: &Path, sid: &str) -> PathBuf {
    dir.join("sessions").join(sid).join(FILE)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A session's file: empty when there is none yet, an error when it cannot be read (it is then
/// left as it is, never overwritten).
pub fn read(dir: &Path, sid: &str) -> Result<Value, String> {
    let file = path(dir, sid);
    if !file.exists() {
        return Ok(json!({ "version": 1, "cards": [] }));
    }
    profile::read_json(&file)
        .filter(|v| v.get("cards").is_some_and(Value::is_array))
        .ok_or_else(|| format!("native: sessions/{sid}/{FILE} is unreadable; it was left as it is"))
}

fn write(dir: &Path, sid: &str, file: &Value) -> Result<(), String> {
    profile::write_json(&path(dir, sid), file)
}

fn cards_mut(file: &mut Value) -> &mut Vec<Value> {
    if !file.get("cards").is_some_and(Value::is_array) {
        file["cards"] = json!([]);
    }
    file["cards"].as_array_mut().expect("array")
}

fn note_id(card: &Value) -> Option<u64> {
    card.get("noteId").and_then(Value::as_u64)
}

/// The session the Log has open, from the profile's `sessions.json`.
pub fn active_session(dir: &Path) -> Option<String> {
    let manifest = profile::read_json(&dir.join("sessions.json"))?;
    let active = manifest.get("activeId")?.as_str()?;
    let known = manifest.get("sessions")?.as_array()?.iter().any(|s| s["id"] == json!(active));
    (known && crate::sync_core::safe_segment(active)).then(|| active.to_string())
}

/// The name of the session the Log has open (card enhancement's `{{session-name}}` tag).
pub fn active_session_name(dir: &Path) -> Option<String> {
    let manifest = profile::read_json(&dir.join("sessions.json"))?;
    let active = manifest.get("activeId")?.as_str()?;
    let session = manifest.get("sessions")?.as_array()?.iter().find(|s| s["id"] == json!(active))?;
    session.get("name")?.as_str().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string)
}

/// The sessions in `sessions.json`, the open one first.
fn sessions(dir: &Path) -> Vec<String> {
    let manifest = profile::read_json(&dir.join("sessions.json")).unwrap_or(Value::Null);
    let mut ids: Vec<String> = manifest["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["id"].as_str().map(str::to_string))
        .filter(|s| crate::sync_core::safe_segment(s))
        .collect();
    if let Some(active) = active_session(dir) {
        ids.retain(|s| *s != active);
        ids.insert(0, active);
    }
    ids
}

/// A card just made.
#[derive(Debug, Clone, PartialEq)]
pub struct NewCard {
    pub note_id: u64,
    pub term: String,
    pub reading: Option<String>,
    pub deck: Option<String>,
    /// `kimochi` (Kimochi's own pop-up) or `extension` (through the relay).
    pub via: &'static str,
    pub engine: String,
}

impl NewCard {
    fn to_value(&self, now: u64) -> Value {
        let mut card = json!({
            "noteId": self.note_id,
            "term": self.term,
            "addedAt": now,
            "via": self.via,
            "engine": self.engine,
            "enhanced": [],
            "updatedAt": now,
        });
        let reading = self.reading.as_deref().map(str::trim).filter(|r| !r.is_empty() && *r != self.term);
        if let Some(reading) = reading {
            card["reading"] = json!(reading);
        }
        if let Some(deck) = self.deck.as_deref().filter(|d| !d.is_empty()) {
            card["deck"] = json!(deck);
        }
        card
    }
}

/// Record `card` in session `sid`. A note already recorded there is left as it was. Returns the
/// record, and whether it is new.
pub fn add(dir: &Path, sid: &str, card: &NewCard, now: u64) -> Result<(Value, bool), String> {
    if !crate::sync_core::safe_segment(sid) {
        return Err(format!("invalid: session id {sid:?}"));
    }
    let _guard = lock();
    let mut file = read(dir, sid)?;
    let cards = cards_mut(&mut file);
    if let Some(existing) = cards.iter().find(|c| note_id(c) == Some(card.note_id)) {
        return Ok((existing.clone(), false));
    }
    let record = card.to_value(now);
    cards.push(record.clone());
    if file.get("version").is_none() {
        file["version"] = json!(1);
    }
    write(dir, sid, &file)?;
    Ok((record, true))
}

/// Note that Kimochi added `kinds` (`SENTENCE_AUDIO`, `WORD_AUDIO`) to note `note_id`, in whichever
/// session recorded it (the open one first). Returns the session and the record when it changed.
pub fn enhance(dir: &Path, note_id_wanted: u64, kinds: &[&str], now: u64) -> Result<Option<(String, Value)>, String> {
    if kinds.is_empty() {
        return Ok(None);
    }
    let _guard = lock();
    for sid in sessions(dir) {
        let Ok(mut file) = read(dir, &sid) else { continue };
        let cards = cards_mut(&mut file);
        let Some(card) = cards.iter_mut().find(|c| note_id(c) == Some(note_id_wanted)) else { continue };
        let mut enhanced = enhanced_of(card);
        let before = enhanced.len();
        for kind in kinds {
            if !enhanced.iter().any(|k| k == kind) {
                enhanced.push((*kind).to_string());
            }
        }
        if enhanced.len() == before {
            return Ok(None);
        }
        enhanced.sort();
        card["enhanced"] = json!(enhanced);
        card["updatedAt"] = json!(now);
        let record = card.clone();
        write(dir, &sid, &file)?;
        return Ok(Some((sid, record)));
    }
    Ok(None)
}

fn is_deleted(card: &Value) -> bool {
    card.get("deleted").and_then(Value::as_bool).unwrap_or(false)
}

/// Mark note `note_id` deleted in session `sid`. Returns the record when it changed.
pub fn remove(dir: &Path, sid: &str, note_id_wanted: u64, now: u64) -> Result<Option<Value>, String> {
    if !crate::sync_core::safe_segment(sid) {
        return Err(format!("invalid: session id {sid:?}"));
    }
    let _guard = lock();
    let mut file = read(dir, sid)?;
    let cards = cards_mut(&mut file);
    let Some(card) = cards.iter_mut().find(|c| note_id(c) == Some(note_id_wanted)) else { return Ok(None) };
    if is_deleted(card) {
        return Ok(None);
    }
    card["deleted"] = json!(true);
    card["updatedAt"] = json!(now);
    let record = card.clone();
    write(dir, sid, &file)?;
    Ok(Some(record))
}

fn enhanced_of(card: &Value) -> Vec<String> {
    card.get("enhanced")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|k| k.as_str().map(str::to_string))
        .collect()
}

/// The cards recorded in session `sid`, oldest first.
pub fn list(dir: &Path, sid: &str) -> Result<Vec<Value>, String> {
    if !crate::sync_core::safe_segment(sid) {
        return Err(format!("invalid: session id {sid:?}"));
    }
    let mut cards: Vec<Value> = read(dir, sid)?["cards"].as_array().cloned().unwrap_or_default();
    cards.retain(|c| note_id(c).is_some() && !is_deleted(c));
    cards.sort_by_key(|c| c.get("addedAt").and_then(Value::as_u64).unwrap_or(0));
    Ok(cards)
}

/// One card changed on two computers: the winner's fields, every enhancement either side made, and
/// the earlier time it was added. Nothing is lost, so there is no conflict copy.
pub fn merge(winner: &Value, loser: &Value) -> Value {
    let mut merged = winner.clone();
    if let (Some(out), Some(other)) = (merged.as_object_mut(), loser.as_object()) {
        for (field, value) in other {
            out.entry(field.clone()).or_insert_with(|| value.clone());
        }
    }
    let mut enhanced = enhanced_of(winner);
    for kind in enhanced_of(loser) {
        if !enhanced.contains(&kind) {
            enhanced.push(kind);
        }
    }
    enhanced.sort();
    if merged.is_object() {
        merged["enhanced"] = json!(enhanced);
        let added = [winner, loser].iter().filter_map(|c| c.get("addedAt").and_then(Value::as_u64)).min();
        if let Some(added) = added {
            merged["addedAt"] = json!(added);
        }
    }
    merged
}

/// Sync's changes to session `sid`'s file: each note id's record (`{sid, card}`), or None to remove it.
pub fn apply(dir: &Path, sid: &str, items: &BTreeMap<String, Option<Value>>) -> Result<(), String> {
    let _guard = lock();
    let mut file = read(dir, sid)?;
    let cards = cards_mut(&mut file);
    for (id, data) in items {
        let Ok(id) = id.parse::<u64>() else { continue };
        let index = cards.iter().position(|c| note_id(c) == Some(id));
        let card = data.as_ref().map(|d| {
            let mut card = d["card"].clone();
            if card.is_object() {
                card["noteId"] = json!(id);
            }
            card
        });
        match (card, index) {
            (Some(card), _) if !card.is_object() => {}
            (Some(card), Some(i)) => cards[i] = card,
            (Some(card), None) => cards.push(card),
            (None, Some(i)) => {
                cards.remove(i);
            }
            (None, None) => {}
        }
    }
    if file.get("version").is_none() {
        file["version"] = json!(1);
    }
    write(dir, sid, &file)
}

/// The word an extension's card was made for and its reading, from the note's fields: the word is
/// a field named for it (Expression, Word, Term, …), else the note's shortest field; the reading a
/// field named Reading or Kana (not the sentence's).
pub fn card_term(fields: &[(String, String)]) -> (String, Option<String>) {
    let plain = |v: &str| kimochi_speech::timeline::normalize(v);
    let term = crate::sentence_audio::card_word(fields, "").or_else(|| {
        fields.iter().map(|(_, v)| plain(v)).filter(|v| !v.is_empty()).min_by_key(|v| v.chars().count())
    });
    let term: String = term.unwrap_or_default().chars().take(TERM_MAX).collect();
    let reading = fields
        .iter()
        .filter(|(name, _)| {
            let name = name.to_lowercase();
            !name.contains("sentence") && (name.contains("reading") || name.contains("kana") || name.contains("読み"))
        })
        .map(|(_, v)| plain(v))
        .find(|v| !v.is_empty() && *v != term && v.chars().count() <= TERM_MAX);
    (term, reading)
}

// ---------------------------------------------------------------- in the app

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn announce(app: &AppHandle, sid: &str, card: &Value) {
    let _ = app.emit(EVENT, json!({ "sessionId": sid, "card": card }));
    crate::sync::local_changed();
}

/// A card was added: record it in the open session of the profile in use.
pub fn record(card: NewCard) {
    let Some(app) = APP.get() else { return };
    let Some(dir) = crate::account::active_profile_dir() else { return };
    let Some(sid) = active_session(&dir) else {
        eprintln!("[anki-cards] no open session to record note {} in", card.note_id);
        return;
    };
    match add(&dir, &sid, &card, now_ms()) {
        Ok((record, true)) => announce(app, &sid, &record),
        Ok((_, false)) => {}
        Err(e) => eprintln!("[anki-cards] note {} was not recorded: {e}", card.note_id),
    }
}

/// Sentence audio filled `kinds` of note `note_id`'s fields.
pub fn enhanced(note_id: u64, kinds: &[&str]) {
    let Some(app) = APP.get() else { return };
    let Some(dir) = crate::account::active_profile_dir() else { return };
    match enhance(&dir, note_id, kinds, now_ms()) {
        Ok(Some((sid, record))) => announce(app, &sid, &record),
        Ok(None) => {}
        Err(e) => eprintln!("[anki-cards] note {note_id}'s enhancement was not recorded: {e}"),
    }
}

/// After the relay carried a dictionary extension's request: an `addNote` AnkiConnect accepted is
/// recorded, whether or not sentence audio is on.
pub fn after_relay(app: &AppHandle, url: &str, request: &Value, reply_status: u16, reply_body: &str) {
    let Some((_, note_id, fields)) = crate::sentence_audio::added_card(url, request, reply_status, reply_body) else {
        return;
    };
    let (term, reading) = card_term(&fields);
    let engine = app
        .try_state::<crate::state::Shared>()
        .map(|s| crate::extensions::selected_engine(&s.settings))
        .unwrap_or_else(|| "yomitan".into());
    let deck = request.pointer("/params/note/deckName").and_then(Value::as_str).map(str::to_string);
    record(NewCard { note_id, term, reading, deck, via: "extension", engine });
}

/// Delete note `note_id`'s card from session `session_id`'s list, and with `from_anki` the note
/// itself from Anki, through Kimochi's AnkiConnect (Settings → Anki → AnkiConnect). Anki first: if
/// it refuses, the card stays listed.
#[tauri::command]
pub async fn anki_cards_delete(
    app: AppHandle,
    state: tauri::State<'_, crate::state::Shared>,
    session_id: String,
    note_id: u64,
    from_anki: bool,
) -> Result<(), String> {
    if from_anki {
        let (url, key) = crate::reader::ankiconnect::configured(&state.settings);
        crate::reader::ankiconnect::action(&url, key.as_deref(), "deleteNotes", json!({ "notes": [note_id] })).await?;
    }
    let dir = crate::account::active_profile_dir().ok_or("native: Kimochi is still starting")?;
    if let Some(record) = remove(&dir, &session_id, note_id, now_ms())? {
        announce(&app, &session_id, &record);
    }
    Ok(())
}

/// The cards recorded in session `session_id` of the profile in use, oldest first.
#[tauri::command]
pub fn anki_cards_list(session_id: String) -> Result<Vec<Value>, String> {
    let dir = crate::account::active_profile_dir().ok_or("native: Kimochi is still starting")?;
    list(&dir, &session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kimochi-anki-cards-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        profile::write_json(
            &dir.join("sessions.json"),
            &json!({ "version": 1, "activeId": "s2", "sessions": [{ "id": "s1" }, { "id": "s2" }] }),
        )
        .unwrap();
        dir
    }

    fn card(note_id: u64, term: &str) -> NewCard {
        NewCard { note_id, term: term.into(), reading: Some("ねこ".into()), deck: Some("Mining".into()), via: "kimochi", engine: KIMOCHI_ENGINE.into() }
    }

    #[test]
    fn a_card_is_recorded_once_in_the_open_session() {
        let dir = dir("add");
        assert_eq!(active_session(&dir).as_deref(), Some("s2"));
        let (record, new) = add(&dir, "s2", &card(7, "猫"), 100).unwrap();
        assert!(new);
        assert_eq!(record["term"], "猫");
        assert_eq!(record["reading"], "ねこ");
        assert_eq!(record["deck"], "Mining");
        assert_eq!(record["via"], "kimochi");
        assert_eq!(record["enhanced"], json!([]));
        let (_, again) = add(&dir, "s2", &card(7, "犬"), 200).unwrap();
        assert!(!again, "the same note is not recorded twice");
        add(&dir, "s2", &card(3, "犬"), 50).unwrap();
        let terms: Vec<Value> = list(&dir, "s2").unwrap().iter().map(|c| c["term"].clone()).collect();
        assert_eq!(terms, [json!("犬"), json!("猫")], "oldest first");
        assert!(list(&dir, "s1").unwrap().is_empty());
        assert!(list(&dir, "../x").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_reading_equal_to_the_term_is_left_out() {
        let mut kana = card(1, "ねこ");
        kana.reading = Some("ねこ".into());
        assert!(kana.to_value(1).get("reading").is_none());
    }

    #[test]
    fn enhancements_are_noted_on_the_card_in_whichever_session_has_it() {
        let dir = dir("enhance");
        add(&dir, "s1", &card(9, "猫"), 100).unwrap();
        let (sid, record) = enhance(&dir, 9, &[SENTENCE_AUDIO], 300).unwrap().unwrap();
        assert_eq!(sid, "s1");
        assert_eq!(record["enhanced"], json!(["sentenceAudio"]));
        assert_eq!(record["updatedAt"], 300);
        let (_, record) = enhance(&dir, 9, &[WORD_AUDIO, SENTENCE_AUDIO], 400).unwrap().unwrap();
        assert_eq!(record["enhanced"], json!(["sentenceAudio", "wordAudio"]));
        assert!(enhance(&dir, 9, &[WORD_AUDIO], 500).unwrap().is_none(), "nothing new");
        assert!(enhance(&dir, 404, &[WORD_AUDIO], 500).unwrap().is_none(), "never recorded");
        assert_eq!(list(&dir, "s1").unwrap()[0]["enhanced"], json!(["sentenceAudio", "wordAudio"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unreadable_file_is_left_as_it_is() {
        let dir = dir("unreadable");
        std::fs::create_dir_all(dir.join("sessions/s2")).unwrap();
        std::fs::write(path(&dir, "s2"), "{ not json").unwrap();
        assert!(add(&dir, "s2", &card(1, "猫"), 1).is_err());
        assert_eq!(std::fs::read_to_string(path(&dir, "s2")).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_deleted_card_is_kept_marked_and_stays_deleted_through_a_merge() {
        let dir = dir("delete");
        add(&dir, "s2", &card(7, "猫"), 100).unwrap();
        add(&dir, "s2", &card(8, "犬"), 110).unwrap();
        let record = remove(&dir, "s2", 7, 200).unwrap().expect("changed");
        assert_eq!((record["deleted"].clone(), record["updatedAt"].clone()), (json!(true), json!(200)));
        assert!(remove(&dir, "s2", 7, 300).unwrap().is_none(), "deleting again changes nothing");
        let terms: Vec<Value> = list(&dir, "s2").unwrap().iter().map(|c| c["term"].clone()).collect();
        assert_eq!(terms, [json!("犬")]);
        // Kept in the file, for Sync.
        assert_eq!(read(&dir, "s2").unwrap()["cards"].as_array().unwrap().len(), 2);
        // Another computer's newer change to the card (its audio) doesn't bring it back.
        let theirs = json!({ "noteId": 7, "term": "猫", "addedAt": 100, "enhanced": ["sentenceAudio"], "updatedAt": 400 });
        assert_eq!(merge(&theirs, &record)["deleted"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_merge_keeps_every_enhancement_and_the_first_time() {
        let mine = json!({ "noteId": 1, "term": "猫", "addedAt": 100, "enhanced": ["wordAudio"], "updatedAt": 300 });
        let theirs = json!({ "noteId": 1, "term": "ねこ", "addedAt": 120, "enhanced": ["sentenceAudio"], "updatedAt": 400, "deck": "D" });
        let merged = merge(&theirs, &mine);
        assert_eq!(merged["term"], "ねこ", "the winner's fields");
        assert_eq!(merged["deck"], "D");
        assert_eq!(merged["enhanced"], json!(["sentenceAudio", "wordAudio"]));
        assert_eq!(merged["addedAt"], 100);
    }

    #[test]
    fn syncs_changes_are_applied_by_note_id() {
        let dir = dir("apply");
        add(&dir, "s1", &card(1, "猫"), 100).unwrap();
        let mut items = BTreeMap::new();
        items.insert("2".to_string(), Some(json!({ "sid": "s1", "card": { "noteId": 99, "term": "犬", "addedAt": 50 } })));
        items.insert("1".to_string(), None);
        items.insert("x".to_string(), Some(json!({ "card": {} })));
        apply(&dir, "s1", &items).unwrap();
        let cards = list(&dir, "s1").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!((cards[0]["noteId"].as_u64(), cards[0]["term"].as_str()), (Some(2), Some("犬")), "the id is the record's");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_extensions_card_is_named_by_its_word_field() {
        let field = |n: &str, v: &str| (n.to_string(), v.to_string());
        let lapis = [
            field("Expression", "天気"),
            field("ExpressionFurigana", "天気[てんき]"),
            field("ExpressionReading", "てんき"),
            field("Sentence", "今日はいい<b>天気</b>ですね。"),
            field("SentenceReading", "きょうはいいてんきですね"),
            field("ExpressionAudio", "[sound:yomitan_audio.mp3]"),
        ];
        assert_eq!(card_term(&lapis), ("天気".to_string(), Some("てんき".to_string())));
        // No field named for the word: the shortest field.
        let basic = [field("Front", ""), field("Back", "weather, the sky"), field("Extra", "天気")];
        assert_eq!(card_term(&basic).0, "天気");
        assert_eq!(card_term(&[]), (String::new(), None));
    }
}
