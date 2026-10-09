//! Reading identity is independent of a session-scoped capture stream.
//! Ordinary desktop sources retain their existing identity; Gaming Mode can
//! associate whole-screen capture with a game or an explicit user profile.
use crate::state::Service;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const OVERRIDE_KEY: &str = "gamingMode.applicationContextOverride";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ApplicationContext {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub manual: bool,
}

pub fn available() -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::platform::gaming_context::available()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn validate(context: &ApplicationContext) -> Result<(), String> {
    if context.id.trim().is_empty()
        || context.id.len() > 256
        || context.name.trim().is_empty()
        || context.name.len() > 512
        || context.id.chars().any(char::is_control)
        || context.name.chars().any(char::is_control)
    {
        return Err(
            "invalid: application context needs a bounded ID and name without control characters"
                .into(),
        );
    }
    Ok(())
}

pub fn current(service: &Service) -> Option<ApplicationContext> {
    if !available() {
        return None;
    }
    if let Some(context) = service
        .settings
        .get(OVERRIDE_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<ApplicationContext>(v).ok())
        .filter(|c| validate(c).is_ok())
    {
        return Some(context);
    }
    #[cfg(target_os = "linux")]
    {
        crate::platform::gaming_context::current()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

pub fn set_override(service: &Service, context: Option<ApplicationContext>) -> Result<(), String> {
    if !available() {
        return Err("unsupported: application profiles are only available in Gaming Mode".into());
    }
    let value = if let Some(mut context) = context {
        validate(&context)?;
        context.id = context.id.trim().to_string();
        context.name = context.name.trim().to_string();
        context.manual = true;
        context.provider = "manual".into();
        serde_json::to_value(context).map_err(|e| e.to_string())?
    } else {
        Value::Null
    };
    service.settings.set(OVERRIDE_KEY, value)
}

pub fn crop_key(context: Option<&ApplicationContext>, fallback: String) -> String {
    context.map_or(fallback, |c| format!("application:{}", c.id))
}

pub fn source(service: &Service) -> Option<Value> {
    source_with_context(service, current(service).as_ref())
}

pub fn source_with_context(
    service: &Service,
    context: Option<&ApplicationContext>,
) -> Option<Value> {
    let mut source = service.settings.get("lastSelectedSource").ok().flatten()?;
    // Only whole-screen capture needs a sidecar identity. Never relabel a window.
    if matches!(source["type"].as_str(), Some("screen" | "display")) {
        if let Some(context) = context {
            source["applicationContext"] = serde_json::to_value(context).ok()?;
        }
    }
    Some(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(id: &str, name: &str) -> ApplicationContext {
        ApplicationContext {
            id: id.into(),
            name: name.into(),
            provider: "steam".into(),
            manual: false,
        }
    }
    #[test]
    fn crops_use_identity_not_display_or_localized_name() {
        assert_eq!(crop_key(None, "Display 1".into()), "Display 1");
        assert_eq!(
            crop_key(Some(&context("steam:42", "Game")), "Display 1".into()),
            "application:steam:42"
        );
        assert_eq!(
            crop_key(Some(&context("steam:42", "ゲーム")), "Display 2".into()),
            "application:steam:42"
        );
        assert_ne!(
            crop_key(Some(&context("steam:42", "Game")), String::new()),
            crop_key(Some(&context("steam:43", "Game")), String::new())
        );
    }
    #[test]
    fn rejects_unbounded_or_empty_manual_profiles() {
        assert!(validate(&context("", "Game")).is_err());
        assert!(validate(&context("id", " \n")).is_err());
        assert!(validate(&context("id", &"x".repeat(513))).is_err());
        assert!(validate(&context("manual:game.one", "Game 一")).is_ok());
    }
}
