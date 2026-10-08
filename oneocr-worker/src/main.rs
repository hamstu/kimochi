//! A private stdin/stdout worker, never a network server. A separate process keeps
//! Snipping Tool's ONNX Runtime out of MeikiOCR's process and permits an ARM64
//! worker when an x64 Kimochi runs on Windows ARM64.
use base64::Engine as _;
use libloading::Library;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, CStr, CString},
    io::{self, BufRead, Write},
    path::Path,
};

#[repr(C)]
struct Image {
    kind: i32,
    width: i32,
    height: i32,
    reserved: i32,
    stride: i64,
    data: *const u8,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Quad {
    coordinates: [f32; 8],
}

// The native ABI is described by Snipping Tool's exports and the original
// reverse-engineering notes: https://b1tg.github.io/post/win11-oneocr/ .
// Handles/status codes are signed 64-bit integers, not HRESULTs or pointers.
type Create = unsafe extern "system" fn(*mut i64) -> i64;
type Release = unsafe extern "system" fn(i64);
type GetHandle = unsafe extern "system" fn(i64, i64, *mut i64) -> i64;
type GetCount = unsafe extern "system" fn(i64, *mut i64) -> i64;
type GetText = unsafe extern "system" fn(i64, *mut *const c_char) -> i64;
type GetQuad = unsafe extern "system" fn(i64, *mut *const Quad) -> i64;

struct Native {
    library: Library,
    // Keep the matching runtime loaded until the OneOCR library is unloaded.
    _runtime: Library,
    init: i64,
    pipeline: i64,
    options: i64,
}
fn check(code: i64, operation: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!(
            "OneOCR {operation} failed (code {code}, 0x{:016X})",
            code as u64
        ))
    }
}

