//! RPG Maker MV and MZ: the actors' names a message's `\N[n]` code stands for.
//!
//! The engine's own hook sends a message before its codes are drawn, so a speaker's name or one
//! mentioned in a line comes as `\N[2]`. Taken out (`clean::strip_markup`), the line lost the
//! name (`「おやすみなさい、様」`) and the card no longer matched the game's text. The names are in
//! the game's database, `data/Actors.json` (`www/data/` for MV), as the game starts with them.
use regex::{Captures, Regex};
use std::path::Path;
use std::sync::OnceLock;

/// Actor names by id (index 0 is unused, as in the database), from the game beside `exe`; empty
/// for any other game, or a database that cannot be read (an encrypted one).
pub fn actor_names(exe: &Path) -> Vec<String> {
    let Some(dir) = exe.parent() else { return Vec::new() };
    ["data/Actors.json", "www/data/Actors.json"]
        .iter()
        .find_map(|p| std::fs::read_to_string(dir.join(p)).ok())
        .map(|text| parse(&text))
        .unwrap_or_default()
}

fn parse(text: &str) -> Vec<String> {
    let Ok(serde_json::Value::Array(actors)) =
        serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}'))
    else {
        return Vec::new();
    };
    actors.iter().map(|a| a["name"].as_str().unwrap_or_default().to_string()).collect()
}

/// `text` with each actor code (`\N[2]`, and a speaker's tag `<\N[1]>`) as the actor's name, where
/// `names` has it; other codes are left to `clean`.
pub fn with_names(text: &str, names: &[String]) -> String {
    static CODE: OnceLock<Regex> = OnceLock::new();
    if names.is_empty() || !text.contains('\\') {
        return text.to_string();
    }
    let code = CODE.get_or_init(|| Regex::new(r"(<)?\\[Nn]\[(\d+)\](>)?").expect("actor code"));
    code.replace_all(text, |caps: &Captures| {
        let name = caps[2].parse::<usize>().ok().and_then(|n| names.get(n)).filter(|n| !n.is_empty());
        match name {
            // A speaker's tag is the name alone, as the game's name box shows it.
            Some(name) if caps.get(1).is_some() && caps.get(3).is_some() => name.clone(),
            Some(name) => {
                format!("{}{name}{}", caps.get(1).map_or("", |m| m.as_str()), caps.get(3).map_or("", |m| m.as_str()))
            }
            None => caps[0].to_string(),
        }
    })
    .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        parse(r#"[null,{"id":1,"name":"アリス"},{"id":2,"name":"ボブ"},{"id":3,"name":""}]"#)
    }

    #[test]
    fn actor_codes_are_the_actors_names() {
        assert_eq!(names(), vec!["", "アリス", "ボブ", ""]);
        assert_eq!(
            with_names("<\\n[1]>\n「おやすみなさい、\\N[2]様」", &names()),
            "アリス\n「おやすみなさい、ボブ様」"
        );
        // An actor with no name, or none at that id, is left for the codes to be taken out.
        assert_eq!(with_names("\\N[3]と\\N[9]", &names()), "\\N[3]と\\N[9]");
        // No database: as it was.
        assert_eq!(with_names("\\N[1]", &[]), "\\N[1]");
        assert_eq!(parse("not json"), Vec::<String>::new());
    }
}
