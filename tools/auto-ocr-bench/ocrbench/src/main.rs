// OCR cost benchmark: where an observation's time goes, and what downscaling / detector size /
// thread count do to speed and accuracy. Usage:
//   ocrbench <engine ppocr|meiki> <image.png> <truth.txt> [variants...]
// variant syntax: s=<scale>,d=<det max side>,t=<threads>   e.g. s=0.5,d=640,t=4
use image::{imageops::FilterType, RgbImage};
use std::time::Instant;

fn lev(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + (ca != cb) as usize).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

fn norm(s: &str) -> Vec<char> {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Box (area-average) downscale by an arbitrary factor, as sources.rs does.
fn downscale(src: &RgbImage, scale: f64) -> RgbImage {
    if scale >= 0.999 {
        return src.clone();
    }
    let (w, h) = ((src.width() as f64 * scale).round() as u32, (src.height() as f64 * scale).round() as u32);
    image::imageops::resize(src, w, h, FilterType::Triangle)
}

struct Variant {
    crop: Option<[u32; 4]>,
    scale: f64,
    det: u32,
    threads: Option<usize>,
}

fn parse(v: &str) -> Variant {
    let mut out = Variant { crop: None, scale: 1.0, det: 960, threads: None };
    for part in v.split(',') {
        let (k, val) = part.split_once('=').unwrap();
        match k {
            "s" => out.scale = val.parse().unwrap(),
            "d" => out.det = val.parse().unwrap(),
            "t" => out.threads = Some(val.parse().unwrap()),
            "c" => { let v: Vec<u32> = val.split(":").map(|x| x.parse().unwrap()).collect(); out.crop = Some([v[0], v[1], v[2], v[3]]); }
            _ => panic!("{k}"),
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let engine = args[1].as_str();
    let source = image::open(&args[2]).unwrap().to_rgb8();
    let truth_text = std::fs::read_to_string(&args[3]).unwrap();
    let truth: Vec<Vec<char>> = truth_text.lines().map(norm).filter(|l| !l.is_empty()).collect();
    let variants: Vec<Variant> = args[4..].iter().map(|v| parse(v)).collect();
    let runs: usize = std::env::var("RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(7);
    let lib = std::env::var("ORT_DYLIB_PATH").unwrap();
    ort::init_from(lib).commit().unwrap();
    let models = std::env::var("MODELS").unwrap();
    println!("{engine} {}x{} runs={runs}", source.width(), source.height());

    // Cost of the pixel plumbing alone at this size: RGBA -> RGB as text_observer does.
    let rgba = image::DynamicImage::ImageRgb8(source.clone()).to_rgba8();
    let t = Instant::now();
    for _ in 0..5 {
        let raw = rgba.as_raw();
        let mut out = Vec::with_capacity(raw.len() / 4 * 3);
        for px in raw.chunks_exact(4) {
            out.extend_from_slice(&px[..3]);
        }
        std::hint::black_box(out);
    }
    println!("rgba->rgb: {:.1} ms", t.elapsed().as_secs_f64() * 1000.0 / 5.0);

    for v in variants {
        let t = Instant::now();
        let cropped = match v.crop { Some([x, y, w, h]) => image::imageops::crop_imm(&source, x, y, w, h).to_image(), None => source.clone() };
        let image = downscale(&cropped, v.scale);
        let resize_ms = t.elapsed().as_secs_f64() * 1000.0;
        let (mut det_ms, mut total_ms) = (Vec::new(), Vec::new());
        let mut text = Vec::new();
        let mut backend = String::new();
        match engine {
            "ppocr" => {
                let config = ppocr::Config { intra_threads: v.threads, detection_max_side: v.det, ..Default::default() };
                let mut e = ppocr::PpOcr::with_config(ppocr::ModelPaths::from_dir(&models, ppocr::Tier::Small), config).unwrap();
                backend = format!("{:?}", e.backend_info().selected);
                let o = ppocr::OcrOptions::default();
                e.ocr(&image, o).unwrap();
                for _ in 0..runs {
                    let t = Instant::now();
                    e.detect(&image, o).unwrap();
                    det_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                    let t = Instant::now();
                    let mut lines = e.ocr(&image, o).unwrap();
                    total_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                    ppocr::japanese::fix_lines(&mut lines);
                    text = lines.into_iter().map(|l| l.text).collect();
                }
            }
            "meiki" => {
                let config = meikiocr::Config { intra_threads: v.threads, ..Default::default() };
                let mut e = meikiocr::MeikiOcr::with_config(meikiocr::ModelPaths::from_dir(&models), config).unwrap();
                backend = format!("{:?}", e.backend_info().selected);
                let o = meikiocr::OcrOptions::default();
                e.ocr(&image, o).unwrap();
                for _ in 0..runs {
                    let t = Instant::now();
                    e.detect(&image, o.detection_threshold).unwrap();
                    det_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                    let t = Instant::now();
                    let lines = e.ocr(&image, o).unwrap();
                    total_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                    text = lines.into_iter().map(|l| l.text).collect();
                }
            }
            _ => panic!("engine"),
        }
        // Accuracy: for each truth line, the best-matching read line's character error rate.
        let read: Vec<Vec<char>> = text.iter().map(|t| norm(t)).collect();
        let (mut errors, mut chars) = (0usize, 0usize);
        for want in &truth {
            let best = read.iter().map(|got| lev(want, got)).min().unwrap_or(want.len());
            errors += best;
            chars += want.len();
        }
        let det = median(det_ms);
        let total = median(total_ms);
        println!(
            "s={:.2} {}x{} d={} t={:?} [{backend}] resize {:.0} ms | det {:.0} ms, rec {:.0} ms, total {:.0} ms | CER {:.1}% ({errors}/{chars}) | {}",
            v.scale, image.width(), image.height(), v.det, v.threads, resize_ms, det, (total - det).max(0.0), total,
            100.0 * errors as f64 / chars.max(1) as f64, text.join(" / ")
        );
    }
}
