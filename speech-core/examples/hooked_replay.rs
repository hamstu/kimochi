//! Replays a voicehook capture and Log lines through `Hooked::tick` on a simulated clock.
//!   cargo run --example hooked_replay -- <capture dir> <lines.jsonl> [step ms]
//! lines.jsonl: one `{uid, text, ts, appeared?, scan?, ocr?}` per line (Diagnostics' fields).
//! Work on a copy of the capture: the reader prunes clip files it considers expired. Events are
//! revealed in the order of their `t` (a clip is logged when it ends), as the live reader sees them.
use kimochi_speech::hooked::Hooked;
use kimochi_speech::timeline::Line;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(&args[1]);
    let step: f64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(100.0);
    let mut lines: Vec<Line> = std::fs::read_to_string(&args[2])
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            Line {
                uid: v["uid"].as_str().unwrap().into(),
                text: v["text"].as_str().unwrap().into(),
                ts: v["ts"].as_f64().unwrap(),
                ocr: v["ocr"].as_bool().unwrap_or(false),
                appeared: v["appeared"].as_f64(),
                scan: v["scan"].as_str().map(str::to_owned),
            }
        })
        .collect();
    lines.sort_by(|a, b| a.ts.total_cmp(&b.ts));
    let log = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
    let mut events: Vec<(f64, String)> = log
        .lines()
        .map(|l| {
            (
                serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v["t"].as_f64()).unwrap_or(0.0),
                l.to_owned(),
            )
        })
        .collect();
    events.sort_by(|a, b| a.0.total_cmp(&b.0));
    std::fs::write(dir.join("events.jsonl"), "").unwrap();
    let mut shown = 0;
    let mut hooked = Hooked::default();
    hooked.add_capture(dir.clone());
    // KIMOCHI_ORT=<onnxruntime.dll>: speech detection on candidates, as the app has it.
    if let Ok(ort) = std::env::var("KIMOCHI_ORT") {
        ort::init_from(ort).commit().unwrap();
        hooked.speech = Some(kimochi_speech::vad::Vad::new().unwrap());
    }
    let (first, last) = (lines[0].ts - 1000.0, lines.last().unwrap().ts + 20_000.0);
    let mut next = 0;
    let mut now = first;
    let mut was_waiting = std::collections::BTreeSet::new();
    while now <= last {
        let mut more = String::new();
        while shown < events.len() && events[shown].0 <= now {
            more.push_str(&events[shown].1);
            more.push('\n');
            shown += 1;
        }
        if !more.is_empty() {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .append(true)
                .open(dir.join("events.jsonl"))
                .unwrap()
                .write_all(more.as_bytes())
                .unwrap();
        }
        while next < lines.len() && lines[next].ts <= now {
            hooked.line(lines[next].clone());
            next += 1;
        }
        for m in hooked.tick(now) {
            println!(
                "{:>8.0} MATCH {} clip seq {} s{} start {:+.0} ms dur {:.2}s",
                now - first,
                m.line.text.chars().take(24).collect::<String>(),
                m.clip.seq,
                m.clip.stream,
                m.clip.start - m.line.anchor(),
                m.clip.dur
            );
        }
        for l in hooked.lines() {
            let w = hooked.waiting(&l.uid, now);
            if !w && was_waiting.remove(&l.uid) && !hooked.completed(&l.uid) {
                println!("{:>8.0} GIVE UP {}", now - first, l.text.chars().take(24).collect::<String>());
            } else if w {
                was_waiting.insert(l.uid.clone());
            }
        }
        now += step;
    }
    let r = &hooked.report;
    println!("matched {} of {} lines; rejected {}; typing {:.0} ms/char; lead {:.0} ms; lag {:.0} ms; clips seen {}; error {:?}", r.matched, lines.len(), r.rejected, r.typing_ms, r.lead_ms, r.lag_ms, r.clips_seen, r.error);
    for g in &r.groups {
        println!("  {:.3} {} ({} clips) {:?}", g.voice, g.group, g.clips, g.reasons);
    }
}
