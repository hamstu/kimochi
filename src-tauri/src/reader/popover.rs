// popover.rs — orchestrates showing/positioning the popover window and
// pushes Yomitan lookup data to it via events.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

const POPOVER_LABEL: &str = "reader-popup";

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
        crate::platform::promote_to_key(&window).map(|_| ())
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
) -> Result<(), String> {
    let is_notebook = kind.as_deref() == Some("notebook");
    // Start the lookup now: it usually lands while the window is being placed, and the popup then
    // opens on the entry rather than flashing a loading state first.
    let mut fields = (!is_notebook).then(|| {
        let (base_url, term) = (base_url.clone(), term.clone());
        tokio::spawn(async move {
            crate::reader::yomitan::ankifields_value(&base_url, &term, false).await
        })
    });

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
        if LOOKUP_GEN.load(Ordering::Relaxed) != gen {
            return Ok(()); // a newer lookup took over while this one ran
        }
    }
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
        let _ = on_popup_main(&app, move |w| crate::platform::desktop_place(&w, rect)).await;
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
        let _ = app.emit(
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
        if LOOKUP_GEN.load(Ordering::Relaxed) != gen {
            return Ok(());
        }
        let _ = app.emit("popover:show", payload);
    }

    on_popup_main(&app, move |window| {
        if LOOKUP_GEN.load(Ordering::Relaxed) != gen {
            return Ok(());
        }
        crate::platform::order_front(&window)?;
        POPOVER_VISIBLE.store(true, Ordering::Relaxed);
        if focus.unwrap_or(false) {
            crate::platform::promote_to_key(&window)?;
        }
        Ok(())
    })
    .await?;

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
        let is_current = || LOOKUP_GEN.load(Ordering::Relaxed) == gen;

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
                        let _ = app2.emit(
                            "popover:show",
                            loaded(true, entries.clone(), Vec::new(), Vec::new()),
                        );
                        entries
                    }
                    Err(err) => {
                        let _ = app2.emit("popover:show", failed(err));
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
            let _ = app2.emit(
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

fn hide_on_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    crate::platform::gamescope::hide(window)?;
    #[cfg(not(target_os = "linux"))]
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
            // `x`, `y` come from the cursor poll in desktop points.
            let b = crate::platform::desktop_bounds(&window)?;
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
        )
        .await?;
        reader_popup_focus(app.clone()).await?;
        let window = app
            .get_webview_window(POPOVER_LABEL)
            .ok_or("missing window")?;
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("popup did not become visible".into());
        }
        let b = on_popup_main(&app, |w| crate::platform::desktop_bounds(&w)).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
