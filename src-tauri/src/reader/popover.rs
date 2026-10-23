// popover.rs — orchestrates showing/positioning the popover window and
// pushes Yomitan lookup data to it via events.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

const POPOVER_LABEL: &str = "reader-popup";

/// How many pop-ups can stand on one another: the first, and a word Shift-scanned inside it opens
/// the next, as Yomitan nests its pop-ups. Each level is a window of its own.
pub const LEVELS: usize = 5;

/// The window for a level: `reader-popup`, then `reader-popup-2` … `reader-popup-5`.
fn label(level: usize) -> String {
    if level == 0 {
        POPOVER_LABEL.into()
    } else {
        format!("{POPOVER_LABEL}-{}", level + 1)
    }
}

/// The level a pop-up window is, from its label.
fn level_of(label: &str) -> Option<usize> {
    if label == POPOVER_LABEL {
        return Some(0);
    }
    let n: usize = label.strip_prefix(POPOVER_LABEL)?.strip_prefix('-')?.parse().ok()?;
    (2..=LEVELS).contains(&n).then(|| n - 1)
}

/// Builds one level's window, hidden. The first is built at startup; the others when the level
/// below them first shows, so one is ready by the time the reader scans inside it.
pub fn build_window(
    app: &AppHandle,
    level: usize,
) -> tauri::Result<tauri::WebviewWindow> {
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        label(level),
        tauri::WebviewUrl::App("app/reader-popup.html".into()),
    )
    .title("Dictionary")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .accept_first_mouse(true)
    .skip_taskbar(true)
    .inner_size(500., 380.)
    .content_protected(true)
    .initialization_script_for_all_frames(crate::platform::platform_prelude());
    #[cfg(target_os = "linux")]
    let builder = builder.focusable(crate::platform::wayland_overlay_unavailable());
    builder.build()
}

/// Builds the window for `level` if it is not there yet. Off the main thread (building a window
/// there can deadlock on Windows); making it a panel is main-thread work.
fn prepare_level(app: &AppHandle, level: usize) {
    if level >= LEVELS || app.get_webview_window(&label(level)).is_some() {
        return;
    }
    if PREPARING[level].swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match build_window(&app, level) {
            Ok(window) => {
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = crate::platform::make_panel(&window) {
                        eprintln!("kimochi: nested dictionary pop-up is not a panel: {error}");
                    }
                });
            }
            Err(error) => eprintln!("kimochi: nested dictionary pop-up: {error}"),
        }
        PREPARING[level].store(false, Ordering::SeqCst);
    });
}

static PREPARING: [AtomicBool; LEVELS] = [const { AtomicBool::new(false) }; LEVELS];

/// Transparent margin baked into the window around the visible card so the
/// card's CSS drop-shadow is not clipped by the window bounds. It must equal
/// `--popover-pad` in `frontend/texthooker/popover.css`: the shell pads the
/// card by exactly this much, so the card is the caller's `width` × `height`
/// and its shadow (which reaches 16px down, 10px sideways) lives in the margin.
/// A clipped shadow shows up as a hard grey band under the card.
const SHADOW_PAD: f64 = 16.0;

/// Space between the word (or cursor) and the card. It is wider than SHADOW_PAD so the window's
/// transparent margin stops short of the word: a margin under the pointer takes its mouse events,
/// which ends a Shift-scan glide and focuses the popup.
const GAP: f64 = SHADOW_PAD + 4.0;

/// How long a lookup may take before the popup opens on a loading state instead of the entry.
const SHOW_WAIT: std::time::Duration = std::time::Duration::from_millis(150);

/// Which levels are on screen. Used by the desktop pointer poll to avoid work while none is.
static VISIBLE: [AtomicBool; LEVELS] = [const { AtomicBool::new(false) }; LEVELS];

/// A card's place in desktop points: `(x, y, width, height)`.
type Card = (f64, f64, f64, f64);

/// Where each level's card was last placed.
static CARDS: std::sync::Mutex<[Option<Card>; LEVELS]> = std::sync::Mutex::new([None; LEVELS]);

