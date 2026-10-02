//! Source catalog, thumbnails, previews and the atomic selection/crop commit that
//! backs the source picker.
//!
//! Reads never mutate selection, crop, scan or revision: opening the picker must not
//! disturb a running scan. Thumbnails and previews are local only — they are never
//! sent to OCR and never written to the evidence log.
use crate::native;
use crate::state::{descriptor_key, descriptor_type, Image, Service, Shared, Thumbnail};
use base64::Engine;
use kimochi_capture::{crop_rect, CaptureError, CaptureRequest, Crop, Source};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Long edge of a catalog thumbnail, in pixels. Large enough to stay sharp on a
/// Retina row, small enough that the base64 payload stays a few kilobytes.
const THUMBNAIL_EDGE: u32 = 320;
const THUMBNAIL_TTL: Duration = Duration::from_secs(10);
const ICON_EDGE: isize = 64;

pub fn err(e: CaptureError) -> String {
    let prefix = match e.code {
        "permission" => "permission",
        "stale_source" | "unavailable" => "gone",
        "invalid_crop" | "dimensions" => "invalid",
        _ => "native",
    };
    format!("{prefix}: {}", e.message)
}

/// Capture one source without touching any view state. Returns the frame's own RGBA
/// so callers encode once, at the size they actually serve.
fn capture_isolated(service: &Service, source_id: &str) -> Result<kimochi_capture::Frame, String> {
    let mut backend = service
        .backend
        .try_lock()
        .map_err(|_| "busy: a capture is already running; retry shortly".to_string())?;
    backend
        .capture(&CaptureRequest {
            source_id: source_id.to_string(),
            crop: None,
        })
        .map_err(err)
}

/// Box-average downscale of tightly packed RGBA. Averaging rather than dropping
/// pixels keeps small text legible in a thumbnail instead of aliasing it away.
fn downscale(pixels: &[u8], width: u32, height: u32, edge: u32) -> (Vec<u8>, u32, u32) {
    let longest = width.max(height);
    if longest <= edge || width == 0 || height == 0 {
        return (pixels.to_vec(), width, height);
    }
    let target_w = (width * edge / longest).max(1);
    let target_h = (height * edge / longest).max(1);
    let mut out = Vec::with_capacity(target_w as usize * target_h as usize * 4);
    for ty in 0..target_h {
        let y0 = (ty * height / target_h) as usize;
        let y1 = (((ty + 1) * height / target_h) as usize)
            .max(y0 + 1)
            .min(height as usize);
        for tx in 0..target_w {
            let x0 = (tx * width / target_w) as usize;
            let x1 = (((tx + 1) * width / target_w) as usize)
                .max(x0 + 1)
                .min(width as usize);
            let mut sums = [0u32; 4];
            let mut count = 0u32;
            for y in y0..y1 {
                let row = y * width as usize * 4;
                for x in x0..x1 {
                    let i = row + x * 4;
                    for (channel, sum) in sums.iter_mut().enumerate() {
                        *sum += u32::from(pixels[i + channel]);
                    }
                    count += 1;
                }
            }
            let count = count.max(1);
            out.extend(sums.iter().map(|sum| (sum / count) as u8));
        }
    }
    (out, target_w, target_h)
}

fn encode_png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| format!("native: {e}"))?;
        writer
            .write_image_data(pixels)
            .map_err(|e| format!("native: {e}"))?;
    }
    Ok(bytes)
}

#[cfg(test)]
fn decode_rgba(png_bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut reader = decoder.read_info().map_err(|e| format!("native: {e}"))?;
    let mut buffer = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|e| format!("native: {e}"))?;
    buffer.truncate(info.buffer_size());
    Ok((buffer, info.width, info.height))
}

fn icon_for(service: &Service, app: Option<&str>) -> Option<Arc<str>> {
    let app = app?.trim();
    if app.is_empty() {
        return None;
    }
    if let Some(cached) = service.icons.lock().unwrap().get(app) {
        return cached.clone();
    }
    let encoded = native::app_icon_png(app, ICON_EDGE).map(|png| {
        Arc::from(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        ))
    });
    service
        .icons
        .lock()
        .unwrap()
        .insert(app.to_string(), encoded.clone());
    encoded
}

fn entry(source: &Source) -> Value {
    json!({
        "id": source.id,
        // capture-core calls a screen a "display"; the picker contract uses the same word.
        "kind": source.kind,
        "name": source.name,
        "app": source.app,
        "bounds": source.bounds,
        "on_screen": source.on_screen,
        "icon": null,
    })
}

