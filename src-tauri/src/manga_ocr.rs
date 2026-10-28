//! Native page OCR, reused on the retained-frame blocking worker.
//!
//! Where the bundled ONNX Runtime is present (Windows and Linux), the detector and recognizer
//! run on it: DirectML on Windows, else its CPU kernels, both far faster there than Candle's
//! CPU path. macOS keeps Candle on Metal; Candle is everywhere's fallback.
use crate::engine_probe::{self, Loaded, Probe, Verified};
use crate::model_store;
use mangaocr::{
    Backend, ComicTextDetector, DetectionOptions, MangaOcr, ModelPaths, OcrOptions, PageResult,
};
use serde_json::{json, Value};
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use tauri::Manager;

// One engine lives behind the Mutex at a time; the variants' sizes don't matter.
#[allow(clippy::large_enum_variant)]
enum PageEngine {
    Candle {
        recognizer: MangaOcr,
        detector: ComicTextDetector,
    },
    #[cfg(not(target_os = "macos"))]
    Onnx {
        page: mangaocr::onnx::OnnxPage,
        /// Why DirectML was not used, when it was asked for.
        fallback: Vec<String>,
    },
}
#[derive(Default)]
pub struct MangaState(Mutex<Option<PageEngine>>);

/// Set once DirectML has failed to build or run Manga OCR's sessions: every engine after
/// that asks for ONNX Runtime's CPU kernels directly.
#[cfg(not(target_os = "macos"))]
static DIRECTML_REFUSED: AtomicBool = AtomicBool::new(false);

/// The ONNX Runtime engine, DirectML first on Windows.
#[cfg(not(target_os = "macos"))]
fn load_onnx(app: &tauri::AppHandle, root: &Path) -> Result<PageEngine, String> {
    use mangaocr::onnx::{OnnxPage, Provider};
    crate::meiki_ocr::onnx_runtime(app)?;
    let paths = ModelPaths::from_dir(root);
    let detector = root.join("comic-text-detector.onnx");
    let beams = OcrOptions::default().beam_width;
    let mut fallback = Vec::new();
    if cfg!(target_os = "windows") && !DIRECTML_REFUSED.load(Ordering::Relaxed) {
        match engine_probe::guarded(|| {
            OnnxPage::new(&paths, &detector, Provider::DirectMl, beams).map_err(|e| e.to_string())
        }) {
            Ok(page) => return Ok(PageEngine::Onnx { page, fallback }),
            Err(e) => {
                DIRECTML_REFUSED.store(true, Ordering::Relaxed);
                fallback.push(format!("DirectML: {e}"));
            }
        }
    }
    let page = engine_probe::guarded(|| {
        OnnxPage::new(&paths, &detector, Provider::Cpu, beams).map_err(|e| e.to_string())
    })?;
    Ok(PageEngine::Onnx { page, fallback })
}

fn load_candle(root: &Path) -> Result<PageEngine, String> {
    Ok(PageEngine::Candle {
        recognizer: MangaOcr::new(ModelPaths::from_dir(root))
            .map_err(|e| format!("Manga OCR models: {e}"))?,
        detector: ComicTextDetector::new(root.join("comic-text-detector.onnx"), Backend::Auto)
            .map_err(|e| format!("Comic detector model: {e}"))?,
    })
}

fn load(app: &tauri::AppHandle, root: &Path) -> Result<PageEngine, String> {
    #[cfg(not(target_os = "macos"))]
    match load_onnx(app, root) {
        Ok(engine) => return Ok(engine),
        Err(e) => eprintln!("Manga OCR: ONNX Runtime unavailable, using Candle: {e}"),
    }
    #[cfg(target_os = "macos")]
    let _ = app;
    load_candle(root)
}
/// The models directory (downloaded, bundled or development; see `model_store`), or why
/// Manga OCR cannot scan yet ("Downloading model… 32%").
fn assets(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    model_store::models_dir(app, model_store::Engine::Manga)
}

/// Builds the engine in the background when Manga OCR is the selected engine and its models are
/// ready, so the first scan does not wait for it: DirectML compiles its kernels as the sessions
/// are created. A scan that arrives meanwhile waits on the same lock.
pub fn prewarm(app: &tauri::AppHandle) {
    let selected = app
        .try_state::<crate::state::Shared>()
        .is_some_and(|service| service.settings.get_or::<String>("ocrMode", String::new()) == "mangaocr");
    let Ok(root) = assets(app) else {
        return;
    };
    if !selected {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(state) = app.try_state::<MangaState>() else {
            return;
        };
        let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            match load(&app, &root) {
                Ok(engine) => *slot = Some(engine),
                Err(e) => eprintln!("Manga OCR: could not prepare the engine ahead of a scan: {e}"),
            }
        }
    });
}

/// Drop the loaded engine so its model files can be deleted.
pub fn unload(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<MangaState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}
static PROBE: LazyLock<Arc<Probe>> = LazyLock::new(Default::default);

