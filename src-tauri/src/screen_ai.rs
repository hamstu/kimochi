//! Chrome Screen AI as a selectable OCR engine (`ocrMode: "screenai"`), on every desktop OS.
//!
//! Screen AI is the on-device OCR library Chrome uses for scanned PDFs. Kimochi neither bundles
//! nor redistributes it. It uses a copy already on the computer, in this order:
//!
//!  1. Kimochi's own download (`model_store`, engine `screenai`): Google's package for this
//!     platform, fetched from Google's servers (CIPD) when the user asks, pinned by version and
//!     SHA-256 in `ocr-models.json`, so the version Kimochi was tested with;
//!  2. the copy owocr and GameSentenceMiner fetch into `~/.config/screen_ai/`;
//!  3. a browser's component (`<user data>/screen_ai/<version>/`), Chrome first.
//!
//! The library runs in `kimochi-screenai-worker` (the `screenai/` crate), never in Kimochi's
//! process: a crash or a layout change in a future library costs a scan, not the app, and on
//! macOS only the worker is signed to load a library Google signed. One worker is kept warm and
//! reused; one that fails is dropped and a new one started for the next scan. Frames go to it as
//! raw RGBA rows, with no PNG in between.
//!
//! The result has Google Lens's shape (`google_lens.rs`): one authoritative group per Screen AI
//! paragraph, its lines as `linePolygons` (rotated as the library says), each line's characters
//! with their boxes as `lineSegments`, a `line` annotation per line and the aggregate first, in the
//! pixels of the captured frame whatever size the library read it at.
use crate::model_store::{self, Engine};
use crate::state::Image;
use kimochi_screenai::{
    client::Worker,
    locate::{self, Arch, Component, Env},
    proto::{self, Direction, Line},
    wire::Request,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;

/// Loading the library and its models: about a second warm, more from a cold disk.
const STARTUP: Duration = Duration::from_secs(60);
/// One frame. The first one of a script also loads that script's recogniser.
const TIMEOUT: Duration = Duration::from_secs(30);

/// A usable copy and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub component: Component,
    /// "downloaded", "shared" (owocr's folder) or the browser's name.
    pub source: String,
    pub arch: Arch,
}

impl Found {
    fn label(&self) -> String {
        match self.source.as_str() {
            "downloaded" => "Kimochi's download".into(),
            "shared" => "the copy in ~/.config/screen_ai".into(),
            browser => format!("{browser}'s copy"),
        }
    }
}

/// The copy whose worker would not start, and why, so it is not offered again this session
/// (a browser's copy may be a version whose interface this worker does not match).
static FAILED: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);

fn failed_reason(dir: &Path) -> Option<String> {
    FAILED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(failed, _)| failed == dir)
        .map(|(_, reason)| reason.clone())
}

/// Whether this build has a worker for a library built for `arch`: its own architecture, and
/// on Windows both x64 and ARM64 (an x64 worker runs under emulation on Windows on ARM).
fn runnable(arch: Arch) -> bool {
    arch == Arch::current() || (cfg!(windows) && matches!(arch, Arch::X64 | Arch::Arm64))
}

/// The architecture to run a copy's library with, when this build can.
fn library_arch(component: &Component) -> Option<Arch> {
    let library = component.dir.join(locate::library_name(std::env::consts::OS));
    let archs = locate::library_architectures(&library);
    // A universal macOS library runs natively.
    if archs.contains(&Arch::current()) {
        return Some(Arch::current());
    }
    archs.into_iter().find(|a| runnable(*a))
}

fn found(component: Component, source: &str) -> Option<Found> {
    let arch = library_arch(&component)?;
    failed_reason(&component.dir).is_none().then(|| Found { component, source: source.into(), arch })
}

/// A copy another program put on this computer (owocr's folder, then each browser), newest
/// version per browser; `None` when there is none this build can run.
pub fn browser_copy() -> Option<Found> {
    let env = Env::current();
    let os = env.os.clone();
    let shared = locate::shared_config_root(&env)
        .and_then(|root| locate::package_in(&root, &os))
        .and_then(|c| found(c, "shared"));
    shared.or_else(|| {
        locate::browser_roots(&env)
            .into_iter()
            .filter_map(|root| locate::newest_in(&root.dir, &os).and_then(|c| found(c, root.browser)))
            .next()
    })
}

