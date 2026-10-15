//! Live readiness is separate from a verified extension download.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn states() -> &'static Mutex<HashMap<String, Value>> {
    static STATES: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

pub fn update(value: &Value) -> bool {
    if value.get("check").and_then(Value::as_str) != Some("dictionary-readiness") {
        return false;
    }
    let Some(engine) = value.get("engine").and_then(Value::as_str) else {
        return false;
    };
    if !crate::extension_store::IDS.contains(&engine) {
        return false;
    }
    states()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(engine.into(), value.clone());
    true
}

pub fn status(engine: &str) -> Value {
    states().lock().unwrap_or_else(|p| p.into_inner()).get(engine).cloned()
        .unwrap_or_else(|| json!({"engine": engine, "phase": "starting", "settingsReady": false, "message": "Starting the dictionary…"}))
}