/// Whether Manga OCR can run here, for `platform_capabilities`.
///
/// Missing models are reported at once. Present models are reported available
/// until the first call's background probe has built the comic text detector the
/// way a scan would (ONNX Runtime on DirectML or the CPU where it is bundled, else
/// Candle on Metal/CUDA/CPU); from then on this is the verified answer. The detector (about 95 MB) is the probe's
/// stand-in for the whole engine: it exercises device selection, which is what
/// differs per machine, without loading the 440 MB recogniser. It is dropped
/// once built, so nothing stays resident.
pub fn availability(app: &tauri::AppHandle) -> (bool, Option<String>) {
    let root = match assets(app) {
        Ok(root) => root,
        Err(e) => return (false, Some(e)),
    };
    // Metal on macOS is proven; see meiki_ocr::availability for why the startup probe
    // is reserved for the other platforms.
    if cfg!(target_os = "macos") {
        return (true, None);
    }
    #[cfg(not(target_os = "macos"))]
    let probe_app = app.clone();
    let probe = move || {
        // The ONNX Runtime detector, as `load` would build it: DirectML first on Windows.
        #[cfg(not(target_os = "macos"))]
        if crate::meiki_ocr::onnx_runtime(&probe_app).is_ok() {
            use mangaocr::onnx::{OnnxDetector, Provider};
            let path = root.join("comic-text-detector.onnx");
            let mut diagnostics = Vec::new();
            if cfg!(target_os = "windows") && !DIRECTML_REFUSED.load(Ordering::Relaxed) {
                match engine_probe::guarded(|| {
                    OnnxDetector::new(&path, Provider::DirectMl).map_err(|e| e.to_string())
                }) {
                    Ok(_) => return Ok(Loaded { accelerator: "directml", diagnostics }),
                    Err(e) => diagnostics.push(format!("fallback: DirectML: {e}")),
                }
            }
            match engine_probe::guarded(|| {
                OnnxDetector::new(&path, Provider::Cpu).map_err(|e| e.to_string())
            }) {
                Ok(_) => return Ok(Loaded { accelerator: "cpu", diagnostics }),
                Err(e) => eprintln!("Manga OCR: ONNX Runtime detector unavailable: {e}"),
            }
        }
        let detector = engine_probe::guarded(|| {
            ComicTextDetector::new(root.join("comic-text-detector.onnx"), Backend::Auto)
                .map_err(|e| format!("Comic detector model: {e}"))
        })?;
        let info = detector.backend_info();
        Ok(Loaded {
            accelerator: match info.selected {
                Backend::Metal => "metal",
                Backend::Cuda => "cuda",
                Backend::Cpu | Backend::Auto => "cpu",
            },
            diagnostics: info
                .fallback_reasons
                .iter()
                .map(|r| format!("fallback: {r}"))
                .collect(),
        })
    };
    match PROBE.verified_or_start("mangaocr", engine_probe::PROBE_TIMEOUT, probe) {
        Some(verified) => (verified.available, verified.reason),
        None => (true, None),
    }
}

/// The verified verdict once the probe has finished: accelerator and diagnostics.
pub fn verification() -> Option<Verified> {
    PROBE.verified()
}

/// Run `hook` whenever the probe records a verdict, so capabilities can be re-announced.
pub fn on_verified(hook: impl Fn() + Send + Sync + 'static) {
    PROBE.on_verified(hook);
}
pub fn recognize(app: &tauri::AppHandle, image: &crate::state::Image) -> Result<Value, String> {
    let image = image.rgb().map_err(|e| format!("Manga OCR {e}"))?;
    // Checked on every scan, not just the first: models deleted since are refused cleanly.
    let root = assets(app).map_err(|reason| format!("Manga OCR is not ready: {reason}"))?;
    let state = app.state::<MangaState>();
    let mut engine = state
        .0
        .lock()
        .map_err(|_| "Manga OCR worker unavailable".to_string())?;
    if engine.is_none() {
        *engine = Some(load(app, &root)?);
    }
    let (page, backend) = read(app, &root, &mut engine, &image)?;
    let mut value = response(page);
    value["backend"] = backend;
    Ok(value)
}

