//! VOCR6 (bee-san/vita-vn-ocr) for scans: a tiny recognizer trained on PS Vita and PSP visual-novel
//! dialogue, read through its own dialogue-line spotter (`kimochi-vocr`, `vocr-core/`).
//!
//! Runs on the ONNX Runtime MeikiOCR bundles (`meiki_ocr::onnx_runtime`), on the CPU on every
//! platform: the graphs are a few megabytes of integer arithmetic whose exactness upstream checked
//! on the CPU provider only, and a whole frame reads in about 11 ms there (Apple M5 Max) against
//! MeikiOCR's 55 ms. Only the models are downloaded, as their own engine in `model_store`. The
//! engine loads lazily on the first scan (or the availability probe when VOCR6 is selected) and is
//! kept until another engine replaces it.
use crate::engine_probe::{self, Loaded, Probe, Verified};
use crate::model_store;
use kimochi_vocr::{Config, ModelPaths, Vocr};
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::Manager;

/// The recognizer the manifest downloads (`ocr-models.json`'s `vocr` files): Large, the fewest
/// errors of the three tiers and still about 1 ms a line on a desktop CPU, in its "fast" form
/// (ONNX Runtime's float kernels, about 2.5 times faster than the bit-exact file here; upstream
/// measured the same text as the exact file on every read once the LM decodes it).
pub(crate) const TIER: &str = "L";
pub(crate) const MODE: &str = "fast";

#[derive(Default)]
pub struct VocrState(Mutex<Option<Vocr>>);

