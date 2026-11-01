//! Screenshots: the whole source as it was when a scan was read, kept for the newest scans, so
//! each Log line can show the picture its text came from (with what OCR saw drawn on it) and the
//! cards mined from it can carry that picture.
//!
//! - **Taking**: `history_add` hands each new scan here (`taken`). The scan's own frame is cropped
//!   to the OCR crop area, so the source is captured again, whole, straight after; the OCR boxes
//!   are moved from the crop's pixels into the picture's. A Quick Shot's source is its display.
//! - **Keeping**: JPEG files in `<app local data>/screenshots/`, indexed by `shots.json`, the newest
//!   `cardScreenshot.kept`. Served at `capture://localhost/shot/<scan>` (the picture) and
//!   `…/shot/<scan>/card` (what a card gets: the Anki crop area, if the source has one, at card
//!   size). Announced as `screenshot-added`.
//! - **Cards**: after a card is added (a dictionary extension's `addNote` through the AnkiConnect
//!   relay, or Kimochi's own pop-up through `screenshot_attach`), the scan whose text matches the
//!   card's sentence puts its picture in the card's picture field, when that is empty.
//!   Hachidori's own screenshot (`capture_frame_source`) is the same card picture.
//!
//! Settings: `cardScreenshot` `{enabled, field, kept}`.
use crate::reader::ankiconnect;
use crate::settings::Settings;
use base64::Engine as _;
use kimochi_capture::audio::now_ms;
use kimochi_speech::timeline;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub const KEY: &str = "cardScreenshot";
/// The enhancement's mark on a card in the Anki tab (`anki_cards`).
pub const SCREENSHOT: &str = "screenshot";
/// The kept picture's longest edge: sharp on any screen, a few hundred KB.
const KEEP_EDGE: u32 = 1920;
const KEEP_QUALITY: u8 = 85;
/// A card's picture: enough to recognise the scene without bloating the collection.
const CARD_EDGE: u32 = 1280;
const CARD_QUALITY: u8 = 80;
/// How recent the newest screenshot must be to go on a card no scan's text matches: a card
/// mined minutes after the line was read still gets it, one mined from elsewhere much later not.
const NEWEST_FOR_CARD_MS: f64 = 10.0 * 60.0 * 1000.0;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    /// The note field the picture goes in.
    pub field: String,
    /// Screenshots kept on disk.
    pub kept: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self { enabled: true, field: "Picture".into(), kept: 50 }
    }
}

impl Config {
    pub fn load(settings: &Settings) -> Self {
        let mut config: Config =
            settings.get(KEY).ok().flatten().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        config.kept = config.kept.clamp(10, 500);
        config.field = config.field.trim().to_string();
        config
    }
}

/// Where OCR read text on a screenshot: `bbox` `[x0, y0, x1, y1]` in the picture's pixels.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub text: String,
    pub bbox: [f64; 4],
    #[serde(default)]
    pub vertical: bool,
}

/// One scan's screenshot, as the index keeps it and the Log reads it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// The scan's history entry id: its Log lines' `ocr.scanId`.
    pub scan: String,
    pub file: String,
    /// Unix ms.
    pub at: f64,
    pub width: u32,
    pub height: u32,
    /// The scan's text, to find the scan a card was mined from.
    pub text: String,
    /// The OCR crop area in the picture's pixels `[x, y, width, height]`; none: the whole source.
    #[serde(default)]
    pub crop: Option<[f64; 4]>,
    #[serde(default)]
    pub marks: Vec<Mark>,
    /// The source's crop key, for its Anki crop area; none for a Quick Shot.
    #[serde(default)]
    pub key: Option<String>,
    /// Where the Log loads the picture (`capture:` differs by platform); not kept.
    #[serde(default, skip_deserializing, skip_serializing_if = "String::is_empty")]
    pub url: String,
}

impl Shot {
    fn served(mut self) -> Self {
        self.url = crate::platform::capture_url(&format!("shot/{}", self.scan));
        self
    }
}

/// What happened to the last card's picture, for Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCard {
    pub at: f64,
    pub ok: bool,
    pub message: String,
}