/// The topmost visible pop-up whose card holds a desktop point, with that card.
fn level_at(x: f64, y: f64) -> Option<(usize, Card)> {
    let cards = CARDS.lock().unwrap_or_else(|p| p.into_inner());
    (0..LEVELS).rev().find_map(|level| {
        let card = cards[level]?;
        let (cx, cy, w, h) = card;
        (VISIBLE[level].load(Ordering::Relaxed) && x >= cx && x < cx + w && y >= cy && y < cy + h)
            .then_some((level, card))
    })
}

#[derive(Serialize, Clone)]
struct CardRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Tells every window where the visible pop-ups are (`popover:cards`, desktop points). The window
/// with the keyboard (the Log) keeps getting the pointer's moves while it is over a pop-up, and
/// must not scan the text the pop-up covers.
fn announce_cards(app: &AppHandle) {
    let cards = CARDS.lock().unwrap_or_else(|p| p.into_inner());
    let visible: Vec<CardRect> = (0..LEVELS)
        .filter(|&level| VISIBLE[level].load(Ordering::Relaxed))
        .filter_map(|level| cards[level])
        .map(|(x, y, width, height)| CardRect { x, y, width, height })
        .collect();
    drop(cards);
    let _ = app.emit("popover:cards", visible);
}

/// Whether a visible pop-up's card covers a desktop point. The overlay's pointer feed counts
/// such a point as blocked, as it does an extension's pop-up: a Shift-scan through the card would
/// look up the text under it, and reading or scrolling the card would change it.
pub fn covers(x: f64, y: f64) -> bool {
    level_at(x, y).is_some()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PopupPointer {
    /// In the pop-up's own viewport (CSS pixels).
    x: f64,
    y: f64,
    /// On the desktop, in the units `show_popover` takes.
    screen_x: f64,
    screen_y: f64,
    shift: bool,
}

/// The native cursor poll's sample, handed to the pop-up under the pointer. A pop-up reads Shift
/// and the pointer from here rather than from its own events, which it only gets once it has the
/// keyboard: Shift-scanning a word inside it then works the moment the pointer is over it, and
/// the text underneath never sees the scan.
pub fn pointer(app: &AppHandle, x: f64, y: f64, shift: bool) {
    if !VISIBLE.iter().any(|v| v.load(Ordering::Relaxed)) {
        return;
    }
    let Some((level, (cx, cy, _, _))) = level_at(x, y) else {
        return;
    };
    // The window's origin, where `show_popover` put it.
    let (ox, oy) = ((cx - SHADOW_PAD).round(), (cy - SHADOW_PAD).round());
    let scale = if crate::platform::desktop_unit() == crate::platform::DesktopUnit::Points {
        1.0
    } else {
        app.get_webview_window(&label(level))
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0)
    };
    let _ = app.emit_to(
        label(level),
        "popover:pointer",
        PopupPointer {
            x: (x - ox) / scale,
            y: (y - oy) / scale,
            screen_x: x,
            screen_y: y,
            shift,
        },
    );
}

/// Each level's window has registered its listeners; `show_popover` waits for it.
static READY: [AtomicBool; LEVELS] = [const { AtomicBool::new(false) }; LEVELS];

#[tauri::command]
pub async fn reader_popup_ready(window: tauri::WebviewWindow) {
    // The card and its shadow are drawn by CSS inside a transparent window.
    // A native window shadow on top of that is computed by the window server
    // from the window's alpha and cached; it goes stale as the window is
    // resized and the card fades in, and outlines the card a second time
    // (a doubled bottom edge and odd translucent fringes). Turn it off before
    // the first show; `show_popover` waits for this command.
    let _ = window.set_shadow(false);
    if let Some(level) = level_of(window.label()) {
        READY[level].store(true, Ordering::SeqCst);
    }
}

/// Gives the keyboard to the pop-up that asks (the reader's pointer arrived on it).
#[tauri::command]
pub async fn reader_popup_focus(window: tauri::WebviewWindow) -> Result<(), String> {
    let level = level_of(window.label()).unwrap_or(0);
    on_popup_main(window.app_handle(), level, |window| {
        crate::platform::promote_to_key(&window).map(|_| ())
    })
    .await
}