/// Kimochi's own download, when it is complete.
fn downloaded(app: &tauri::AppHandle) -> Option<Found> {
    let dir = model_store::models_dir(app, Engine::ScreenAi).ok()?;
    let file = model_store::manifest().engine(Engine::ScreenAi).files.first()?;
    let package = locate::package_in(&file.installed(&dir), std::env::consts::OS)?;
    found(package, "downloaded")
}

/// The copy to read with, or why there is none.
pub fn component(app: &tauri::AppHandle) -> Result<Found, String> {
    downloaded(app).or_else(browser_copy).ok_or_else(|| missing_reason(app))
}

fn missing_reason(app: &tauri::AppHandle) -> String {
    if let Some(reason) = FAILED.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|(_, r)| r.clone()) {
        return reason;
    }
    if !model_store::manifest().engine(Engine::ScreenAi).offered() {
        return format!(
            "Google does not publish Screen AI for {} on {}. Kimochi uses a browser's copy when one is installed.",
            os_name(),
            Arch::current().name()
        );
    }
    model_store::models_dir(app, Engine::ScreenAi)
        .err()
        .filter(|reason| reason != "Model not downloaded")
        .unwrap_or_else(|| {
            "Screen AI is not on this computer yet. Download it from Google, or let Google Chrome fetch it (chrome://components, Screen AI, Check for update).".into()
        })
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        _ => "Linux",
    }
}

/// The worker built for `arch`, bundled or (in development) staged by `prepare-screenai.mjs`.
fn worker_program(app: &tauri::AppHandle, arch: Arch) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        format!("kimochi-screenai-{}.exe", if arch == Arch::Arm64 { "arm64" } else { "x64" })
    } else {
        "kimochi-screenai-worker".to_string()
    };
    let bundled = app.path().resource_dir().map(|dir| dir.join("screenai").join(&name));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/screenai").join(&name);
    bundled
        .into_iter()
        .chain([development])
        .find(|p| p.is_file())
        .ok_or_else(|| format!("The Screen AI helper ({name}) is missing. Rebuild Kimochi with npm run bundle."))
}

/// The `ocrEngines.screenai` capability.
pub fn capability(app: &tauri::AppHandle) -> Value {
    let found = component(app);
    if let Err(reason) = worker_program(app, found.as_ref().map_or(Arch::current(), |f| f.arch)) {
        return json!({"available": false, "reason": reason});
    }
    match found {
        Ok(found) => {
            warm_if_selected(app);
            json!({
                "available": true,
                "accelerator": "cpu",
                "version": found.component.version,
                "source": found.source,
                "runtimePath": found.component.dir,
            })
        }
        Err(reason) => {
            let models = model_store::manifest().engine(Engine::ScreenAi);
            let mut value = json!({"available": false, "selectable": models.offered(), "reason": reason});
            // Held back only by the download (no copy failed): the pickers show where the download
            // stands and offer it.
            let failed = FAILED.lock().unwrap_or_else(|p| p.into_inner()).is_some();
            if let Some(state) = model_store::gate(app, Engine::ScreenAi).filter(|_| models.offered() && !failed) {
                value["model"] = json!(state);
            }
            value
        }
    }
}

struct Running {
    dir: PathBuf,
    worker: Worker,
}

static WORKER: Mutex<Option<Running>> = Mutex::new(None);
static WARMING: AtomicBool = AtomicBool::new(false);

/// Stop the worker (the downloaded package is about to be removed, or the engine changed).
pub fn unload() {
    *WORKER.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

fn start(app: &tauri::AppHandle, found: &Found) -> Result<Worker, String> {
    let program = worker_program(app, found.arch)?;
    Worker::start(&program, &found.component.dir, STARTUP, |command| {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(windows))]
        let _ = command;
    })
    .map_err(|e| {
        let reason = format!("Screen AI from {} could not start: {e}", found.label());
        *FAILED.lock().unwrap_or_else(|p| p.into_inner()) = Some((found.component.dir.clone(), reason.clone()));
        reason
    })
}

/// The running worker for `found`, started if need be.
fn worker<'a>(app: &tauri::AppHandle, slot: &'a mut Option<Running>, found: &Found) -> Result<&'a mut Worker, String> {
    if slot.as_ref().is_some_and(|r| r.dir != found.component.dir) {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(Running { dir: found.component.dir.clone(), worker: start(app, found)? });
    }
    Ok(&mut slot.as_mut().expect("just started").worker)
}

