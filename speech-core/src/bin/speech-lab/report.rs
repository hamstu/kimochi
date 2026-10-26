//! The replay's report: `report.html` to read and listen to, `report.json` to compare runs, and a
//! one-paragraph summary for the terminal.
use crate::replay::Clipped;
use crate::session::{LineRow, Session};
use kimochi_speech::listener::{Decision, How, Outcome};
use kimochi_speech::matching::Heard;
use kimochi_speech::trim::{PAD_AFTER_MS, PAD_BEFORE_MS};
use serde_json::json;
use std::fmt::Write as _;
use std::path::Path;

pub struct Row {
    pub line: LineRow,
    pub decision: Option<Decision>,
    pub clip: Option<Clipped>,
    pub appeared: Option<f64>,
    /// Why the listener decided as it did.
    pub note: String,
    /// Its clip changed after it was matched by its words (other than for a better match).
    pub flipped: bool,
    /// When it first got a clip (Unix ms, the replay's clock).
    pub voiced_at: Option<f64>,
}

/// How a voiced line's clip compares with where its voice really was.
struct Score {
    /// The clip holds the whole voice (give or take 100 ms).
    covered: bool,
    /// The clip holds at least half the voice (else it is the wrong audio).
    overlaps: bool,
    start_error: f64,
    end_error: f64,
}

