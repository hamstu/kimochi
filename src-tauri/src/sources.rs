//! Source catalog, thumbnails, previews and the atomic selection/crop commit that
//! backs the source picker.
//!
//! Reads never mutate selection, crop, scan or revision: opening the picker must not
//! disturb a running scan. Thumbnails and previews are local only — they are never
//! sent to OCR and never written to the evidence log.
use crate::platform;
use crate::state::{descriptor_key, descriptor_type, Image, Service, Shared, Thumbnail};
use base64::Engine;
use kimochi_capture::{
    crop_rect, Capabilities, CaptureBackend, CaptureError, CaptureRequest, Crop, Frame, Source,
    SourceId,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Long edge of a catalog thumbnail, in pixels. Large enough to stay sharp on a
/// Retina row, small enough that the base64 payload stays a few kilobytes.
const THUMBNAIL_EDGE: u32 = 320;
const THUMBNAIL_TTL: Duration = Duration::from_secs(10);
/// Long edge of the main window's live source preview: sharp at 2x across the widest sidebar.
const LIVE_THUMBNAIL_EDGE: u32 = 640;
const ICON_EDGE: isize = 64;

pub fn err(e: CaptureError) -> String {
    let prefix = match e.code {
        "busy" => "busy",
        "permission" => "permission",
        "stale_source" | "unavailable" => "gone",
        "invalid_crop" | "dimensions" => "invalid",
        _ => "native",
    };
    format!("{prefix}: {}", e.message)
}

/// The tag after an error's prefix (`gone: pick-again: …`) that says the source can only come
/// back through the system picker, so the UI offers "Choose in system picker" again rather
/// than a list to refresh. `nativeError()` in `frontend/bridge/tauri.ts` turns it into
/// `pickAgain: true`.
pub const PICK_AGAIN: &str = "pick-again";

/// Whether a failure on this source means "pick again". Only portal sources qualify: their ids
/// name a stream of one picker session, so a closed stream (`stale_source`) or a session that
/// was never picked in this run (`permission`) has no remedy but another pick.
pub fn needs_pick_again(source_id: &str, code: &str) -> bool {
    source_id.starts_with("portal:") && matches!(code, "stale_source" | "permission")
}

/// Insert the pick-again tag after an already formatted `prefix: message` error.
fn tag_pick_again(error: String) -> String {
    tag(error, PICK_AGAIN)
}

/// The tag after `gone:` (`gone: hidden: …`) that says a window source still exists but is out
/// of view for now: minimised, on another virtual desktop or workspace, or showing nothing. It
/// comes back on its own (an exclusive-fullscreen game minimises whenever it loses focus and
/// restores when clicked), so automatic scanning waits for it instead of stopping.
/// `nativeError()` in `frontend/bridge/tauri.ts` turns it into `hidden: true`.
pub const HIDDEN: &str = "hidden";

/// Whether a failure on this source means "out of view for now" rather than "closed". The
/// backends report a minimised or off-desktop window as `unavailable`; a closed one is
/// `stale_source`.
pub fn is_hidden(source_id: &str, code: &str) -> bool {
    code == "unavailable" && SourceId::parse(source_id).is_some_and(|id| id.is_window())
}

/// Insert a tag after an already formatted `prefix: message` error.
fn tag(error: String, tag: &str) -> String {
    match error.split_once(": ") {
        Some((prefix, message)) => format!("{prefix}: {tag}: {message}"),
        None => format!("{tag}: {error}"),
    }
}

/// `err`, tagged with `pick-again` when this source can only come back through the picker,
/// or `hidden` when it is a window that is merely out of view.
pub fn err_for(source_id: &str, e: CaptureError) -> String {
    let pick_again = needs_pick_again(source_id, e.code);
    let hidden = is_hidden(source_id, e.code);
    let text = err(e);
    if pick_again {
        tag_pick_again(text)
    } else if hidden {
        tag(text, HIDDEN)
    } else {
        text
    }
}

/// The error for a source that is no longer among the live ones.
fn closed(source_id: &str) -> String {
    let text = "gone: that source has closed; refresh the list and pick again".to_string();
    if needs_pick_again(source_id, "stale_source") {
        tag_pick_again(
            "gone: that shared source has closed; choose it again in the system picker".into(),
        )
    } else {
        text
    }
}

/// Capture one source without touching any view state. Returns the frame's own RGBA
/// so callers encode once, at the size they actually serve.
fn capture_isolated(service: &Service, source_id: &str) -> Result<kimochi_capture::Frame, String> {
    let mut backend = service
        .backend
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let request = CaptureRequest {
        source_id: source_id.to_string(),
        crop: None,
    };
    #[cfg(target_os = "linux")]
    let frame = backend.preview(&request);
    #[cfg(not(target_os = "linux"))]
    let frame = backend.capture(&request);
    frame.map_err(|e| err_for(source_id, e))
}

/// The whole of one source now, without touching any view state: a scan's screenshot
/// (screenshots.rs), which its OCR-cropped frame cannot be.
pub fn capture_whole(service: &Service, source_id: &str) -> Result<kimochi_capture::Frame, String> {
    capture_isolated(service, source_id)
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
    let identity = platform::AppIdentity {
        name: app.to_string(),
        pid: None,
    };
    let encoded = platform::app_icon_png(&identity, ICON_EDGE).map(|png| {
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

fn entry(source: &Source, space: Option<&String>) -> Value {
    json!({
        "id": source.id,
        // capture-core calls a screen a "display"; the picker contract uses the same word.
        "kind": source.kind,
        "name": source.name,
        "app": source.app,
        "bounds": source.bounds,
        "on_screen": source.on_screen,
        // Where an off-screen window is ("Full screen", "Desktop 2"): open, readable once the
        // reader goes there, but with nothing to preview from here.
        "space": space,
        "icon": null,
    })
}

/// Displays first, then windows grouped by application. The UI is free to re-sort.
///
/// Kimochi's own windows are excluded: selecting the picker or the overlay would
/// capture our own interface, and scanning it would feed OCR its own output.
pub fn catalog() -> Result<Vec<Value>, String> {
    // Bounds in desktop points, like every rectangle the UI sees.
    let mut sources = platform::desktop_picker_sources()?;
    sources.sort_by(|a, b| {
        let rank = |s: &Source| u8::from(s.kind != "display");
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.app.cmp(&b.app))
            .then_with(|| a.name.cmp(&b.name))
    });
    let spaces = platform::source_spaces(&sources);
    let result: Vec<_> = sources.iter().map(|s| entry(s, spaces.get(&s.id))).collect();
    Ok(result)
}

pub fn icon(service: &Shared, app: &str) -> Value {
    platform::with_pool(|| json!({"icon": icon_for(service, Some(app))}))
}

pub fn thumbnail(service: &Shared, source_id: &str) -> Result<Value, String> {
    if let Some(cached) = service.thumbnails.lock().unwrap().get(source_id) {
        if cached.taken.elapsed() < THUMBNAIL_TTL {
            return Ok(json!({ "url": cached.data_uri }));
        }
    }
    // Captured at thumbnail size: the capture scales on the GPU, so a 5K display is
    // never copied or shrunk at full size just to show 320 pixels of it.
    let frame = service
        .backend
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .thumbnail(source_id, THUMBNAIL_EDGE)
        .map_err(|e| err_for(source_id, e))?;
    let png = encode_png(&frame.pixels, frame.info.width, frame.info.height)?;
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
        serde_json::to_value(platform::desktop_frame_info(&frame.info)).unwrap_or(Value::Null),
    );
    let token = service.images.lock().unwrap().put_preview(image);
    Ok(json!({
        "url": platform::capture_url(&format!("preview/{token}")),
        "width": width,
        "height": height,
    }))
}

/// The whole selected window, full resolution, for the overlay's hover marking.
///
/// Built for being cheap to get wrong-footed by: it never touches the latest,
/// published or retained frames, never allocates a frame id and never runs the text
/// observer. It does not wait out a scan either: the scan releases the backend once
/// it has its frame, and a capture from the source's running stream is a copy. Pixels
/// stay raw until the `capture:` protocol is asked for them, so the PNG encode happens
/// off this call and only if the overlay actually loads the image.
pub fn hover_preview(service: &Shared, source_id: &str) -> Result<Value, String> {
    let frame = capture_isolated(service, source_id)?;
    // `scaleFactor` is frame pixels per desktop point, as in the frame's own info.
    let desktop = platform::desktop_frame_info(&frame.info);
    let (width, height, scale) = (desktop.width, desktop.height, desktop.scale_factor);
    let info = serde_json::to_value(&desktop).unwrap_or(Value::Null);
    let token = service
        .images
        .lock()
        .unwrap()
        .put_hover(Image::captured(frame, info));
    Ok(json!({
        "url": platform::capture_url(&format!("hover/{token}")),
        "width": width,
        "height": height,
        "scaleFactor": scale,
    }))
}

/// A fresh, uncached thumbnail of the chosen source for the main window's sidebar, which
/// refreshes it every few seconds. It shares the source's running stream with scans and
/// the hover preview, so it is a copy and a shrink rather than a capture of its own.
pub fn live_thumbnail(service: &Shared, source_id: &str) -> Result<Value, String> {
    // Behind the game in Gaming Mode nobody sees the preview: skip the capture, shrink and
    // PNG encode (on the Deck they cost more than everything else Kimochi does while idle).
    #[cfg(target_os = "linux")]
    if crate::platform::gamescope::active() && !crate::platform::gamescope::shown() {
        return Ok(json!({ "url": null }));
    }
    #[cfg(target_os = "linux")]
    crate::platform::gnome::refresh_identity(service,source_id);
    let frame = capture_isolated(service, source_id)?;
    let (small, width, height) = downscale(
        &frame.pixels,
        frame.info.width,
        frame.info.height,
        LIVE_THUMBNAIL_EDGE,
    );
    let png = encode_png(&small, width, height)?;
    Ok(json!({
        "url": format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        ),
        "width": width,
        "height": height,
    }))
}

/// Select a source and keep the region saved for it, if any: what picking a source in the source
/// picker means now that regions are drawn over the source itself rather than in the picker.
pub fn select_keeping_crop(service: &Shared, source_id: &str) -> Result<Value, String> {
    let source = {
        let mut backend = service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        backend
            .enumerate()
            .map_err(err)?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or_else(|| closed(source_id))?
    };
    let key = selection_crop_key(service, source.kind, &source.name, source.app.as_deref());
    let saved = saved_crop_for_key(service, &key);
    commit_with_key(service, source_id, saved, Some(key))
}

/// Selection and crop change together or not at all.
///
/// All three persisted keys go through a single settings transaction, so a failed
/// write cannot leave a source selected with another source's crop.
pub fn commit(service: &Shared, source_id: &str, crop: Option<Crop>) -> Result<Value, String> {
    commit_with_key(service, source_id, crop, None)
}

fn commit_with_key(service: &Shared, source_id: &str, crop: Option<Crop>, saved_key: Option<String>) -> Result<Value, String> {
    let source = {
        let mut backend = service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        backend
            .enumerate()
            .map_err(err)?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or_else(|| closed(source_id))?
    };
    if let Some(crop) = crop {
        // Reuse capture-core's validation rather than re-deriving the rules here.
        crop_rect(Some(crop), crop.reference_width, crop.reference_height)
            .map_err(|e| format!("invalid: {}", e.message))?;
    }
    let key = saved_key.unwrap_or_else(|| selection_crop_key(service, source.kind, &source.name, source.app.as_deref()));
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
    #[cfg(target_os = "linux")]
    platform::gnome::refresh_identity(service, &source.id);
    Ok(json!({ "sourceId": source.id, "crop": crop, "key": key }))
}

/// Save (or, with `None`, clear) the Anki crop of a source: the part of it that goes on Anki
/// cards as the screenshot. Kept per source under the same key as its OCR crop, in
/// `ankiCropRegions`. Unlike `commit`, nothing else moves: the selection, the OCR crop and the
/// scan on screen all stay as they are.
pub fn commit_anki(service: &Shared, source_id: &str, crop: Option<Crop>) -> Result<Value, String> {
    let source = {
        let mut backend = service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        backend
            .enumerate()
            .map_err(err)?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or_else(|| closed(source_id))?
    };
    if let Some(crop) = crop {
        crop_rect(Some(crop), crop.reference_width, crop.reference_height)
            .map_err(|e| format!("invalid: {}", e.message))?;
    }
    let key = selection_crop_key(service, source.kind, &source.name, source.app.as_deref());
    let value = match crop {
        Some(crop) => serde_json::to_value(crop).unwrap(),
        None => Value::Null,
    };
    // Literal segments: an application name may contain a dot.
    service.settings.set_many(&[(&["ankiCropRegions", key.as_str()], value)])?;
    Ok(json!({ "sourceId": source.id, "crop": crop, "key": key }))
}

/// The crop key of the selected source: the key `commit` saves its crops under. None when
/// nothing is selected.
pub fn current_crop_key(service: &Service) -> Option<String> {
    service.selection.lock().unwrap().as_ref()?;
    let record = service.settings.get("lastSelectedSource").ok().flatten()?;
    record_crop_key(&record, service.source_fullscreen.load(Ordering::Relaxed))
}

/// The crop key for a persisted source record (`{type, name, appName}`).
fn record_crop_key(record: &Value, fullscreen: bool) -> Option<String> {
    let kind = descriptor_type(record.get("type")?.as_str()?);
    let name = record.get("name").and_then(Value::as_str).unwrap_or_default();
    let app = record.get("appName").and_then(Value::as_str);
    Some(crate::state::shaped_crop_key(descriptor_key(kind, name, app), kind, fullscreen))
}

/// The Anki crop saved under a crop key, if any. None means the whole source.
pub fn anki_crop_for_key(service: &Service, key: &str) -> Option<Crop> {
    service
        .settings
        .get_path(&["ankiCropRegions", key])
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
}

/// Reads nothing: no source is selected, now or at the next launch. Each source's saved crop is
/// kept, so choosing it again brings its region back. The scan on screen belonged to the source,
/// so it goes too.
pub fn clear(service: &Shared) -> Result<Value, String> {
    service.settings.set_many(&[(&["lastSelectedSource"], Value::Null)])?;
    let previous = service.selection.lock().unwrap().take();
    let mut view = service.view.lock().unwrap();
    // With nothing to watch, automatic scanning could only fail until it gave up.
    view.auto_ocr = false;
    if previous.is_some() {
        view.scan = None;
        view.regions.clear();
        view.revision += 1;
    }
    Ok(json!({ "sourceId": Value::Null, "previous": previous }))
}

/// Whether a capture error means the source is gone for good: `err`'s `gone:` prefix, but not
/// a window that is only out of view (`gone: hidden:`), which comes back by itself.
fn gone_for_good(error: &str) -> bool {
    error.starts_with("gone:") && !error.starts_with(&format!("gone: {HIDDEN}:"))
}

/// Turn automatic scanning off when a capture of the chosen source finds it gone for good: the
/// window closed, so every later round would fail the same way. A minimised window is not
/// gone; the loop waits for it (`ui/autoscan.ts`).
pub fn stop_auto_if_gone(service: &Service, source_id: &str, error: &str) {
    if !gone_for_good(error) {
        return;
    }
    if service.selection.lock().unwrap().as_deref() != Some(source_id) {
        return;
    }
    service.view.lock().unwrap().auto_ocr = false;
}

// ---------------------------------------------------------------- system picker

/// Set while a system picker is open, so a second request is answered rather than queued.
static PICKING: AtomicBool = AtomicBool::new(false);

/// Why a pick that returned false is reported as `cancelled`: `request_permission()` answers
/// only a bool, and the concrete `PortalCapture::last_error()` is out of reach behind
/// `Box<dyn CaptureBackend>`, so a dismissal, a timeout and a portal failure look the same here.
const NOT_SHARED: &str =
    "Nothing was shared. The system picker was closed, timed out or could not open; try again.";

/// Stands in for the real backend while its system picker is open.
///
/// `request_permission()` blocks for as long as the user takes (up to the portal's two-minute
/// limit). Holding the backend mutex for that long would stall every other capture command,
/// including the synchronous `permission_status` the UI polls, so the backend is taken out of
/// the mutex for the pick and this placeholder answers in its place: nothing granted yet,
/// nothing to list, and `busy:` for any capture.
struct PickerOpen {
    capabilities: Capabilities,
}

impl PickerOpen {
    fn busy() -> CaptureError {
        CaptureError::new(
            "busy",
            "The system picker is open; choose a screen or window there first",
        )
    }
}

impl CaptureBackend for PickerOpen {
    fn capabilities(&self) -> Capabilities {
        self.capabilities.clone()
    }
    fn permission(&self) -> &'static str {
        "promptOnSelect"
    }
    fn request_permission(&self) -> bool {
        false
    }
    fn enumerate(&mut self) -> Result<Vec<Source>, CaptureError> {
        Ok(Vec::new())
    }
    fn capture(&mut self, _request: &CaptureRequest) -> Result<Frame, CaptureError> {
        Err(Self::busy())
    }
}