pub struct Screenshots {
    dir: PathBuf,
    settings: Arc<Settings>,
    shots: Mutex<Vec<Shot>>,
    last: Mutex<Option<LastCard>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// What `taken` needs from the scan.
pub struct Scan {
    pub id: String,
    pub text: String,
    /// The OCR groups as `history_add` got them (boxes in the scan frame's pixels).
    pub groups: Vec<crate::ocr_result::OcrGroup>,
    /// The scan frame's `FrameInfo` (with `capturedAt`), when the image store still held it.
    pub info: Option<Value>,
    /// A Quick Shot: its source is a display, and it has no crop key.
    pub detached: bool,
}

impl Screenshots {
    pub fn open(dir: PathBuf, settings: Arc<Settings>) -> Arc<Self> {
        let shots = std::fs::read(dir.join("shots.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Shot>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|shot| dir.join(&shot.file).is_file())
            .collect();
        Arc::new(Self { dir, settings, shots: Mutex::new(shots), last: Mutex::new(None) })
    }

    pub fn config(&self) -> Config {
        Config::load(&self.settings)
    }

    pub fn list(&self) -> Vec<Shot> {
        lock(&self.shots).iter().cloned().map(Shot::served).collect()
    }

    pub fn get(&self, scan: &str) -> Option<Shot> {
        lock(&self.shots).iter().find(|s| s.scan == scan).cloned()
    }

    pub fn newest(&self) -> Option<Shot> {
        lock(&self.shots).last().cloned()
    }

    pub fn read(&self, shot: &Shot) -> Option<Vec<u8>> {
        std::fs::read(self.dir.join(&shot.file)).ok()
    }

    /// Keep `shot` with its JPEG, the newest last, and let the oldest beyond `kept` go.
    fn put(&self, shot: Shot, jpeg: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        std::fs::write(self.dir.join(&shot.file), jpeg).map_err(|e| e.to_string())?;
        let mut shots = lock(&self.shots);
        shots.retain(|s| s.scan != shot.scan);
        shots.push(shot);
        let keep = self.config().kept;
        let over = shots.len().saturating_sub(keep);
        let gone: Vec<Shot> = shots.drain(..over).collect();
        self.save(&shots)?;
        drop(shots);
        for shot in gone {
            let _ = std::fs::remove_file(self.dir.join(&shot.file));
        }
        Ok(())
    }

    /// The setting's `kept` went down: the oldest beyond it go now.
    pub fn settings_changed(&self) {
        let keep = self.config().kept;
        let mut shots = lock(&self.shots);
        if shots.len() <= keep {
            return;
        }
        let over = shots.len() - keep;
        let gone: Vec<Shot> = shots.drain(..over).collect();
        let _ = self.save(&shots);
        drop(shots);
        for shot in gone {
            let _ = std::fs::remove_file(self.dir.join(&shot.file));
        }
    }

    fn save(&self, shots: &[Shot]) -> Result<(), String> {
        let tmp = self.dir.join("shots.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(shots).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, self.dir.join("shots.json")).map_err(|e| e.to_string())
    }

    fn note(&self, ok: bool, message: impl Into<String>) {
        let message = message.into();
        if !ok {
            eprintln!("[screenshot] {message}");
        }
        *lock(&self.last) = Some(LastCard { at: now_ms(), ok, message });
    }

    pub fn last(&self) -> Option<LastCard> {
        lock(&self.last).clone()
    }

    /// The kept scan a card with these fields was mined from: the one whose text matches the
    /// card's best, the newest on a tie.
    pub fn for_card(&self, fields: &[(String, String)]) -> Option<Shot> {
        let texts: Vec<&str> = fields.iter().map(|(_, v)| v.as_str()).collect();
        let mut best: Option<(&Shot, u8)> = None;
        let shots = lock(&self.shots);
        for shot in shots.iter() {
            let score = timeline::card_score(&shot.text, &texts);
            if score > 0 && score >= best.map_or(0, |(_, s)| s) {
                best = Some((shot, score));
            }
        }
        best.map(|(shot, _)| shot.clone())
    }

    /// The screenshot a new card gets: the scan it names, else the scan its text matches, else
    /// the newest one when it was taken in the last few minutes. A dictionary's sentence is often
    /// only part of the scan's text (cut at a line or a run of the overlay), too little to match.
    pub fn pick_for_card(&self, fields: &[(String, String)], scan: Option<&str>, now: f64) -> Option<Shot> {
        scan.and_then(|s| self.get(s))
            .or_else(|| self.for_card(fields))
            .or_else(|| self.newest().filter(|shot| now - shot.at <= NEWEST_FOR_CARD_MS))
    }
}

/// `scan`'s picture as a card gets it: the source's Anki crop area when it has one, no larger
/// than `CARD_EDGE`, as JPEG.
pub fn card_picture(app: &tauri::AppHandle, shot: &Shot) -> Result<Vec<u8>, String> {
    let service = app.try_state::<Arc<Screenshots>>().ok_or("Screenshots are not available.")?;
    let jpeg = service.read(shot).ok_or("The screenshot is no longer kept.")?;
    let mut picture = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| format!("The screenshot could not be read: {e}"))?
        .to_rgb8();
    let anki_crop = shot.key.as_deref().and_then(|key| {
        let state = app.try_state::<crate::state::Shared>()?;
        crate::sources::anki_crop_for_key(&state, key)
    });
    if let Some(crop) = anki_crop {
        if let Some([x, y, w, h]) = scaled_crop(&crop, picture.width(), picture.height()) {
            picture = image::imageops::crop_imm(&picture, x, y, w, h).to_image();
        }
    }
    encode(picture, CARD_EDGE, CARD_QUALITY)
}

/// A saved crop (pixels against its own reference size) in a `width`×`height` picture of the
/// same source; none when it falls outside it.
fn scaled_crop(crop: &kimochi_capture::Crop, width: u32, height: u32) -> Option<[u32; 4]> {
    if crop.reference_width == 0 || crop.reference_height == 0 {
        return None;
    }
    let (sx, sy) = (width as f64 / crop.reference_width as f64, height as f64 / crop.reference_height as f64);
    let x = ((crop.x as f64 * sx).round() as u32).min(width);
    let y = ((crop.y as f64 * sy).round() as u32).min(height);
    let w = ((crop.width as f64 * sx).round() as u32).min(width - x);
    let h = ((crop.height as f64 * sy).round() as u32).min(height - y);
    (w >= 8 && h >= 8).then_some([x, y, w, h])
}

/// Shrink `picture` to at most `edge` on its longest side, and encode it as JPEG.
fn encode(picture: image::RgbImage, edge: u32, quality: u8) -> Result<Vec<u8>, String> {
    let (w, h) = picture.dimensions();
    let picture = if w.max(h) > edge {
        let scale = edge as f64 / w.max(h) as f64;
        let (nw, nh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
        image::imageops::resize(&picture, nw, nh, image::imageops::FilterType::Triangle)
    } else {
        picture
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&picture)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// The scan's OCR boxes, from its frame's pixels (the OCR crop) into the picture's: offset by the
/// crop's place in the source, scaled from the source's size to the picture's.
fn marks(groups: &[crate::ocr_result::OcrGroup], info: Option<&Value>, width: u32, height: u32) -> (Option<[f64; 4]>, Vec<Mark>) {
    let Some(info) = info else { return (None, Vec::new()) };
    let num = |v: &Value| v.as_f64();
    let full_w = info.get("full_width").and_then(num).filter(|v| *v > 0.0).unwrap_or(width as f64);
    let full_h = info.get("full_height").and_then(num).filter(|v| *v > 0.0).unwrap_or(height as f64);
    let (sx, sy) = (width as f64 / full_w, height as f64 / full_h);
    let crop: Option<[f64; 4]> = info.get("crop_pixels").and_then(Value::as_array).and_then(|c| {
        let c: Vec<f64> = c.iter().filter_map(num).collect();
        (c.len() == 4).then(|| [c[0], c[1], c[2], c[3]])
    });
    let (ox, oy) = crop.map_or((0.0, 0.0), |c| (c[0], c[1]));
    // A crop that is the whole source is no crop.
    let shown = crop.filter(|c| c[2] < full_w - 1.0 || c[3] < full_h - 1.0).map(|c| [c[0] * sx, c[1] * sy, c[2] * sx, c[3] * sy]);
    let marks = groups
        .iter()
        .filter_map(|g| {
            let b = g.bbox?;
            Some(Mark {
                text: g.text.clone(),
                bbox: [(b[0] + ox) * sx, (b[1] + oy) * sy, (b[2] + ox) * sx, (b[3] + oy) * sy],
                vertical: matches!(g.orientation, crate::ocr_result::Orientation::Vertical),
            })
        })
        .collect();
    (shown, marks)
}

/// A new scan reached the history: capture its source whole, in the background, and keep it.
pub fn taken(app: &tauri::AppHandle, scan: Scan) {
    if app.try_state::<Arc<Screenshots>>().is_none() {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("screenshot".into())
        .spawn(move || {
            if let Err(e) = take(&app, scan) {
                eprintln!("[screenshot] not kept: {e}");
            }
        })
        .ok();
}

fn take(app: &tauri::AppHandle, scan: Scan) -> Result<(), String> {
    let service = app.try_state::<Arc<Screenshots>>().ok_or("no store")?.inner().clone();
    let state = app.try_state::<crate::state::Shared>().ok_or("no state")?;
    let source_id = scan
        .info
        .as_ref()
        .and_then(|i| i.get("source_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| state.selection.lock().ok()?.clone())
        .ok_or("no source")?;
    let frame = crate::sources::capture_whole(&state, &source_id)?;
    let picture = crate::text_observer::rgb_image(&frame).map_err(|e| e.message)?;
    let full = (frame.info.width, frame.info.height);
    let jpeg = encode(picture, KEEP_EDGE, KEEP_QUALITY)?;
    // The size it was kept at.
    let scale = (KEEP_EDGE as f64 / full.0.max(full.1) as f64).min(1.0);
    let (width, height) = (((full.0 as f64 * scale).round() as u32).max(1), ((full.1 as f64 * scale).round() as u32).max(1));
    let (crop, marks) = marks(&scan.groups, scan.info.as_ref(), width, height);
    let key = if scan.detached { None } else { crate::sources::current_crop_key(&state) };
    let shot = Shot {
        scan: scan.id.clone(),
        file: format!("shot-{}.jpg", now_ms() as u64),
        at: scan.info.as_ref().and_then(|i| i.get("capturedAt")).and_then(Value::as_f64).unwrap_or_else(now_ms),
        width,
        height,
        text: scan.text,
        crop,
        marks,
        key,
        url: String::new(),
    };
    service.put(shot.clone(), &jpeg)?;
    let _ = app.emit("screenshot-added", &shot.served());
    Ok(())
}

/// Put `shot`'s card picture in note `note_id`'s picture field (`field`, or the configured one)
/// when the note has that field and it is empty.
async fn attach(app: tauri::AppHandle, anki: crate::sentence_audio::Anki, note_id: u64, shot: Shot, field: String) -> Result<String, String> {
    if field.is_empty() {
        return Err("No picture field is set in Settings → Anki.".into());
    }
    let call = |action: &'static str, params: Value| {
        let (url, key) = (anki.url.clone(), anki.key.clone());
        async move { ankiconnect::action(&url, key.as_deref(), action, params).await }
    };
    let empty = |info: &Value| -> Option<bool> {
        let fields = info.get(0)?.get("fields")?;
        Some(fields.get(&field)?.get("value").and_then(Value::as_str).is_none_or(|v| v.trim().is_empty()))
    };
    let info = call("notesInfo", json!({ "notes": [note_id] })).await?;
    match empty(&info) {
        None if info.get(0).and_then(|n| n.get("fields")).is_none() => return Err("Anki did not find the new card.".into()),
        None => return Err(format!("The card's note type has no “{field}” field, so no screenshot was added.")),
        Some(false) => return Ok(format!("The card's “{field}” field was already filled; left as it was.")),
        Some(true) => {}
    }
    let picture_app = app.clone();
    let picture_shot = shot.clone();
    let jpeg = tauri::async_runtime::spawn_blocking(move || card_picture(&picture_app, &picture_shot))
        .await
        .map_err(|e| e.to_string())??;
    let filename = format!("kimochi_{}.jpg", now_ms() as u64);
    let data = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    call("storeMediaFile", json!({ "filename": filename, "data": data })).await?;
    // Filled meanwhile (by hand, or the extension's own picture): left as it is.
    let info = call("notesInfo", json!({ "notes": [note_id] })).await?;
    if empty(&info) != Some(true) {
        return Ok(format!("The card's “{field}” field was filled meanwhile; left as it was."));
    }
    let mut fields = serde_json::Map::new();
    fields.insert(field.clone(), json!(format!("<img src=\"{filename}\">")));
    call("updateNoteFields", json!({ "note": { "id": note_id, "fields": fields } })).await?;
    crate::anki_cards::enhanced(note_id, &[SCREENSHOT]);
    Ok(format!("Added the screenshot to “{field}”."))
}

/// Attach the picture of the scan a card was mined from (found by its fields, or named by
/// `scan`), reporting how it went in the status.
fn spawn_attach(app: &tauri::AppHandle, anki: crate::sentence_audio::Anki, note_id: u64, fields: Vec<(String, String)>, scan: Option<String>, field: Option<String>) {
    let Some(service) = app.try_state::<Arc<Screenshots>>() else { return };
    let service = service.inner().clone();
    let config = service.config();
    let field = field.filter(|f| !f.trim().is_empty()).unwrap_or(config.field);
    let Some(shot) = service.pick_for_card(&fields, scan.as_deref(), now_ms()) else {
        service.note(true, "No recent screenshot matches the card, so none was added.");
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match attach(app, anki, note_id, shot, field).await {
            Ok(message) => service.note(true, message),
            Err(message) => service.note(false, message),
        }
    });
}

/// After the relay carried a dictionary extension's request: a card AnkiConnect added gets its
/// scan's screenshot.
pub fn after_relay(app: &tauri::AppHandle, url: &str, request: &Value, reply_status: u16, reply_body: &str) {
    let Some(service) = app.try_state::<Arc<Screenshots>>() else { return };
    if !service.config().enabled {
        return;
    }
    let Some((anki, note_id, fields)) = crate::sentence_audio::added_card(url, request, reply_status, reply_body) else {
        return;
    };
    spawn_attach(app, anki, note_id, fields, None, None);
}

// ---------------------------------------------------------------- commands

/// Every kept screenshot, oldest first, for the Log.
#[tauri::command]
pub fn screenshots_list(service: tauri::State<'_, Arc<Screenshots>>) -> Vec<Shot> {
    service.list()
}

/// How the last card's screenshot went, for Settings.
#[tauri::command]
pub fn screenshot_status(service: tauri::State<'_, Arc<Screenshots>>) -> Value {
    json!({ "kept": service.list().len(), "last": service.last() })
}

/// Kimochi's pop-up added note `note_id` from `sentence` (read in scan `scan`, when known): its
/// screenshot follows, into `field` (a field mapped to the screenshot) or the configured field.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a command's arguments are its parameters, by name
pub fn screenshot_attach(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Screenshots>>,
    settings: tauri::State<'_, crate::state::Shared>,
    url: String,
    note_id: u64,
    sentence: Option<String>,
    scan: Option<String>,
    field: Option<String>,
) {
    if !service.config().enabled {
        return;
    }
    let (_, key) = ankiconnect::configured(&settings.settings);
    let fields = sentence.into_iter().map(|s| ("Sentence".to_string(), s)).collect();
    spawn_attach(&app, crate::sentence_audio::Anki { url, key }, note_id, fields, scan, field);
}

/// The Anki tab's Add screenshot, for a card made without one: the note's fields are read back
/// from Anki and its scan's screenshot put in its empty picture field.
#[tauri::command]
pub async fn screenshot_add_to_note(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Screenshots>>,
    settings: tauri::State<'_, crate::state::Shared>,
    note_id: u64,
) -> Result<(), String> {
    let (url, key) = ankiconnect::configured(&settings.settings);
    let info = ankiconnect::action(&url, key.as_deref(), "notesInfo", json!({ "notes": [note_id] })).await?;
    let fields: Vec<(String, String)> = info
        .get(0)
        .and_then(|n| n.get("fields"))
        .and_then(Value::as_object)
        .ok_or("Anki did not find the card.")?
        .iter()
        .map(|(name, f)| (name.clone(), f.get("value").and_then(Value::as_str).unwrap_or_default().to_string()))
        .collect();
    let service = service.inner().clone();
    let shot = service.for_card(&fields).ok_or("No kept screenshot is from this card's sentence.")?;
    let field = service.config().field;
    match attach(app, crate::sentence_audio::Anki { url, key }, note_id, shot, field).await {
        Ok(message) if message.starts_with("Added") => {
            service.note(true, message);
            Ok(())
        }
        Ok(message) => Err(message),
        Err(message) => {
            service.note(false, message.clone());
            Err(message)
        }
    }
}

/// `capture:` protocol paths under `shot/`: `<scan>` the kept picture, `<scan>/card` a card's.
pub fn serve(app: &tauri::AppHandle, path: &str) -> Option<Vec<u8>> {
    let service = app.try_state::<Arc<Screenshots>>()?;
    let (scan, card) = match path.strip_suffix("/card") {
        Some(scan) => (scan, true),
        None => (path, false),
    };
    let shot = service.get(scan)?;
    if card {
        card_picture(app, &shot).ok()
    } else {
        service.read(&shot)
    }
}

pub fn install(app: &tauri::AppHandle, settings: Arc<Settings>) -> Arc<Screenshots> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map(|d| d.join("screenshots"))
        .unwrap_or_else(|_| std::env::temp_dir().join("kimochi-screenshots"));
    Screenshots::open(dir, settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr_result::{OcrGroup, Orientation};

    #[test]
    fn ocr_boxes_move_from_the_crop_into_the_picture() {
        let info = json!({ "full_width": 2000, "full_height": 1000, "crop_pixels": [400, 600, 1200, 300] });
        let group = OcrGroup {
            id: "g".into(),
            text: "猫".into(),
            bbox: Some([10.0, 20.0, 110.0, 70.0]),
            orientation: Orientation::Horizontal,
            confidence: None,
            line_polygons: None,
        };
        // Kept at half size.
        let (crop, found) = marks(&[group], Some(&info), 1000, 500);
        assert_eq!(crop, Some([200.0, 300.0, 600.0, 150.0]));
        assert_eq!(found[0].bbox, [205.0, 310.0, 255.0, 335.0]);
        let whole = json!({ "full_width": 2000, "full_height": 1000, "crop_pixels": [0, 0, 2000, 1000] });
        assert_eq!(marks(&[], Some(&whole), 1000, 500).0, None, "a crop of everything is no crop");
    }

    #[test]
    fn an_anki_crop_is_scaled_to_the_picture() {
        let crop = kimochi_capture::Crop { x: 100, y: 50, width: 400, height: 200, reference_width: 1000, reference_height: 500 };
        assert_eq!(scaled_crop(&crop, 2000, 1000), Some([200, 100, 800, 400]));
        let outside = kimochi_capture::Crop { x: 998, y: 0, width: 2, height: 2, reference_width: 1000, reference_height: 500 };
        assert_eq!(scaled_crop(&outside, 1000, 500), None);
    }

    #[test]
    fn the_newest_kept_shots_stay_and_a_card_finds_its_scan() {
        let dir = std::env::temp_dir().join(format!("kimochi-screenshots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let settings = Arc::new(Settings::load(dir.join("settings.json")));
        settings.set(KEY, json!({ "kept": 10 })).unwrap();
        let store = Screenshots::open(dir.join("shots"), settings);
        let shot = |i: usize, text: &str| Shot {
            scan: format!("s{i}"),
            file: format!("shot-{i}.jpg"),
            at: i as f64,
            width: 4,
            height: 4,
            text: text.into(),
            crop: None,
            marks: Vec::new(),
            key: None,
            url: String::new(),
        };
        for i in 0..12 {
            store.put(shot(i, if i == 5 { "猫が好きです。" } else { "今日はいい天気ですね。" }), b"jpeg").unwrap();
        }
        let kept: Vec<String> = store.list().into_iter().map(|s| s.scan).collect();
        assert_eq!(kept.len(), 10);
        assert_eq!(kept[0], "s2");
        assert!(!dir.join("shots/shot-0.jpg").exists());
        let card = vec![("Sentence".to_string(), "<b>猫</b>が好きです。".to_string())];
        assert_eq!(store.for_card(&card).unwrap().scan, "s5");
        // A sentence cut too short to match gets the newest shot, while it is recent.
        let cut = vec![("Sentence".to_string(), "原始の~".to_string()), ("Expression".to_string(), "原始".to_string())];
        assert!(store.for_card(&cut).is_none());
        assert_eq!(store.pick_for_card(&cut, None, 11.0).unwrap().scan, "s11");
        assert!(store.pick_for_card(&cut, None, 11.0 + NEWEST_FOR_CARD_MS + 1.0).is_none());
        assert_eq!(store.pick_for_card(&cut, Some("s4"), 11.0).unwrap().scan, "s4");
        // Reopened from disk.
        let again = Screenshots::open(dir.join("shots"), Arc::new(Settings::load(dir.join("settings.json"))));
        assert_eq!(again.list().len(), 10);
        let _ = std::fs::remove_dir_all(dir);
    }
}