/// Monotonic lookup generation per level. Bumped on every show_popover (and hide), so
/// in-flight fetches from a superseded lookup can detect they're stale and
/// skip emitting — the lookup now runs in two phases (fields fast, media
/// slow), which widens the window for such races.
static LOOKUP_GEN: [AtomicU64; LEVELS] = [const { AtomicU64::new(0) }; LEVELS];

/// Async commands run on Tokio workers. Tauri's window methods dispatch for
/// themselves, but our direct AppKit helpers do not. Keep that boundary here:
/// orderFrontRegardless on a worker aborts in NSWMWindowCoordinator.
async fn on_popup_main<T: Send + 'static>(
    app: &AppHandle,
    level: usize,
    operation: impl FnOnce(tauri::WebviewWindow) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = handle
            .get_webview_window(&label(level))
            .ok_or_else(|| "Dictionary window is unavailable".to_string())
            .and_then(operation);
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub anki_filename: String,
    pub content_base64: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ShowPayload {
    Loading {
        term: String,
        sentence: Option<String>,
    },
    Loaded {
        term: String,
        /// The lookup's first result (a new word), as opposed to the same lookup's media
        /// arriving later; the popup resets its navigation for a fresh one.
        fresh: bool,
        /// All matched entries, longest match first (Yomitan-style: exact
        /// compound, then progressively shorter sub-terms).
        entries: Vec<Value>,
        #[serde(rename = "audioMedia")]
        audio_media: Vec<MediaItem>,
        #[serde(rename = "dictionaryMedia")]
        dictionary_media: Vec<MediaItem>,
        sentence: Option<String>,
        #[serde(rename = "audioAutoplay")]
        audio_autoplay: bool,
        #[serde(rename = "audioVolume")]
        audio_volume: f32,
        #[serde(rename = "ankiConfig")]
        anki_config: Option<Value>,
        /// The Yomitan host URL, threaded through so the popover can resolve
        /// cross-reference links (`⟶ 取り憑く`) in glossary content by looking
        /// the target term up itself, without re-positioning the window.
        #[serde(rename = "baseUrl")]
        base_url: String,
    },
    Error {
        term: String,
        message: String,
        sentence: Option<String>,
    },
    Notebook {
        entry: Value,
        sentence: Option<String>,
    },
}

/// A box in desktop coordinates (the matched word, from the page that asked for the lookup). The
/// page also sends its width, which placement doesn't need.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub height: f64,
}

