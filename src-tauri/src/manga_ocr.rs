//! Native page OCR, reused on the retained-frame blocking worker.
use crate::engine_probe::{self, Loaded, Probe, Verified};
use crate::model_store;
use mangaocr::{
    Backend, ComicTextDetector, DetectionOptions, MangaOcr, ModelPaths, OcrOptions, PageResult,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
};
use tauri::Manager;

struct PageEngine {
    recognizer: MangaOcr,
    detector: ComicTextDetector,
}
#[derive(Default)]
pub struct MangaState(Mutex<Option<PageEngine>>);
/// The models directory (downloaded, bundled or development; see `model_store`), or why
/// Manga OCR cannot scan yet ("Downloading model… 32%").
fn assets(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    model_store::models_dir(app, model_store::Engine::Manga)
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
/// until the first call's background probe has selected the Candle device
/// (Metal/CUDA/CPU) and built the comic text detector graph on it; from then on
/// this is the verified answer. The detector (about 95 MB) is the probe's
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
    let probe = move || {
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
// TODO(integrator): surface `accelerator` in `ocrEngines.mangaocr` instead of the OS table's guess.
#[allow(dead_code)]
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
        *engine = Some(PageEngine {
            recognizer: MangaOcr::new(ModelPaths::from_dir(&root))
                .map_err(|e| format!("Manga OCR models: {e}"))?,
            detector: ComicTextDetector::new(root.join("comic-text-detector.onnx"), Backend::Auto)
                .map_err(|e| format!("Comic detector model: {e}"))?,
        });
    }
    let engine = engine.as_mut().ok_or("Manga OCR initialization failed")?;
    // A whole page or a snip of one bubble: see `MangaOcr::recognize_region`.
    let page = engine
        .recognizer
        .recognize_region(
            &image,
            &mut engine.detector,
            &OcrOptions::default(),
            &DetectionOptions::default(),
        )
        .map_err(|e| format!("Manga page inference: {e}"))?;
    let mut value = response(page);
    value["backend"] =
        serde_json::to_value(engine.recognizer.backend_info()).map_err(|e| e.to_string())?;
    Ok(value)
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
    }
    page.full_text = ellipses(&page.full_text);
    let groups: Vec<_> = page.groups.iter().map(|g| json!({"id":g.id,"text":g.recognition.text,"bbox":g.bbox,"orientation":g.orientation,"confidence":g.detection_confidence,"linePolygons":g.line_polygons,"recognition":g.recognition})).collect();
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
