//! PP-OCRv6 (PaddleOCR) sessions for scans, loaded lazily and reused.
//!
//! Runs on the ONNX Runtime MeikiOCR bundles (`meiki_ocr::onnx_runtime`); only the models are
//! downloaded, as their own engine in `model_store`. The same engine also watches the screen
//! for automatic scanning when the overlay chooses it (`text_observer.rs`, `read_lines`).
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

/// Core ML's compiled models, one per input shape and seconds each to build: kept across launches
/// (6.4 s to load cold, 1.7 s from here on an M5 Max) and pruned by ppocr itself. Other platforms'
/// providers compile nothing worth keeping.
fn compiled_cache(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    app.path().app_cache_dir().ok().map(|dir| dir.join("ppocr-coreml"))
}

/// Remove the compiled-model cache along with the models (`model_delete`).
pub fn delete_cache(app: &tauri::AppHandle) {
    if let Some(dir) = compiled_cache(app) {
        let _ = model_store::remove_dir(&dir);
    }
}

/// The app's engine settings: Linux's CPU thread count and, on macOS, the compiled-model cache.
fn config(cache_dir: Option<std::path::PathBuf>) -> Config {
    Config { intra_threads: crate::meiki_ocr::cpu_threads(), cache_dir, ..Config::default() }
}

fn load_engine(app: &tauri::AppHandle) -> Result<PpOcr, String> {
    let models = model_store::models_dir(app, model_store::Engine::PpOcr)?;
    crate::meiki_ocr::onnx_runtime(app)?;
    let config = config(compiled_cache(app));
    engine_probe::guarded(|| {
        PpOcr::with_config(ModelPaths::from_dir(models, TIER), config)
            .map_err(|e| format!("PaddleOCR models: {e}"))
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
                let mut slot = state.0.lock().map_err(|_| "PaddleOCR worker unavailable".to_string())?;
                if slot.is_none() {
                    *slot = Some(load_engine(&probe_app)?);
                }
                return Ok(describe(slot.as_ref().ok_or("PaddleOCR initialization failed")?));
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

/// The models directory is complete (`text_observer`'s gate; nothing is downloaded here).
pub(crate) fn models_ready(app: &tauri::AppHandle) -> Result<(), String> {
    model_store::models_dir(app, model_store::Engine::PpOcr).map(|_| ())
}

/// Why `read_lines` could not read: the engine cannot load, or this image failed.
pub(crate) enum ReadError {
    Unavailable(String),
    Inference(String),
}

/// One read on the scan engine (loading it on first use): the lines with the Japanese fixes,
/// and which backend ran them.
fn read(app: &tauri::AppHandle, image: &image::RgbImage) -> Result<(Vec<ppocr::TextLine>, Value), ReadError> {
    let state = app.state::<PpState>();
    let mut engine = state.0.lock().map_err(|_| ReadError::Inference("PaddleOCR worker unavailable".into()))?;
    if engine.is_none() {
        *engine = Some(load_engine(app).map_err(|reason| ReadError::Unavailable(format!("PaddleOCR is not ready: {reason}")))?);
    }
    let engine = engine.as_mut().ok_or(ReadError::Inference("PaddleOCR initialization failed".into()))?;
    // Shares Meiki's lock: two DirectML runs on one adapter contend for its command queue.
    let _serial = (engine.backend_info().selected == Backend::DirectMl)
        .then(|| crate::meiki_ocr::DIRECTML_RUN.lock().unwrap_or_else(|p| p.into_inner()));
    let mut lines = engine_probe::guarded(|| {
        engine.ocr(image, OcrOptions::default()).map_err(|e| format!("PaddleOCR inference: {e}"))
    })
    .map_err(ReadError::Inference)?;
    ppocr::japanese::fix_lines(&mut lines);
    let backend = serde_json::to_value(engine.backend_info()).unwrap_or(Value::Null);
    Ok((lines, backend))
}

/// The lines automatic scanning watches with, in MeikiOCR's shape (`text_observer`).
pub(crate) fn read_lines(app: &tauri::AppHandle, image: &image::RgbImage) -> Result<Vec<meikiocr::TextLine>, ReadError> {
    read(app, image).map(|(lines, _)| as_meiki(lines))
}

pub fn recognize(app: &tauri::AppHandle, image: &crate::state::Image) -> Result<Value, String> {
    let image = image.rgb().map_err(|e| format!("PaddleOCR {e}"))?;
    let (lines, backend) = read(app, &image).map_err(|e| match e {
        ReadError::Unavailable(reason) | ReadError::Inference(reason) => reason,
    })?;
    let mut result = crate::meiki_ocr::annotations(&as_meiki(lines), "ppocr");
    result["backend"] = backend;
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
        let mut engine = PpOcr::with_config(ModelPaths::from_dir(models, TIER), config(None)).unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/overlay-alignment/dialogue.png");
        let image = image::open(fixture).unwrap().to_rgb8();
        let mut lines = engine.ocr(&image, OcrOptions::default()).unwrap();
        ppocr::japanese::fix_lines(&mut lines);
        let value = crate::meiki_ocr::annotations(&as_meiki(lines), "ppocr");
        assert!(value["fullText"].as_str().unwrap().contains("今日は一緒に図書館へ行かない"));
        println!("PP-OCR: {:?}, threads {:?}", engine.backend_info(), config(None).intra_threads);
    }
}
