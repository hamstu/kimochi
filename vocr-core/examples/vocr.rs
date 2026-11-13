//! `vocr_onnx.py`'s command line, for parity checks against the Python reference and timing:
//!
//!     ORT_DYLIB_PATH=…/libonnxruntime.dylib cargo run --release --example vocr -- \
//!         --models DIR [--tier L] [--mode exact|fast] [--lm] [--capture] [--repeat N] IMAGE...
//!
//! One JSON line per image, the reference's fields; `--capture` reads through `read_capture` (scaled
//! to fit 1280 x 720) instead of the reference's whole-frame read. `--repeat N` times N reads after
//! a warm-up and prints the median to stderr.
use kimochi_vocr::{Config, Grey, ModelPaths, Vocr};
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut models, mut tier, mut mode, mut lm, mut capture, mut repeat, mut images) =
        (String::new(), "L".to_string(), "exact".to_string(), false, false, 0usize, Vec::new());
    while let Some(a) = args.next() {
        match a.as_str() {
            "--models" => models = args.next().unwrap(),
            "--tier" => tier = args.next().unwrap(),
            "--mode" => mode = args.next().unwrap(),
            "--lm" => lm = true,
            "--capture" => capture = true,
            "--repeat" => repeat = args.next().unwrap().parse().unwrap(),
            _ => images.push(a),
        }
    }
    let started = Instant::now();
    let mut vocr = Vocr::load(&ModelPaths::from_dir(&models, &tier, &mode, lm), Config::default()).unwrap();
    eprintln!("load {:.1} ms", started.elapsed().as_secs_f64() * 1e3);
    let classes = vocr.spotter.classes.clone();
    for path in images {
        let rgb = image::open(&path).unwrap().to_rgb8();
        let (w, h) = (rgb.width() as usize, rgb.height() as usize);
        let read = |vocr: &mut Vocr| {
            let grey = Grey::from_interleaved(rgb.as_raw(), w, h, w * 3, 3);
            if capture { vocr.read_capture(&grey) } else { vocr.read_frame(&grey, None, None) }.unwrap()
        };
        let lines = read(&mut vocr);
        if repeat > 0 {
            let mut times: Vec<f64> = (0..repeat)
                .map(|_| {
                    let t = Instant::now();
                    read(&mut vocr);
                    t.elapsed().as_secs_f64() * 1e3
                })
                .collect();
            times.sort_by(f64::total_cmp);
            eprintln!(
                "{path}: {w}x{h} median {:.2} ms (min {:.2}, {} lines)",
                times[repeat / 2],
                times[0],
                lines.len()
            );
        }
        let out: Vec<_> = lines
            .iter()
            .map(|ln| {
                serde_json::json!({
                    "text": ln.text, "greedy": ln.greedy,
                    "box": [ln.bbox.0, ln.bbox.1, ln.bbox.2, ln.bbox.3],
                    "tag": classes[ln.tag], "dark": ln.dark as i64,
                    "conf_min": (ln.conf_min as f64 * 1e4).round() / 1e4,
                    "chars": ln.text_chars.iter().map(|c| serde_json::json!([c.text, c.f0,
                        (c.x0 as f64 * 100.0).round_ties_even() / 100.0, (c.x1 as f64 * 100.0).round_ties_even() / 100.0])).collect::<Vec<_>>(),
                })
            })
            .collect();
        println!("{}", serde_json::json!({"image": path, "lines": out}));
    }
}
