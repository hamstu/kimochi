//! Native MeikiOCR sessions are loaded lazily and reused by both scan paths.
use meikiocr::{MeikiOcr, ModelPaths, OcrOptions, TextLine};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;

#[derive(Default)]
pub struct MeikiState(Mutex<Option<MeikiOcr>>);

fn assets(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("meikiocr");
    if bundled.join("models").is_dir() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/meikiocr");
    if development.join("models").is_dir() {
        return Ok(development);
    }
    Err("MeikiOCR assets are missing. Rebuild Kimochi with npm run bundle.".into())
}

fn initialize_runtime(root: &std::path::Path) -> Result<(), String> {
    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            let name = if cfg!(target_os = "macos") {
                "libonnxruntime.dylib"
            } else if cfg!(target_os = "windows") {
                "onnxruntime.dll"
            } else {
                "libonnxruntime.so"
            };
            let library = root.join("runtime").join(name);
            if !library.is_file() {
                return Err(
                    "MeikiOCR native runtime is missing. Rebuild Kimochi with npm run bundle."
                        .into(),
                );
            }
            // ort's dynamic loader panics for absent dependencies or incompatible APIs.
            // Turn those deployment failures into a scan error instead of poisoning the engine lock.
            std::panic::catch_unwind(|| ort::init_from(library.to_string_lossy()).commit())
                .map_err(|_| {
                    "MeikiOCR could not load ONNX Runtime or its native dependencies.".to_string()
                })?
                .map(|_| ())
                .map_err(|e| format!("MeikiOCR runtime: {e}"))
        })
        .clone()
}

pub fn recognize(app: &tauri::AppHandle, png: &[u8]) -> Result<Value, String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| format!("MeikiOCR image: {e}"))?
        .to_rgb8();
    let root = assets(app)?;
    initialize_runtime(&root)?;
    let state = app.state::<MeikiState>();
    let mut engine = state
        .0
        .lock()
        .map_err(|_| "MeikiOCR worker unavailable".to_string())?;
    if engine.is_none() {
        *engine = Some(
            MeikiOcr::new(ModelPaths::from_dir(root.join("models")))
                .map_err(|e| format!("MeikiOCR models: {e}"))?,
        );
    }
    let engine = engine.as_mut().ok_or("MeikiOCR initialization failed")?;
    let lines = engine
        .ocr(&image, OcrOptions::default())
        .map_err(|e| format!("MeikiOCR inference: {e}"))?;
    let mut result = annotations(&lines);
    result["backend"] = serde_json::to_value(engine.backend_info()).map_err(|e| e.to_string())?;
    Ok(result)
}

/// The overlay's cloud-compatible annotation contract uses capture pixel coordinates.
fn annotations(lines: &[TextLine]) -> Value {
    let nonempty: Vec<_> = lines.iter().filter(|l| !l.text.is_empty()).collect();
    let text = nonempty
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut annotations: Vec<_> = nonempty
        .iter()
        .map(|line| {
            let [x1, y1, x2, y2] = line.bbox;
            json!({
                "description": line.text,
                "boundingPoly": {"vertices": [
                    {"x": x1, "y": y1}, {"x": x2, "y": y1},
                    {"x": x2, "y": y2}, {"x": x1, "y": y2}
                ]},
                "isVertical": line.is_vertical,
                "characters": line.characters,
                "confidence": line.detection_confidence,
            })
        })
        .collect();
    // Annotation zero is the aggregate in the existing cloud contract. The UI
    // strips it before filtering/rendering; omitting it would drop the first line.
    if !nonempty.is_empty() {
        let left = nonempty.iter().map(|l| l.bbox[0]).min().unwrap_or(0);
        let top = nonempty.iter().map(|l| l.bbox[1]).min().unwrap_or(0);
        let right = nonempty.iter().map(|l| l.bbox[2]).max().unwrap_or(0);
        let bottom = nonempty.iter().map(|l| l.bbox[3]).max().unwrap_or(0);
        annotations.insert(
            0,
            json!({"description": text, "boundingPoly": {"vertices": [
                {"x":left,"y":top}, {"x":right,"y":top},
                {"x":right,"y":bottom}, {"x":left,"y":bottom}
            ]}}),
        );
    }
    json!({"fullText": text, "textAnnotations": annotations, "engine": "meikiocr"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires prepared assets and MEIKIOCR_TEST_IMAGE"]
    fn bundled_runtime_recognizes_example() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/meikiocr");
        initialize_runtime(&root).unwrap();
        let mut engine = MeikiOcr::new(ModelPaths::from_dir(root.join("models"))).unwrap();
        let lines = engine
            .ocr_file(
                std::env::var("MEIKIOCR_TEST_IMAGE").unwrap(),
                OcrOptions::default(),
            )
            .unwrap();
        assert!(lines.iter().any(|l| l.text.contains("ナルホド")));
        let value = annotations(&lines);
        assert_eq!(
            value["textAnnotations"].as_array().unwrap().len(),
            lines.iter().filter(|l| !l.text.is_empty()).count() + 1
        );
        println!("Bundled OCR: {:?}", engine.backend_info());
    }

    #[test]
    fn overlay_contract_preserves_text_and_capture_coordinates() {
        let line = TextLine {
            text: "日本語".into(),
            bbox: [10, 20, 90, 40],
            detection_confidence: Some(0.9),
            characters: vec![],
            is_vertical: false,
        };
        let empty = TextLine {
            text: String::new(),
            ..line.clone()
        };
        let result = annotations(&[line, empty]);
        assert_eq!(result["fullText"], "日本語");
        assert_eq!(result["textAnnotations"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["textAnnotations"][1]["boundingPoly"]["vertices"][2],
            json!({"x":90,"y":40})
        );
    }
}
