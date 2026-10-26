//! A session from a screen recording with sound: the sound becomes the session's audio, and the
//! frames are read the way automatic OCR reads a game.
//!
//! ffmpeg takes the sound out and hands over `--fps` frames a second (default 5), cropped to
//! `--crop x,y,w,h` (the text box) if given. Each frame is read by this OS's quick text reader
//! (`kimochi_capture::platform_observer`: Live Text on macOS); every change of what it reads is a
//! screen reading, and once the text has read the same twice and differs from the last line
//! logged, it is logged as an OCR line, `SCAN_MS` later (the accurate scan's time).
use crate::session::{self, LineRow, Meta, ScreenRow};
use kimochi_capture::{Frame, FrameInfo, TextObserver};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

const SCAN_MS: f64 = 400.0;
const T0: f64 = 1_800_000_000_000.0;

pub fn main(args: &[String]) -> Result<(), String> {
    let positional = crate::positional(args);
    let (video, dir) = match positional.as_slice() {
        [video, dir, ..] => (Path::new(video).to_path_buf(), Path::new(dir).to_path_buf()),
        _ => return Err(crate::USAGE.into()),
    };
    let fps: f64 = crate::flag(args, "--fps").and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let crop = crate::flag(args, "--crop").map(str::to_string);
    let work = move || read(&video, &dir, fps, crop.as_deref());
    run_with_main_loop(work)
}

/// Live Text answers on the main queue: the work runs on a thread while the main thread turns
/// the run loop.
#[cfg(target_os = "macos")]
fn run_with_main_loop(work: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<(), String> {
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
        fn CFRunLoopRunInMode(mode: *const std::ffi::c_void, seconds: f64, once: u8) -> i32;
    }
    let mtm = objc2::MainThreadMarker::new().ok_or("not on the main thread")?;
    let _app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    let handle = std::thread::spawn(work);
    while !handle.is_finished() {
        // SAFETY: the run loop of the current (main) thread, in its default mode.
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, 0) };
    }
    handle.join().map_err(|_| "the reader panicked".to_string())?
}

#[cfg(not(target_os = "macos"))]
fn run_with_main_loop(work: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<(), String> {
    work()
}

fn probe(video: &Path) -> Result<(u32, u32), String> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
        .arg(video)
        .output()
        .map_err(|e| format!("ffprobe: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().split(',').map(|v| v.trim().parse::<u32>());
    match (parts.next(), parts.next()) {
        (Some(Ok(w)), Some(Ok(h))) => Ok((w, h)),
        _ => Err(format!("ffprobe could not read the video's size: {text}")),
    }
}

fn read(video: &Path, dir: &Path, fps: f64, crop: Option<&str>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let audio = crate::decode_audio(video, 48_000)?;
    kimochi_speech::wav::write(&dir.join("audio.wav"), &audio, 48_000)?;
    let (mut width, mut height) = probe(video)?;
    let mut filter = format!("fps={fps}");
    if let Some(crop) = crop {
        let v: Vec<u32> = crop.split(',').filter_map(|p| p.trim().parse().ok()).collect();
        let [x, y, w, h] = v[..] else { return Err("--crop takes x,y,w,h".into()) };
        filter.push_str(&format!(",crop={w}:{h}:{x}:{y}"));
        (width, height) = (w, h);
    }
    let mut child = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(video)
        .args(["-vf", &filter, "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut observer = kimochi_capture::platform_observer();
    let status = observer.status();
    if !status.supported {
        return Err(format!("This computer has no quick text reader for the frames: {}", status.detail));
    }
    let size = (width * height * 4) as usize;
    let mut pixels = vec![0u8; size];
    let mut screen: Vec<ScreenRow> = Vec::new();
    let mut lines: Vec<LineRow> = Vec::new();
    let (mut previous, mut logged) = (String::new(), String::new());
    let mut k = 0u64;
    while stdout.read_exact(&mut pixels).is_ok() {
        let at = T0 + k as f64 * 1000.0 / fps;
        k += 1;
        let text = observe(&mut *observer, &pixels, width, height)?;
        if screen.last().is_none_or(|r| r.text != text) {
            screen.push(ScreenRow { at, text: text.clone() });
        }
        if text == previous && !text.trim().is_empty() && text != logged {
            lines.push(LineRow {
                uid: format!("v{:03}", lines.len() + 1),
                text: text.clone(),
                ts: at + SCAN_MS,
                source: "ocr".into(),
                ..LineRow::default()
            });
            eprintln!("{:>7.2}s  {}", (at - T0) / 1000.0, text.replace('\n', " / "));
            logged = text.clone();
        }
        previous = text;
    }
    let _ = child.wait();
    let meta = Meta { audio: "audio.wav".into(), audio_start_ms: T0, notes: Some(format!("video {}", video.display())) };
    session::write(dir, &meta, &lines, &screen)?;
    println!("{} lines from {} frames, in {}", lines.len(), k, dir.display());
    Ok(())
}

fn observe(observer: &mut dyn TextObserver, pixels: &[u8], width: u32, height: u32) -> Result<String, String> {
    let frame = Frame {
        info: FrameInfo {
            source_id: "video".into(),
            width,
            height,
            stride: width as usize * 4,
            full_width: width,
            full_height: height,
            crop_pixels: [0, 0, width, height],
            scale_factor: 1.0,
            source_bounds: None,
            pixel_format: "rgba",
            color_space: "srgb",
            resolve_ms: 0.0,
            acquisition_ms: 0.0,
            pixels_ms: 0.0,
            total_ms: 0.0,
        },
        pixels: pixels.to_vec(),
    };
    match observer.observe(&frame, Duration::from_secs(5)) {
        Ok(observation) => Ok(observation.text),
        Err(e) => Err(format!("reading a frame: {}", e.message)),
    }
}
