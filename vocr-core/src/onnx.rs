//! ONNX Runtime sessions and the files' `vocr.*` metadata.
use crate::Error;
use ort::session::Session;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// A CPU session as upstream checked the exact files with: the default optimisation level, no
/// denormal flushing, `threads` intra-op threads, one inter-op thread, no spinning workers (they
/// would compete with the game and the capture for the CPU between reads).
pub fn session(path: &Path, threads: usize) -> Result<Session, Error> {
    let bytes = std::fs::read(path).map_err(|e| Error::Model(format!("{}: {e}", path.display())))?;
    let session = Session::builder()?
        .with_intra_threads(threads.max(1))?
        .with_inter_threads(1)?
        .with_intra_op_spinning(false)?
        .with_config_entry("session.inter_op.allow_spinning", "0")?
        .commit_from_memory(&bytes)?;
    Ok(session)
}

/// The model's `vocr.*` custom metadata, each value JSON (or a bare string).
pub struct Meta(HashMap<String, Value>);

impl Meta {
    pub fn read(session: &Session) -> Result<Self, Error> {
        let meta = session.metadata()?;
        let mut map = HashMap::new();
        for key in meta.custom_keys()? {
            if let Some(raw) = meta.custom(&key)? {
                let value = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
                map.insert(key, value);
            }
        }
        let meta = Self(map);
        if meta.0.get("vocr.format").and_then(Value::as_i64) != Some(crate::FORMAT) {
            return Err(Error::Model(format!("not a VOCR ONNX file of format {}", crate::FORMAT)));
        }
        Ok(meta)
    }

    pub fn value(&self, key: &str) -> Result<&Value, Error> {
        self.0.get(key).ok_or_else(|| Error::Model(format!("metadata {key} missing")))
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<T, Error> {
        serde_json::from_value(self.value(key)?.clone()).map_err(|e| Error::Model(format!("metadata {key}: {e}")))
    }

    pub fn int(&self, key: &str) -> Result<i64, Error> {
        self.value(key)?.as_i64().ok_or_else(|| Error::Model(format!("metadata {key} is not an integer")))
    }

    pub fn str(&self, key: &str) -> Result<&str, Error> {
        self.value(key)?.as_str().ok_or_else(|| Error::Model(format!("metadata {key} is not a string")))
    }
}