/// Drop the engine so its model files can be deleted, or its memory returned.
pub fn unload(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<VocrState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

fn load_engine(app: &tauri::AppHandle) -> Result<Vocr, String> {
    let models = model_store::models_dir(app, model_store::Engine::Vocr)?;
    crate::meiki_ocr::onnx_runtime(app)?;
    engine_probe::guarded(|| {
        // Lines without Japanese are the overlay's own setting to drop ("Drop lines"), not the engine's.
        let config = Config { japanese_only: false, ..Config::default() };
        Vocr::load(&ModelPaths::from_dir(models, TIER, MODE, true), config).map_err(|e| format!("VOCR6 models: {e}"))
    })
}

static PROBE: LazyLock<Arc<Probe>> = LazyLock::new(Default::default);

/// Whether VOCR6 can run here, for `platform_capabilities`: missing models or runtime at once,
/// otherwise a background probe that loads the sessions (and keeps them for the first scan when
/// VOCR6 is the selected engine), as `pp_ocr::availability` does.
pub fn availability(app: &tauri::AppHandle) -> (bool, Option<String>) {
    if let Err(reason) = model_store::models_dir(app, model_store::Engine::Vocr) {
        return (false, Some(reason));
    }
    if let Err(reason) = crate::meiki_ocr::runtime_available(app) {
        return (false, Some(reason));
    }
    let probe_app = app.clone();
    let probe = move || {
        let loaded = || Loaded { accelerator: "cpu", diagnostics: Vec::new() };
        let selected = probe_app.try_state::<crate::state::Shared>().is_some_and(|service| {
            service.settings.get_or::<String>("ocrMode", String::new()) == "vocr"
        });
        if selected {
            if let Some(state) = probe_app.try_state::<VocrState>() {
                let mut slot = state.0.lock().map_err(|_| "VOCR6 worker unavailable".to_string())?;
                if slot.is_none() {
                    *slot = Some(load_engine(&probe_app)?);
                }
                return Ok(loaded());
            }
        }
        load_engine(&probe_app).map(|_| loaded())
    };
    match PROBE.verified_or_start("vocr", engine_probe::PROBE_TIMEOUT, probe) {
        Some(verified) => (verified.available, verified.reason),
        None => (true, None),
    }
}

pub fn verification() -> Option<Verified> {
    PROBE.verified()
}

/// VOCR's lines in the shape the overlay contract (`meiki_ocr::annotations`) reads: boxes and
/// character cells in capture pixels. A cell spans the line's height; the cells tile the line, so
/// a pointer anywhere along it picks a character for the hover lookup.
fn as_meiki(lines: &[kimochi_vocr::Line]) -> Vec<meikiocr::TextLine> {
    let px = |v: f32| v.round().max(0.0) as u32;
    lines
        .iter()
        .map(|line| {
            let (x, y, w, h) = line.bbox;
            let (x, y, w, h) = (x.max(0) as u32, y.max(0) as u32, w.max(0) as u32, h.max(0) as u32);
            meikiocr::TextLine {
                text: line.text.clone(),
                bbox: [x, y, x + w, y + h],
                detection_confidence: Some(line.conf as f32 / 127.0),
                characters: line
                    .text_chars
                    .iter()
                    .filter_map(|c| {
                        let mut it = c.text.chars();
                        let (Some(character), None) = (it.next(), it.next()) else { return None };
                        Some(meikiocr::Character {
                            character,
                            bbox: [px(c.x0), y, px(c.x1).max(px(c.x0)), y + h],
                            confidence: c.conf,
                        })
                    })
                    .collect(),
                is_vertical: false,
            }
        })
        .collect()
}

/// The models directory is complete (`text_observer`'s gate; nothing is downloaded here).
pub(crate) fn models_ready(app: &tauri::AppHandle) -> Result<(), String> {
    model_store::models_dir(app, model_store::Engine::Vocr).map(|_| ())
}

/// One read on the scan engine, loading it on first use. Auto OCR's watcher shares it with the
/// scans (`text_observer`): it is a few megabytes and reads a frame in milliseconds, so a scan
/// waits at most one observation for the lock, and the frame the watcher read last is the one
/// a scan reuses (`text_observer::scan_for`).
pub(crate) fn read_lines(app: &tauri::AppHandle, grey: &kimochi_vocr::Grey) -> Result<Vec<meikiocr::TextLine>, crate::pp_ocr::ReadError> {
    use crate::pp_ocr::ReadError;
    let state = app.state::<VocrState>();
    let mut engine = state.0.lock().map_err(|_| ReadError::Inference("VOCR6 worker unavailable".into()))?;
    if engine.is_none() {
        *engine = Some(load_engine(app).map_err(|reason| ReadError::Unavailable(format!("VOCR6 is not ready: {reason}")))?);
    }
    let engine = engine.as_mut().ok_or(ReadError::Inference("VOCR6 initialization failed".into()))?;
    let lines = engine_probe::guarded(|| engine.read_capture(grey).map_err(|e| format!("VOCR6 inference: {e}")))
        .map_err(ReadError::Inference)?;
    Ok(as_meiki(&lines))
}

/// What a scan returns for `lines`.
pub(crate) fn scan_result(lines: &[meikiocr::TextLine]) -> Value {
    let mut result = crate::meiki_ocr::annotations(lines, "vocr");
    result["backend"] = json!({"requested": "Cpu", "selected": "Cpu", "fallback_reasons": []});
    result
}

pub fn recognize(app: &tauri::AppHandle, image: &crate::state::Image) -> Result<Value, String> {
    let grey = image.grey().map_err(|e| format!("VOCR6 {e}"))?;
    let lines = read_lines(app, &grey).map_err(|e| match e {
        crate::pp_ocr::ReadError::Unavailable(reason) | crate::pp_ocr::ReadError::Inference(reason) => reason,
    })?;
    Ok(scan_result(&lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> kimochi_vocr::Line {
        let c = |t: &str, x0: f32, x1: f32| kimochi_vocr::Char {
            text: t.into(), cls: 1, f0: 0, f1: 0, x: (x0 + x1) / 2.0, x0, x1, y0: 20, y1: 50, conf: 0.9,
        };
        kimochi_vocr::Line {
            text: "日本".into(),
            greedy: "日本".into(),
            bbox: (10, 20, 60, 30),
            chars: vec![],
            text_chars: vec![c("日", 10.4, 40.6), c("本", 40.6, 70.0)],
            conf_min: 0.9,
            conf_mean: 0.9,
            frames: 8,
            width: 64,
            dark: false,
            tag: 0,
            conf: 127,
            block: 0,
        }
    }

    #[test]
    fn lines_become_the_overlay_contract_with_character_cells() {
        let result = crate::meiki_ocr::annotations(&as_meiki(&[line()]), "vocr");
        assert_eq!(result["fullText"], "日本");
        let first = &result["textAnnotations"][1];
        assert_eq!(first["boundingPoly"]["vertices"][2], json!({"x": 70, "y": 50}));
        assert_eq!(first["characters"][0]["bbox"], json!([10, 20, 41, 50]));
        assert_eq!(first["characters"][1]["character"], "本");
        assert_eq!(first["confidence"], json!(1.0));
    }

    /// The scan path without a window, on whichever runtime ORT_DYLIB_PATH names.
    #[test]
    #[ignore = "manual: requires ORT_DYLIB_PATH and VOCR_MODEL_DIR"]
    fn reads_a_fixture_through_the_scan_path() {
        let models = std::env::var("VOCR_MODEL_DIR").unwrap();
        let mut engine = Vocr::load(&ModelPaths::from_dir(models, TIER, MODE, true), Config::default()).unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/overlay-alignment/dialogue.png");
        let rgb = image::open(fixture).unwrap().to_rgb8();
        let (w, h) = (rgb.width() as usize, rgb.height() as usize);
        let grey = kimochi_vocr::Grey::from_interleaved(rgb.as_raw(), w, h, w * 3, 3);
        let lines = engine.read_capture(&grey).unwrap();
        let value = crate::meiki_ocr::annotations(&as_meiki(&lines), "vocr");
        assert!(value["fullText"].as_str().unwrap().contains("今日は一緒に図書館へ行かない"));
    }
}