/// Displays first, then windows grouped by application. The UI is free to re-sort.
///
/// Kimochi's own windows are excluded: selecting the picker or the overlay would
/// capture our own interface, and scanning it would feed OCR its own output.
pub fn catalog() -> Result<Vec<Value>, String> {
    let mut sources = native::picker_sources()?;
    sources.sort_by(|a, b| {
        let rank = |s: &Source| u8::from(s.kind != "display");
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.app.cmp(&b.app))
            .then_with(|| a.name.cmp(&b.name))
    });
    let result: Vec<_> = sources.iter().map(entry).collect();
    Ok(result)
}

pub fn icon(service: &Shared, app: &str) -> Value {
    objc2::rc::autoreleasepool(|_| json!({"icon": icon_for(service, Some(app))}))
}

pub fn thumbnail(service: &Shared, source_id: &str) -> Result<Value, String> {
    if let Some(cached) = service.thumbnails.lock().unwrap().get(source_id) {
        if cached.taken.elapsed() < THUMBNAIL_TTL {
            return Ok(json!({ "url": cached.data_uri }));
        }
    }
    let frame = capture_isolated(service, source_id)?;
    // Downscale the captured pixels directly: encoding a full 5K frame to PNG only to
    // decode it again would cost far more than the thumbnail itself.
    let (small, small_w, small_h) = downscale(
        &frame.pixels,
        frame.info.width,
        frame.info.height,
        THUMBNAIL_EDGE,
    );
    let png = encode_png(&small, small_w, small_h)?;
    let data_uri: Arc<str> = Arc::from(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    ));
    let mut cache = service.thumbnails.lock().unwrap();
    // Drop anything stale before inserting, so the map tracks live sources only.
    cache.retain(|_, entry| entry.taken.elapsed() < THUMBNAIL_TTL);
    cache.insert(
        source_id.to_string(),
        Thumbnail {
            taken: Instant::now(),
            data_uri: data_uri.clone(),
        },
    );
    Ok(json!({ "url": data_uri }))
}

/// A full-resolution preview, served through the `capture:` protocol rather than
/// base64: a display preview is multiple megabytes and must not cross the IPC bridge.
pub fn preview(service: &Shared, source_id: &str) -> Result<Value, String> {
    let frame = capture_isolated(service, source_id)?;
    let (width, height) = (frame.info.width, frame.info.height);
    let image = Image::encoded(
        encode_png(&frame.pixels, width, height)?,
        serde_json::to_value(&frame.info).unwrap_or(Value::Null),
    );
    let token = service.images.lock().unwrap().put_preview(image);
    Ok(json!({
        "url": format!("capture://localhost/preview/{token}"),
        "width": width,
        "height": height,
    }))
}

/// The whole selected window, full resolution, for the overlay's hover marking.
///
/// Built for being cheap to get wrong-footed by: it never touches the latest,
/// published or retained frames, never allocates a frame id, never runs the text
/// observer, and refuses outright while a scan or auto-OCR capture holds the
/// `scanning` flag rather than queueing behind it. Pixels stay raw until the
/// `capture:` protocol is asked for them, so the PNG encode happens off this call
/// and only if the overlay actually loads the image.
pub fn hover_preview(service: &Shared, source_id: &str) -> Result<Value, String> {
    if service.scanning.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("busy: a scan is running".into());
    }
    let frame = capture_isolated(service, source_id)?;
    let (width, height, scale) = (frame.info.width, frame.info.height, frame.info.scale_factor);
    let info = serde_json::to_value(&frame.info).unwrap_or(Value::Null);
    let token = service
        .images
        .lock()
        .unwrap()
        .put_hover(Image::captured(frame, info));
    Ok(json!({
        "url": format!("capture://localhost/hover/{token}"),
        "width": width,
        "height": height,
        "scaleFactor": scale,
    }))
}