/// The card's top-left for a `width` × `height` card in the work area `(x, y, w, h)`: above the
/// word with its left edges aligned, as Yomitan and Hachidori place theirs, or below it when there
/// is no room above. Without a word box, it centres on the cursor.
fn place_card(
    anchor: Option<Anchor>,
    cursor: (f64, f64),
    width: f64,
    height: f64,
    work: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (mon_x, mon_y, mon_w, mon_h) = work;
    let (left, top, bottom) = match anchor {
        Some(a) => (a.x, a.y, a.y + a.height),
        None => (cursor.0 - width / 2.0, cursor.1, cursor.1),
    };

    let x = left.min(mon_x + mon_w - width - 8.0).max(mon_x + 8.0);

    let space_above = top - mon_y;
    let space_below = mon_y + mon_h - bottom;
    let y = if space_above >= height + GAP + 8.0 {
        top - height - GAP
    } else if space_below >= height + GAP + 8.0 {
        bottom + GAP
    } else if space_above >= space_below {
        mon_y + 8.0
    } else {
        mon_y + mon_h - height - 8.0
    };
    let y = y.min(mon_y + mon_h - height - 8.0).max(mon_y + 8.0);
    (x, y)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Preserve Super Texthooker invoke payload compatibility.
pub async fn show_popover(
    app: AppHandle,
    term: String,
    cursor_x: f64,
    cursor_y: f64,
    width: f64,
    height: f64,
    base_url: String,
    #[allow(non_snake_case)] focus: Option<bool>,
    sentence: Option<String>,
    include_media: Option<bool>,
    audio_autoplay: Option<bool>,
    audio_volume: Option<f32>,
    anki_config: Option<Value>,
    kind: Option<String>,
    notebook_entry: Option<Value>,
    anchor: Option<Anchor>,
    level: Option<usize>,
) -> Result<(), String> {
    // A word scanned inside the pop-up at `level - 1` opens this one on top of it.
    let level = level.unwrap_or(0).min(LEVELS - 1);
    let is_notebook = kind.as_deref() == Some("notebook");
    // Start the lookup now: it usually lands while the window is being placed, and the popup then
    // opens on the entry rather than flashing a loading state first.
    let mut fields = (!is_notebook).then(|| {
        let (base_url, term) = (base_url.clone(), term.clone());
        tokio::spawn(async move {
            crate::reader::yomitan::ankifields_value(&base_url, &term, false).await
        })
    });

    prepare_level(&app, level);
    for _ in 0..100 {
        if READY[level].load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !READY[level].load(Ordering::SeqCst) {
        return Err("Dictionary popup is still loading; retry shortly".into());
    }
    let gen = LOOKUP_GEN[level].fetch_add(1, Ordering::Relaxed) + 1;
    // Wait for the lookup before moving the window, so the popup showing now stays put with its
    // word until the next one is ready to replace it.
    let mut first: Option<Result<Vec<Value>, String>> = None;
    if let Some(handle) = fields.as_mut() {
        first = tokio::time::timeout(SHOW_WAIT, handle)
            .await
            .ok()
            .map(|joined| {
                joined
                    .map_err(|e| e.to_string())
                    .and_then(|r| r)
                    .map(|v| extract_entries(&v))
            });
        if LOOKUP_GEN[level].load(Ordering::Relaxed) != gen {
            return Ok(()); // a newer lookup took over while this one ran
        }
    }
    // A new word at this level closes the pop-ups that were open on top of the old one.
    hide_from(&app, level + 1).await;
    // Whole logical pixels, so the card's 1px ring lands on the pixel grid
    // instead of straddling two device pixels (which reads as a double line).
    let width = width.clamp(240., 1200.).round();
    let height = height.clamp(120., 1000.).round();
    let window = app
        .get_webview_window(&label(level))
        .ok_or_else(|| "popover window missing".to_string())?;

    // Grow the window by 2*SHADOW_PAD so the visible card's drop-shadow lives
    // inside transparent margin and doesn't get clipped by the OS window.
    let win_w = width + 2.0 * SHADOW_PAD;
    let win_h = height + 2.0 * SHADOW_PAD;
    // Where the OS's desktop is already in points (macOS), Tauri's logical size and
    // position are desktop points; elsewhere the window is placed below, in one call.
    let logical = crate::platform::desktop_unit() == crate::platform::DesktopUnit::Points;
    if logical {
        let _ = window.set_size(LogicalSize::new(win_w, win_h));
    }

    // cursor_x / cursor_y arrive in desktop points (event.screenX/Y on macOS, where
    // they coincide). Find the monitor that contains the cursor so we put the popover
    // on the same physical display the user is reading on.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(crate::platform::desktop_display_infos());
    })
    .map_err(|e| e.to_string())?;
    let displays = rx.await.map_err(|e| e.to_string())?;
    let target = displays
        .iter()
        .find(|m| {
            let b = m.bounds;
            cursor_x >= b.x
                && cursor_x < b.x + b.width
                && cursor_y >= b.y
                && cursor_y < b.y + b.height
        })
        .or_else(|| displays.first());
    let (mon_x, mon_y, mon_w, mon_h) = target
        .map(|m| {
            let b = m.work_area;
            (b.x, b.y, b.width, b.height)
        })
        .unwrap_or((0., 0., 1920., 1080.));

    let (x, y) = place_card(
        anchor,
        (cursor_x, cursor_y),
        width,
        height,
        (mon_x, mon_y, mon_w, mon_h),
    );
    CARDS.lock().unwrap_or_else(|p| p.into_inner())[level] = Some((x, y, width, height));

    // (x, y) above target the CARD's top-left. Subtract SHADOW_PAD so the
    // window's transparent margin sits behind the card. Tauri converts logical
    // → physical using the destination monitor's scale factor.
    if logical {
        let _ = window.set_position(LogicalPosition::new(
            (x - SHADOW_PAD).round(),
            (y - SHADOW_PAD).round(),
        ));
    } else {
        // Tauri's logical position is not desktop points under mixed DPI, so the
        // platform places the window (on the main thread, which native placement needs).
        let rect = kimochi_capture::Rect {
            x: (x - SHADOW_PAD).round(),
            y: (y - SHADOW_PAD).round(),
            width: win_w,
            height: win_h,
        };
        let _ = on_popup_main(&app, level, move |w| crate::platform::desktop_place(&w, rect)).await;
    }

    let audio_autoplay_v = audio_autoplay.unwrap_or(true);
    let audio_volume_v = audio_volume.unwrap_or(0.9);
    let loaded = {
        let (term, sentence, anki_config, base_url) = (
            term.clone(),
            sentence.clone(),
            anki_config.clone(),
            base_url.clone(),
        );
        move |fresh: bool, entries: Vec<Value>, audio_media, dictionary_media| ShowPayload::Loaded {
            term: term.clone(),
            fresh,
            entries,
            audio_media,
            dictionary_media,
            sentence: sentence.clone(),
            audio_autoplay: audio_autoplay_v,
            audio_volume: audio_volume_v,
            anki_config: anki_config.clone(),
            base_url: base_url.clone(),
        }
    };
    let failed = {
        let (term, sentence) = (term.clone(), sentence.clone());
        move |message: String| ShowPayload::Error {
            term: term.clone(),
            message,
            sentence: sentence.clone(),
        }
    };

    // The initial payload. A notebook entry carries everything; a lookup that finished within
    // SHOW_WAIT opens on its entry; a slower one opens on a loading state.
    if is_notebook {
        let entry = notebook_entry
            .clone()
            .ok_or_else(|| "notebook payload missing".to_string())?;
        let _ = app.emit_to(
            label(level),
            "popover:show",
            ShowPayload::Notebook {
                entry,
                sentence: sentence.clone(),
            },
        );
    } else if fields.is_some() {
        let payload = match &first {
            Some(Ok(entries)) => loaded(true, entries.clone(), Vec::new(), Vec::new()),
            Some(Err(err)) => failed(err.clone()),
            None => ShowPayload::Loading {
                term: term.clone(),
                sentence: sentence.clone(),
            },
        };
        if LOOKUP_GEN[level].load(Ordering::Relaxed) != gen {
            return Ok(());
        }
        let _ = app.emit_to(label(level), "popover:show", payload);
    }

    on_popup_main(&app, level, move |window| {
        if LOOKUP_GEN[level].load(Ordering::Relaxed) != gen {
            return Ok(());
        }
        crate::platform::order_front(&window)?;
        VISIBLE[level].store(true, Ordering::Relaxed);
        if focus.unwrap_or(false) {
            crate::platform::promote_to_key(&window)?;
        }
        Ok(())
    })
    .await?;
    announce_cards(&app);
    // The next level, ready before the reader Shift-scans a word inside this one.
    prepare_level(&app, level + 1);

    let Some(handle) = fields else {
        // Notebook popovers carry all their data in the initial event.
        return Ok(());
    };

    // Two phases:
    //   1. fields only (fast, ~20ms), usually already shown above
    //   2. fields + media (audio downloads can take seconds) → re-emit with
    //      audio/dictionary media attached; the frontend reconciles in place.
    let app2 = app.clone();
    let term2 = term.clone();
    let fetch_media = include_media.unwrap_or(false);
    tauri::async_runtime::spawn(async move {
        let is_current = || LOOKUP_GEN[level].load(Ordering::Relaxed) == gen;

        let entries = match first {
            Some(Ok(entries)) => entries,
            Some(Err(_)) => return,
            None => {
                let result = handle
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r)
                    .map(|v| extract_entries(&v));
                if !is_current() {
                    return;
                }
                match result {
                    Ok(entries) => {
                        let _ = app2.emit_to(
                            label(level),
                            "popover:show",
                            loaded(true, entries.clone(), Vec::new(), Vec::new()),
                        );
                        entries
                    }
                    Err(err) => {
                        let _ = app2.emit_to(label(level), "popover:show", failed(err));
                        return;
                    }
                }
            }
        };

        if !fetch_media || entries.is_empty() {
            return;
        }
        // Phase 2 is heavy. Wait for the cursor to settle on this term before
        // starting it, so scan-mode glides over many words don't start media
        // fetches the user already moved past.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if !is_current() {
            return;
        }
        // On error, stay silent — the fields-only payload is already
        // showing and is strictly better than replacing it with an error.
        if let Ok(v) = crate::reader::yomitan::ankifields_value(&base_url, &term2, true).await {
            if !is_current() {
                return;
            }
            let _ = app2.emit_to(
                label(level),
                "popover:show",
                loaded(
                    false,
                    extract_entries(&v),
                    extract_media(&v, "audioMedia"),
                    extract_media(&v, "dictionaryMedia"),
                ),
            );
        }
    });

    Ok(())
}

