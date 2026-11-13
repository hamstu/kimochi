use super::*;
use serde_json::json;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hooked-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(p.join("clips")).unwrap();
        Self(p)
    }
    fn event(&self, e: serde_json::Value) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(self.0.join("events.jsonl")).unwrap();
        writeln!(f, "{e}").unwrap();
    }
    fn clip(&self, seq: u64, start: f64, source: Option<&str>, dur: f64) {
        let name = format!("clips/{seq}.wav");
        crate::wav::write(&self.0.join(&name), &vec![0.2; 16000], 16000).unwrap();
        self.event(json!({"ev":"clip","seq":seq,"s":seq,"api":"dsound","start":start,"t":start+dur*1000.0,"dur":dur,"file":name,"source":source,"fmt":"16000Hz 1ch PCM16"}));
    }
    fn hooked(&self) -> Hooked {
        let mut h = Hooked::default();
        h.add_capture(self.0.clone());
        h
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn line(id: &str, ts: f64) -> Line {
    Line { uid: id.into(), text: "今日はいい天気ですね".into(), ts, appeared: None, ocr: false, scan: None }
}
#[test]
fn named_voice_wins_over_music_without_a_model_and_is_used_once() {
    let f = Fixture::new();
    f.clip(1, 1000., Some("voice/001"), 1.);
    f.clip(2, 1000., Some("bgm/theme"), 20.);
    let mut h = f.hooked();
    h.line(line("a", 1000.));
    assert!(h.tick(1500.).is_empty());
    let matched = h.tick(2200.);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].clip.seq, 1);
    assert!(h.completed("a"));
    assert!(h.tick(3000.).is_empty());
    h.line(line("b", 1000.));
    assert!(h.tick(3000.).is_empty());
}
#[test]
fn unnamed_voice_requires_repeated_evidence() {
    let f = Fixture::new();
    let mut h = f.hooked();
    for i in 1..=3 {
        let start = i as f64 * 4000.;
        f.clip(i, start, None, 2.);
        h.line(line(&i.to_string(), start));
        let got = h.tick(start + 2200.);
        if i < 3 {
            assert!(got.is_empty());
        } else {
            assert_eq!(got.len(), 3);
        }
    }
}
#[test]
fn ambiguous_simultaneous_voices_fall_back() {
    let f = Fixture::new();
    f.clip(1, 1000., Some("voice/a"), 1.);
    f.clip(2, 1010., Some("voice/b"), 1.);
    let mut h = f.hooked();
    h.line(line("a", 1000.));
    assert!(h.tick(2500.).is_empty());
    assert!(!h.waiting("a", 17000.));
    assert!(h.needs_fallback(17000.));
}
#[test]
fn named_voices_teach_a_bounded_late_start_window() {
    let f = Fixture::new();
    let mut h = f.hooked();
    // Late starts are decided once the timing has settled (five voices): until then a late voice
    // may be the next line's, still typing out.
    for i in 1..=5 {
        let ts = i as f64 * 10000.;
        h.line(line(&i.to_string(), ts));
        f.clip(i, ts + 2500., Some("voice/a"), 1.);
    }
    assert_eq!(h.tick(54000.).len(), 5);
    assert_eq!(h.report.lag_ms, 2900.);
}
#[test]
fn longest_line_in_an_ocr_scan_gets_the_voice() {
    let f = Fixture::new();
    f.clip(1, 1000., Some("voice/a"), 1.);
    let mut h = f.hooked();
    let mut name = line("name", 1000.);
    name.text = "花子".into();
    name.scan = Some("scan".into());
    name.ocr = true;
    let mut dialogue = line("dialogue", 1000.);
    dialogue.scan = name.scan.clone();
    dialogue.ocr = true;
    h.line(name);
    h.line(dialogue);
    let matched = h.tick(2200.);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].line.uid, "dialogue");
}
#[test]
fn partial_log_and_open_stream_end_and_pruning() {
    let f = Fixture::new();
    f.event(json!({"ev":"stream","s":1,"info":{"channel":"voice"}}));
    f.event(json!({"ev":"data","s":1,"t":1000}));
    let mut log = std::fs::OpenOptions::new().append(true).open(f.0.join("events.jsonl")).unwrap();
    write!(log, "{{\"ev\":\"clip\"").unwrap();
    let mut feed = feed::Feed::new(f.0.clone());
    assert_eq!(feed.poll(1200.).unwrap(), 0);
    assert_eq!(feed.open_starts(1200.), vec![1000.]);
    writeln!(log, ",\"s\":1,\"seq\":1,\"start\":1000,\"dur\":2}}").unwrap();
    assert_eq!(feed.poll(3000.).unwrap(), 1);
    assert_eq!(feed.clips()[0].channel.as_deref(), Some("voice"));
    assert!(feed.open_starts(3000.).is_empty());
    assert_eq!(feed.poll(3000.).unwrap(), 0);
    assert!(feed.clip_path("../outside.wav").is_err());
    feed.poll(700000.).unwrap();
    assert!(feed.clips().is_empty());
}
#[test]
fn missing_audio_does_not_block_fallback() {
    let f = Fixture::new();
    f.clip(1, 1000., Some("voice/a"), 1.);
    std::fs::remove_file(f.0.join("clips/1.wav")).unwrap();
    let mut h = f.hooked();
    h.line(line("a", 1000.));
    assert!(h.tick(3000.).is_empty());
    assert!(!h.waiting("a", 17000.));
    assert!(h.report.error.is_some());
}
#[test]
fn pcm_bit_depths_are_downmixed_and_bad_audio_returns_errors() {
    let f = Fixture::new();
    for bits in [8, 16, 24, 32] {
        let p = f.0.join(format!("{bits}.wav"));
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 16000,
            bits_per_sample: bits,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        let v = 1i32 << (bits - 2);
        w.write_sample(v).unwrap();
        w.write_sample(-v).unwrap();
        w.finalize().unwrap();
        let (audio, rate) = feed::decode(&p).unwrap();
        assert_eq!(rate, 16000);
        assert_eq!(audio, vec![0.]);
    }
    let bad = f.0.join("bad.ogg");
    std::fs::write(&bad, b"invalid").unwrap();
    assert!(feed::decode(&bad).is_err());
}
#[test]
fn unnamed_stream_can_learn_a_late_start() {
    let f = Fixture::new();
    let mut h = f.hooked();
    for i in 1..=5 {
        let ts = i as f64 * 10000.;
        h.line(line(&i.to_string(), ts));
        f.clip(i, ts + 2500., None, 2.);
    }
    assert_eq!(h.tick(55000.).len(), 5);
    assert_eq!(h.report.lag_ms, 2900.);
}
#[test]
fn forgetting_a_replaced_line_releases_its_clip() {
    let f = Fixture::new();
    f.clip(1, 1000., Some("voice/a"), 1.);
    let mut h = f.hooked();
    h.line(line("old", 1000.));
    assert_eq!(h.tick(2200.).len(), 1);
    h.forget(&["old".into()]);
    h.line(line("replacement", 1000.));
    assert_eq!(h.tick(2300.).len(), 1);
}
#[test]
fn short_buffers_bound_the_wait_for_an_unfinished_stream() {
    let f = Fixture::new();
    f.event(json!({"ev":"data","s":1,"t":1000}));
    let mut h = f.hooked();
    h.max_wait_ms = 8000.;
    h.line(line("a", 1000.));
    h.tick(1100.);
    assert!(h.waiting("a", 2000.));
    assert!(!h.waiting("a", 9001.));
    assert!(h.needs_fallback(9001.));
}
#[test]
fn split_utf8_malformed_records_and_log_truncation_recover() {
    let f = Fixture::new();
    let path = f.0.join("events.jsonl");
    let event =
        json!({"ev":"clip","seq":1,"s":1,"source":"\u{30dc}\u{30a4}\u{30b9}","t":1000,"dur":1}).to_string() + "\n";
    let split = event.as_bytes().iter().position(|b| *b >= 128).unwrap() + 1;
    std::fs::write(&path, &event.as_bytes()[..split]).unwrap();
    let mut feed = feed::Feed::new(f.0.clone());
    assert_eq!(feed.poll(1000.).unwrap(), 0);
    let mut log = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
    log.write_all(&event.as_bytes()[split..]).unwrap();
    writeln!(log, "invalid json").unwrap();
    drop(log);
    assert_eq!(feed.poll(1000.).unwrap(), 1);
    assert_eq!(feed.clips()[0].source.as_deref(), Some("\u{30dc}\u{30a4}\u{30b9}"));
    std::fs::write(path, b"{\"ev\":\"clip\",\"seq\":2,\"t\":2000}\n").unwrap();
    assert_eq!(feed.poll(2000.).unwrap(), 1);
    assert_eq!(feed.clips().len(), 1);
    assert_eq!(feed.clips()[0].seq, 2);
}
#[test]
fn a_pass_held_up_for_minutes_still_matches_every_line_to_its_own_clip() {
    // Live AdvHD: the app's listening pass was held up for over a minute; the lines it then saw
    // were older than the old 60 s horizon and were never matched, though their clips were kept.
    let f = Fixture::new();
    let mut h = f.hooked();
    for i in 1..=5u64 {
        let start = i as f64 * 7000.;
        f.clip(i, start - 330., None, 4.);
        h.line(line(&i.to_string(), start));
    }
    let matched = h.tick(5. * 7000. + 120_000.);
    assert_eq!(matched.len(), 5);
    for m in &matched {
        assert_eq!(m.line.uid, m.clip.seq.to_string());
    }
}
#[test]
fn voices_that_start_before_their_text_teach_the_lead_not_the_lag() {
    // Live AdvHD: every voice starts ~330 ms before the text hook delivers its line, one 640 ms;
    // lines come 1.2-3 s apart. Measured from the line before, each start looked 0.9-2.7 s late,
    // which stretched the lag; the fixed 400 ms lead then missed the 640 ms one.
    let f = Fixture::new();
    let mut h = f.hooked();
    let gaps: [f64; 9] = [6500., 6500., 1200., 1200., 3000., 3000., 3000., 6500., 6500.];
    let mut ts = 10_000.;
    for (i, gap) in gaps.iter().enumerate() {
        let seq = i as u64 + 1;
        let early = if seq == 8 { 640. } else { 330. };
        f.clip(seq, ts - early, None, (gap / 1000. - 0.2).min(4.));
        h.line(line(&seq.to_string(), ts));
        ts += gap;
    }
    let matched = h.tick(ts + 10_000.);
    assert_eq!(matched.len(), gaps.len(), "every line gets its own clip");
    for m in &matched {
        assert_eq!(m.line.uid, m.clip.seq.to_string());
    }
    assert_eq!(h.report.lag_ms, classify::LAG_MS, "no clip started after its line");
    assert!(h.report.lead_ms >= 700. && h.report.lead_ms <= classify::MAX_LEAD_MS, "lead {}", h.report.lead_ms);
}
#[test]
fn voices_played_before_any_known_line_do_not_hide_the_voice() {
    // Live AdvHD after a Kimochi restart: the capture held 32 earlier voice clips whose lines the
    // new session never saw; counted against the voice, they dropped its score to 0.15.
    let f = Fixture::new();
    for i in 1..=30u64 {
        f.clip(i, i as f64 * 7000., None, 4.);
    }
    let mut h = f.hooked();
    let mut matched = Vec::new();
    for i in 31..=34u64 {
        let ts = 400_000. + i as f64 * 7000.;
        f.clip(i, ts - 330., None, 4.);
        h.line(line(&i.to_string(), ts));
        matched.extend(h.tick(ts + 5000.));
    }
    assert_eq!(matched.len(), 4, "groups: {:?}", h.report.groups);
    for m in &matched {
        assert_eq!(m.line.uid, m.clip.seq.to_string());
    }
}
/// Speech detection on real game clips, opt-in: `KIMOCHI_ORT=<onnxruntime.dll>
/// KIMOCHI_VOICE_WAV=<a voiced clip> KIMOCHI_EFFECT_WAV=<a same-format effect, 1.5 s or longer>
/// cargo test --lib hooked::tests::a_long -- --ignored`. Live AdvHD gave a narration line the
/// 3.4 s footsteps that started with it, in the voice's own format.
#[test]
#[ignore]
fn a_long_clip_without_speech_is_never_a_voice() {
    ort::init_from(std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT")).commit().unwrap();
    let f = Fixture::new();
    for (seq, var, start) in [(1u64, "KIMOCHI_EFFECT_WAV", 10_000. - 300.), (2, "KIMOCHI_VOICE_WAV", 20_000. - 330.)] {
        let src = std::path::PathBuf::from(std::env::var(var).expect(var));
        let name = format!("clips/{seq}.wav");
        std::fs::copy(&src, f.0.join(&name)).unwrap();
        let (samples, rate) = feed::decode(&f.0.join(&name)).unwrap();
        let dur = samples.len() as f64 / rate as f64;
        assert!(seq == 2 || dur >= 1.5, "the effect must be long enough to judge");
        // Unnamed, as AdvHD's are (a clip named as voice is never second-guessed), and trusted
        // as this game's voice from an earlier session.
        f.event(json!({"ev":"clip","seq":seq,"s":seq,"api":"xaudio2.9","start":start,"t":start+dur*1000.0,"dur":dur,"file":name,"fmt":"float32 1ch 44100Hz"}));
    }
    let mut h = f.hooked();
    h.remembered = Some("xaudio2.9 | float32 1ch 44100Hz | ".into());
    h.speech = Some(crate::vad::Vad::new().unwrap());
    h.line(line("narration", 10_000.));
    h.line(line("spoken", 20_000.));
    let matched = h.tick(60_000.);
    assert_eq!(matched.iter().map(|m| (m.line.uid.as_str(), m.clip.seq)).collect::<Vec<_>>(), vec![("spoken", 2)]);
    assert_eq!(h.report.rejected, 1);
}
/// Opt-in, like the test above: `KIMOCHI_ORT=… KIMOCHI_SHOUT_WAV=<a shouted voice line Silero
/// misses> cargo test --lib hooked::tests::a_shouted -- --ignored`. Live Unity fell back to
/// system audio for a shouted apology, its file named as voice.
#[test]
#[ignore]
fn a_shouted_line_named_as_voice_is_kept() {
    ort::init_from(std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT")).commit().unwrap();
    let f = Fixture::new();
    let name = "clips/1.wav";
    std::fs::copy(std::env::var("KIMOCHI_SHOUT_WAV").expect("KIMOCHI_SHOUT_WAV"), f.0.join(name)).unwrap();
    let (samples, rate) = feed::decode(&f.0.join(name)).unwrap();
    let dur = samples.len() as f64 / rate as f64;
    let mut vad = crate::vad::Vad::new().unwrap();
    assert!(vad.speech_share(&samples, rate).unwrap() < MIN_SPEECH_SHARE, "a clip Silero misses");
    f.event(json!({"ev":"clip","seq":1,"s":1,"api":"unity","start":10_000.,"t":10_000.,"dur":dur,"file":name,"source":"Sound/Voice/ch01_003.ogg","fmt":"float32 1ch 48000Hz"}));
    let mut h = f.hooked();
    h.speech = Some(vad);
    h.line(line("shout", 10_004.));
    let matched = h.tick(60_000.);
    assert_eq!(matched.len(), 1);
    assert_eq!(h.report.rejected, 0);
}
#[test]
fn a_few_effects_that_start_with_lines_do_not_unseat_the_voice() {
    // Live AdvHD: a stereo effect group of two clips, both starting with lines (a door, a chime),
    // scored 0.93 against the voice's 1.00 and, as a "competitor", left no group trusted.
    let f = Fixture::new();
    let mut h = f.hooked();
    let mut matched = 0;
    for i in 1..=6u64 {
        let ts = i as f64 * 7000.;
        f.clip(i, ts - 330., None, 4.);
        if i == 4 || i == 5 {
            let name = format!("clips/fx{i}.wav");
            crate::wav::write(&f.0.join(&name), &vec![0.1; 16000], 16000).unwrap();
            f.event(json!({"ev":"clip","seq":100+i,"s":100+i,"api":"dsound","start":ts-330.,"t":ts+3670.,"dur":4.0,"file":name,"fmt":"16000Hz 2ch PCM16"}));
        }
        h.line(line(&i.to_string(), ts));
        let got = h.tick(ts + 5000.);
        assert!(
            got.iter().all(|m| m.line.uid == m.clip.seq.to_string()),
            "{:?}",
            got.iter().map(|m| m.clip.seq).collect::<Vec<_>>()
        );
        matched += got.len();
    }
    assert_eq!(matched, 6, "groups: {:?}", h.report.groups);
    assert!(h.established());
}
#[test]
fn a_remembered_voice_stream_is_trusted_from_its_first_clip() {
    // Live Siglus/AdvHD: until three clips had come with lines in a session, no stream was
    // trusted, and the first voiced lines after every restart went to the system recording.
    let f = Fixture::new();
    let mut h = f.hooked();
    f.clip(1, 6670., None, 4.);
    h.line(line("1", 7000.));
    assert!(h.tick(12_000.).is_empty(), "one unnamed clip is not enough on its own");
    let mut h = f.hooked();
    h.remembered = Some(
        HookClip {
            seq: 0,
            stream: 0,
            api: "dsound".into(),
            start: 0.,
            dur: 0.,
            file: None,
            source: None,
            fmt: Some("16000Hz 1ch PCM16".into()),
            looping: false,
            channel: None,
        }
        .group(),
    );
    h.line(line("1", 7000.));
    let matched = h.tick(12_000.);
    assert_eq!(matched.len(), 1);
    assert!(h.established());
}
#[test]
fn a_short_sound_that_ends_first_does_not_take_a_longer_voice_starting_with_it() {
    // Live SiglusEngine: a 0.25 s sound and the 1.02 s voice of a short reply started 5 ms apart;
    // the short one ended first and was taken while the voice was still playing.
    let f = Fixture::new();
    let mut h = f.hooked();
    for i in 1..=3u64 {
        let ts = i as f64 * 7000.;
        f.clip(i, ts - 330., None, 4.);
        h.line(line(&i.to_string(), ts));
        h.tick(ts + 5000.);
    }
    assert!(h.established());
    let ts = 30_000.;
    h.line(line("dayone", ts));
    // Both are DirectSound buffers in the voice's format; the voice is still being played.
    f.event(json!({"ev":"stream","s":11,"api":"dsound","fmt":"16000Hz 1ch PCM16","t":ts-430.}));
    f.event(json!({"ev":"data","s":11,"t":ts-421.}));
    f.clip(10, ts - 426., None, 0.25);
    assert!(h.tick(ts + 200.).is_empty(), "waits for the sound still playing");
    let name = "clips/11.wav";
    crate::wav::write(&f.0.join(name), &vec![0.2; 16000], 16000).unwrap();
    f.event(json!({"ev":"clip","seq":11,"s":11,"api":"dsound","start":ts-421.,"t":ts+600.,"dur":1.02,"file":name,"fmt":"16000Hz 1ch PCM16"}));
    let matched = h.tick(ts + 900.);
    assert_eq!(matched.iter().map(|m| m.clip.seq).collect::<Vec<_>>(), vec![11]);
}
fn text_line(id: &str, text: &str, ts: f64) -> Line {
    Line { uid: id.into(), text: text.into(), ts, appeared: None, ocr: false, scan: None }
}
#[test]
fn typed_rows_get_their_voice_and_a_quotes_rows_share_it() {
    // Live KiriKiri: each row is handed over once typed, ~150 ms a character after
    // its voice started, so a voice began ~1.5 s before its quote's first row arrived and ~0.5 s
    // after the narration row before it; the quote's next row carries on the same voice.
    let f = Fixture::new();
    let mut h = f.hooked();
    let mut out = Vec::new();
    for i in 0..7u64 {
        let t = 10_000. + i as f64 * 12_000.;
        h.line(text_line(&format!("n{i}"), "彼女は静かに頷くと、窓の外へ目を向けた。", t));
        let quote = "「ここで待っていて、";
        h.line(text_line(&format!("q{i}"), quote, t + 2000.));
        f.clip(i + 1, t + 2000. - 150. * quote.chars().count() as f64, None, 4.);
        h.line(text_line(&format!("c{i}"), "きっとすぐに戻ってくるから待ってて」", t + 3800.));
        out.extend(h.tick(t + 7000.));
    }
    out.extend(h.tick(100_000.));
    out.extend(h.tick(100_100.));
    let mut got: Vec<(String, u64)> = out.iter().map(|m| (m.line.uid.clone(), m.clip.seq)).collect();
    got.sort();
    let mut want: Vec<(String, u64)> =
        (0..7u64).flat_map(|i| [(format!("q{i}"), i + 1), (format!("c{i}"), i + 1)]).collect();
    want.sort();
    assert_eq!(got, want, "typing {} ms/char", h.report.typing_ms);
    assert!(h.report.typing_ms >= 120. && h.report.typing_ms <= 200., "typing {}", h.report.typing_ms);
}
#[test]
fn whole_line_engines_learn_no_typing_delay() {
    // AdvHD/SiglusEngine hand over whole lines ~330 ms after their voice starts, whatever their length.
    let f = Fixture::new();
    let mut h = f.hooked();
    let texts =
        ["短い", "「これは少し長めの台詞になります」", "「さらにずっと長い台詞で、ひとつの行が二十文字を超えていく」"];
    for i in 0..9u64 {
        let ts = 10_000. + i as f64 * 7000.;
        h.line(text_line(&i.to_string(), texts[i as usize % 3], ts));
        f.clip(i + 1, ts - 330., None, 4.);
        h.tick(ts + 5000.);
    }
    assert_eq!(h.report.typing_ms, 0.);
    assert_eq!(h.report.matched, 9);
}
#[test]
fn a_quote_keeps_its_voice_from_the_narration_row_typed_out_after_it() {
    // Live KiriKiri: a 23-character quote arrived 541 ms after its voice
    // started and a 30-character narration row 845 ms after it; with a small typing delay the row
    // looked 87 ms closer and took the voice.
    let mut lines = vec![text_line("q", "「でも、そんなことは絶対にさせないんだから！」", 10_000. - 920.)];
    lines.push(text_line("n", "彼女は唇をきゅっと結ぶと、何も言わずに窓の外をじっと見つめた", 10_845. - 1240.));
    lines[0].appeared = Some(10_000. - 920.);
    lines[1].appeared = Some(10_845. - 1240.);
    let clip = HookClip {
        seq: 20,
        stream: 6,
        api: "dsound".into(),
        start: 10_000. - 541.,
        dur: 2.87,
        file: Some("x".into()),
        source: None,
        fmt: None,
        looping: false,
        channel: None,
    };
    let pairs = classify::pair(&lines, &[&clip], 900., 3400.);
    assert_eq!(pairs[0].map(|(i, _)| i), Some(0), "the quote takes its voice");
    assert_eq!(pairs[1], None);
}
#[test]
fn a_stream_named_as_voice_is_established_by_its_first_clip() {
    // Live Ren'Py: three voiced lines in twenty-three; narration kept system audio
    // placed by timing because three matches never came soon enough.
    let f = Fixture::new();
    let mut h = f.hooked();
    f.clip(1, 6670., Some("audio/voice/hero/01.ogg"), 2.7);
    h.line(line("1", 7000.));
    assert_eq!(h.tick(12_000.).len(), 1);
    assert!(h.established());
}
#[test]
fn a_remembered_game_is_established_before_its_first_voice() {
    let f = Fixture::new();
    f.event(json!({"ev":"start","exe":"C:/Games/X/game.exe","t":1000.}));
    let mut h = f.hooked();
    assert!(!h.established());
    h.remembered = Some("renpy | ogg | audio/voice/hero".into());
    h.line(line("narration", 7000.));
    h.tick(8000.);
    assert!(h.established());
    assert_eq!(h.exe(), Some("C:/Games/X/game.exe"));
}
#[test]
fn a_line_waits_for_a_whole_voice_file_still_playing() {
    // Live Unity: each voice is handed over whole as it starts (an AudioClip), and
    // released once it has played; the line stopped waiting 1.9 s in, and went to system audio.
    let f = Fixture::new();
    let name = "clips/1.wav";
    crate::wav::write(&f.0.join(name), &vec![0.2; 16000], 16000).unwrap();
    f.event(json!({"ev":"clip","seq":1,"s":1,"api":"unity","start":1000.,"t":1000.,"dur":6.3,"file":name,"source":"Sound/Voice/ch01_004.ogg","fmt":"float32 1ch 48000Hz"}));
    let mut h = f.hooked();
    h.line(line("a", 1010.));
    assert!(h.tick(1100.).is_empty());
    assert!(h.waiting("a", 4000.), "still playing");
    assert!(h.tick(4000.).is_empty());
    let matched = h.tick(7500.);
    assert_eq!(matched.len(), 1);
    assert!(!h.waiting("a", 7600.));
    assert!(h.established());
}
#[test]
fn a_voice_and_an_effect_starting_together_go_by_the_lines_length() {
    // Artemis: the line's voice (2.7 s) and an effect (1.3 s) in the voice's own format, started
    // in the same instant.
    let f = Fixture::new();
    f.clip(1, 1000., Some("voice/a"), 1.3);
    f.clip(2, 1005., Some("voice/b"), 2.7);
    let mut h = f.hooked();
    let mut l = line("a", 1300.);
    l.text = "魔法使いの少女「後ろにもゴブリンが……きゃっ！」".into();
    h.line(l);
    let matched = h.tick(4500.);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].clip.seq, 2);
}
