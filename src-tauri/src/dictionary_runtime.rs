//! Live readiness is separate from a verified extension download.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

fn states() -> &'static Mutex<HashMap<String, Value>> {
    static STATES: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

/// Numbers each stored readiness, so a window can tell a late `dictionary_runtime_status` answer
/// from a newer event: the two travel separately, and a reloaded window can read "starting" just
/// before the host reports "ready", then receive that answer after the event.
static SEQ: AtomicU64 = AtomicU64::new(0);

/// Records a `dictionary-readiness` report, stamping it with `seq`. Returns whether it was one,
/// so the caller emits the stamped value.
pub fn update(value: &mut Value) -> bool {
    if value.get("check").and_then(Value::as_str) != Some("dictionary-readiness") {
        return false;
    }
    let Some(engine) = value.get("engine").and_then(Value::as_str) else {
        return false;
    };
    if !crate::extension_store::IDS.contains(&engine) {
        return false;
    }
    let engine = engine.to_string();
    let mut states = states().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(object) = value.as_object_mut() {
        object.insert("seq".into(), json!(SEQ.fetch_add(1, Ordering::Relaxed) + 1));
    }
    states.insert(engine, value.clone());
    true
}

pub fn status(engine: &str) -> Value {
    states().lock().unwrap_or_else(|p| p.into_inner()).get(engine).cloned()
        .unwrap_or_else(|| json!({"engine": engine, "phase": "starting", "settingsReady": false, "message": "Starting the dictionary…", "seq": 0}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_report_is_numbered_after_the_last_and_kept_with_its_number() {
        let mut first = json!({"check": "dictionary-readiness", "engine": "yomitan", "phase": "starting"});
        let mut second = json!({"check": "dictionary-readiness", "engine": "yomitan", "phase": "ready"});
        assert!(update(&mut first));
        assert!(update(&mut second));
        let (a, b) = (first["seq"].as_u64().unwrap(), second["seq"].as_u64().unwrap());
        assert!(b > a && a > 0);
        assert_eq!(status("yomitan"), second);
        // Not readiness, or no known engine: untouched and not stored.
        let mut other = json!({"check": "something-else", "engine": "yomitan"});
        assert!(!update(&mut other));
        assert!(other.get("seq").is_none());
    }
}
