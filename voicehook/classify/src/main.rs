//! vh-classify: which streams of a capture are the voice, and which clip goes with each line.
//!
//! ```text
//! vh-classify <capture dir> [lines.jsonl]   lines: {"uid", "text", "ts", "appeared"?} per line
//! vh-classify mock                          the synthetic scenes and their scores
//! ```
use std::path::Path;
use std::process::ExitCode;
use vh_classify::*;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("mock") => {
            println!("precision / recall over 20 seeds x 60 lines per scene\n");
            println!("{:<8} {:>15} {:>15} {:>15}", "scene", "timing", "+speech check", "names only*");
            for name in mock::SCENES {
                let mut acc = [mock::Score::default(); 3];
                for seed in 1..=20 {
                    let s = mock::scene(name, seed);
                    for (i, (wl, sp)) in [(true, false), (true, true), (false, false)].into_iter().enumerate() {
                        let x = mock::evaluate(&s, wl, sp);
                        acc[i].voiced += x.voiced;
                        acc[i].right += x.right;
                        acc[i].wrong += x.wrong;
                        acc[i].missed += x.missed;
                        acc[i].false_claims += x.false_claims;
                    }
                }
                let f = |s: &mock::Score| format!("{:.3} / {:.3}", s.precision(), s.recall());
                println!("{:<8} {:>15} {:>15} {:>15}", name, f(&acc[0]), f(&acc[1]), f(&acc[2]));
            }
            println!("\n* groups chosen without the lines (names, format, lengths); lines still pick the clip");
            ExitCode::SUCCESS
        }
        Some(dir) => {
            let cap = match Capture::load(Path::new(dir)) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            };
            let lines: Vec<Line> = args
                .get(2)
                .and_then(|p| std::fs::read_to_string(p).ok())
                .map(|t| t.lines().filter_map(|l| serde_json::from_str(l.trim_start_matches('\u{feff}')).ok()).collect())
                .unwrap_or_default();
            let verdicts = classify(&cap, &lines);
            println!("{} clips, {} lines\n\ngroups (voice likelihood):", cap.clips.len(), lines.len());
            for v in &verdicts {
                println!("  {:>5.2}  {:<46} {:>4} clips  median {:>5.1}s  {}", v.voice, v.group, v.clips, v.median_dur, v.reasons.join("; "));
            }
            let voice = voice_groups(&verdicts);
            println!("\nvoice: {}", if voice.is_empty() { "(none decided)".to_string() } else { voice.join(", ") });
            // speech.jsonl (vh-speechcheck): VAD speech share per clip, as the speech check.
            let speech: std::collections::HashMap<u64, f64> = std::fs::read_to_string(Path::new(dir).join("speech.jsonl"))
                .map(|t| {
                    t.lines()
                        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                        .filter_map(|v| Some((v["seq"].as_u64()?, v["speech"].as_f64()?)))
                        .collect()
                })
                .unwrap_or_default();
            if !speech.is_empty() {
                println!("speech check: {} clips from speech.jsonl", speech.len());
            }
            let check = |c: &Clip| speech.get(&c.seq).map(|r| (r * 2.0).min(1.0));
            if !lines.is_empty() {
                println!("\nlines:");
                for m in match_lines_with(&cap, &voice, &lines, if speech.is_empty() { None } else { Some(&check) }) {
                    match m.clip {
                        Some(c) => println!("  {:<10} {:+6.0} ms  {}  {}", m.uid, m.offset_ms.unwrap_or(0.0), c.file.unwrap_or_default(), c.source.unwrap_or_default()),
                        None => println!("  {:<10} (no voice clip)", m.uid),
                    }
                }
            } else {
                let voiced: Vec<&Clip> = cap.clips.iter().filter(|c| voice.contains(&c.group()) && !c.looping && name_says(&format!("{} {}", c.source.as_deref().unwrap_or(""), c.channel.as_deref().unwrap_or(""))).0 >= 0).collect();
                println!("\nvoice clips ({}):", voiced.len());
                for c in voiced.iter().take(40) {
                    println!("  {:>5.1}s  {}  {}", c.dur, c.file.as_deref().unwrap_or("-"), c.source.as_deref().unwrap_or(""));
                }
            }
            ExitCode::SUCCESS
        }
        None => {
            eprintln!("vh-classify <capture dir> [lines.jsonl]\nvh-classify mock");
            ExitCode::from(2)
        }
    }
}