/// Start the worker in the background when Screen AI is the engine in use, so the first scan does
/// not wait for the library to load. Once per session; a later scan starts it otherwise.
fn warm_if_selected(app: &tauri::AppHandle) {
    let selected = app
        .try_state::<crate::state::Shared>()
        .is_some_and(|service| service.settings.get_or::<String>("ocrMode", String::new()) == "screenai");
    if !selected || WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("screenai-warm".into()).spawn(move || {
        if let Ok(found) = component(&app) {
            let mut slot = WORKER.lock().unwrap_or_else(|p| p.into_inner());
            if worker(&app, &mut slot, &found).is_err() {
                // The failure is recorded; announce the capability that now says so.
                drop(slot);
                announce(&app);
            }
        }
    });
}

fn announce(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Some(service) = app.try_state::<crate::state::Shared>() {
        let _ = app.emit("platform-capabilities", crate::capabilities_value(app, service.inner()));
    }
}

/// The pixels to send: the frame's own rows when it fits, else a scaled-down copy; and the
/// factor that maps the library's coordinates back to the frame's.
enum Pixels<'a> {
    Rows { data: &'a [u8], width: u32, height: u32, stride: usize },
    Owned(image::RgbaImage),
}

impl Pixels<'_> {
    fn request(&self) -> Request {
        let (width, height) = match self {
            Pixels::Rows { width, height, .. } => (*width, *height),
            Pixels::Owned(image) => image.dimensions(),
        };
        Request { width, height, flags: 0 }
    }

    fn rows(&self) -> Box<dyn Iterator<Item = &[u8]> + '_> {
        match self {
            Pixels::Rows { data, width, height, stride } => {
                Box::new(data.chunks(*stride).take(*height as usize).map(move |row| &row[..*width as usize * 4]))
            }
            Pixels::Owned(image) => Box::new(image.as_raw().chunks_exact(image.width() as usize * 4)),
        }
    }
}

/// Scale `(width, height)` so neither side exceeds `max`; 1 when it already fits.
fn fit(width: u32, height: u32, max: u32) -> f64 {
    let longest = width.max(height);
    if longest <= max || max == 0 {
        1.
    } else {
        f64::from(max) / f64::from(longest)
    }
}

fn scaled(image: &image::RgbaImage, scale: f64) -> image::RgbaImage {
    let size = |v: u32| ((f64::from(v) * scale).floor() as u32).max(1);
    image::imageops::resize(image, size(image.width()), size(image.height()), image::imageops::FilterType::Triangle)
}

/// Recognise a captured frame.
pub fn recognize(app: &tauri::AppHandle, image: &Image) -> Result<Value, String> {
    let found = component(app)?;
    // The retained frame's own rows when there are pixels; else the PNG, decoded.
    let frame = image.frame().filter(|f| {
        let info = &f.info;
        info.stride >= info.width as usize * 4 && f.pixels.len() >= info.stride * info.height as usize
    });
    let decoded = match frame {
        Some(_) => None,
        None => Some(
            image::load_from_memory_with_format(&image.png()?, image::ImageFormat::Png)
                .map_err(|e| format!("Screen AI could not decode the frame: {e}"))?
                .to_rgba8(),
        ),
    };
    let (data, width, height, stride) = match (&frame, &decoded) {
        (Some(f), _) => (&f.pixels[..], f.info.width, f.info.height, f.info.stride),
        (None, Some(d)) => (&d.as_raw()[..], d.width(), d.height(), d.width() as usize * 4),
        (None, None) => unreachable!("decoded when there is no frame"),
    };
    recognize_rows(app, &found, data, width, height, stride)
}

/// Recognise an RGB image: Auto OCR's watcher (`text_observer`), whose frames arrive converted.
pub(crate) fn recognize_rgb(app: &tauri::AppHandle, image: &image::RgbImage) -> Result<Value, String> {
    let found = component(app)?;
    let (width, height) = image.dimensions();
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for pixel in image.as_raw().chunks_exact(3) {
        rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
    }
    recognize_rows(app, &found, &rgba, width, height, width as usize * 4)
}

