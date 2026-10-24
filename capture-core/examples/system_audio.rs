//! System-audio probe: records what the computer plays for a few seconds and reports when the
//! loud parts happened, in wall-clock time, so the ring's timestamps can be checked against a
//! sound played at a known moment (in another terminal, or `KIMOCHI_PLAY`: a sound file played
//! quietly with afplay, pw-play or PowerShell's SoundPlayer, by OS).
//!
//! Also prints what is recorded and whether Kimochi's own sounds would be left out.
//!
//! Reports levels and timings only. `KIMOCHI_WAV=path` also writes what was recorded, for
//! listening to.
//!
//! Usage:
//!   cargo run --manifest-path capture-core/Cargo.toml --example system_audio
//!   KIMOCHI_SECONDS=8 KIMOCHI_PLAY=/System/Library/Sounds/Glass.aiff KIMOCHI_WAV=/tmp/a.wav ...
//!
//! On Windows the probe's own children (`KIMOCHI_PLAY`) are left out, as Kimochi's are: play the
//! sound from another terminal. `KIMOCHI_AUDIO_ENDPOINT_LOOPBACK=1` tries the fallback that records
//! the default output device instead.

use kimochi_capture::audio::{now_ms, AudioRing, SystemAudio};
use std::time::Duration;

fn main() {
    let seconds: f64 = std::env::var("KIMOCHI_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let mut capture = match SystemAudio::start() {
        Ok(capture) => capture,
        Err(e) => {
            eprintln!("start failed: {} ({})", e.message, e.code);
            std::process::exit(1);
        }
    };
    println!("recording: {} (own audio excluded: {})", capture.source(), capture.excludes_own_audio());
    let started = now_ms();
    println!("capture began at Unix ms {started:.0}");
    let mut ring = AudioRing::new(48_000, seconds + 1.0);
    let mut played_at = None;
    while now_ms() - started < seconds * 1000.0 {
        std::thread::sleep(Duration::from_millis(50));
        capture.drain_into(&mut ring);
        if played_at.is_none() && now_ms() - started > 1000.0 {
            if let Ok(path) = std::env::var("KIMOCHI_PLAY") {
                played_at = Some(now_ms());
                play(&path);
            }
        }
        if let Some(why) = capture.ended() {
            eprintln!("stream ended: {why}");
            break;
        }
    }
    capture.drain_into(&mut ring);
    let (Some(start), Some(end)) = (ring.start_ms(), ring.end_ms()) else {
        println!("no audio arrived");
        return;
    };
    println!(
        "held {:.0}ms at {} Hz (ring starts {:.0}ms after capture began, ends {:.0}ms before now), {} chunks dropped",
        end - start,
        ring.sample_rate(),
        start - started,
        now_ms() - end,
        capture.dropped_chunks()
    );
    // Equal when the stamps agree with the audio clock; a large difference is stamp jitter.
    println!(
        "samples held: {:.0}ms of audio for {:.0}ms of wall clock",
        ring.len() as f64 * 1000.0 / ring.sample_rate() as f64,
        end - start
    );
    let clip = ring.snapshot(start, end).unwrap();
    let window = (clip.sample_rate / 10) as usize;
    let mut first_loud = None;
    for (i, part) in clip.samples.chunks(window).enumerate() {
        let rms = (part.iter().map(|s| s * s).sum::<f32>() / part.len() as f32).sqrt();
        let at = clip.start_ms + i as f64 * 100.0 - started;
        if rms > 0.01 && first_loud.is_none() {
            first_loud = Some(clip.start_ms + i as f64 * 100.0);
        }
        println!("{at:>7.0}ms  rms {rms:.4} {}", "#".repeat((rms * 200.0).min(60.0) as usize));
    }
    if let (Some(played), Some(loud)) = (played_at, first_loud) {
        println!("the sound started at {:.0}ms; first loud 100ms window at {:.0}ms (offset {:+.0}ms)", played - started, loud - started, loud - played);
    }
    if let Ok(path) = std::env::var("KIMOCHI_WAV") {
        write_wav(&path, clip.sample_rate, &clip.samples);
        println!("wrote {path}");
    }
}

/// Play a sound file quietly, without waiting for it.
fn play(path: &str) {
    let mut command = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("afplay");
        c.args(["-v", "0.3", path]);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-Command", &format!("(New-Object Media.SoundPlayer '{path}').PlaySync()")]);
        c
    } else {
        let mut c = std::process::Command::new("pw-play");
        c.args(["--volume", "0.3", path]);
        c
    };
    if let Err(e) = command.spawn() {
        eprintln!("could not play {path}: {e}");
    }
}

fn write_wav(path: &str, rate: u32, samples: &[f32]) {
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    let data = (samples.len() * 2) as u32;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, out).expect("write wav");
}
