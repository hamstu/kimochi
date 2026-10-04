//! Read-only capture audit: is the screenshot route returning fresh pixels?
//!
//! Answers one question the preview cannot: when the same source is captured
//! repeatedly, does the content actually change, and if it does not, is that
//! because the screen is still or because the frame is stale?
//!
//! Reports timings and statistics only — never text, never pixels, never an
//! image. The per-frame digest is a hash, which distinguishes frames without
//! disclosing anything about them.
//!
//! Nothing here launches or restarts an application, changes the selected source
//! or touches the network. It captures the source it is told to and stops.
//!
//! Usage:
//!   KIMOCHI_SOURCE=macos:display:3 cargo run -p kimochi-capture --example capture_audit
//!   KIMOCHI_FRAMES=40 KIMOCHI_INTERVAL_MS=250 ... (defaults 24 and 250)

use kimochi_capture::{platform_backend, CaptureRequest, Crop};
use std::time::{Duration, Instant};

/// FNV-1a over the whole buffer. Identifies a frame; discloses nothing about it.
fn digest(pixels: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in pixels {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

struct Stats {
    black_fraction: f64,
    opaque_fraction: f64,
    luma_min: f64,
    luma_mean: f64,
    luma_max: f64,
    sampled: usize,
}

/// Sampled on a stride so a 4K frame costs microseconds, not milliseconds.
fn stats(pixels: &[u8], stride_pixels: usize) -> Stats {
    let mut black = 0usize;
    let mut opaque = 0usize;
    let mut n = 0usize;
    let mut min = f64::MAX;
    let mut max = f64::MIN;
    let mut total = 0.0f64;
    let step = stride_pixels.max(1) * 4;
    let mut i = 0;
    while i + 3 < pixels.len() {
        let (r, g, b, a) = (pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
        if r == 0 && g == 0 && b == 0 {
            black += 1;
        }
        if a == 255 {
            opaque += 1;
        }
        let luma = f64::from(r) * 0.299 + f64::from(g) * 0.587 + f64::from(b) * 0.114;
        min = min.min(luma);
        max = max.max(luma);
        total += luma;
        n += 1;
        i += step;
    }
    Stats {
        black_fraction: black as f64 / n.max(1) as f64,
        opaque_fraction: opaque as f64 / n.max(1) as f64,
        luma_min: if n == 0 { 0.0 } else { min },
        luma_mean: total / n.max(1) as f64,
        luma_max: if n == 0 { 0.0 } else { max },
        sampled: n,
    }
}

/// What changed between two frames, as shape and magnitude only.
///
/// Counts, a bounding box and delta sizes — never a pixel value, never an image.
/// This is what separates "a small thing blinked" from "every pixel moved by one",
/// which are the same digest change and completely different causes.
struct Diff {
    changed: usize,
    total: usize,
    box_x: (u32, u32),
    box_y: (u32, u32),
    max_delta: u8,
    mean_delta: f64,
}

fn diff(previous: &[u8], current: &[u8], width: u32) -> Option<Diff> {
    if previous.len() != current.len() || width == 0 {
        return None;
    }
    let total = current.len() / 4;
    let mut changed = 0usize;
    let (mut x0, mut x1, mut y0, mut y1) = (u32::MAX, 0u32, u32::MAX, 0u32);
    let mut max_delta = 0u8;
    let mut sum_delta = 0f64;
    for index in 0..total {
        let i = index * 4;
        let mut worst = 0u8;
        for channel in 0..4 {
            worst = worst.max(previous[i + channel].abs_diff(current[i + channel]));
        }
        if worst == 0 {
            continue;
        }
        changed += 1;
        max_delta = max_delta.max(worst);
        sum_delta += f64::from(worst);
        let x = (index as u32) % width;
        let y = (index as u32) / width;
        x0 = x0.min(x);
        x1 = x1.max(x);
        y0 = y0.min(y);
        y1 = y1.max(y);
    }
    if changed == 0 {
        return None;
    }
    Some(Diff {
        changed,
        total,
        box_x: (x0, x1),
        box_y: (y0, y1),
        max_delta,
        mean_delta: sum_delta / changed as f64,
    })
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[index]
}

fn main() {
    // Window streams need the window server connection an app has; a bare process
    // asserts in CGS_REQUIRE_INIT without it.
    #[cfg(target_os = "macos")]
    unsafe {
        let _: *mut objc2::runtime::AnyObject =
            objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
    }
    let source = std::env::var("KIMOCHI_SOURCE").unwrap_or_default();
    let frames: usize = std::env::var("KIMOCHI_FRAMES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(24);
    let interval = Duration::from_millis(
        std::env::var("KIMOCHI_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(250),
    );
    // Bounded on purpose: a diagnostic that can run away is not a diagnostic.
    let frames = frames.clamp(1, 240);

    let mut backend = match platform_backend() {
        Ok(backend) => backend,
        Err(error) => {
            println!("backend unavailable: {} {}", error.code, error.message);
            return;
        }
    };

    println!("permission: {}", backend.permission());
    if backend.permission() != "granted" {
        // Deliberately does NOT request it: that puts a system dialog on screen,
        // and this is an audit, not an action.
        println!("no screen recording permission for this binary; nothing captured");
        return;
    }

    // Optional: list an application's window ids, so a window can be probed
    // directly. Ids and geometry only — no titles.
    let list_app = std::env::var("KIMOCHI_LIST_APP").unwrap_or_default();

    match backend.enumerate() {
        Ok(sources) => {
            let displays = sources.iter().filter(|s| s.kind == "display").count();
            let windows = sources.iter().filter(|s| s.kind == "window").count();
            println!("sources: {displays} displays, {windows} windows");
            if !list_app.is_empty() {
                for candidate in sources.iter().filter(|s| {
                    s.kind == "window"
                        && s.app.as_deref().is_some_and(|app| app.eq_ignore_ascii_case(&list_app))
                }) {
                    let bounds = candidate.bounds.map_or((0.0, 0.0), |b| (b.width, b.height));
                    println!(
                        "  window {} {}x{} on_screen={:?}",
                        candidate.id, bounds.0, bounds.1, candidate.on_screen
                    );
                }
            }
            if !source.is_empty() && !sources.iter().any(|s| s.id == source) {
                println!("requested source is NOT in the catalogue: {source}");
            }
        }
        Err(error) => println!("enumerate failed: {} {}", error.code, error.message),
    }

    if source.is_empty() {
        println!("set KIMOCHI_SOURCE to the source id to probe");
        return;
    }

    // Optional crop, as "x,y,w,h,refw,refh" — the region the app actually scans,
    // so a still game area can be told from a busy desktop around it.
    let crop = std::env::var("KIMOCHI_CROP").ok().and_then(|spec| {
        let parts: Vec<u32> = spec.split(',').filter_map(|p| p.trim().parse().ok()).collect();
        if parts.len() == 6 {
            Some(Crop {
                x: parts[0],
                y: parts[1],
                width: parts[2],
                height: parts[3],
                reference_width: parts[4],
                reference_height: parts[5],
            })
        } else {
            None
        }
    });
    if crop.is_some() {
        println!("cropped to the saved scan region");
    }

    let request = CaptureRequest {
        source_id: source.clone(),
        crop,
    };

    println!("probing {source}: {frames} frames, {interval:?} apart\n");
    println!(
        "{:>3} {:>8} {:>8} {:>8} {:>8}  {:>18} {:>6} {:>6} {:>11} {:>5}",
        "#", "resolve", "acquire", "pixels", "total", "digest", "black", "opaque", "luma", "same"
    );

    let mut digests: Vec<u64> = Vec::new();
    let mut resolve: Vec<f64> = Vec::new();
    let mut acquire: Vec<f64> = Vec::new();
    let mut pixels_ms: Vec<f64> = Vec::new();
    let mut total_ms: Vec<f64> = Vec::new();
    let mut errors = 0usize;
    let mut dimensions = (0u32, 0u32);
    let mut previous: Option<Vec<u8>> = None;
    let started = Instant::now();

    for index in 0..frames {
        if index > 0 {
            std::thread::sleep(interval);
        }
        match backend.capture(&request) {
            Ok(frame) => {
                let d = digest(&frame.pixels);
                let s = stats(&frame.pixels, 97);
                let same = digests.last().is_some_and(|previous| *previous == d);
                dimensions = (frame.info.width, frame.info.height);
                println!(
                    "{:>3} {:>8.1} {:>8.1} {:>8.1} {:>8.1}  {:>18x} {:>6.3} {:>6.3} {:>3.0}/{:>3.0}/{:<3.0} {:>5}",
                    index,
                    frame.info.resolve_ms,
                    frame.info.acquisition_ms,
                    frame.info.pixels_ms,
                    frame.info.total_ms,
                    d,
                    s.black_fraction,
                    s.opaque_fraction,
                    s.luma_min,
                    s.luma_mean,
                    s.luma_max,
                    if same { "YES" } else { "-" }
                );
                if !same {
                    if let Some(before) = previous.as_ref() {
                        if let Some(delta) = diff(before, &frame.pixels, frame.info.width) {
                            println!(
                                "      CHANGED {:>7} of {} px ({:.4}%)  box x{}..{} y{}..{} ({}x{})  delta max {} mean {:.1}",
                                delta.changed,
                                delta.total,
                                100.0 * delta.changed as f64 / delta.total as f64,
                                delta.box_x.0,
                                delta.box_x.1,
                                delta.box_y.0,
                                delta.box_y.1,
                                delta.box_x.1 - delta.box_x.0 + 1,
                                delta.box_y.1 - delta.box_y.0 + 1,
                                delta.max_delta,
                                delta.mean_delta
                            );
                        }
                    }
                }
                previous = Some(frame.pixels.clone());
                digests.push(d);
                resolve.push(frame.info.resolve_ms);
                acquire.push(frame.info.acquisition_ms);
                pixels_ms.push(frame.info.pixels_ms);
                total_ms.push(frame.info.total_ms);
                if index == 0 {
                    println!(
                        "    (frame {}x{}, {} samples per frame, stride 97px)",
                        frame.info.width, frame.info.height, s.sampled
                    );
                }
            }
            Err(error) => {
                errors += 1;
                println!("{index:>3} ERROR {} {}", error.code, error.message);
            }
        }
    }

    // --- summary ------------------------------------------------------------
    let elapsed = started.elapsed();
    let unique: std::collections::BTreeSet<u64> = digests.iter().copied().collect();
    let mut longest_run = 0usize;
    let mut run = 0usize;
    for pair in digests.windows(2) {
        if pair[0] == pair[1] {
            run += 1;
            longest_run = longest_run.max(run);
        } else {
            run = 0;
        }
    }
    let sorted = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v.clone()
    };
    let r = sorted(&mut resolve);
    let a = sorted(&mut acquire);
    let p = sorted(&mut pixels_ms);
    let t = sorted(&mut total_ms);

    println!("\n--- summary ----------------------------------------------------");
    println!("captured {} frames in {:?}, {} errors", digests.len(), elapsed, errors);
    println!("frame size {}x{}", dimensions.0, dimensions.1);
    println!(
        "distinct frames: {} of {}  |  longest identical run: {}",
        unique.len(),
        digests.len(),
        longest_run
    );
    for (name, v) in [("resolve", &r), ("acquire", &a), ("pixels", &p), ("total", &t)] {
        println!(
            "{name:>8} ms  min {:>7.1}  p50 {:>7.1}  p95 {:>7.1}  max {:>7.1}",
            percentile(v, 0.0),
            percentile(v, 0.5),
            percentile(v, 0.95),
            percentile(v, 1.0)
        );
    }
    println!(
        "\nreading: identical digests over a period the screen was CHANGING means stale frames;\n\
         identical digests over a period the screen was STILL means the route is fine and the\n\
         source simply did not move. This audit cannot tell those apart on its own — pair it\n\
         with known activity."
    );
    backend.close();
}
