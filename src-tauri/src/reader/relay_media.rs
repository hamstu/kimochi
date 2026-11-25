// relay_media.rs — the media file names in a dictionary extension's relayed AnkiConnect
// requests (ankiconnect.rs `anki_connect_relay`).
//
// `storeMediaFile` answers the name a file was stored under, and that is not always the name
// asked for: Anki picks another when a different file already has it, and Manatan SRS converts
// every file and names it after its content (`hachidori_<hash>.png` becomes `mtn_<hash>.avif`;
// checked against Manatan 6.3.31). A field has to name the file as it was stored. Kimochi's own
// calls do (ankiconnect.rs `store_media`), but an extension may not: Hachidori 0.5.2 requires the
// name it asked for, and refuses to add a card whose definition holds a dictionary image with
// "Anki stored media under a different filename" (its anki-media.js), so no card with such a
// definition could be added to Manatan SRS.
//
// So the relay lets the extension keep the names it chose, and puts the stored ones on the wire:
//
// - a `storeMediaFile` answered with another name is remembered (sent → stored, per server) and
//   answered to the extension with the name it sent;
// - a note written later (`addNote`, `updateNoteFields`, …) has the sent names in its fields
//   replaced by the stored ones, and one read back (`notesInfo`) the other way round;
// - `deleteMediaFile`, `retrieveMediaFile` and `getMediaFilesNames` for a sent name ask about the
//   stored file;
// - `getMediaFilesNames` on a server that has no such action (Manatan SRS) is answered from what
//   was stored through here: a file not seen is reported missing, so the extension stores it,
//   which is safe to repeat (the extensions store with `deleteExisting: false`).
//
// A request that names no remembered file, and a reply that needs no change, pass through
// byte for byte. Nothing is remembered when nothing was stored (an error, or no name answered).
// The names are kept in memory only: after a restart the extension stores a file again and gets
// the same answer.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

/// How many renamed files are remembered, newest kept. A card has a handful.
const KEPT: usize = 4096;

/// Actions whose `params.note.fields` hold a note's field values.
const NOTE_ACTIONS: &[&str] = &["addNote", "updateNoteFields", "updateNote", "updateNoteModel"];
/// Actions whose `params.notes[].fields` do.
const NOTES_ACTIONS: &[&str] = &["addNotes", "canAddNotes", "canAddNotesWithErrorDetail"];
/// Actions whose `params.filename` names one media file.
const FILE_ACTIONS: &[&str] = &["deleteMediaFile", "retrieveMediaFile"];

struct Renamed {
    server: String,
    sent: String,
    stored: String,
}

/// The files each AnkiConnect server stored under another name than the one it was sent.
#[derive(Default)]
pub(crate) struct StoredNames {
    /// Oldest first; one entry per server and sent name.
    renamed: VecDeque<Renamed>,
}

/// The names remembered for the running app.
pub(crate) fn shared() -> &'static Mutex<StoredNames> {
    static NAMES: OnceLock<Mutex<StoredNames>> = OnceLock::new();
    NAMES.get_or_init(Mutex::default)
}

impl StoredNames {
    fn stored(&self, server: &str, sent: &str) -> Option<&str> {
        self.renamed.iter().find(|r| r.server == server && r.sent == sent).map(|r| r.stored.as_str())
    }

    fn forget(&mut self, server: &str, sent: &str) {
        self.renamed.retain(|r| !(r.server == server && r.sent == sent));
    }

    fn remember(&mut self, server: &str, sent: &str, stored: &str) {
        self.forget(server, sent);
        self.renamed.push_back(Renamed { server: server.into(), sent: sent.into(), stored: stored.into() });
        while self.renamed.len() > KEPT {
            self.renamed.pop_front();
        }
    }

    /// `(sent, stored)` for every file `server` renamed.
    fn sent_to_stored(&self, server: &str) -> Vec<(&str, &str)> {
        self.renamed.iter().filter(|r| r.server == server).map(|r| (r.sent.as_str(), r.stored.as_str())).collect()
    }