/// Keep the engine's line text authoritative. Glyph boxes are useful evidence,
/// but Japanese glyph gaps must not become spaces or independent font sizes.
fn line_group(index: i64, text: &str, polygon: &Value) -> Result<Value, String> {
    let vertices = polygon["vertices"]
        .as_array()
        .ok_or("OneOCR line has no vertices")?;
    if vertices.len() != 4 {
        return Err("OneOCR line needs four vertices".into());
    }
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut points = Vec::new();
    for vertex in vertices {
        let x = vertex["x"]
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or("OneOCR line has invalid x")?;
        let y = vertex["y"]
            .as_f64()
            .filter(|y| y.is_finite())
            .ok_or("OneOCR line has invalid y")?;
        bbox[0] = bbox[0].min(x);
        bbox[1] = bbox[1].min(y);
        bbox[2] = bbox[2].max(x);
        bbox[3] = bbox[3].max(y);
        points.push([x, y]);
    }
    let width = bbox[2] - bbox[0];
    let height = bbox[3] - bbox[1];
    let orientation = if text.chars().count() > 1 && height > width * 1.5 {
        "vertical"
    } else {
        "horizontal"
    };
    Ok(json!({
        "id": format!("oneocr-line-{index}"), "text": text,
        "bbox": if width > 0. && height > 0. { Some(bbox) } else { None },
        "orientation": orientation, "linePolygons": [points]
    }))
}
impl Native {
    unsafe fn function<T: Copy>(&self, name: &[u8]) -> Result<T, String> {
        self.library
            .get::<T>(name)
            .map(|s| *s)
            .map_err(|e| format!("OneOCR export {}: {e}", String::from_utf8_lossy(name)))
    }
    fn load(root: &Path) -> Result<Self, String> {
        // Absolute paths, without SetDllDirectory or a process-wide PATH change.
        let runtime = unsafe { Library::new(root.join("onnxruntime.dll")) }
            .map_err(|e| format!("OneOCR load onnxruntime.dll: {e:?}"))?;
        let library = unsafe { Library::new(root.join("oneocr.dll")) }
            .map_err(|e| format!("OneOCR load oneocr.dll: {e:?}"))?;
        let mut native = Self {
            library,
            _runtime: runtime,
            init: 0,
            pipeline: 0,
            options: 0,
        };
        unsafe {
            check(
                native.function::<Create>(b"CreateOcrInitOptions\0")?(&mut native.init),
                "CreateOcrInitOptions",
            )?;
            let delay = native.function::<unsafe extern "system" fn(i64, u8) -> i64>(
                b"OcrInitOptionsSetUseModelDelayLoad\0",
            )?;
            check(delay(native.init, 0), "OcrInitOptionsSetUseModelDelayLoad")?;
            let create = native.function::<unsafe extern "system" fn(
                *const c_char,
                *const c_char,
                i64,
                *mut i64,
            ) -> i64>(b"CreateOcrPipeline\0")?;
            let model = CString::new(
                root.join("oneocr.onemodel")
                    .to_str()
                    .ok_or("OneOCR model path is not Unicode")?,
            )
            .map_err(|e| e.to_string())?;
            // Snipping Tool's model-format key; this is part of the native ABI.
            let key = b"kj)TGtrK>f]b[Piow.gU+nC@s\"\"\"\"\"\"4\0";
            check(
                create(
                    model.as_ptr(),
                    key.as_ptr().cast(),
                    native.init,
                    &mut native.pipeline,
                ),
                "CreateOcrPipeline",
            )?;
            check(
                native.function::<Create>(b"CreateOcrProcessOptions\0")?(&mut native.options),
                "CreateOcrProcessOptions",
            )?;
            let max = native.function::<unsafe extern "system" fn(i64, i64) -> i64>(
                b"OcrProcessOptionsSetMaxRecognitionLineCount\0",
            )?;
            check(
                max(native.options, 1000),
                "OcrProcessOptionsSetMaxRecognitionLineCount",
            )?;
        }
        Ok(native)
    }
    fn recognize(&self, png: &[u8]) -> Result<Value, String> {
        let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .map_err(|e| format!("OneOCR PNG: {e}"))?
            .into_rgba8();
        let (width, height) = image.dimensions();
        if width == 0 || height == 0 || width > 10000 || height > 10000 {
            return Err("OneOCR capture must be between 1 and 10000 pixels on each side".into());
        }
        // Pad narrow crops instead of stretching them: all output coordinates
        // remain in the original capture pixels, including vertical Japanese.
        let (padded_w, padded_h) = (width.max(50), height.max(50));
        let mut pixels = vec![255u8; padded_w as usize * padded_h as usize * 4];
        for (x, y, p) in image.enumerate_pixels() {
            let start = (y as usize * padded_w as usize + x as usize) * 4;
            pixels[start..start + 4].copy_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
        let input = Image {
            kind: 3,
            width: padded_w as i32,
            height: padded_h as i32,
            reserved: 0,
            stride: i64::from(padded_w) * 4,
            data: pixels.as_ptr(),
        };
        let mut result = 0;
        unsafe {
            let run = self
                .function::<unsafe extern "system" fn(i64, *const Image, i64, *mut i64) -> i64>(
                    b"RunOcrPipeline\0",
                )?;
            let release = self.function::<Release>(b"ReleaseOcrResult\0")?;
            let code = run(self.pipeline, &input, self.options, &mut result);
            if let Err(error) = check(code, "RunOcrPipeline") {
                if result != 0 {
                    release(result);
                }
                return Err(error);
            }
            if result == 0 {
                return Err("OneOCR returned a null result".into());
            }
            let parsed = self.parse(result, width, height);
            release(result);
            parsed
        }
    }
    unsafe fn text(&self, handle: i64, name: &[u8]) -> Result<String, String> {
        let mut p = std::ptr::null();
        check(self.function::<GetText>(name)?(handle, &mut p), "read text")?;
        if p.is_null() {
            return Err("OneOCR returned null text".into());
        }
        CStr::from_ptr(p)
            .to_str()
            .map(str::to_owned)
            .map_err(|e| format!("OneOCR text is not UTF-8: {e}"))
    }
    unsafe fn polygon(
        &self,
        handle: i64,
        name: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Value, String> {
        let mut p = std::ptr::null();
        check(
            self.function::<GetQuad>(name)?(handle, &mut p),
            "read bounding box",
        )?;
        if p.is_null() {
            return Err("OneOCR returned null bounding box".into());
        }
        let coordinates = (*p).coordinates;
        if !coordinates.iter().all(|v| v.is_finite()) {
            return Err("OneOCR returned a non-finite bounding box".into());
        }
        Ok(
            json!({"vertices": coordinates.chunks_exact(2).map(|xy| json!({"x": xy[0].clamp(0., width as f32), "y": xy[1].clamp(0., height as f32)})).collect::<Vec<_>>()}),
        )
    }
    unsafe fn count(&self, handle: i64, name: &[u8]) -> Result<i64, String> {
        let mut n = 0;
        check(
            self.function::<GetCount>(name)?(handle, &mut n),
            "read count",
        )?;
        if !(0..=10000).contains(&n) {
            return Err(format!("OneOCR invalid result count {n}"));
        }
        Ok(n)
    }
    unsafe fn child(&self, handle: i64, index: i64, name: &[u8]) -> Result<i64, String> {
        let mut child = 0;
        check(
            self.function::<GetHandle>(name)?(handle, index, &mut child),
            "read result handle",
        )?;
        if child == 0 {
            return Err("OneOCR returned a null child handle".into());
        }
        Ok(child)
    }
    unsafe fn parse(&self, result: i64, width: u32, height: u32) -> Result<Value, String> {
        let mut annotations = Vec::new();
        let mut lines = Vec::new();
        let mut groups = Vec::new();
        for index in 0..self.count(result, b"GetOcrLineCount\0")? {
            let line = self.child(result, index, b"GetOcrLine\0")?;
            let text = self.text(line, b"GetOcrLineContent\0")?;
            if text.trim().is_empty() {
                continue;
            }
            lines.push(text.clone());
            let polygon = self.polygon(line, b"GetOcrLineBoundingBox\0", width, height)?;
            let group = line_group(index, &text, &polygon)?;
            let orientation = group["orientation"]
                .as_str()
                .ok_or("OneOCR line has no orientation")?
                .to_owned();
            groups.push(group);
            let count = self.count(line, b"GetOcrLineWordCount\0")?;
            if count == 0 {
                annotations.push(json!({"description":text,"boundingPoly":polygon,"orientation":orientation,"granularity":"line","groupId":format!("oneocr-line-{index}")}));
            }
            for w in 0..count {
                let word = self.child(line, w, b"GetOcrWord\0")?;
                let text = self.text(word, b"GetOcrWordContent\0")?;
                if text.trim().is_empty() {
                    continue;
                }
                let mut confidence = 0f32;
                let get = self.function::<unsafe extern "system" fn(i64, *mut f32) -> i64>(
                    b"GetOcrWordConfidence\0",
                )?;
                check(get(word, &mut confidence), "GetOcrWordConfidence")?;
                if !confidence.is_finite() {
                    return Err("OneOCR returned non-finite confidence".into());
                }
                annotations.push(json!({"description":text,"boundingPoly":self.polygon(word,b"GetOcrWordBoundingBox\0",width,height)?,"confidence":confidence,"orientation":orientation,"granularity":"fragment","groupId":format!("oneocr-line-{index}")}));
            }
        }
        let text = lines.join("\n");
        if !annotations.is_empty() {
            annotations.insert(0, json!({"description":text,"granularity":"aggregate","boundingPoly":{"vertices":[{"x":0,"y":0},{"x":width,"y":0},{"x":width,"y":height},{"x":0,"y":height}]}}));
        }
        Ok(json!({"fullText":text,"textAnnotations":annotations,"groups":groups,"engine":"oneocr"}))
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        for (handle, name) in [
            (self.options, b"ReleaseOcrProcessOptions\0".as_slice()),
            (self.pipeline, b"ReleaseOcrPipeline\0"),
            (self.init, b"ReleaseOcrInitOptions\0"),
        ] {
            if handle != 0 {
                unsafe {
                    if let Ok(release) = self.function::<Release>(name) {
                        release(handle);
                    }
                }
            }
        }
    }
}
fn send(value: Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{value}")?;
    out.flush()
}
fn serve() -> Result<(), String> {
    let root = std::env::args_os()
        .nth(1)
        .ok_or("OneOCR worker needs a runtime directory")?;
    let engine = Native::load(Path::new(&root))?;
    send(json!({"ready":true})).map_err(|e| e.to_string())?;
    for line in io::stdin().lock().lines() {
        let request = line.map_err(|e| e.to_string())?;
        let result = (|| {
            let value: Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
            let encoded = value["png"].as_str().ok_or("OneOCR request needs png")?;
            let png = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| e.to_string())?;
            engine.recognize(&png)
        })();
        send(match result {
            Ok(ocr) => json!({"ocr":ocr}),
            Err(error) => json!({"error":error}),
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = serve() {
        let _ = send(json!({"error":error}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_image_abi() {
        assert_eq!(std::mem::size_of::<Image>(), 32);
        assert_eq!(std::mem::offset_of!(Image, stride), 16);
        assert_eq!(std::mem::offset_of!(Image, data), 24);
        assert_eq!(std::mem::size_of::<Quad>(), 32);
    }
    #[test]
    fn native_errors_keep_exact_status() {
        assert_eq!(check(0, "scan"), Ok(()));
        assert_eq!(
            check(-1, "scan").unwrap_err(),
            "OneOCR scan failed (code -1, 0xFFFFFFFFFFFFFFFF)"
        );
    }
    #[test]
    fn semantic_line_preserves_japanese_and_real_spaces_with_one_box() {
        let polygon = json!({"vertices":[{"x":12.,"y":7.},{"x":332.,"y":8.},{"x":330.,"y":51.},{"x":10.,"y":50.}]});
        let group = line_group(3, "日本語のテスト API", &polygon).unwrap();
        assert_eq!(group["text"], "日本語のテスト API");
        assert_eq!(group["bbox"], json!([10., 7., 332., 51.]));
        assert_eq!(group["id"], "oneocr-line-3");
        assert_eq!(group["orientation"], "horizontal");
        assert_eq!(group["linePolygons"][0][2], json!([330., 51.]));
    }
    #[test]
    fn semantic_line_keeps_vertical_capture_coordinates() {
        let polygon = json!({"vertices":[{"x":20.,"y":10.},{"x":50.,"y":10.},{"x":50.,"y":210.},{"x":20.,"y":210.}]});
        let group = line_group(0, "日本語", &polygon).unwrap();
        assert_eq!(group["orientation"], "vertical");
        assert_eq!(group["bbox"], json!([20., 10., 50., 210.]));
    }
}
