//! Kanji readings, so a line's 分かった lines up with a heard わかった (and a heard 為 with a
//! line's ため): the recogniser writes words in kana or kanji as it likes, and so do scripts.
//!
//! `data/kanji-readings.txt` is every kanji of the Japanese standards with its on and kun
//! readings in hiragana, from the Unicode Character Database's Unihan (kJapanese; built by
//! `tools/kanji_readings.py`). A reading is folded as `matching::fold` folds text.
use std::collections::HashMap;
use std::sync::OnceLock;

const TABLE: &str = include_str!("../data/kanji-readings.txt");

fn table() -> &'static HashMap<char, Vec<Vec<char>>> {
    static READINGS: OnceLock<HashMap<char, Vec<Vec<char>>>> = OnceLock::new();
    READINGS.get_or_init(|| {
        let mut map = HashMap::new();
        for row in TABLE.lines() {
            let Some((kanji, readings)) = row.split_once('\t') else { continue };
            let Some(kanji) = kanji.chars().next() else { continue };
            let folded: Vec<Vec<char>> =
                readings.split(' ').map(|r| crate::matching::fold(r).0).filter(|r| !r.is_empty()).collect();
            map.insert(kanji, folded);
        }
        map
    })
}

/// `kanji`'s readings, folded; None for anything else.
pub fn of(kanji: char) -> Option<&'static [Vec<char>]> {
    table().get(&kanji).map(Vec::as_slice)
}

/// The voiced forms of a kana (rendaku: 人々 ひとびと, 学校 がっこう's neighbours).
fn voiced(c: char) -> &'static [char] {
    match c {
        'か' => &['が'],
        'き' => &['ぎ'],
        'く' => &['ぐ'],
        'け' => &['げ'],
        'こ' => &['ご'],
        'さ' => &['ざ'],
        'し' => &['じ'],
        'す' => &['ず'],
        'せ' => &['ぜ'],
        'そ' => &['ぞ'],
        'た' => &['だ'],
        'ち' => &['ぢ', 'じ'],
        'つ' => &['づ', 'ず'],
        'て' => &['で'],
        'と' => &['ど'],
        'は' => &['ば', 'ぱ'],
        'ひ' => &['び', 'ぴ'],
        'ふ' => &['ぶ', 'ぷ'],
        'へ' => &['べ', 'ぺ'],
        'ほ' => &['ぼ', 'ぽ'],
        _ => &[],
    }
}

/// Whether kana `run` is how one of `readings` is said: the whole reading or its start (a kun
/// reading's stem before the kana written after it, 分 of 分かる), its first sound perhaps voiced.
pub fn reads(readings: &[Vec<char>], run: &[char]) -> bool {
    let Some((&first, rest)) = run.split_first() else { return false };
    readings.iter().any(|r| {
        r.len() >= run.len() && r[1..run.len()] == *rest && (r[0] == first || voiced(r[0]).contains(&first))
    })
}

/// Whether `c` is kana (what a reading is made of).
pub fn is_kana(c: char) -> bool {
    ('\u{3041}'..='\u{309F}').contains(&c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kanji_is_read_by_its_readings_their_starts_and_voiced_forms() {
        let wa: Vec<char> = "わ".chars().collect();
        assert!(reads(of('分').unwrap(), &wa), "分 of 分かる");
        assert!(reads(of('為').unwrap(), &"ため".chars().collect::<Vec<_>>()));
        assert!(reads(of('学').unwrap(), &"が".chars().collect::<Vec<_>>()), "がっこう");
        assert!(reads(of('人').unwrap(), &"びと".chars().collect::<Vec<_>>()), "rendaku");
        assert!(!reads(of('分').unwrap(), &"ため".chars().collect::<Vec<_>>()));
        assert!(of('あ').is_none() && is_kana('あ') && !is_kana('分'));
    }
}
