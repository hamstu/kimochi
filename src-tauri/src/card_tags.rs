//! Card enhancement's tags (Settings → Anki → Card enhancement → Tags): every new card gets them,
//! whichever dictionary made it. Kimochi's own pop-up (the Yomitan API) adds them with the note
//! (`anki_add_note`); a card a dictionary extension adds through the relay gets them right after,
//! with `addTags` at the extension's own AnkiConnect.
//!
//! The setting, `cardTags`: `{enabled, tags}`, `tags` a comma-separated list in which
//! `{{session-name}}` stands for the name of the session the Log has open.
use crate::settings::Settings;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const KEY: &str = "cardTags";
pub const SESSION_NAME: &str = "{{session-name}}";
pub const DEFAULT_TAGS: &str = "kimochi, {{session-name}}";

/// The tags in `template` (comma-separated), `{{session-name}}` replaced by `session`. Anki splits
/// tags at spaces, so spaces become `_`; it nests them at `::`, which a session's name must not
/// do, so a name's `::` becomes `:` (the template's own `::` nests as written). A tag left empty
/// (no open session) is dropped, and so is a repeat.
pub fn tags(template: &str, session: Option<&str>) -> Vec<String> {
    let mut name = session.unwrap_or("").to_string();
    while name.contains("::") {
        name = name.replace("::", ":");
    }
    let mut out: Vec<String> = Vec::new();
    for part in template.split(',') {
        let tag = part.replace(SESSION_NAME, &name);
        let tag = tag.split_whitespace().collect::<Vec<_>>().join("_");
        let tag = tag.trim_matches('_').to_string();
        if !tag.is_empty() && !out.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            out.push(tag);
        }
    }
    out
}

/// The tags a new card gets now, from the setting and the open session; none when it is off.
pub fn current(settings: &Settings) -> Vec<String> {
    let setting = settings.get(KEY).ok().flatten().unwrap_or(Value::Null);
    if !setting.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
        return Vec::new();
    }
    let template = setting.get("tags").and_then(Value::as_str).unwrap_or(DEFAULT_TAGS);
    let session = crate::account::active_profile_dir().and_then(|dir| crate::anki_cards::active_session_name(&dir));
    tags(template, session.as_deref())
}

/// After the relay carried a dictionary extension's request: a card AnkiConnect added gets the tags.
pub fn after_relay(app: &AppHandle, url: &str, request: &Value, reply_status: u16, reply_body: &str) {
    let Some((anki, note_id, _)) = crate::sentence_audio::added_card(url, request, reply_status, reply_body) else {
        return;
    };
    let Some(state) = app.try_state::<crate::state::Shared>() else { return };
    let tags = current(&state.settings);
    if tags.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let params = json!({ "notes": [note_id], "tags": tags.join(" ") });
        if let Err(e) = crate::reader::ankiconnect::action(&anki.url, anki.key.as_deref(), "addTags", params).await {
            eprintln!("[card-tags] note {note_id} was not tagged: {e}");
        }
    });
}

/// `cardTags` for a settings file from before it: the Yomitan API's own tags (`ankiTags`), with
/// `super-texthooker` (the old default) now `kimochi`, then the session's name.
pub fn migrated(reader: &Value) -> Option<Value> {
    let old: Vec<&str> = reader.get("ankiTags")?.as_array()?.iter().filter_map(Value::as_str).collect();
    let mut parts: Vec<&str> =
        old.iter().map(|t| if *t == "super-texthooker" { "kimochi" } else { t }).filter(|t| !t.trim().is_empty()).collect();
    parts.push(SESSION_NAME);
    let joined = tags(&parts.join(", "), Some(SESSION_NAME)).join(", ");
    Some(json!({ "enabled": true, "tags": joined }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_name_becomes_one_tag() {
        assert_eq!(tags(DEFAULT_TAGS, Some("Chrono Trigger")), ["kimochi", "Chrono_Trigger"]);
        assert_eq!(tags(DEFAULT_TAGS, Some("Persona 5 :: Part  1 ")), ["kimochi", "Persona_5_:_Part_1"]);
        assert_eq!(tags("kimochi, game::{{session-name}}", Some("P5R")), ["kimochi", "game::P5R"]);
    }

    #[test]
    fn no_open_session_leaves_its_tag_out() {
        assert_eq!(tags(DEFAULT_TAGS, None), ["kimochi"]);
        assert_eq!(tags(" , kimochi,,KIMOCHI, mined ", None), ["kimochi", "mined"]);
    }

    #[test]
    fn the_yomitan_api_tags_move_to_card_enhancement() {
        let reader = json!({ "ankiTags": ["super-texthooker", "jp"] });
        assert_eq!(migrated(&reader).unwrap(), json!({ "enabled": true, "tags": "kimochi, jp, {{session-name}}" }));
        assert_eq!(migrated(&json!({})), None);
    }
}
