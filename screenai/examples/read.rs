//! Read PNGs through the worker and print the lines and timings.
//!
//! cargo build --release --features worker
//! cargo run --release --example read -- target/release/kimochi-screenai-worker <component dir> a.png b.png …
//!
//! `SCREENAI_RUNS=n` repeats each image (the first read of a size warms the library up);
//! `SCREENAI_LIGHT=1` uses the light model.
use kimochi_screenai::{client::Worker, proto, wire};
use std::{path::PathBuf, time::{Duration, Instant}};

fn main() {
    let mut args = std::env::args_os().skip(1).map(PathBuf::from);
    let worker = args.next().expect("worker path");
    let dir = args.next().expect("component directory");
    let runs: usize = std::env::var("SCREENAI_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    let flags = if std::env::var_os("SCREENAI_LIGHT").is_some() { wire::FLAG_LIGHT } else { 0 };
    let started = Instant::now();
    let mut worker = Worker::start(&worker, &dir, Duration::from_secs(60), |_| {}).expect("start");
    println!("ready in {:?}: {:?}", started.elapsed(), worker.ready);
    for path in args {
        let image = image::open(&path).expect("png").to_rgba8();
        let (w, h) = image.dimensions();
        let request = wire::Request { width: w, height: h, flags };
        let mut times = Vec::new();
        let mut lines = Vec::new();
        for _ in 0..runs {
            let t = Instant::now();
            let bytes = worker
                .recognize(request, image.as_raw().chunks_exact(w as usize * 4), Duration::from_secs(30))
                .expect("recognize");
            lines = proto::decode(&bytes).expect("decode");
            times.push(t.elapsed().as_secs_f64() * 1000.);
        }
        println!("\n{} ({w}×{h}) ms: {:?}", path.display(), times.iter().map(|t| t.round()).collect::<Vec<_>>());
        for line in &lines {
            let b = line.bounding_box;
            println!(
                "  [{:?} block {} conf {:.2} box {},{} {}×{} ∠{}] {:?}  words={} symbols={}",
                line.direction, line.block_id, line.confidence, b.x, b.y, b.width, b.height, b.angle, line.text,
                line.words.len(), line.words.iter().map(|w| w.symbols.len()).sum::<usize>()
            );
        }
    }
}
