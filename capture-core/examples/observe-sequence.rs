//! Local-only diagnostic: observe one explicitly selected window. Never saves or
//! uploads pixels/text. Run with a source id, or no argument for generated glyphs.
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This native observer probe requires macOS");
}

#[cfg(target_os = "macos")]
fn main() {
    let mtm = objc2::MainThreadMarker::new().expect("main thread");
    let _app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    use kimochi_capture::text::fixture::{japanese_frame, Placement};
    use kimochi_capture::{platform_backend, platform_observer, CaptureRequest};
    use std::{
        collections::hash_map::DefaultHasher,
        hash::{Hash, Hasher},
        sync::mpsc,
        time::{Duration, Instant},
    };
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
        fn CFRunLoopRunInMode(mode: *const std::ffi::c_void, seconds: f64, once: u8) -> i32;
    }
    let optimized = std::env::args().any(|arg| arg == "--optimized");
    let source = std::env::args().nth(1).filter(|arg| arg != "--optimized");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut backend = platform_backend().expect("capture backend");
        let mut observer = if optimized {
            Box::new(kimochi_capture::text::CachedObserver::new(
                platform_observer(),
            )) as Box<dyn kimochi_capture::TextObserver>
        } else {
            platform_observer()
        };
        let mut previous_pixels = 0;
        let mut previous_text = String::new();
        println!("sample,capture_ms,observe_ms,encode_ms,total_ms,same_pixels,same_text,characters,lines");
        for i in 0..16 {
            let started = Instant::now();
            let frame = match &source {
                Some(id) => match backend.capture(&CaptureRequest {
                    source_id: id.clone(),
                    crop: None,
                }) {
                    Ok(frame) => frame,
                    Err(e) => {
                        eprintln!("capture unavailable: {}", e.code);
                        break;
                    }
                },
                None => japanese_frame(
                    1000,
                    600,
                    if i < 8 {
                        &[(
                            "今日は寒いですね",
                            Placement {
                                x: 60.0,
                                top: 120.0,
                                size: 42.0,
                            },
                        )]
                    } else {
                        &[]
                    },
                ),
            };
            let mut hash = DefaultHasher::new();
            frame.pixels.hash(&mut hash);
            let pixels = hash.finish();
            if !optimized {
                let _ =
                    kimochi_capture::dhash_rgba(&frame.pixels, frame.info.width, frame.info.height);
            }
            let read = match observer.observe(&frame, Duration::from_secs(5)) {
                Ok(read) => read,
                Err(e) => {
                    eprintln!("observer unavailable: {}", e.code);
                    break;
                }
            };
            let encoding = Instant::now();
            if !optimized {
                let _png = frame.png().expect("encode");
            }
            println!(
                "{i},{:.1},{:.1},{:.1},{:.1},{},{},{},{}",
                frame.info.total_ms,
                read.duration_ms,
                encoding.elapsed().as_secs_f64() * 1000.0,
                started.elapsed().as_secs_f64() * 1000.0,
                i > 0 && pixels == previous_pixels,
                i > 0 && read.text == previous_text,
                read.text.chars().count(),
                read.lines.len()
            );
            previous_pixels = pixels;
            previous_text = read.text;
            std::thread::sleep(Duration::from_millis(250));
        }
        observer.close();
        let _ = tx.send(());
    });
    let deadline = Instant::now() + Duration::from_secs(100);
    while rx.try_recv().is_err() {
        assert!(Instant::now() < deadline, "probe timed out");
        // SAFETY: run this process's main loop for native completion delivery.
        unsafe {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, 1);
        }
    }
}
