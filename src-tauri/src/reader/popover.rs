// popover.rs — orchestrates showing/positioning the popover window and
// pushes Yomitan lookup data to it via events.

use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

const POPOVER_LABEL: &str = "reader-popup";
const GAP: f64 = 14.0; // px from cursor to popover edge

/// Transparent margin baked into the window around the visible card so the
/// card's CSS drop-shadow is not clipped by the window bounds. It must equal
/// `--popover-pad` in `frontend/texthooker/popover.css`: the shell pads the
/// card by exactly this much, so the card is the caller's `width` × `height`
/// and its shadow (which reaches 16px down, 10px sideways) lives in the margin.
/// A clipped shadow shows up as a hard grey band under the card.
const SHADOW_PAD: f64 = 16.0;

/// Used by the desktop pointer poll to avoid work while the popup is hidden.
static POPOVER_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Monotonic lookup generation. Bumped on every show_popover (and hide), so
/// in-flight fetches from a superseded lookup can detect they're stale and
/// skip emitting — the lookup now runs in two phases (fields fast, media
/// slow), which widens the window for such races.
static READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn reader_popup_ready(app: AppHandle) {
    // The card and its shadow are drawn by CSS inside a transparent window.
    // A native window shadow on top of that is computed by the window server
    // from the window's alpha and cached; it goes stale as the window is
    // resized and the card fades in, and outlines the card a second time
    // (a doubled bottom edge and odd translucent fringes). Turn it off before
    // the first show; `show_popover` waits for this command.
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.set_shadow(false);
    }
    READY.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn reader_popup_focus(app: AppHandle) -> Result<(), String> {
    on_popup_main(&app, |window| {
        crate::native::promote_to_key(&window).map(|_| ())
    })
    .await
}

static LOOKUP_GEN: AtomicU64 = AtomicU64::new(0);