/// Recognise RGBA rows of `stride` bytes with the warm worker, starting it if need be.
fn recognize_rows(
    app: &tauri::AppHandle,
    found: &Found,
    data: &[u8],
    width: u32,
    height: u32,
    stride: usize,
) -> Result<Value, String> {
    if width == 0 || height == 0 {
        return Ok(value_from_lines(&[], 1., width, height));
    }
    let mut slot = WORKER.lock().unwrap_or_else(|p| p.into_inner());
    let running = worker(app, &mut slot, found)?;
    let scale = fit(width, height, running.ready.max_dimension);
    let pixels = if scale == 1. {
        Pixels::Rows { data, width, height, stride }
    } else {
        let mut copy = image::RgbaImage::new(width, height);
        for (row, out) in data.chunks(stride).zip(copy.chunks_exact_mut(width as usize * 4)) {
            out.copy_from_slice(&row[..width as usize * 4]);
        }
        Pixels::Owned(scaled(&copy, scale))
    };
    let request = pixels.request();
    // Back to the frame's pixels from the size the library read.
    let back = f64::from(width) / f64::from(request.width);
    match running.recognize(request, pixels.rows(), TIMEOUT) {
        Ok(bytes) => {
            drop(slot);
            let lines = proto::decode(&bytes)?;
            Ok(value_from_lines(&lines, back, width, height))
        }
        Err(e) => {
            // Crashed, hung or confused: never reuse it.
            *slot = None;
            Err(format!("Screen AI: {e}"))
        }
    }
}

/// Text Screen AI read, as opposed to images, separators and the like it also reports.
fn is_text(line: &Line) -> bool {
    matches!(line.content_type, 0 | 1) && !line.text.trim().is_empty()
}

/// A rectangle's corners in frame pixels, clamped to the frame.
fn frame_corners(rect: &proto::Rect, back: f64, width: u32, height: u32) -> [[f64; 2]; 4] {
    let (w, h) = (f64::from(width), f64::from(height));
    rect.corners().map(|[x, y]| [(x * back).clamp(0., w), (y * back).clamp(0., h)])
}

fn bounds(corners: &[[f64; 2]]) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for [x, y] in corners {
        b = [b[0].min(*x), b[1].min(*y), b[2].max(*x), b[3].max(*y)];
    }
    (b[2] > b[0] && b[3] > b[1]).then_some(b)
}