/// One page through the loaded engine, and the backend that read it. A DirectML engine that
/// fails is replaced by ONNX Runtime's CPU engine and the page read again.
#[cfg_attr(target_os = "macos", allow(unused_variables))]
fn read(
    app: &tauri::AppHandle,
    root: &Path,
    engine: &mut Option<PageEngine>,
    image: &image::RgbImage,
) -> Result<(PageResult, Value), String> {
    let (options, detection) = (OcrOptions::default(), DetectionOptions::default());
    #[allow(clippy::let_unit_value)]
    let directml_error = match engine.as_mut().ok_or("Manga OCR initialization failed")? {
        // A whole page or a snip of one bubble: see `MangaOcr::recognize_region`.
        PageEngine::Candle {
            recognizer,
            detector,
        } => {
            let page = recognizer
                .recognize_region(image, detector, &options, &detection)
                .map_err(|e| format!("Manga page inference: {e}"))?;
            let backend =
                serde_json::to_value(recognizer.backend_info()).map_err(|e| e.to_string())?;
            return Ok((page, backend));
        }
        #[cfg(not(target_os = "macos"))]
        PageEngine::Onnx { page, fallback } => {
            use mangaocr::onnx::Provider;
            let provider = page.provider();
            let result = {
                let _serial = (provider == Provider::DirectMl).then(|| {
                    crate::meiki_ocr::DIRECTML_RUN
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                });
                engine_probe::guarded(|| {
                    page.recognize_region(image, &options, &detection)
                        .map_err(|e| e.to_string())
                })
            };
            let backend = json!({
                "runtime": "onnxruntime",
                "requested": "Auto",
                "selected": provider,
                "fallback_reasons": fallback,
            });
            match result {
                Ok(result) => return Ok((result, backend)),
                Err(e) if provider != Provider::DirectMl => {
                    return Err(format!("Manga page inference: {e}"))
                }
                // Some adapters build DirectML sessions and then fail to run them: read the
                // page again on the CPU, below, once this engine's borrow has ended.
                Err(e) => e,
            }
        }
    };
    #[cfg(not(target_os = "macos"))]
    {
        DIRECTML_REFUSED.store(true, Ordering::Relaxed);
        *engine = Some(load(app, root)?);
        if let Some(PageEngine::Onnx { fallback, .. }) = engine.as_mut() {
            fallback.push(format!("DirectML inference: {directml_error}"));
        }
        read(app, root, engine, image)
    }
}
/// Manga OCR's dots as the ellipses they were on the page.
///
/// Its post-processing (upstream's, kept as is) spells every `…` as three full-width periods, so
/// a bubble's `……` arrives as `．．．．．．`: six characters a full cell apart in the overlay where
/// the page has two, and in the Log. A run of three or more becomes one `…` per three (rounded,
/// at least one); two become `‥`. A lone `．` is a full stop and stays.
fn ellipses(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut dots = 0usize;
    let flush = |out: &mut String, dots: usize| match dots {
        0 => {}
        1 => out.push('．'),
        2 => out.push('‥'),
        n => out.extend(std::iter::repeat_n('…', ((n + 1) / 3).max(1))),
    };
    for c in text.chars() {
        if c == '．' {
            dots += 1;
        } else {
            flush(&mut out, dots);
            dots = 0;
            out.push(c);
        }
    }
    flush(&mut out, dots);
    out
}

fn response(mut page: PageResult) -> Value {
    for group in &mut page.groups {
        group.recognition.text = ellipses(&group.recognition.text);
        for line in &mut group.lines {
            *line = ellipses(line);
        }
    }
    page.full_text = ellipses(&page.full_text);
    let groups: Vec<_> = page.groups.iter().map(|g| json!({"id":g.id,"text":g.recognition.text,"bbox":g.bbox,"orientation":g.orientation,"confidence":g.detection_confidence,"linePolygons":g.line_polygons,"lines":g.lines,"fontSize":g.font_size,"recognition":g.recognition})).collect();
    let mut annotations = Vec::new();
    for g in &page.groups {
        let [x1, y1, x2, y2] = g.bbox;
        annotations.push(json!({"description":g.recognition.text,"groupId":g.id,"granularity":"block","orientation":g.orientation,"isVertical":matches!(g.orientation,mangaocr::Orientation::Vertical),"boundingPoly":{"vertices":[{"x":x1,"y":y1},{"x":x2,"y":y1},{"x":x2,"y":y2},{"x":x1,"y":y2}]}}));
    }
    if let Some(first) = annotations.first() {
        annotations.insert(0,json!({"description":page.full_text,"granularity":"aggregate","boundingPoly":first["boundingPoly"]}));
    }
    json!({"schemaVersion":1,"engine":"mangaocr","groups":groups,"fullText":page.full_text,"textAnnotations":annotations,"geometry":!page.groups.is_empty()})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dots_become_the_ellipses_on_the_page() {
        assert_eq!(ellipses("．．．．．．かう"), "……かう");
        assert_eq!(ellipses("．．．嘘だろ．．．？"), "…嘘だろ…？");
        assert_eq!(ellipses("あ．．"), "あ‥");
        assert_eq!(ellipses("です．"), "です．");
        // A miscount of one either way is still the ellipses it was read from.
        assert_eq!(ellipses("．．．．"), "…");
        assert_eq!(ellipses("．．．．．"), "……");
        assert_eq!(ellipses("．．．．．．．"), "……");
        assert_eq!(ellipses("ひらがな"), "ひらがな");
    }
    #[test]
    fn empty_page_has_no_invented_geometry() {
        let result = response(PageResult {
            groups: vec![],
            full_text: String::new(),
        });
        assert_eq!(result["geometry"], false);
        assert_eq!(result["groups"], json!([]));
    }
}