/// Async commands run on Tokio workers. Tauri's window methods dispatch for
/// themselves, but our direct AppKit helpers do not. Keep that boundary here:
/// orderFrontRegardless on a worker aborts in NSWMWindowCoordinator.
async fn on_popup_main<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(tauri::WebviewWindow) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = handle
            .get_webview_window(POPOVER_LABEL)
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
) -> Result<(), String> {
    for _ in 0..100 {
        if READY.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !READY.load(Ordering::SeqCst) {
        return Err("Dictionary popup is still loading; retry shortly".into());
    }
    let gen = LOOKUP_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    // Whole logical pixels, so the card's 1px ring lands on the pixel grid
    // instead of straddling two device pixels (which reads as a double line).
    let width = width.clamp(240., 1200.).round();
    let height = height.clamp(120., 1000.).round();
    let window = app
        .get_webview_window(POPOVER_LABEL)
        .ok_or_else(|| "popover window missing".to_string())?;

    // Grow the window by 2*SHADOW_PAD so the visible card's drop-shadow lives
    // inside transparent margin and doesn't get clipped by the OS window.
    let win_w = width + 2.0 * SHADOW_PAD;
    let win_h = height + 2.0 * SHADOW_PAD;
    let _ = window.set_size(LogicalSize::new(win_w, win_h));

    // cursor_x / cursor_y arrive in LOGICAL CSS pixels (event.screenX/Y).
    // Find the monitor that contains the cursor so we put the popover on the
    // same physical display the user is reading on.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(crate::native::display_infos());
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

    // Horizontal: center on cursor, clamp to the monitor it sits on.
    let mut x = cursor_x - width / 2.0;
    if x < mon_x + 8.0 {
        x = mon_x + 8.0;
    }
    if x + width > mon_x + mon_w - 8.0 {
        x = mon_x + mon_w - width - 8.0;
    }

    // Vertical: prefer above cursor; flip below if not enough room.
    let space_above = cursor_y - mon_y;
    let space_below = mon_y + mon_h - cursor_y;
    let mut y = if space_above >= height + GAP + 8.0 {
        cursor_y - height - GAP
    } else if space_below >= height + GAP + 8.0 {
        cursor_y + GAP
    } else if space_above >= space_below {
        mon_y + 8.0
    } else {
        mon_y + mon_h - height - 8.0
    };
    if y < mon_y + 8.0 {
        y = mon_y + 8.0;
    }
    if y + height > mon_y + mon_h - 8.0 {
        y = mon_y + mon_h - height - 8.0;
    }

    // (x, y) above target the CARD's top-left. Subtract SHADOW_PAD so the
    // window's transparent margin sits behind the card. Tauri converts logical
    // → physical using the destination monitor's scale factor.
    let _ = window.set_position(LogicalPosition::new(
        (x - SHADOW_PAD).round(),
        (y - SHADOW_PAD).round(),
    ));

    let is_notebook = kind.as_deref() == Some("notebook");

    // Emit the initial payload. For notebook, we emit the final payload now and
    // skip the Yomitan fetch below. For everything else, emit Loading first.
    if is_notebook {
        let entry = notebook_entry
            .clone()
            .ok_or_else(|| "notebook payload missing".to_string())?;
        let _ = app.emit(
            "popover:show",
            ShowPayload::Notebook {
                entry,
                sentence: sentence.clone(),
            },
        );
    } else {
        let _ = app.emit(
            "popover:show",
            ShowPayload::Loading {
                term: term.clone(),
                sentence: sentence.clone(),
            },
        );
    }

    on_popup_main(&app, move |window| {
        if LOOKUP_GEN.load(Ordering::Relaxed) != gen {
            return Ok(());
        }
        crate::native::order_front(&window)?;
        POPOVER_VISIBLE.store(true, Ordering::Relaxed);
        if focus.unwrap_or(false) {
            crate::native::promote_to_key(&window)?;
        }
        Ok(())
    })
    .await?;

    if is_notebook {
        // Notebook popovers carry all their data in the initial event.
        return Ok(());
    }

    // Spawn the lookup so it doesn't block the command. Two phases:
    //   1. fields only (fast, ~50ms) → popover fills immediately
    //   2. fields + media (audio downloads can take >1s cold) → re-emit with
    //      audio/dictionary media attached; the frontend reconciles in place.
    let app2 = app.clone();
    let term2 = term.clone();
    let sentence2 = sentence.clone();
    let fetch_media = include_media.unwrap_or(false);
    let audio_autoplay_v = audio_autoplay.unwrap_or(true);
    let audio_volume_v = audio_volume.unwrap_or(0.9);
    let anki_config_v = anki_config.clone();
    let base_url_v = base_url.clone();
    tauri::async_runtime::spawn(async move {
        let is_current = || LOOKUP_GEN.load(Ordering::Relaxed) == gen;

        let entries = match crate::reader::yomitan::ankifields_value(&base_url, &term2, false).await
        {
            Ok(v) => extract_entries(&v),
            Err(err) => {
                if is_current() {
                    let _ = app2.emit(
                        "popover:show",
                        ShowPayload::Error {
                            term: term2,
                            message: err,
                            sentence: sentence2,
                        },
                    );
                }
                return;
            }
        };
        if !is_current() {
            return;
        }
        let _ = app2.emit(
            "popover:show",
            ShowPayload::Loaded {
                term: term2.clone(),
                entries: entries.clone(),
                audio_media: Vec::new(),
                dictionary_media: Vec::new(),
                sentence: sentence2.clone(),
                audio_autoplay: audio_autoplay_v,
                audio_volume: audio_volume_v,
                anki_config: anki_config_v.clone(),
                base_url: base_url_v.clone(),
            },
        );

        if !fetch_media || entries.is_empty() {
            return;
        }
        // Phase 2 is heavy (audio downloads can take >1s and tie up the local
        // Yomitan host). Wait for the cursor to settle on this term before
        // starting it, so scan-mode glides over many words don't queue a
        // backlog of media fetches the user already moved past.
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
            let _ = app2.emit(
                "popover:show",
                ShowPayload::Loaded {
                    term: term2,
                    entries: extract_entries(&v),
                    audio_media: extract_media(&v, "audioMedia"),
                    dictionary_media: extract_media(&v, "dictionaryMedia"),
                    sentence: sentence2,
                    audio_autoplay: audio_autoplay_v,
                    audio_volume: audio_volume_v,
                    anki_config: anki_config_v,
                    base_url: base_url_v,
                },
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

fn hide_on_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    LOOKUP_GEN.fetch_add(1, Ordering::Relaxed);
    POPOVER_VISIBLE.store(false, Ordering::Relaxed);
    window
        .app_handle()
        .emit("popover:hide", ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_popover(app: AppHandle) -> Result<(), String> {
    on_popup_main(&app, |window| hide_on_main(&window)).await
}

/// A desktop click outside the API popup dismisses it; pressing within it never does.
/// Called by the native pointer worker: reading NSWindow bounds is main-thread work too.
pub fn pointer_down(app: &AppHandle, x: f64, y: f64) {
    if !POPOVER_VISIBLE.load(Ordering::Relaxed) {
        return;
    }
    let generation = LOOKUP_GEN.load(Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = on_popup_main(&app, move |window| {
            // Do not let a queued click dismiss a newer lookup.
            if LOOKUP_GEN.load(Ordering::Relaxed) != generation {
                return Ok(());
            }
            let b = crate::native::bounds(&window)?;
            if x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height {
                return Ok(());
            }
            hide_on_main(&window)
        })
        .await;
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
    if crate::native::order_front(&window).is_ok() || crate::native::promote_to_key(&window).is_ok()
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
        )
        .await?;
        reader_popup_focus(app.clone()).await?;
        let window = app
            .get_webview_window(POPOVER_LABEL)
            .ok_or("missing window")?;
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("popup did not become visible".into());
        }
        let b = on_popup_main(&app, |w| crate::native::bounds(&w)).await?;
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
        hide_popover(app.clone()).await?;
        if window.is_visible().map_err(|e| e.to_string())? {
            return Err("popup did not hide".into());
        }
    }
    Ok(())
}