/// A line's characters with their boxes (the library's symbols, or a word's own box when it has
/// none), in reading order.
fn line_segments(line: &Line, back: f64, width: u32, height: u32) -> Vec<Value> {
    line.words
        .iter()
        .flat_map(|word| {
            let parts: Vec<(&str, &proto::Rect)> = if word.symbols.is_empty() {
                vec![(word.text.as_str(), &word.bounding_box)]
            } else {
                word.symbols.iter().map(|s| (s.text.as_str(), &s.bounding_box)).collect()
            };
            parts
                .into_iter()
                .filter_map(|(text, rect)| {
                    let text = text.trim();
                    let bbox = bounds(&frame_corners(rect, back, width, height))?;
                    (!text.is_empty()).then(|| json!({"text": text, "bbox": bbox}))
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The result value for the library's `lines`, read from an image `1 / back` the frame's size.
fn value_from_lines(lines: &[Line], back: f64, width: u32, height: u32) -> Value {
    let mut groups = Vec::new();
    let mut annotations = Vec::new();
    let mut texts = Vec::new();
    // A paragraph is the run of lines sharing a block and paragraph id, in the library's order.
    let mut paragraphs: Vec<Vec<&Line>> = Vec::new();
    for line in lines.iter().filter(|l| is_text(l)) {
        match paragraphs.last_mut() {
            Some(last) if last[0].block_id == line.block_id && last[0].paragraph_id == line.paragraph_id => {
                last.push(line)
            }
            _ => paragraphs.push(vec![line]),
        }
    }
    for (index, paragraph) in paragraphs.iter().enumerate() {
        let id = format!("screenai-paragraph-{index}");
        let placed: Vec<(&Line, [[f64; 2]; 4])> = paragraph
            .iter()
            .map(|line| (*line, frame_corners(&line.bounding_box, back, width, height)))
            .filter(|(_, corners)| bounds(corners).is_some())
            .collect();
        let text = paragraph.iter().map(|l| l.text.trim()).collect::<Vec<_>>().join("\n");
        texts.push(text.clone());
        if placed.is_empty() {
            continue;
        }
        let vertical = placed.iter().all(|(line, corners)| {
            line.direction == Direction::TopToBottom
                || (line.direction == Direction::Unspecified
                    && bounds(corners)
                        .is_some_and(|b| line.text.trim().chars().count() > 1 && b[3] - b[1] > (b[2] - b[0]) * 1.5))
        });
        let orientation = if vertical { "vertical" } else { "horizontal" };
        let polygons: Vec<[[f64; 2]; 4]> = placed.iter().map(|(_, c)| *c).collect();
        let segments: Vec<Vec<Value>> =
            placed.iter().map(|(line, _)| line_segments(line, back, width, height)).collect();
        let bbox = bounds(&polygons.concat());
        let confidence = placed.iter().map(|(l, _)| f64::from(l.confidence)).fold(f64::INFINITY, f64::min);
        groups.push(json!({
            "id": id,
            "text": text,
            "bbox": bbox,
            "orientation": orientation,
            "confidence": confidence,
            "linePolygons": polygons,
            "lineSegments": segments,
        }));
        for (line, polygon) in &placed {
            annotations.push(json!({
                "description": line.text.trim(),
                "boundingPoly": {"vertices": polygon.iter().map(|[x, y]| json!({"x": x, "y": y})).collect::<Vec<_>>()},
                "orientation": orientation,
                "isVertical": vertical,
                "granularity": "line",
                "groupId": id,
                "confidence": line.confidence,
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
    json!({
        "fullText": text,
        "textAnnotations": annotations,
        "groups": groups,
        "engine": "screenai",
        "geometry": !annotations.is_empty(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimochi_screenai::proto::{Rect, Symbol, Word};

    fn line(text: &str, rect: Rect, block: i32, paragraph: i32, direction: Direction) -> Line {
        let symbols = text
            .chars()
            .enumerate()
            .map(|(i, c)| Symbol {
                text: c.to_string(),
                bounding_box: if direction == Direction::TopToBottom {
                    Rect {
                        x: rect.x,
                        y: rect.y + i as i32 * rect.width,
                        width: rect.width,
                        height: rect.width,
                        angle: 0.,
                    }
                } else {
                    Rect {
                        x: rect.x + i as i32 * rect.height,
                        y: rect.y,
                        width: rect.height,
                        height: rect.height,
                        angle: 0.,
                    }
                },
                confidence: 1.,
            })
            .collect();
        Line {
            text: text.into(),
            bounding_box: rect,
            words: vec![Word { text: text.into(), bounding_box: rect, symbols, ..Word::default() }],
            block_id: block,
            paragraph_id: paragraph,
            direction,
            confidence: 0.9,
            ..Line::default()
        }
    }

    #[test]
    fn a_paragraphs_lines_become_one_group_with_their_characters() {
        let lines = [
            line("今日は", Rect { x: 10, y: 10, width: 60, height: 20, angle: 0. }, 0, 0, Direction::LeftToRight),
            line("晴れ", Rect { x: 10, y: 40, width: 40, height: 20, angle: 0. }, 0, 0, Direction::LeftToRight),
            line("猫", Rect { x: 10, y: 90, width: 20, height: 20, angle: 0. }, 1, 0, Direction::LeftToRight),
        ];
        let value = value_from_lines(&lines, 1., 200, 200);
        assert_eq!(value["fullText"], "今日は\n晴れ\n猫");
        let groups = value["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["text"], "今日は\n晴れ");
        assert_eq!(groups[0]["linePolygons"].as_array().unwrap().len(), 2);
        assert_eq!(groups[0]["lineSegments"][0].as_array().unwrap().len(), 3);
        assert_eq!(groups[0]["lineSegments"][0][1], json!({"text": "日", "bbox": [30.0, 10.0, 50.0, 30.0]}));
        assert_eq!(groups[0]["bbox"], json!([10.0, 10.0, 70.0, 60.0]));
        let annotations = value["textAnnotations"].as_array().unwrap();
        assert_eq!(annotations[0]["granularity"], "aggregate");
        assert_eq!(annotations.len(), 4);
        assert_eq!(annotations[3]["groupId"], "screenai-paragraph-1");
    }

    #[test]
    fn top_to_bottom_lines_are_vertical() {
        let lines =
            [line("吾輩は猫", Rect { x: 100, y: 10, width: 30, height: 120, angle: 0. }, 0, 0, Direction::TopToBottom)];
        let value = value_from_lines(&lines, 1., 300, 300);
        assert_eq!(value["groups"][0]["orientation"], "vertical");
        assert_eq!(value["textAnnotations"][1]["isVertical"], true);
    }

    #[test]
    fn coordinates_return_to_the_frame_from_a_scaled_read() {
        let lines = [line("猫", Rect { x: 10, y: 20, width: 30, height: 30, angle: 0. }, 0, 0, Direction::LeftToRight)];
        let value = value_from_lines(&lines, 2., 400, 400);
        assert_eq!(value["groups"][0]["bbox"], json!([20.0, 40.0, 80.0, 100.0]));
        assert_eq!(value["groups"][0]["lineSegments"][0][0]["bbox"], json!([20.0, 40.0, 80.0, 100.0]));
    }

    #[test]
    fn images_and_empty_lines_are_not_text() {
        let mut picture =
            line("x", Rect { x: 0, y: 0, width: 10, height: 10, angle: 0. }, 0, 0, Direction::LeftToRight);
        picture.content_type = 2;
        let blank = line("  ", Rect { x: 0, y: 20, width: 10, height: 10, angle: 0. }, 0, 0, Direction::LeftToRight);
        let value = value_from_lines(&[picture, blank], 1., 100, 100);
        assert_eq!(value["fullText"], "");
        assert!(value["groups"].as_array().unwrap().is_empty());
        assert!(value["textAnnotations"].as_array().unwrap().is_empty());
        assert_eq!(value["geometry"], false);
    }

    #[test]
    fn large_frames_are_scaled_to_the_librarys_limit() {
        assert_eq!(fit(1920, 1080, 2048), 1.);
        assert_eq!(fit(4096, 2160, 2048), 0.5);
        assert_eq!(fit(1000, 4096, 2048), 0.5);
    }

    /// Reads the overlay-alignment fixtures with Screen AI and with MeikiOCR, and prints each
    /// engine's text and median time. Needs the worker built (`npm run prepare:screenai`), a
    /// Screen AI copy (`SCREENAI_DIR`, the directory holding the library) and, for MeikiOCR, the
    /// staged runtime and `MEIKIOCR_MODEL_DIR`.
    #[test]
    #[ignore = "manual benchmark: needs SCREENAI_DIR, the staged worker, and MeikiOCR's runtime and models"]
    fn benchmark_against_meikiocr() {
        use std::time::Instant;
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/overlay-alignment");
        let program = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "resources/screenai/{}",
            if cfg!(windows) { "kimochi-screenai-x64.exe" } else { "kimochi-screenai-worker" }
        ));
        let dir = PathBuf::from(std::env::var("SCREENAI_DIR").expect("SCREENAI_DIR"));
        let started = Instant::now();
        let mut worker = Worker::start(&program, &dir, STARTUP, |_| {}).unwrap();
        println!("Screen AI {} ready in {:?}", worker.ready.version(), started.elapsed());
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/meikiocr");
        let mut meiki = std::env::var("MEIKIOCR_MODEL_DIR").ok().map(|models| {
            crate::meiki_ocr::initialize_runtime(&root).unwrap();
            meikiocr::MeikiOcr::new(meikiocr::ModelPaths::from_dir(models)).unwrap()
        });
        let median = |mut v: Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v[v.len() / 2]
        };
        for name in ["dialogue", "halfwidth", "katakana", "large", "pixel", "small", "vertical"] {
            let rgba = image::open(fixtures.join(format!("{name}.png"))).unwrap().to_rgba8();
            let (w, h) = rgba.dimensions();
            let request = Request { width: w, height: h, flags: 0 };
            let mut times = Vec::new();
            let mut text = String::new();
            for _ in 0..7 {
                let t = Instant::now();
                let bytes = worker.recognize(request, rgba.as_raw().chunks_exact(w as usize * 4), TIMEOUT).unwrap();
                let value = value_from_lines(&proto::decode(&bytes).unwrap(), 1., w, h);
                times.push(t.elapsed().as_secs_f64() * 1e3);
                text = value["fullText"].as_str().unwrap().replace('\n', " / ");
            }
            println!("{name:10} {w}×{h}  screenai {:6.1} ms  {text}", median(times));
            // `SCREENAI_DUMP=<dir>`: also save each raw result, for
            // `node scripts/measure-overlay-alignment.mjs normalize <raw> screenai <fixture>`.
            if let Some(dump) = std::env::var_os("SCREENAI_DUMP") {
                let bytes = worker.recognize(request, rgba.as_raw().chunks_exact(w as usize * 4), TIMEOUT).unwrap();
                let value = value_from_lines(&proto::decode(&bytes).unwrap(), 1., w, h);
                std::fs::write(PathBuf::from(dump).join(format!("{name}.json")), value.to_string()).unwrap();
            }
            if let Some(engine) = meiki.as_mut() {
                let rgb = image::DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
                let mut times = Vec::new();
                let mut text = String::new();
                for _ in 0..7 {
                    let t = Instant::now();
                    let lines = crate::meiki_ocr::infer(engine, &rgb).unwrap();
                    times.push(t.elapsed().as_secs_f64() * 1e3);
                    text = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" / ");
                }
                println!("{:10} {w}×{h}  meikiocr {:6.1} ms  {text}", "", median(times));
            }
        }
    }
}