    /// `(stored, sent)` for every file `server` renamed. Two sent names can share a stored file
    /// (the same content sent twice): the newest is the one read back.
    fn stored_to_sent(&self, server: &str) -> Vec<(&str, &str)> {
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        for r in self.renamed.iter().rev().filter(|r| r.server == server) {
            if !pairs.iter().any(|(stored, _)| *stored == r.stored) {
                pairs.push((r.stored.as_str(), r.sent.as_str()));
            }
        }
        pairs
    }

    /// `request` as it goes to `server`: with the stored names where it names files this server
    /// renamed. None when it names none, and goes out as it came.
    pub(crate) fn outgoing(&self, server: &str, request: &Value) -> Option<Value> {
        let pairs = self.sent_to_stored(server);
        if pairs.is_empty() {
            return None;
        }
        let mut out = request.clone();
        let mut changed = false;
        each_call_mut(&mut out, |action, params| {
            if FILE_ACTIONS.contains(&action) {
                changed |= rename_exact(params.get_mut("filename"), &pairs);
            } else if action == "getMediaFilesNames" {
                changed |= rename_exact(params.get_mut("pattern"), &pairs);
            } else if NOTE_ACTIONS.contains(&action) {
                changed |= rename_in_fields(params.get_mut("note"), &pairs);
            } else if NOTES_ACTIONS.contains(&action) {
                for note in params.get_mut("notes").and_then(Value::as_array_mut).into_iter().flatten() {
                    changed |= rename_in_fields(Some(note), &pairs);
                }
            }
        });
        changed.then_some(out)
    }

    /// Learns from `server`'s reply (`body`) to `request`, as the extension wrote it, and gives
    /// the reply the extension should get when that is not `body` itself.
    pub(crate) fn incoming(&mut self, server: &str, request: &Value, body: &str) -> Option<String> {
        let action = request.get("action").and_then(Value::as_str)?;
        let mut reply: Value = serde_json::from_str(body).ok()?;
        let mut changed = false;
        if action == "multi" {
            let actions = request.pointer("/params/actions").and_then(Value::as_array)?;
            // A `multi` answers a list, in an envelope from API version 5 on.
            let answers = match &mut reply {
                Value::Array(answers) => answers,
                other => other.get_mut("result").and_then(Value::as_array_mut)?,
            };
            for (call, answer) in actions.iter().zip(answers.iter_mut()) {
                let Some(action) = call.get("action").and_then(Value::as_str) else { continue };
                changed |= self.answer(server, action, call.get("params").unwrap_or(&Value::Null), answer);
            }
        } else {
            changed = self.answer(server, action, request.get("params").unwrap_or(&Value::Null), &mut reply);
        }
        changed.then(|| reply.to_string())
    }

    /// One call's answer: an envelope (`{result, error}`), or the bare result an API version
    /// below 5 gives. True when it was changed.
    fn answer(&mut self, server: &str, action: &str, params: &Value, answer: &mut Value) -> bool {
        let enveloped = answer.as_object().is_some_and(|o| o.contains_key("result") && o.contains_key("error"));
        let error = if enveloped { answer.get("error").filter(|e| !e.is_null()).map(Value::to_string) } else { None };
        match action {
            "storeMediaFile" => {
                let Some(sent) = params.get("filename").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return false;
                };
                let result = if enveloped { &mut answer["result"] } else { answer };
                // Nothing stored, or no name to go by: the extension decides what that means.
                let Some(stored) = result.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string) else {
                    return false;
                };
                if error.is_some() {
                    return false;
                }
                if stored == sent {
                    self.forget(server, sent);
                    return false;
                }
                self.remember(server, sent, &stored);
                *result = json!(sent);
                true
            }
            "getMediaFilesNames" => {
                let Some(pattern) = params.get("pattern").and_then(Value::as_str) else { return false };
                let stored = self.stored(server, pattern).map(str::to_string);
                if enveloped && error.as_deref().is_some_and(unsupported) {
                    let names: Vec<&str> = stored.iter().map(|_| pattern).collect();
                    *answer = json!({ "result": names, "error": null });
                    return true;
                }
                let Some(stored) = stored else { return false };
                let result = if enveloped { &mut answer["result"] } else { answer };
                let mut changed = false;
                for name in result.as_array_mut().into_iter().flatten() {
                    if name.as_str() == Some(stored.as_str()) {
                        *name = json!(pattern);
                        changed = true;
                    }
                }
                changed
            }
            "notesInfo" => {
                let pairs = self.stored_to_sent(server);
                if pairs.is_empty() {
                    return false;
                }
                let result = if enveloped { &mut answer["result"] } else { answer };
                let mut changed = false;
                for note in result.as_array_mut().into_iter().flatten() {
                    for field in note.get_mut("fields").and_then(Value::as_object_mut).into_iter().flatten() {
                        if let Some(value) = field.1.get_mut("value") {
                            changed |= rename_within(value, &pairs);
                        }
                    }
                }
                changed
            }
            _ => false,
        }
    }
}