fn extract_entries(v: &Value) -> Vec<Value> {
    v.get("fields")
        .and_then(|f| f.as_array())
        .cloned()
        .unwrap_or_default()
}

fn extract_media(v: &Value, key: &str) -> Vec<MediaItem> {
    let Some(arr) = v.get(key).and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let filename = item
                .get("ankiFilename")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())?;
            let content = item
                .get("content")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())?;
            Some(MediaItem {
                anki_filename: filename,
                content_base64: content,
            })
        })
        .collect()
}

fn hide_on_main(window: &tauri::WebviewWindow, level: usize) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    crate::platform::gamescope::hide(window)?;
    #[cfg(not(target_os = "linux"))]
    window.hide().map_err(|e| e.to_string())?;
    LOOKUP_GEN[level].fetch_add(1, Ordering::Relaxed);
    VISIBLE[level].store(false, Ordering::Relaxed);
    Ok(())
}

#[derive(Serialize, Clone)]
struct Hidden {
    /// The lowest level that closed; every level above it closed too.
    level: usize,
}

/// Hides the pop-ups from `from` up, innermost first, and says so (`popover:hide`): the Log and
/// the overlay clear their scanned word when the first closes, a pop-up its own when the one on
/// top of it does.
async fn hide_from(app: &AppHandle, from: usize) {
    let mut any = from == 0;
    for level in (from..LEVELS).rev() {
        if !VISIBLE[level].load(Ordering::Relaxed) || app.get_webview_window(&label(level)).is_none() {
            continue;
        }
        any = true;
        let _ = on_popup_main(app, level, move |window| hide_on_main(&window, level)).await;
    }
    if any {
        announce_cards(app);
        let _ = app.emit("popover:hide", Hidden { level: from });
    }
}