/// Selection and crop change together or not at all.
///
/// All three persisted keys go through a single settings transaction, so a failed
/// write cannot leave a source selected with another source's crop.
pub fn commit(service: &Shared, source_id: &str, crop: Option<Crop>) -> Result<Value, String> {
    let source = {
        let mut backend = service
            .backend
            .try_lock()
            .map_err(|_| "busy: a capture is already running; retry shortly".to_string())?;
        backend
            .enumerate()
            .map_err(err)?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or("gone: that source has closed; refresh the list and pick again")?
    };
    if let Some(crop) = crop {
        // Reuse capture-core's validation rather than re-deriving the rules here.
        crop_rect(Some(crop), crop.reference_width, crop.reference_height)
            .map_err(|e| format!("invalid: {}", e.message))?;
    }
    let key = descriptor_key(source.kind, &source.name, source.app.as_deref());
    let previous = saved_crop_for_key(service, &key);
    let crop_value = match crop {
        Some(crop) => serde_json::to_value(crop).unwrap(),
        None => Value::Null,
    };
    let selection_value = json!({
        "sourceId": source.id,
        // The frontend's CaptureSource vocabulary, not capture-core's.
        "type": descriptor_type(source.kind),
        "name": source.name,
        "appName": source.app,
    });
    service.settings.set_many(&[
        // Literal segments: an application name may contain a dot.
        (&["cropRegions", key.as_str()], crop_value),
        (&["cropScanEnabled", key.as_str()], json!(crop.is_some())),
        (&["lastSelectedSource"], selection_value),
    ])?;
    {
        let mut selection = service.selection.lock().unwrap();
        let source_changed = selection.as_deref() != Some(source.id.as_str());
        *selection = Some(source.id.clone());
        drop(selection);
        // A new crop on the *same* source invalidates the previous scan just as much
        // as a different source would: the old text no longer matches the new region.
        let crop_changed = crop_differs(previous.as_ref(), crop.as_ref());
        if source_changed || crop_changed {
            let mut view = service.view.lock().unwrap();
            view.scan = None;
            view.regions.clear();
            view.revision += 1;
        }
    }
    Ok(json!({ "sourceId": source.id, "crop": crop, "key": key }))
}

fn crop_differs(a: Option<&Crop>, b: Option<&Crop>) -> bool {
    match (a, b) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            (
                a.x,
                a.y,
                a.width,
                a.height,
                a.reference_width,
                a.reference_height,
            ) != (
                b.x,
                b.y,
                b.width,
                b.height,
                b.reference_width,
                b.reference_height,
            )
        }
        _ => true,
    }
}

fn saved_crop_for_key(service: &Service, key: &str) -> Option<Crop> {
    service
        .settings
        .get_path(&["cropRegions", key])
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
}

/// Outcome of matching a persisted source record against live sources.
#[derive(Debug, PartialEq, Eq)]
pub enum Restored {
    /// The saved id is still live and still describes the same thing.
    Exact(String),
    /// The id changed, but exactly one live source matches the description.
    Matched(String),
    /// Several live sources match the description; picking one would be a guess.
    Ambiguous,
    /// Nothing matches.
    Gone,
}

fn field<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str).map(str::trim)
}

fn same_description(saved: &Value, source: &Source) -> bool {
    // Compare in the frontend's vocabulary, since that is what was persisted.
    let kind_matches = field(saved, "type") == Some(descriptor_type(source.kind));
    let name_matches = field(saved, "name").unwrap_or_default() == source.name.trim();
    let app_matches = field(saved, "appName").unwrap_or_default()
        == source.app.as_deref().unwrap_or_default().trim();
    kind_matches && name_matches && app_matches
}

/// Resolve a persisted record against a fresh enumeration.
///
/// Capture source ids are session-scoped: capture-core says so explicitly, and reusing
/// a stale one across launches would either fail or, worse, silently address a
/// different window that happens to have inherited the id. The persisted record is
/// descriptive, and this is where it is turned back into a live id.
pub fn resolve_saved_source(saved: &Value, live: &[Source]) -> Restored {
    let saved_id = field(saved, "sourceId").unwrap_or_default();
    if !saved_id.is_empty() {
        if let Some(source) = live
            .iter()
            .find(|s| s.id == saved_id && same_description(saved, s))
        {
            return Restored::Exact(source.id.clone());
        }
    }
    let mut matches = live.iter().filter(|s| same_description(saved, s));
    match (matches.next(), matches.next()) {
        (Some(source), None) => Restored::Matched(source.id.clone()),
        (Some(_), Some(_)) => Restored::Ambiguous,
        _ => Restored::Gone,
    }
}