/// AnkiConnect's (and Manatan's) answer to an action it does not have.
fn unsupported(error: &str) -> bool {
    error.to_ascii_lowercase().contains("unsupported action")
}

/// Runs `visit(action, params)` on the request's own call, or on each call of a `multi`.
fn each_call_mut(request: &mut Value, mut visit: impl FnMut(&str, &mut Value)) {
    let Some(action) = request.get("action").and_then(Value::as_str).map(str::to_string) else { return };
    if action != "multi" {
        if let Some(params) = request.get_mut("params") {
            visit(&action, params);
        }
        return;
    }
    for call in request.pointer_mut("/params/actions").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(action) = call.get("action").and_then(Value::as_str).map(str::to_string) else { continue };
        if let Some(params) = call.get_mut("params") {
            visit(&action, params);
        }
    }
}

/// Replaces a value that is exactly one of the names.
fn rename_exact(value: Option<&mut Value>, pairs: &[(&str, &str)]) -> bool {
    let Some(value) = value else { return false };
    let Some((_, to)) = pairs.iter().find(|(from, _)| value.as_str() == Some(*from)) else { return false };
    *value = json!(to);
    true
}

/// Replaces the names inside each of a note's field values (`note.fields`: field → text).
fn rename_in_fields(note: Option<&mut Value>, pairs: &[(&str, &str)]) -> bool {
    let fields = note.and_then(|note| note.get_mut("fields")).and_then(Value::as_object_mut);
    let mut changed = false;
    for (_, value) in fields.into_iter().flatten() {
        changed |= rename_within(value, pairs);
    }
    changed
}

/// Replaces the names inside a text value.
fn rename_within(value: &mut Value, pairs: &[(&str, &str)]) -> bool {
    let Some(text) = value.as_str() else { return false };
    let mut text = text.to_string();
    let mut changed = false;
    for (from, to) in pairs {
        if let Some(next) = replace_name(&text, from, to) {
            text = next;
            changed = true;
        }
    }
    if changed {
        *value = json!(text);
    }
    changed
}

/// A character a file name is made of, for telling `a.png` from the end of `data.png`.
fn name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '%')
}

