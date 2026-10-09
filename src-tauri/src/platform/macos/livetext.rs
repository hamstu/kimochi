//! Apple Live Text as a selectable OCR engine (`ocrMode: "livetext"`), macOS only.
//!
//! The engine is `kimochi_capture::LiveTextObserver`, the same VisionKitCore path
//! automatic scanning observes frames with (see `capture-core/src/text/livetext.rs`
//! for what the private API costs). This is a second, independent instance: the
//! observer behind automatic scanning is one-analysis-at-a-time and is held under
//! the capture state's lock while a tick runs, so a manual scan never waits on it
//! and never steals its answer.
//!
//! Live Text answers with lines, not words, so the result carries one `groups`
//! entry per line, which the overlay treats as authoritative (OCR.md): one lookup
//! target with one font size per line, like OneOCR's semantic lines. Per-character
//! boxes exist in the analysis but are not read; nothing downstream would use them.
//!
//! Nothing is downloaded or bundled: the engine is part of macOS 13 and later.

use crate::state::Image;
use kimochi_capture::text::LiveTextObserver;
use kimochi_capture::{Frame, FrameInfo, TextLine, TextObserver};
use serde_json::{json, Value};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// A manual scan may take as long as it needs within reason; automatic scanning
/// has its own, much shorter budget on its own instance.
const TIMEOUT: Duration = Duration::from_secs(20);

static ENGINE: LazyLock<Mutex<LiveTextObserver>> =
    LazyLock::new(|| Mutex::new(LiveTextObserver::new()));

fn engine() -> std::sync::MutexGuard<'static, LiveTextObserver> {
    ENGINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The `ocrEngines.livetext` capability: probed, so an OS that renamed the private
/// classes reports why before anyone scans.
pub fn capability() -> Value {
    match engine().available() {
        Ok(()) => json!({"available": true}),
        Err(reason) => json!({"available": false, "reason": reason}),
    }
}

/// Recognise a captured frame. Reads the retained pixels when the image still has
/// them, and decodes its PNG otherwise.
pub fn recognize(image: &Image) -> Result<Value, String> {
    let frame = match image.frame() {
        Some(frame) => frame,
        None => std::sync::Arc::new(decode_png(&image.png()?)?),
    };
    let observation = engine()
        .observe(&frame, TIMEOUT)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    Ok(value_from_lines(
        &observation.lines,
        frame.info.width,
        frame.info.height,
    ))
}

/// The cloud-compatible result (OCR.md): one authoritative group per line, a
/// `line` annotation per line for diagnostics, and the aggregate first.
fn value_from_lines(lines: &[TextLine], width: u32, height: u32) -> Value {
    let mut groups = Vec::new();
    let mut annotations = Vec::new();
    let mut texts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let text = line.text.trim();
        if text.is_empty() {
            continue;
        }
        texts.push(text.to_owned());
        let id = format!("livetext-line-{index}");
        let (x1, y1) = (line.x.max(0.), line.y.max(0.));
        let (x2, y2) = (
            (line.x + line.width).min(f64::from(width)),
            (line.y + line.height).min(f64::from(height)),
        );
        let positioned = x2 > x1 && y2 > y1;
        let orientation = if text.chars().count() > 1 && (y2 - y1) > (x2 - x1) * 1.5 {
            "vertical"
        } else {
            "horizontal"
        };
        let polygon = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
        groups.push(json!({
            "id": id, "text": text,
            "bbox": if positioned { Some([x1, y1, x2, y2]) } else { None },
            "orientation": orientation,
            "linePolygons": if positioned { json!([polygon]) } else { json!([]) },
        }));
        if positioned {
            annotations.push(json!({
                "description": text,
                "boundingPoly": {"vertices": polygon.iter().map(|[x, y]| json!({"x": x, "y": y})).collect::<Vec<_>>()},
                "orientation": orientation,
                "granularity": "line",
                "groupId": id,
            }));
        }
    }
    let text = texts.join("\n");
    if !annotations.is_empty() {
        annotations.insert(0, json!({
            "description": text, "granularity": "aggregate",
            "boundingPoly": {"vertices": [{"x": 0, "y": 0}, {"x": width, "y": 0}, {"x": width, "y": height}, {"x": 0, "y": height}]}
        }));
    }
    json!({"fullText": text, "textAnnotations": annotations, "groups": groups, "engine": "livetext"})
}

