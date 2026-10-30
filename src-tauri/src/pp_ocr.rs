//! PP-OCRv6 (PaddleOCR) sessions for scans, loaded lazily and reused.
//!
//! Runs on the ONNX Runtime MeikiOCR bundles (`meiki_ocr::onnx_runtime`); only the models are
//! downloaded, as their own engine in `model_store`. Automatic scanning's change detection
//! still uses MeikiOCR (`text_observer.rs`); PP-OCR reads the frames it settles on, like any
//! other selected engine.
use crate::engine_probe::{self, Loaded, Probe, Verified};
use crate::model_store;
use ppocr::{Backend, Config, ModelPaths, OcrOptions, PpOcr, Tier};
use serde_json::Value;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::Manager;

/// The model size the manifest downloads (`ocr-models.json`'s `ppocr` files).
pub(crate) const TIER: Tier = Tier::Small;

#[derive(Default)]
pub struct PpState(Mutex<Option<PpOcr>>);

/// Drop the scan engine so its model files can be deleted.
pub fn unload(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PpState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

fn config() -> Config {
    Config { intra_threads: crate::meiki_ocr::cpu_threads(), ..Config::default() }
}

fn load_engine(app: &tauri::AppHandle) -> Result<PpOcr, String> {
    let models = model_store::models_dir(app, model_store::Engine::PpOcr)?;
    crate::meiki_ocr::onnx_runtime(app)?;
    engine_probe::guarded(|| {
        PpOcr::with_config(ModelPaths::from_dir(models, TIER), config())
            .map_err(|e| format!("PP-OCR models: {e}"))
    })
}

fn accelerator(backend: Backend) -> &'static str {
    match backend {
        Backend::CoreMl => "coreml",
        Backend::DirectMl => "directml",
        Backend::Cuda => "cuda",
        Backend::Cpu | Backend::Auto => "cpu",
    }
}

static PROBE: LazyLock<Arc<Probe>> = LazyLock::new(Default::default);

/// Whether PP-OCR can run here, for `platform_capabilities`. Missing models or runtime are
/// reported at once; otherwise a background probe loads the sessions (and, when PP-OCR is the
/// selected engine, keeps them for the first scan), as `meiki_ocr::availability` does.
pub fn availability(app: &tauri::AppHandle) -> (bool, Option<String>) {
    if let Err(reason) = model_store::models_dir(app, model_store::Engine::PpOcr) {
        return (false, Some(reason));
    }
    if let Err(reason) = crate::meiki_ocr::runtime_available(app) {
        return (false, Some(reason));
    }
    let probe_app = app.clone();
    let probe = move || {
        let describe = |engine: &PpOcr| {
            let info = engine.backend_info();
            Loaded {
                accelerator: accelerator(info.selected),
                diagnostics: info.fallback_reasons.iter().map(|r| format!("fallback: {r}")).collect(),
            }
        };
        let selected = probe_app.try_state::<crate::state::Shared>().is_some_and(|service| {
            service.settings.get_or::<String>("ocrMode", String::new()) == "ppocr"
        });
        if selected {
            if let Some(state) = probe_app.try_state::<PpState>() {
                let mut slot = state.0.lock().map_err(|_| "PP-OCR worker unavailable".to_string())?;
                if slot.is_none() {
                    *slot = Some(load_engine(&probe_app)?);
                }
                return Ok(describe(slot.as_ref().ok_or("PP-OCR initialization failed")?));
            }
        }
        Ok(describe(&load_engine(&probe_app)?))
    };
    match PROBE.verified_or_start("ppocr", engine_probe::PROBE_TIMEOUT, probe) {
        Some(verified) => (verified.available, verified.reason),
        None => (true, None),
    }
}

pub fn verification() -> Option<Verified> {
    PROBE.verified()
}

pub fn on_verified(hook: impl Fn() + Send + Sync + 'static) {
    PROBE.on_verified(hook);
}

/// PP-OCR's lines in the shape the overlay contract (`meiki_ocr::annotations`) reads.
fn as_meiki(lines: Vec<ppocr::TextLine>) -> Vec<meikiocr::TextLine> {
    lines
        .into_iter()
        .map(|line| meikiocr::TextLine {
            text: line.text,
            bbox: line.bbox,
            detection_confidence: line.detection_confidence,
            characters: line
                .characters
                .into_iter()
                .map(|c| meikiocr::Character { character: c.character, bbox: c.bbox, confidence: c.confidence })
                .collect(),
            is_vertical: line.is_vertical,
        })
        .collect()
}

pub fn recognize(app: &tauri::AppHandle, image: &crate::state::Image) -> Result<Value, String> {
    let image = image.rgb().map_err(|e| format!("PP-OCR {e}"))?;
    let state = app.state::<PpState>();
    let mut engine = state.0.lock().map_err(|_| "PP-OCR worker unavailable".to_string())?;
    if engine.is_none() {
        *engine = Some(load_engine(app).map_err(|reason| format!("PP-OCR is not ready: {reason}"))?);
    }
    let engine = engine.as_mut().ok_or("PP-OCR initialization failed")?;
    // Shares Meiki's lock: two DirectML runs on one adapter contend for its command queue.
    let _serial = (engine.backend_info().selected == Backend::DirectMl)
        .then(|| crate::meiki_ocr::DIRECTML_RUN.lock().unwrap_or_else(|p| p.into_inner()));
    let mut lines = engine_probe::guarded(|| {
        engine.ocr(&image, OcrOptions::default()).map_err(|e| format!("PP-OCR inference: {e}"))
    })?;
    ppocr::japanese::fix_lines(&mut lines);
    let mut result = crate::meiki_ocr::annotations(&as_meiki(lines), "ppocr");
    result["backend"] = serde_json::to_value(engine.backend_info()).map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scan path without a window: the app's config, the Japanese fixes and the overlay
    /// annotations, on whichever runtime ORT_DYLIB_PATH names.
    #[test]
    #[ignore = "manual: requires ORT_DYLIB_PATH and PPOCR_MODEL_DIR"]
    fn reads_a_fixture_through_the_scan_path() {
        let models = std::env::var("PPOCR_MODEL_DIR").unwrap();
        let mut engine = PpOcr::with_config(ModelPaths::from_dir(models, TIER), config()).unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/overlay-alignment/dialogue.png");
        let image = image::open(fixture).unwrap().to_rgb8();
        let mut lines = engine.ocr(&image, OcrOptions::default()).unwrap();
        ppocr::japanese::fix_lines(&mut lines);
        let value = crate::meiki_ocr::annotations(&as_meiki(lines), "ppocr");
        assert!(value["fullText"].as_str().unwrap().contains("今日は一緒に図書館へ行かない"));
        println!("PP-OCR: {:?}, threads {:?}", engine.backend_info(), config().intra_threads);
    }
}
