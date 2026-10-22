//! Gaming Mode check: list Gamescope's sources and save a thumbnail of each as PNG.
//!
//!   cargo run --example gamescope_sources -- <output-dir>
#[cfg(target_os = "linux")]
fn main() {
    use kimochi_capture::{CaptureBackend, CaptureRequest, GamescopeCapture};
    let dir = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    println!("gamescope node available: {}", kimochi_capture::linux_gamescope::available());
    let mut backend = GamescopeCapture::new();
    let sources = backend.enumerate().expect("enumerate");
    for source in &sources {
        println!("{} {:?} app={:?} bounds={:?}", source.id, source.name, source.app, source.bounds);
    }
    for round in 0..2 {
        for source in &sources {
            let start = std::time::Instant::now();
            let result = if round == 0 {
                backend.thumbnail(&source.id, 640)
            } else {
                backend.capture(&CaptureRequest { source_id: source.id.clone(), crop: None })
            };
            match result {
                Ok(frame) => {
                    let name = source.id.replace(':', "_");
                    let path = dir.join(format!("{name}-{round}.png"));
                    std::fs::write(&path, frame.png().unwrap()).unwrap();
                    println!("round {round} {}: {}x{} scale {:.2} in {:.0} ms -> {}", source.id, frame.info.width, frame.info.height, frame.info.scale_factor, start.elapsed().as_secs_f64() * 1000., path.display());
                }
                Err(e) => println!("round {round} {}: {} ({}) after {:.0} ms", source.id, e.message, e.code, start.elapsed().as_secs_f64() * 1000.),
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("Gamescope capture is Linux-only");
}