/// A frame from a PNG, for an image whose pixels were not retained. Only the
/// dimensions and pixels matter to the engine; the rest of `FrameInfo` is unknown
/// here and left zeroed.
fn decode_png(bytes: &[u8]) -> Result<Frame, String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| format!("decode: {e}"))?;
    let size = reader
        .output_buffer_size()
        .ok_or("decode: PNG too large to decode")?;
    let mut buffer = vec![0; size];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|e| format!("decode: {e}"))?;
    buffer.truncate(info.buffer_size());
    let pixels = match (info.color_type, info.bit_depth) {
        (png::ColorType::Rgba, png::BitDepth::Eight) => buffer,
        (png::ColorType::Rgb, png::BitDepth::Eight) => buffer
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
            .collect(),
        (color, depth) => {
            return Err(format!(
                "decode: unsupported PNG layout {color:?}/{depth:?}"
            ))
        }
    };
    Ok(Frame {
        info: FrameInfo {
            source_id: String::new(),
            width: info.width,
            height: info.height,
            stride: info.width as usize * 4,
            full_width: info.width,
            full_height: info.height,
            crop_pixels: [0, 0, info.width, info.height],
            scale_factor: 1.,
            source_bounds: None,
            pixel_format: "RGBA8 straight alpha, top-left rows",
            color_space: "unknown",
            resolve_ms: 0.,
            acquisition_ms: 0.,
            pixels_ms: 0.,
            total_ms: 0.,
        },
        pixels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f64, y: f64, width: f64, height: f64) -> TextLine {
        TextLine {
            text: text.into(),
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn lines_become_authoritative_groups_with_the_aggregate_first() {
        let value = value_from_lines(
            &[
                line("日本語のテスト", 10., 20., 260., 42.),
                line("縦書き", 300., 10., 30., 120.),
            ],
            400,
            200,
        );
        assert_eq!(value["fullText"], "日本語のテスト\n縦書き");
        assert_eq!(value["engine"], "livetext");
        let groups = value["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["id"], "livetext-line-0");
        assert_eq!(groups[0]["bbox"], json!([10., 20., 270., 62.]));
        assert_eq!(groups[0]["orientation"], "horizontal");
        assert_eq!(groups[1]["orientation"], "vertical");
        assert_eq!(
            groups[1]["linePolygons"],
            json!([[[300., 10.], [330., 10.], [330., 130.], [300., 130.]]])
        );
        let annotations = value["textAnnotations"].as_array().unwrap();
        assert_eq!(annotations.len(), 3);
        assert_eq!(annotations[0]["granularity"], "aggregate");
        assert_eq!(annotations[1]["granularity"], "line");
        assert_eq!(annotations[1]["groupId"], "livetext-line-0");
    }

    #[test]
    fn boxes_are_clamped_to_the_frame_and_empty_lines_dropped() {
        let value = value_from_lines(
            &[
                line("  ", 0., 0., 10., 10.),
                line("端", -5., 190., 20., 30.),
                line("空", 50., 50., 0., 0.),
            ],
            100,
            200,
        );
        assert_eq!(value["fullText"], "端\n空");
        let groups = value["groups"].as_array().unwrap();
        assert_eq!(groups[0]["bbox"], json!([0., 190., 15., 200.]));
        assert_eq!(groups[1]["bbox"], Value::Null);
        assert_eq!(groups[1]["linePolygons"], json!([]));
        // Only the positioned line is annotated, plus the aggregate.
        assert_eq!(value["textAnnotations"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_single_character_is_never_called_vertical() {
        let value = value_from_lines(&[line("あ", 0., 0., 10., 40.)], 100, 100);
        assert_eq!(value["groups"][0]["orientation"], "horizontal");
    }

    #[test]
    fn png_decoding_yields_rgba_pixels() {
        let frame = Frame {
            info: decode_png(&rgb_png()).unwrap().info,
            pixels: decode_png(&rgb_png()).unwrap().pixels,
        };
        assert_eq!((frame.info.width, frame.info.height), (2, 1));
        assert_eq!(frame.pixels, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    fn rgb_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[1, 2, 3, 4, 5, 6]).unwrap();
        }
        bytes
    }
}