/// Hides the pop-up at `level` (default: the first) and every one on top of it.
#[tauri::command]
pub async fn hide_popover(app: AppHandle, level: Option<usize>) -> Result<(), String> {
    hide_from(&app, level.unwrap_or(0).min(LEVELS - 1)).await;
    Ok(())
}

/// A desktop click outside every pop-up dismisses them all; one inside a pop-up closes only the
/// pop-ups on top of it, as in Yomitan. Called by the native pointer worker.
pub fn pointer_down(app: &AppHandle, x: f64, y: f64) {
    if !VISIBLE.iter().any(|v| v.load(Ordering::Relaxed)) {
        return;
    }
    let from = level_at(x, y).map_or(0, |(level, _)| level + 1);
    if from >= LEVELS || !VISIBLE[from].load(Ordering::Relaxed) {
        return;
    }
    let generation = LOOKUP_GEN[from].load(Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Do not let a queued click dismiss a newer lookup.
        if LOOKUP_GEN[from].load(Ordering::Relaxed) == generation {
            hide_from(&app, from).await;
        }
    });
}

/// Exercises the real asynchronous commands and AppKit window with a synthetic
/// notebook payload. No capture, dictionary server, OCR, or user text is involved.
#[cfg(debug_assertions)]
pub async fn smoke(app: AppHandle) -> Result<(), String> {
    let entry = serde_json::json!({
        "id": "smoke", "kind": "thing", "name": "猫", "aliases": [],
        "description": "Synthetic popup regression", "notes": [], "images": [],
        "matchEnabled": false, "createdAt": 0, "updatedAt": 0
    });
    let window = app
        .get_webview_window(POPOVER_LABEL)
        .ok_or("missing window")?;
    // The helpers must fail safely if a future caller forgets the dispatcher.
    if crate::platform::order_front(&window).is_ok() || crate::platform::promote_to_key(&window).is_ok()
    {
        return Err("native helpers accepted a worker-thread call".into());
    }
    for _ in 0..3 {
        show_popover(
            app.clone(),
            "猫".into(),
            300.,
            300.,
            400.,
            300.,
            String::new(),
            Some(false),
            None,
            Some(false),
            Some(false),
            None,
            None,
            Some("notebook".into()),
            Some(entry.clone()),
            None,
            None,
        )
        .await?;
        let window = app
            .get_webview_window(POPOVER_LABEL)
            .ok_or("missing window")?;
        reader_popup_focus(window.clone()).await?;
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("popup did not become visible".into());
        }
        let b = on_popup_main(&app, 0, |w| crate::platform::desktop_bounds(&w)).await?;
        pointer_down(&app, b.x + b.width / 2., b.y + b.height / 2.);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("inside click dismissed the popup".into());
        }
        pointer_down(&app, b.x - 100., b.y - 100.);
        for _ in 0..20 {
            if !window.is_visible().map_err(|e| e.to_string())? {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        if window.is_visible().map_err(|e| e.to_string())? {
            return Err("outside click did not dismiss the popup".into());
        }
        hide_popover(app.clone(), None).await?;
        if window.is_visible().map_err(|e| e.to_string())? {
            return Err("popup did not hide".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_level_has_its_own_window_and_reads_back() {
        let labels: Vec<String> = (0..LEVELS).map(label).collect();
        assert_eq!(
            labels,
            ["reader-popup", "reader-popup-2", "reader-popup-3", "reader-popup-4", "reader-popup-5"]
        );
        for (level, label) in labels.iter().enumerate() {
            assert_eq!(level_of(label), Some(level));
        }
        for other in ["reader-popup-1", "reader-popup-6", "reader-popupx", "overlay", "reader-popup-"] {
            assert_eq!(level_of(other), None, "{other}");
        }
    }

    const WORK: (f64, f64, f64, f64) = (0., 25., 1440., 875.);

    fn word(x: f64, y: f64) -> Option<Anchor> {
        Some(Anchor { x, y, height: 30. })
    }

    #[test]
    fn sits_above_the_word_with_left_edges_aligned() {
        let (x, y) = place_card(word(300., 600.), (340., 615.), 400., 300., WORK);
        assert_eq!(x, 300.);
        assert_eq!(y, 600. - GAP - 300.);
    }

    #[test]
    fn its_window_margin_stays_off_the_word() {
        let (_, y) = place_card(word(300., 600.), (340., 615.), 400., 300., WORK);
        assert!(y + 300. + SHADOW_PAD < 600.);
        let (_, y) = place_card(word(300., 100.), (340., 115.), 400., 300., WORK);
        assert!(y - SHADOW_PAD > 130.);
    }

    #[test]
    fn flips_below_when_there_is_no_room_above() {
        let (_, y) = place_card(word(300., 100.), (340., 115.), 400., 300., WORK);
        assert_eq!(y, 130. + GAP);
    }

    #[test]
    fn stays_on_screen_at_the_right_edge() {
        let (x, _) = place_card(word(1400., 600.), (1410., 615.), 400., 300., WORK);
        assert_eq!(x, 1440. - 400. - 8.);
    }

    #[test]
    fn without_a_word_centres_on_the_cursor() {
        let (x, y) = place_card(None, (700., 600.), 400., 300., WORK);
        assert_eq!(x, 500.);
        assert_eq!(y, 600. - GAP - 300.);
    }
}
