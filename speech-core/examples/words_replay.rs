//! Replays a capture and Log lines through `Hooked::tick` and, with the speech model, the words
//! pass (`Hooked::by_words`), on a simulated clock; writes what each line was given as JSON.
//!   cargo run --release --example words_replay -- <capture dir> <lines.jsonl> <out.json> [step ms]
//! KIMOCHI_ORT=<onnxruntime.dll> KIMOCHI_SENSEVOICE=<model dir> turn the words pass on.
//! Work on a copy of the capture: the reader prunes clip files it considers expired.
use kimochi_speech::hooked::Hooked;
use kimochi_speech::timeline::Line;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(&args[1]);
    let step: f64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(100.0);
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
    let mut asr = None;
    if let Ok(ort) = std::env::var("KIMOCHI_ORT") {
        ort::init_from(ort).commit().unwrap();
        hooked.speech = Some(kimochi_speech::vad::Vad::new().unwrap());
        if let Ok(model) = std::env::var("KIMOCHI_SENSEVOICE") {
            asr = Some(kimochi_speech::sense_voice::SenseVoice::load(std::path::Path::new(&model), 2).unwrap());
        }
    }
    let mut given: std::collections::BTreeMap<String, (f64, &str)> = Default::default();
    let mut asr_ms = 0.0;
    let (mut heard_n, mut heard_s) = (0usize, 0.0f64);
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
        let mut matched: Vec<(kimochi_speech::hooked::Matched, &str)> =
            hooked.tick(now).into_iter().map(|m| (m, "timing")).collect();
        if let Some(asr) = asr.as_mut() {
            let began = std::time::Instant::now();
            let mut hear = |s: &[f32], r: u32| {
                heard_n += 1;
                heard_s += s.len() as f64 / r as f64;
                asr.transcribe(&kimochi_speech::vad::to_16k(s, r)).ok()
            };
            matched.extend(hooked.by_words(now, &mut hear).into_iter().map(|m| (m, "words")));
            asr_ms += began.elapsed().as_secs_f64() * 1000.0;
        }
        for (m, how) in matched {
            given.insert(m.line.uid.clone(), (m.clip.start, how));
            println!(
                "{:>8.0} MATCH {how} {} clip seq {} s{} start {:+.0} ms dur {:.2}s",
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
    let out: Vec<serde_json::Value> = lines
        .iter()
        .map(|l| {
            let g = given.get(&l.uid);
            serde_json::json!({ "uid": l.uid, "text": l.text, "ts": l.ts, "clip": g.map(|g| g.0), "how": g.map(|g| g.1) })
        })
        .collect();
    std::fs::write(&args[3], serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("words pass: {:.0} ms in all; {heard_n} clips heard, {heard_s:.0} s of audio", asr_ms);
    let r = &hooked.report;
    println!("matched {} ({} by words) of {} lines; rejected {}; typing {:.0} ms/char; lead {:.0} ms; lag {:.0} ms; clips seen {}; error {:?}", r.matched, r.by_words, lines.len(), r.rejected, r.typing_ms, r.lead_ms, r.lag_ms, r.clips_seen, r.error);
    for g in &r.groups {
        println!("  {:.3} {} ({} clips) {:?}", g.voice, g.group, g.clips, g.reasons);
    }
}