/// `text` with each whole file name `from` replaced by `to` (`[sound:from]`, `src="from"`), or
/// None when it names no such file. A longer name that only contains `from` is left alone.
fn replace_name(text: &str, from: &str, to: &str) -> Option<String> {
    if from.is_empty() || !text.contains(from) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut before: Option<char> = None;
    let mut changed = false;
    while let Some(at) = rest.find(from) {
        let (head, tail) = (&rest[..at], &rest[at + from.len()..]);
        let previous = head.chars().next_back().or(before);
        let whole = !previous.is_some_and(name_char) && !tail.chars().next().is_some_and(name_char);
        out.push_str(head);
        out.push_str(if whole { to } else { from });
        changed |= whole;
        before = from.chars().next_back();
        rest = tail;
    }
    out.push_str(rest);
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "http://127.0.0.1:8765/";
    const SENT: &str = "hachidori_aa11.png";
    const STORED: &str = "mtn_5bc2.avif";

    fn store(filename: &str) -> Value {
        json!({ "action": "storeMediaFile", "version": 6, "params": { "filename": filename, "data": "AAAA", "deleteExisting": false } })
    }

    fn answered(result: Value) -> String {
        json!({ "result": result, "error": null }).to_string()
    }

    fn parsed(body: Option<String>) -> Value {
        serde_json::from_str(&body.expect("a changed reply")).unwrap()
    }

    /// Names with `SENT` stored as `STORED` on `SERVER`.
    fn renamed() -> StoredNames {
        let mut names = StoredNames::default();
        names.incoming(SERVER, &store(SENT), &answered(json!(STORED)));
        names
    }

    #[test]
    fn a_file_stored_under_another_name_keeps_the_name_the_extension_sent() {
        let mut names = StoredNames::default();
        // Before anything is renamed, every request goes out as it came.
        let add = json!({ "action": "addNote", "version": 6, "params": { "note": { "fields": { "Picture": format!("<img src=\"{SENT}\">") } } } });
        assert!(names.outgoing(SERVER, &add).is_none());

        // Manatan SRS names the file after its content: the extension is told its own name.
        let reply = parsed(names.incoming(SERVER, &store(SENT), &answered(json!(STORED))));
        assert_eq!(reply, json!({ "result": SENT, "error": null }));
        assert_eq!(names.stored(SERVER, SENT), Some(STORED));

        // The note it then adds names the stored file, wherever a field names the sent one.
        let add = json!({ "action": "addNote", "version": 6, "key": "k", "params": { "note": {
            "deckName": "Mining", "modelName": "Manatan-NoteType", "tags": [SENT],
            "fields": {
                "Expression": "注目",
                "MainDefinition": format!("<div>ちゅうもく <img src=\"{SENT}\"> and <img src='{SENT}'></div>"),
                "SentenceAudio": format!("[sound:{SENT}]"),
                "Hint": format!("x{SENT} {SENT}x my-{SENT}"),
            },
        } } });
        let sent = names.outgoing(SERVER, &add).expect("rewritten");
        let fields = &sent["params"]["note"]["fields"];
        assert_eq!(
            fields["MainDefinition"],
            format!("<div>ちゅうもく <img src=\"{STORED}\"> and <img src='{STORED}'></div>")
        );
        assert_eq!(fields["SentenceAudio"], format!("[sound:{STORED}]"));
        assert_eq!(fields["Expression"], "注目");
        assert_eq!(fields["Hint"], format!("x{SENT} {SENT}x my-{SENT}"), "a longer name is another file");
        assert_eq!(sent["params"]["note"]["tags"], json!([SENT]), "only fields are rewritten");
        assert_eq!(sent["key"], "k");

        // Another server has stored nothing under that name.
        assert!(names.outgoing("http://127.0.0.1:9999/", &add).is_none());
    }

    #[test]
    fn a_file_that_was_not_stored_is_not_remembered() {
        let mut names = StoredNames::default();
        // An error, no name, an empty name: nothing was stored under another name.
        for body in [
            json!({ "result": null, "error": "unsupported image" }).to_string(),
            json!({ "result": STORED, "error": "failed" }).to_string(),
            answered(Value::Null),
            answered(json!("")),
            answered(json!(false)),
            "not json".to_string(),
        ] {
            assert!(names.incoming(SERVER, &store(SENT), &body).is_none(), "{body}");
            assert_eq!(names.stored(SERVER, SENT), None, "{body}");
        }
        // Stored under the name sent: the reply is the server's own.
        assert!(names.incoming(SERVER, &store(SENT), &answered(json!(SENT))).is_none());
        assert_eq!(names.stored(SERVER, SENT), None);

        // A later store under the sent name ends an earlier rename (Anki, once the other file went).
        let mut names = renamed();
        assert!(names.incoming(SERVER, &store(SENT), &answered(json!(SENT))).is_none());
        assert_eq!(names.stored(SERVER, SENT), None);
    }

    #[test]
    fn anki_giving_an_existing_name_a_suffix_is_followed() {
        // Anki, `deleteExisting: false`, another file already named so: stored beside it.
        let mut names = StoredNames::default();
        let stored = "kimochi-shot-0a1b2c.jpg";
        let reply = parsed(names.incoming(SERVER, &store("kimochi-shot.jpg"), &answered(json!(stored))));
        assert_eq!(reply["result"], "kimochi-shot.jpg");
        let update = json!({ "action": "updateNoteFields", "version": 6, "params": { "note": { "id": 7, "fields": { "Picture": "<img src=\"kimochi-shot.jpg\">" } } } });
        let sent = names.outgoing(SERVER, &update).unwrap();
        assert_eq!(sent["params"]["note"]["fields"]["Picture"], format!("<img src=\"{stored}\">"));
        assert_eq!(sent["params"]["note"]["id"], 7);
    }

    #[test]
    fn a_multi_is_followed_call_by_call() {
        // Hachidori uploads a card's dictionary images in one `multi`, then adds the note.
        let mut names = StoredNames::default();
        let multi = json!({ "action": "multi", "version": 6, "params": { "actions": [
            { "action": "storeMediaFile", "version": 6, "params": { "filename": SENT, "data": "AAAA", "deleteExisting": false } },
            { "action": "storeMediaFile", "version": 6, "params": { "filename": "kept.png", "data": "AAAA" } },
            { "action": "storeMediaFile", "version": 6, "params": { "filename": "refused.png", "data": "AAAA" } },
            { "action": "version", "version": 6 },
        ] } });
        let body = answered(json!([
            { "result": STORED, "error": null },
            { "result": "kept.png", "error": null },
            { "result": null, "error": "unsupported image" },
            { "result": 6, "error": null },
        ]));
        let reply = parsed(names.incoming(SERVER, &multi, &body));
        assert_eq!(
            reply["result"],
            json!([
                { "result": SENT, "error": null },
                { "result": "kept.png", "error": null },
                { "result": null, "error": "unsupported image" },
                { "result": 6, "error": null },
            ])
        );
        assert_eq!(names.stored(SERVER, "kept.png"), None);
        assert_eq!(names.stored(SERVER, "refused.png"), None);

        // Bare results, as an API version below 5 answers.
        let mut names = StoredNames::default();
        assert_eq!(
            parsed(names.incoming(SERVER, &multi, &json!([STORED, "kept.png", null, 6]).to_string())),
            json!([SENT, "kept.png", null, 6])
        );
        assert_eq!(parsed(names.incoming(SERVER, &store("b.png"), &json!("mtn_b.avif").to_string())), json!("b.png"));

        // Notes written inside a `multi`, and several at once.
        let write = json!({ "action": "multi", "version": 6, "params": { "actions": [
            { "action": "addNotes", "version": 6, "params": { "notes": [
                { "fields": { "Picture": format!("<img src=\"{SENT}\">") } },
                { "fields": { "Picture": "<img src=\"other.png\">" } },
            ] } },
            { "action": "storeMediaFile", "version": 6, "params": { "filename": SENT, "data": "AAAA" } },
        ] } });
        let sent = names.outgoing(SERVER, &write).unwrap();
        let actions = &sent["params"]["actions"];
        assert_eq!(actions[0]["params"]["notes"][0]["fields"]["Picture"], format!("<img src=\"{STORED}\">"));
        assert_eq!(actions[0]["params"]["notes"][1]["fields"]["Picture"], "<img src=\"other.png\">");
        assert_eq!(actions[1]["params"]["filename"], SENT, "a file is stored under the name the extension chose");
    }

    #[test]
    fn a_renamed_file_is_asked_about_and_read_back_by_the_name_sent() {
        let mut names = renamed();
        for action in ["deleteMediaFile", "retrieveMediaFile"] {
            let request = json!({ "action": action, "version": 6, "params": { "filename": SENT } });
            assert_eq!(names.outgoing(SERVER, &request).unwrap()["params"]["filename"], STORED);
            let other = json!({ "action": action, "version": 6, "params": { "filename": "other.png" } });
            assert!(names.outgoing(SERVER, &other).is_none());
        }

        // Is it there? Asked by the stored name, answered by the sent one.
        let exists = json!({ "action": "getMediaFilesNames", "version": 6, "params": { "pattern": SENT } });
        assert_eq!(names.outgoing(SERVER, &exists).unwrap()["params"]["pattern"], STORED);
        assert_eq!(parsed(names.incoming(SERVER, &exists, &answered(json!([STORED]))))["result"], json!([SENT]));
        assert!(names.incoming(SERVER, &exists, &answered(json!([]))).is_none(), "gone from the server");

        // A note read back shows the names the extension wrote.
        let info = json!({ "action": "notesInfo", "version": 6, "params": { "notes": [7] } });
        let body = answered(json!([{ "noteId": 7, "fields": {
            "Picture": { "value": format!("<img src=\"{STORED}\">"), "order": 1 },
            "Expression": { "value": "注目", "order": 0 },
        } }]));
        let reply = parsed(names.incoming(SERVER, &info, &body));
        assert_eq!(
            reply["result"][0]["fields"]["Picture"],
            json!({ "value": format!("<img src=\"{SENT}\">"), "order": 1 })
        );
        assert_eq!(reply["result"][0]["fields"]["Expression"]["value"], "注目");
        // The same content sent again under a newer name: that is the one read back.
        names.incoming(SERVER, &store("hachidori_bb22.png"), &answered(json!(STORED)));
        let reply = parsed(names.incoming(SERVER, &info, &body));
        assert_eq!(reply["result"][0]["fields"]["Picture"]["value"], "<img src=\"hachidori_bb22.png\">");
    }

    #[test]
    fn a_server_without_a_media_list_is_answered_from_what_was_stored() {
        // Manatan SRS has no getMediaFilesNames; Hachidori asks it before and after storing.
        let unsupported = json!({ "result": null, "error": "unsupported action" }).to_string();
        let exists = json!({ "action": "getMediaFilesNames", "version": 6, "params": { "pattern": SENT } });
        let mut names = StoredNames::default();
        assert_eq!(parsed(names.incoming(SERVER, &exists, &unsupported)), json!({ "result": [], "error": null }));
        names.incoming(SERVER, &store(SENT), &answered(json!(STORED)));
        assert_eq!(parsed(names.incoming(SERVER, &exists, &unsupported)), json!({ "result": [SENT], "error": null }));
        // Inside a `multi` too; any other error, and any other unsupported action, is the server's.
        let multi = json!({ "action": "multi", "version": 6, "params": { "actions": [exists.clone()] } });
        let body = answered(json!([{ "result": null, "error": "unsupported action" }]));
        assert_eq!(
            parsed(names.incoming(SERVER, &multi, &body))["result"][0],
            json!({ "result": [SENT], "error": null })
        );
        let failed = json!({ "result": null, "error": "collection is not available" }).to_string();
        assert!(names.incoming(SERVER, &exists, &failed).is_none());
        let other = json!({ "action": "getMediaDirPath", "version": 6, "params": {} });
        assert!(names.incoming(SERVER, &other, &unsupported).is_none());
    }

    #[test]
    fn only_the_newest_names_are_kept() {
        let mut names = StoredNames::default();
        for i in 0..KEPT + 5 {
            names.remember(SERVER, &format!("sent_{i}.png"), &format!("stored_{i}.avif"));
        }
        assert_eq!(names.renamed.len(), KEPT);
        assert_eq!(names.stored(SERVER, "sent_0.png"), None);
        assert_eq!(
            names.stored(SERVER, &format!("sent_{}.png", KEPT + 4)).map(str::to_string),
            Some(format!("stored_{}.avif", KEPT + 4))
        );
    }

    #[test]
    fn whole_names_only() {
        assert_eq!(
            replace_name("[sound:a.mp3][sound:a.mp3]", "a.mp3", "b.webm").as_deref(),
            Some("[sound:b.webm][sound:b.webm]")
        );
        assert_eq!(replace_name("a.mp3", "a.mp3", "b.webm").as_deref(), Some("b.webm"));
        assert_eq!(replace_name("data.mp3 a.mp3x a.mp3.bak", "a.mp3", "b.webm"), None);
        assert_eq!(replace_name("aa.mp3 a.mp3", "a.mp3", "b").as_deref(), Some("aa.mp3 b"));
        assert_eq!(replace_name("絵a.mp3", "a.mp3", "b"), None, "letters of any script are part of a name");
        assert_eq!(replace_name("nothing here", "a.mp3", "b"), None);
        assert_eq!(replace_name("x", "", "b"), None);
    }
}
