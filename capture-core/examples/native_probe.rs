//! Drive native Wayland capture (`linux_native`) without the app.
//!
//! ```text
//! cargo run --example native_probe -- list                      # driver, outputs, windows
//! cargo run --example native_probe -- capture <id|title> out.png
//! cargo run --example native_probe -- bench <id|title> [seconds]  # repeated captures, timings
//! cargo run --example native_probe -- thumbs                    # a thumbnail of every source
//! cargo run --example native_probe -- activate <id|title>
//! ```
//!
//! `KIMOCHI_WAYLAND_CAPTURE=mutter|kwin|ext` forces a driver. A `<title>` picks the first source
//! whose name contains it.
#[cfg(target_os = "linux")]
fn main() {
    use kimochi_capture::linux_native::{self, NativeCapture};
    use kimochi_capture::{CaptureBackend, CaptureRequest};
    use std::time::{Duration, Instant};

    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("list");
    let name = linux_native::init();
    for (driver, result) in linux_native::report() {
        match result {
            Ok(()) => eprintln!("driver {driver}: ok"),
            Err(e) => eprintln!("driver {driver}: {e}"),
        }
    }
    let Some(mut capture) = NativeCapture::new() else {
        eprintln!("no native driver ({name:?})");
        std::process::exit(2);
    };
    let sources = capture.enumerate().unwrap_or_else(|e| {
        eprintln!("enumerate: {} ({})", e.message, e.code);
        std::process::exit(1)
    });
    let find = |needle: &str| {
        sources
            .iter()
            .find(|s| s.id == needle)
            .or_else(|| sources.iter().find(|s| s.name.contains(needle)))
            .map(|s| s.id.clone())
            .unwrap_or_else(|| needle.to_string())
    };
    let save = |frame: &kimochi_capture::Frame, path: &str| {
        std::fs::write(path, frame.png().expect("png")).expect("write");
    };
    match command {
        "list" => {
            let inv = linux_native::inventory().unwrap_or_default();
            println!("{}", serde_json::to_string_pretty(&inv).unwrap());
            for s in &sources {
                println!("{:<40} {:<8} {:?} app={:?} bounds={:?} on_screen={:?}", s.id, s.kind, s.name, s.app, s.bounds, s.on_screen);
            }
        }
        "capture" => {
            let id = find(args.get(1).expect("source"));
            let out = args.get(2).map(String::as_str).unwrap_or("capture.png");
            let started = Instant::now();
            match capture.capture(&CaptureRequest { source_id: id.clone(), crop: None }) {
                Ok(frame) => {
                    println!("{id}: {}x{} scale={} bounds={:?} total={:.1}ms (first, includes stream start {:.0}ms)", frame.info.width, frame.info.height, frame.info.scale_factor, frame.info.source_bounds, frame.info.total_ms, started.elapsed().as_secs_f64() * 1e3);
                    save(&frame, out);
                    let again = capture.capture(&CaptureRequest { source_id: id.clone(), crop: None }).expect("second capture");
                    println!("second capture: {:.1}ms", again.info.total_ms);
                }
                Err(e) => {
                    eprintln!("capture {id}: {} ({})", e.message, e.code);
                    std::process::exit(1);
                }
            }
        }
        "bench" => {
            let id = find(args.get(1).expect("source"));
            let seconds: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
            let until = Instant::now() + Duration::from_secs(seconds);
            let mut times = Vec::new();
            while Instant::now() < until {
                match capture.capture(&CaptureRequest { source_id: id.clone(), crop: None }) {
                    Ok(frame) => times.push(frame.info.total_ms),
                    Err(e) => eprintln!("{} ({})", e.message, e.code),
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            times.sort_by(f64::total_cmp);
            if !times.is_empty() {
                println!("{} captures: median {:.1}ms, p95 {:.1}ms, max {:.1}ms", times.len(), times[times.len() / 2], times[times.len() * 95 / 100], times[times.len() - 1]);
            }
        }
        "thumbs" => {
            for s in &sources {
                let started = Instant::now();
                match capture.thumbnail(&s.id, 320) {
                    Ok(frame) => {
                        let path = format!("thumb-{}.png", s.id.replace(':', "_"));
                        save(&frame, &path);
                        println!("{:<40} {}x{} {:.0}ms → {path}", s.id, frame.info.width, frame.info.height, started.elapsed().as_secs_f64() * 1e3);
                    }
                    Err(e) => println!("{:<40} {} ({})", s.id, e.message, e.code),
                }
            }
        }
        "activate" => {
            let id = find(args.get(1).expect("source"));
            let handle = linux_native::window_handle(&id).expect("a window source");
            match linux_native::activate(&handle) {
                Ok(()) => println!("activated {id}"),
                Err(e) => eprintln!("{} ({})", e.message, e.code),
            }
        }
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {}
