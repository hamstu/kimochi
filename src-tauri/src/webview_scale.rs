//! Keeps a Windows webview's CSS pixel at the size the rest of the app assumes.
//!
//! Everything native on Windows (Tauri's logical sizes, the overlay's desktop points, the mouse
//! hook's press positions, `panel_pointer`) takes one CSS pixel to be the window's DPI scale
//! (`GetDpiForWindow / 96`) in physical pixels. WebView2 can render at a larger device scale
//! factor than that: a reader on a 100 % display had every webview at `devicePixelRatio` 1.5,
//! with the page's outer size shrunk by the same factor (so not page zoom). Every point native
//! handed a page then landed at 1.5 times its place, and a Quick Shot box, which starts at the
//! hook's press and follows the page's own moves, ran away from the mouse.
//!
//! Native cannot see the device scale factor WebView2 chose, so each top-level page reports its
//! `devicePixelRatio` (`webview_scale_sync`, from [`prelude`]) on load and whenever it changes,
//! and native sets the page zoom that cancels the difference. Elsewhere this does nothing.

#[cfg(target_os = "windows")]
use serde_json::json;

/// The page zoom that makes one CSS pixel `dpi_scale` physical pixels, for a page whose
/// `devicePixelRatio` is `ratio` at page zoom `zoom`. 1 when they agree to within 1 %, and
/// `None` for nonsense input or a correction too large to be one.
pub fn matching_zoom(dpi_scale: f64, ratio: f64, zoom: f64) -> Option<f64> {
    let valid = |value: f64| value.is_finite() && value > 0.;
    if !(valid(dpi_scale) && valid(ratio) && valid(zoom)) {
        return None;
    }
    // The device scale factor WebView2 renders at, before any zoom of ours.
    let device = ratio / zoom;
    let target = dpi_scale / device;
    if (target - 1.).abs() < 0.01 {
        Some(1.)
    } else if (0.25..=4.).contains(&target) {
        Some(target)
    } else {
        None
    }
}

/// The script every Windows window runs (in [`crate::platform::platform_prelude`]): reports
/// the top-level page's `devicePixelRatio` once the page has loaded and again on every change
/// (a zoom of ours, another monitor, a new Windows text size). Pages that cannot reach app
/// commands (an extension's loopback origin) fail quietly.
#[cfg(target_os = "windows")]
pub fn prelude() -> &'static str {
    r#";(function(){try{
if(window.top!==window)return;
var query=null;
function sync(){
  var api=window.__TAURI_INTERNALS__;
  if(!api||!api.invoke)return;
  var ratio=window.devicePixelRatio;
  if(query)query.removeEventListener('change',sync);
  query=matchMedia('(resolution: '+ratio+'dppx)');
  query.addEventListener('change',sync);
  Promise.resolve(api.invoke('webview_scale_sync',{ratio:ratio})).catch(function(){});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',sync,{once:true});
else sync();
}catch(e){}})();
"#
}

/// The page zoom WebView2 is applying now. Asked on the main thread, where the controller lives.
#[cfg(target_os = "windows")]
fn current_zoom(webview: &tauri::Webview) -> Option<f64> {
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            let mut zoom = 0.;
            let read = unsafe { platform.controller().ZoomFactor(&mut zoom) };
            let _ = sender.send(read.is_ok().then_some(zoom));
        })
        .ok()?;
    receiver.recv_timeout(std::time::Duration::from_secs(2)).ok().flatten()
}

/// `webview_scale_sync(ratio) -> number | null`: the calling page's `devicePixelRatio`. On
/// Windows, sets the page zoom that brings one CSS pixel back to the window's DPI scale and
/// returns it (1 when nothing needed changing); `null` elsewhere or when it cannot tell.
/// Each change is recorded as `webview-scale`.
#[tauri::command]
pub async fn webview_scale_sync(app: tauri::AppHandle, webview: tauri::Webview, ratio: f64) -> Option<f64> {
    #[cfg(target_os = "windows")]
    {
        // Blocking: the zoom is read on the main thread and waited for here.
        tauri::async_runtime::spawn_blocking(move || {
            let dpi_scale = webview.window().scale_factor().ok()?;
            let zoom = current_zoom(&webview)?;
            let target = matching_zoom(dpi_scale, ratio, zoom)?;
            if (target - zoom).abs() > 0.001 {
                webview.set_zoom(target).ok()?;
                if let Some(service) = tauri::Manager::try_state::<crate::state::Shared>(&app) {
                    crate::record(
                        &app,
                        &service,
                        json!({
                            "check": "webview-scale",
                            "window": webview.label(),
                            "ratio": ratio,
                            "dpiScale": dpi_scale,
                            "zoom": zoom,
                            "applied": target,
                        }),
                    );
                }
            }
            Some(target)
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, webview, ratio);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::matching_zoom;

    #[test]
    fn a_webview_drawn_larger_than_its_display_is_zoomed_back() {
        // The reader's case: a 100 % display, every webview at 1.5.
        let zoom = matching_zoom(1., 1.5, 1.).unwrap();
        assert!((zoom - 1. / 1.5).abs() < 1e-9);
        // The same at 150 % with an extra 1.25 on top.
        let zoom = matching_zoom(1.5, 1.875, 1.).unwrap();
        assert!((zoom - 0.8).abs() < 1e-9);
    }

    #[test]
    fn a_zoom_already_applied_is_kept_not_compounded() {
        // After zooming to 2/3 the page reports 1.0: the same zoom again, not 2/3 of it.
        let zoom = matching_zoom(1., 1., 1. / 1.5).unwrap();
        assert!((zoom - 1. / 1.5).abs() < 1e-9);
    }

    #[test]
    fn matching_scales_need_no_zoom() {
        assert_eq!(matching_zoom(1., 1., 1.), Some(1.));
        assert_eq!(matching_zoom(1.5, 1.5, 1.), Some(1.));
        assert_eq!(matching_zoom(1.25, 1.2501, 1.), Some(1.));
        // A zoom of ours is undone once the webview no longer needs it.
        assert_eq!(matching_zoom(1., 0.6667, 1. / 1.5), Some(1.));
    }

    #[test]
    fn nonsense_is_left_alone() {
        assert_eq!(matching_zoom(1., 0., 1.), None);
        assert_eq!(matching_zoom(1., f64::NAN, 1.), None);
        assert_eq!(matching_zoom(0., 1.5, 1.), None);
        assert_eq!(matching_zoom(1., 1.5, -1.), None);
        assert_eq!(matching_zoom(1., 10., 1.), None);
    }
}