/// The crop saved for a source descriptor, used when a scan starts.
pub fn saved_crop(service: &Service, kind: &str, name: &str, app: Option<&str>) -> Option<Crop> {
    saved_crop_for_key(service, &descriptor_key(kind, name, app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, value: u8) -> Vec<u8> {
        vec![value; width as usize * height as usize * 4]
    }

    #[test]
    fn downscale_preserves_aspect_and_shrinks_the_long_edge() {
        let (out, w, h) = downscale(&solid(1000, 500, 9), 1000, 500, 320);
        assert_eq!((w, h), (320, 160));
        assert_eq!(out.len(), 320 * 160 * 4);
        // A solid image must stay solid: averaging, not sampling noise.
        assert!(out.iter().all(|&v| v == 9));
    }

    #[test]
    fn downscale_leaves_small_images_alone() {
        let (out, w, h) = downscale(&solid(10, 10, 3), 10, 10, 320);
        assert_eq!((w, h, out.len()), (10, 10, 400));
    }

    #[test]
    fn downscale_averages_rather_than_dropping() {
        // Two columns, black and white: a 2x1 -> 1x1 reduction must yield the mean.
        let pixels = vec![0, 0, 0, 255, 255, 255, 255, 255];
        let (out, w, h) = downscale(&pixels, 2, 1, 1);
        assert_eq!((w, h), (1, 1));
        assert_eq!(&out[..3], &[127, 127, 127]);
    }

    #[test]
    fn png_round_trips_through_the_decoder() {
        let png = encode_png(&solid(4, 3, 200), 4, 3).unwrap();
        let (rgba, w, h) = decode_rgba(&png).unwrap();
        assert_eq!((w, h), (4, 3));
        assert!(rgba.iter().all(|&v| v == 200));
    }

    fn crop(x: u32) -> Crop {
        Crop {
            x,
            y: 0,
            width: 10,
            height: 10,
            reference_width: 100,
            reference_height: 100,
        }
    }

    #[test]
    fn crop_change_is_detected_on_the_same_source() {
        assert!(!crop_differs(None, None));
        assert!(crop_differs(None, Some(&crop(0))));
        assert!(crop_differs(Some(&crop(0)), None));
        assert!(crop_differs(Some(&crop(0)), Some(&crop(5))));
        assert!(!crop_differs(Some(&crop(3)), Some(&crop(3))));
    }

    fn source(id: &str, kind: &'static str, name: &str, app: Option<&str>) -> Source {
        Source {
            id: id.into(),
            kind,
            name: name.into(),
            app: app.map(str::to_string),
            bounds: None,
            on_screen: Some(true),
        }
    }

    fn saved(id: &str, kind: &str, name: &str, app: &str) -> Value {
        json!({"sourceId": id, "type": kind, "name": name, "appName": app})
    }

    #[test]
    fn a_live_id_that_still_describes_the_same_thing_is_exact() {
        let live = [source("macos:window:1:2", "window", "Doc", Some("Safari"))];
        assert_eq!(
            resolve_saved_source(&saved("macos:window:1:2", "window", "Doc", "Safari"), &live),
            Restored::Exact("macos:window:1:2".into())
        );
    }

    #[test]
    fn a_recycled_id_is_not_trusted() {
        // Same id, different window: ids are session-scoped and must not be believed.
        let live = [source("macos:window:1:2", "window", "Mail", Some("Mail"))];
        assert_eq!(
            resolve_saved_source(&saved("macos:window:1:2", "window", "Doc", "Safari"), &live),
            Restored::Gone
        );
    }

    #[test]
    fn a_changed_id_resolves_by_description() {
        let live = [
            source("macos:window:9:9", "window", "Doc", Some("Safari")),
            source("macos:display:1", "display", "Display 1", None),
        ];
        assert_eq!(
            resolve_saved_source(&saved("macos:window:1:2", "window", "Doc", "Safari"), &live),
            Restored::Matched("macos:window:9:9".into())
        );
    }

    #[test]
    fn two_identical_windows_stay_unselected() {
        let live = [
            source("macos:window:3:3", "window", "Doc", Some("Safari")),
            source("macos:window:4:4", "window", "Doc", Some("Safari")),
        ];
        // Picking one would be a guess, and the wrong guess scans the wrong window.
        assert_eq!(
            resolve_saved_source(&saved("macos:window:1:2", "window", "Doc", "Safari"), &live),
            Restored::Ambiguous
        );
    }

    #[test]
    fn displays_restore_through_the_frontend_vocabulary() {
        let live = [source("macos:display:7", "display", "Display 7", None)];
        // Persisted records say "screen"; capture-core says "display".
        assert_eq!(
            resolve_saved_source(&saved("macos:display:7", "screen", "Display 7", ""), &live),
            Restored::Exact("macos:display:7".into())
        );
    }

    #[test]
    fn nothing_live_means_gone() {
        assert_eq!(
            resolve_saved_source(&saved("x", "window", "Doc", "Safari"), &[]),
            Restored::Gone
        );
    }

    #[test]
    fn capture_errors_map_onto_the_documented_prefixes() {
        let cases = [
            ("permission", "permission:"),
            ("stale_source", "gone:"),
            ("unavailable", "gone:"),
            ("invalid_crop", "invalid:"),
            ("encode", "native:"),
        ];
        for (code, prefix) in cases {
            assert!(
                err(CaptureError::new(code, "x")).starts_with(prefix),
                "{code}"
            );
        }
    }
}
