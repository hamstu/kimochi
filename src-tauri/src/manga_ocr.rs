//! Native page OCR, reused on the retained-frame blocking worker.
use mangaocr::{
    Backend, ComicTextDetector, DetectionOptions, MangaOcr, ModelPaths, OcrOptions, PageResult,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};
use tauri::Manager;

struct PageEngine {
    recognizer: MangaOcr,
    detector: ComicTextDetector,
}
#[derive(Default)]
pub struct MangaState(Mutex<Option<PageEngine>>);
fn assets(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("mangaocr/models");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/mangaocr/models");
    for root in [bundled, development] {
        let paths = ModelPaths::from_dir(&root);
        if [
            &paths.weights,
            &paths.vocab,
            &paths.config,
            &root.join("comic-text-detector.onnx"),
        ]
        .iter()
        .all(|p| p.is_file())
        {
            return Ok(root);
        }
    }
    Err("Manga OCR assets are missing. Run npm run prepare:mangaocr or rebuild with npm run bundle.".into())
}
pub fn recognize(app: &tauri::AppHandle, png: &[u8]) -> Result<Value, String> {
    let image = mangaocr::decode_image(png).map_err(|e| format!("Manga OCR image: {e}"))?;
    let state = app.state::<MangaState>();
    let mut engine = state
        .0
        .lock()
        .map_err(|_| "Manga OCR worker unavailable".to_string())?;
    if engine.is_none() {
        let root = assets(app)?;
        *engine = Some(PageEngine {
            recognizer: MangaOcr::new(ModelPaths::from_dir(&root))
                .map_err(|e| format!("Manga OCR models: {e}"))?,
            detector: ComicTextDetector::new(root.join("comic-text-detector.onnx"), Backend::Auto)
                .map_err(|e| format!("Comic detector model: {e}"))?,
        });
    }
    let engine = engine.as_mut().ok_or("Manga OCR initialization failed")?;
    let page = engine
        .recognizer
        .recognize_page(
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
fn response(page: PageResult) -> Value {
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
    fn empty_page_has_no_invented_geometry() {
        let result = response(PageResult {
            groups: vec![],
            full_text: String::new(),
        });
        assert_eq!(result["geometry"], false);
        assert_eq!(result["groups"], json!([]));
    }
}