/// Puts the real backend back and clears `PICKING`, also if the pick panics.
struct Restore<'a> {
    service: &'a Service,
    backend: Option<Box<dyn CaptureBackend>>,
}

impl Drop for Restore<'_> {
    fn drop(&mut self) {
        if let Some(backend) = self.backend.take() {
            *self
                .service
                .backend
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = backend;
        }
        PICKING.store(false, Ordering::SeqCst);
    }
}

fn not_picked(reason: &str, message: &str) -> Value {
    json!({ "picked": false, "reason": reason, "message": message })
}

/// What the sources a pick left behind mean. Pure, so the decision is testable without a portal.
#[derive(Debug)]
enum PickResult<'a> {
    One(&'a Source),
    /// The session ended before it could be listed: as good as nothing shared.
    None,
    /// The portal is asked for a single source; several would mean choosing for the user.
    Several,
}

fn pick_result(sources: &[Source]) -> PickResult<'_> {
    match sources {
        [one] => PickResult::One(one),
        [] => PickResult::None,
        _ => PickResult::Several,
    }
}

/// Open the system picker (the Wayland ScreenCast portal) and select what the user shares.
///
/// Blocking: call it on a worker. Returns `{picked: true, source, selection}` with the source
/// in the catalog's shape and `selection` as `commit` returns it, or `{picked: false, reason,
/// message}` with `reason` one of `cancelled`, `busy` (a picker is already open) or `ambiguous`.
/// A backend that lists sources itself has no picker and answers `invalid:`.
pub fn pick_source(service: &Shared) -> Result<Value, String> {
    let capabilities = service
        .backend
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .capabilities();
    if !capabilities.system_picker_required {
        return Err(
            "invalid: this capture backend lists sources itself; choose one from the list".into(),
        );
    }
    if PICKING.swap(true, Ordering::SeqCst) {
        return Ok(not_picked("busy", "The system picker is already open."));
    }
    let real = std::mem::replace(
        &mut *service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        Box::new(PickerOpen { capabilities }),
    );
    let open = Restore {
        service,
        backend: Some(real),
    };
    let granted = open
        .backend
        .as_ref()
        .is_some_and(|backend| backend.request_permission());
    drop(open);
    if !granted {
        return Ok(not_picked("cancelled", NOT_SHARED));
    }
    let sources = service
        .backend
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .enumerate()
        .map_err(err)?;
    match pick_result(&sources) {
        PickResult::One(source) => {
            // The same path as choosing a tile in the grid: keep a region saved for it.
            let selection = select_keeping_crop(service, &source.id)?;
            let desktop = platform::DesktopGeometry::current().source_to_desktop(source.clone());
            Ok(json!({ "picked": true, "source": entry(&desktop, None), "selection": selection }))
        }
        PickResult::None => Ok(not_picked("cancelled", NOT_SHARED)),
        PickResult::Several => Ok(not_picked(
            "ambiguous",
            "The system picker shared more than one source; share a single screen or window.",
        )),
    }
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

fn selection_crop_key(service: &Service, kind: &str, name: &str, app: Option<&str>) -> String {
    crate::state::shaped_crop_key(descriptor_key(kind, name, app), kind, service.source_fullscreen.load(Ordering::Relaxed))
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
    let key = crate::state::shaped_crop_key(descriptor_key(kind, name, app), kind, service.source_fullscreen.load(Ordering::Relaxed));
    saved_crop_for_key(service, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_crop_key_matches_the_commit_key() {
        let record = json!({"sourceId": "w:1", "type": "window", "name": "Game", "appName": "Steam"});
        assert_eq!(record_crop_key(&record, false).as_deref(), Some("Steam"));
        assert_eq!(record_crop_key(&record, true).as_deref(), Some("Steam (full screen)"));
        let screen = json!({"type": "screen", "name": "Built-in Display", "appName": null});
        assert_eq!(record_crop_key(&screen, true).as_deref(), Some("Built-in Display"));
        assert_eq!(record_crop_key(&json!({"name": "x"}), false), None);
    }

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
    fn only_portal_sources_are_picked_again() {
        assert!(needs_pick_again("portal:display:57", "stale_source"));
        assert!(needs_pick_again("portal:window:9", "permission"));
        assert!(!needs_pick_again("portal:window:9", "dimensions"));
        assert!(!needs_pick_again("macos:window:1:2", "stale_source"));
        assert!(!needs_pick_again("x11:window:5", "permission"));
    }

    #[test]
    fn a_stale_portal_source_is_tagged_after_its_prefix() {
        assert_eq!(
            err_for(
                "portal:display:57",
                CaptureError::new("stale_source", "Choose it again.")
            ),
            "gone: pick-again: Choose it again."
        );
        // Anything else keeps today's text exactly.
        assert_eq!(
            err_for(
                "macos:display:1",
                CaptureError::new("stale_source", "Closed.")
            ),
            "gone: Closed."
        );
        assert_eq!(
            closed("macos:window:1:2"),
            "gone: that source has closed; refresh the list and pick again"
        );
        assert!(closed("portal:window:3").starts_with("gone: pick-again: "));
    }

    #[test]
    fn a_window_out_of_view_is_hidden_not_gone_for_good() {
        // What a minimised window reports on every desktop backend (#2: an exclusive-fullscreen
        // game minimises as soon as Kimochi is clicked).
        let minimised = CaptureError::new("unavailable", "Window is minimized; restore it.");
        let error = err_for("windows:window:0x1A2B:42", minimised.clone());
        assert_eq!(error, "gone: hidden: Window is minimized; restore it.");
        assert!(!gone_for_good(&error), "a minimised game must not turn Auto OCR off");
        for id in ["macos:window:7:1", "x11:window:5"] {
            assert!(err_for(id, minimised.clone()).starts_with("gone: hidden: "), "{id}");
        }
        // A closed window is still gone for good, and stops automatic scanning as before.
        let closed_window = err_for(
            "windows:window:0x1A2B:42",
            CaptureError::new("stale_source", "Source has closed."),
        );
        assert_eq!(closed_window, "gone: Source has closed.");
        assert!(gone_for_good(&closed_window));
        assert!(gone_for_good(&closed("windows:window:0x1A2B:42")));
        // Only window sources can be out of view; a display reporting it keeps the plain text.
        assert_eq!(err_for("windows:display:0x1", minimised), "gone: Window is minimized; restore it.");
        assert!(!gone_for_good("busy: a capture is already running"));
    }

    #[test]
    fn a_pick_selects_only_a_single_shared_source() {
        let one = [source("portal:window:3", "window", "Game", None)];
        assert!(matches!(pick_result(&one), PickResult::One(s) if s.id == "portal:window:3"));
        assert!(matches!(pick_result(&[]), PickResult::None));
        let two = [
            source("portal:window:3", "window", "Game", None),
            source("portal:display:4", "display", "Screen", None),
        ];
        assert!(matches!(pick_result(&two), PickResult::Several));
    }

    #[test]
    fn the_picker_placeholder_reports_busy_and_nothing_granted() {
        let mut open = PickerOpen {
            capabilities: Capabilities {
                backend: "test",
                enumeration: false,
                system_picker_required: true,
                retained_session: true,
            },
        };
        assert_eq!(open.permission(), "promptOnSelect");
        assert!(!open.request_permission());
        assert!(open.enumerate().unwrap().is_empty());
        let Err(error) = open.capture(&CaptureRequest {
            source_id: "portal:display:1".into(),
            crop: None,
        }) else {
            panic!("a capture while the picker is open must fail");
        };
        assert!(err(error).starts_with("busy: "));
    }

    #[test]
    fn capture_errors_map_onto_the_documented_prefixes() {
        let cases = [
            ("busy", "busy:"),
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