fn score(row: &Row) -> Option<Score> {
    let truth = row.line.truth.as_ref().filter(|t| t.voiced)?;
    let (start, end) = (truth.start_ms?, truth.end_ms?);
    let Some(Outcome::Voiced(v)) = row.decision.as_ref().map(|d| &d.outcome) else { return None };
    let overlap = (v.to_ms.min(end) - v.from_ms.max(start)).max(0.0);
    Some(Score {
        covered: v.from_ms <= start + 100.0 && v.to_ms >= end - 100.0,
        overlaps: overlap >= (end - start) / 2.0,
        start_error: v.from_ms + PAD_BEFORE_MS - start,
        end_error: v.to_ms - PAD_AFTER_MS - end,
    })
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

pub fn write(
    session: &Session,
    out: &Path,
    rows: &[Row],
    heard: &[Heard],
    elapsed: f64,
    audio_seconds: f64,
    model: bool,
) -> Result<String, String> {
    let t0 = session.meta.audio_start_ms;
    let rel = |ms: f64| (ms - t0) / 1000.0;
    let count = |f: &dyn Fn(&Row) -> bool| rows.iter().filter(|r| f(r)).count();
    fn outcome(r: &Row) -> Option<&Outcome> {
        r.decision.as_ref().map(|d| &d.outcome)
    }
    let voiced = count(&|r| matches!(outcome(r), Some(Outcome::Voiced(_))));
    let matched = count(&|r| matches!(outcome(r), Some(Outcome::Voiced(v)) if matches!(v.how, How::Matched(_))));
    let silent = count(&|r| matches!(outcome(r), Some(Outcome::Silent)));
    let missed = count(&|r| matches!(outcome(r), Some(Outcome::Missed(_))));
    let mut summary = format!(
        "{} lines: {voiced} voiced ({matched} matched by words, {} by timing), {silent} no voice, {missed} missed, {} undecided. \
         {:.1}s of processing for {:.0}s of audio{}.",
        rows.len(),
        voiced - matched,
        rows.len() - voiced - silent - missed,
        elapsed,
        audio_seconds,
        if model { "" } else { " (no model: timing only)" }
    );
    let truths = count(&|r| r.line.truth.is_some());
    let mut metrics = json!({});
    if truths > 0 {
        let scores: Vec<Score> = rows.iter().filter_map(score).collect();
        let truly_voiced = count(&|r| r.line.truth.as_ref().is_some_and(|t| t.voiced));
        let truly_silent = count(&|r| r.line.truth.as_ref().is_some_and(|t| !t.voiced));
        let silent_right = count(&|r| r.line.truth.as_ref().is_some_and(|t| !t.voiced) && matches!(outcome(r), Some(Outcome::Silent)));
        let covered = scores.iter().filter(|s| s.covered).count();
        let wrong = scores.iter().filter(|s| !s.overlaps).count();
        let starts = median(scores.iter().map(|s| s.start_error.abs()).collect());
        let ends = median(scores.iter().map(|s| s.end_error.abs()).collect());
        let flipped: Vec<&str> = rows.iter().filter(|r| r.flipped).map(|r| r.line.uid.as_str()).collect();
        let names = count(&|r| r.line.kind.as_deref() == Some("name"));
        let names_voiced = count(&|r| r.line.kind.as_deref() == Some("name") && matches!(outcome(r), Some(Outcome::Voiced(_))));
        let _ = write!(
            summary,
            "\nAgainst the truth: {}/{truly_voiced} voiced lines got a clip, {covered} holding the whole voice, {wrong} the wrong audio; \
             median start error {starts:.0} ms, end error {ends:.0} ms; {silent_right}/{truly_silent} unvoiced lines said no voice.",
            scores.len()
        );
        // How long after a voiced line arrived (or its voice ended, if later) its clip came.
        let waits: Vec<f64> = rows
            .iter()
            .filter_map(|r| {
                let end = r.line.truth.as_ref().filter(|t| t.voiced)?.end_ms?;
                Some(r.voiced_at? - r.line.ts.max(end))
            })
            .collect();
        let p90 = |mut v: Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v.get(v.len() * 9 / 10).copied().unwrap_or(f64::NAN)
        };
        let (wait_median, wait_p90) = (median(waits.clone()), p90(waits));
        // Purity: a clip that takes in 300 ms or more of another line's voice, and how much
        // longer than its own voice clips run (their padding aside).
        let voices: Vec<(&str, f64, f64)> = rows
            .iter()
            .filter_map(|r| {
                let t = r.line.truth.as_ref().filter(|t| t.voiced)?;
                Some((r.line.uid.as_str(), t.start_ms?, t.end_ms?))
            })
            .collect();
        let mut contaminated = 0;
        let mut excess = Vec::new();
        for r in rows {
            let (Some(Outcome::Voiced(v)), Some(t)) = (outcome(r), r.line.truth.as_ref().filter(|t| t.voiced)) else { continue };
            let others = voices.iter().filter(|(uid, ..)| *uid != r.line.uid);
            if others.clone().any(|(_, a, b)| v.to_ms.min(*b) - v.from_ms.max(*a) >= 300.0) {
                contaminated += 1;
            }
            if let (Some(a), Some(b)) = (t.start_ms, t.end_ms) {
                excess.push((v.to_ms - v.from_ms - PAD_BEFORE_MS - PAD_AFTER_MS) - (b - a));
            }
        }
        let excess_median = median(excess);
        let _ = write!(
            summary,
            " {contaminated} clips take in another line's voice; clips run {:.2}s longer than the voice (median).",
            excess_median / 1000.0
        );
        let _ = write!(summary, " Clips came {:.1}s (median), {:.1}s (90%) after the line and its voice.", wait_median / 1000.0, wait_p90 / 1000.0);
        if names > 0 {
            let _ = write!(summary, " {names_voiced}/{names} name boxes were given a voice.");
        }
        let _ = write!(summary, " {} lines changed their clip after being matched.", flipped.len());
        metrics = json!({
            "voicedLines": truly_voiced, "clipped": scores.len(), "covered": covered, "wrongAudio": wrong,
            "medianStartErrorMs": starts, "medianEndErrorMs": ends,
            "unvoicedLines": truly_silent, "unvoicedSaidSilent": silent_right,
            "nameBoxes": names, "nameBoxesVoiced": names_voiced, "changedAfterMatch": flipped, "waitMedianMs": wait_median, "waitP90Ms": wait_p90,
            "otherVoiceClips": contaminated, "excessMedianMs": excess_median,
        });
    }

    let mut html = String::new();
    let _ = write!(
        html,
        r#"<!doctype html><meta charset="utf-8"><title>Sentence audio lab</title>
<style>
body {{ font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #222; background: #fafafa }}
table {{ border-collapse: collapse; width: 100% }} td, th {{ border-bottom: 1px solid #ddd; padding: 6px 8px; vertical-align: top; text-align: left }}
.text {{ font-size: 16px }} .muted {{ color: #777; font-size: 12px }} .bad {{ color: #b00020 }} .good {{ color: #1b7a32 }}
audio {{ height: 28px; width: 220px }} pre {{ white-space: pre-wrap }}
</style>
<h1>Sentence audio lab</h1><pre>{}</pre><p class="muted">{}</p>
<table><tr><th>#</th><th>Line</th><th>Arrived</th><th>Decided</th><th>Clip</th><th>Truth</th></tr>"#,
        escape(&summary),
        escape(&session.dir.display().to_string())
    );
    for (i, row) in rows.iter().enumerate() {
        let line = &row.line;
        let arrived = format!(
            "{:.2}s {}{}{}",
            rel(line.ts),
            line.source,
            line.scan.as_ref().map_or(String::new(), |s| format!(" <span class=muted>scan {}</span>", escape(s))),
            row.appeared.map_or(String::new(), |a| format!("<br><span class=muted>appeared {:.2}s</span>", rel(a)))
        );
        let (decided, clip) = match (&row.decision, &row.clip) {
            (Some(d), clip) => match &d.outcome {
                Outcome::Voiced(v) => {
                    let how = match &v.how {
                        How::Matched(m) => format!("matched {:.0}%<br><span class=muted>heard {}</span>", m.score * 100.0, escape(&m.heard)),
                        How::Timed => "by timing".into(),
                    };
                    let player = match clip {
                        Some(Clipped { file: Some(f), word, .. }) => {
                            let word = word.as_ref().and_then(|w| w.split_once('|')).map_or(String::new(), |(w, f)| {
                                format!("<br><span class=muted>{}</span> <audio controls preload=none src=\"clips/{f}\"></audio>", escape(w))
                            });
                            format!("<audio controls preload=none src=\"clips/{f}\"></audio>{word}")
                        }
                        Some(Clipped { error: Some(e), .. }) => format!("<span class=bad>{}</span>", escape(e)),
                        _ => String::new(),
                    };
                    (
                        format!("{how}{}", if d.provisional { " <span class=muted>(provisional)</span>" } else { "" }),
                        format!("{player}<br><span class=muted>{:.2}–{:.2}s</span>", rel(v.from_ms), rel(v.to_ms)),
                    )
                }
                Outcome::Silent => ("no voice".into(), String::new()),
                Outcome::Missed(why) => (format!("missed: {}", escape(why)), String::new()),
            },
            (None, _) => ("<span class=bad>undecided</span>".into(), String::new()),
        };
        let decided = format!("{decided}<br><span class=muted>{}</span>", escape(&row.note));
        let text = match line.kind.as_deref() {
            Some(kind) => format!("{} <span class=muted>({kind})</span>", escape(&line.text)),
            None => escape(&line.text),
        };
        let truth = match &line.truth {
            None => String::new(),
            Some(t) if !t.voiced => {
                let right = matches!(row.decision.as_ref().map(|d| &d.outcome), Some(Outcome::Silent));
                format!("<span class={}>no voice</span>", if right { "good" } else { "bad" })
            }
            Some(t) => {
                let range = format!("{:.2}–{:.2}s", rel(t.start_ms.unwrap_or(0.0)), rel(t.end_ms.unwrap_or(0.0)));
                match score(row) {
                    Some(s) => format!(
                        "{range}<br><span class={}>{}</span> <span class=muted>start {:+.0} ms, end {:+.0} ms</span>",
                        if s.covered { "good" } else { "bad" },
                        if !s.overlaps { "wrong audio" } else if s.covered { "whole voice" } else { "partly cut" },
                        s.start_error,
                        s.end_error
                    ),
                    None => format!("{range}<br><span class=bad>no clip</span>"),
                }
            }
        };
        let _ = write!(
            html,
            "<tr><td>{}</td><td class=text>{text}</td><td>{arrived}</td><td>{decided}</td><td>{clip}</td><td>{truth}</td></tr>",
            i + 1,
        );
    }
    html.push_str("</table><h2>Speech heard</h2><table><tr><th>From</th><th>To</th><th>Heard</th></tr>");
    for h in heard {
        let _ = write!(html, "<tr><td>{:.2}s</td><td>{:.2}s</td><td>{}</td></tr>", rel(h.start_ms), rel(h.end_ms), escape(&h.text()));
    }
    html.push_str("</table>");
    std::fs::write(out.join("report.html"), html).map_err(|e| e.to_string())?;

    let json_rows: Vec<_> = rows
        .iter()
        .map(|r| {
            let (outcome, from, to, how, score_) = match r.decision.as_ref().map(|d| &d.outcome) {
                Some(Outcome::Voiced(v)) => {
                    let (how, s) = match &v.how {
                        How::Matched(m) => ("matched", Some(m.score)),
                        How::Timed => ("timed", None),
                    };
                    ("voiced", Some(v.from_ms - t0), Some(v.to_ms - t0), Some(how), s)
                }
                Some(Outcome::Silent) => ("silent", None, None, None, None),
                Some(Outcome::Missed(_)) => ("missed", None, None, None, None),
                None => ("undecided", None, None, None, None),
            };
            json!({ "uid": r.line.uid, "text": r.line.text, "outcome": outcome, "how": how, "score": score_,
                    "fromMs": from, "toMs": to, "truth": r.line.truth, "ts": r.line.ts - t0, "scan": r.line.scan,
                    "kind": r.line.kind, "note": r.note, "voicedAt": r.voiced_at.map(|v| v - t0) })
        })
        .collect();
    let report = json!({ "summary": summary, "metrics": metrics, "processingSeconds": elapsed, "audioSeconds": audio_seconds, "lines": json_rows });
    std::fs::write(out.join("report.json"), serde_json::to_string_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    Ok(summary)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
