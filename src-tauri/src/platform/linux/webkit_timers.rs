//! WebKitGTK clamps chained timers in a hidden page to about one a second ("hidden page DOM timer
//! throttling"). Kimochi's hidden windows keep working while hidden: Hachidori's engine runs in its
//! background window, and the overlay waits on timers for a pop-up to open. On the Steam Deck ten
//! chained 50 ms timers took nine seconds there, so a lookup missed its 1.5 s window and fell back.
//! Tauri's `background_throttling(Disabled)` only reaches WKWebView (wry), so every webview turns
//! WebKit's own switches off here: WebKitGTK 2.42+ has them; an older one keeps its default.
use std::ffi::{c_char, c_void, CStr};

/// WebKit's feature identifiers (`webkit_feature_get_identifier`) for the throttling.
const OFF: [&CStr; 2] = [c"HiddenPageDOMTimerThrottling", c"HiddenPageDOMTimerThrottlingAutoIncreases"];

type AllFeatures = unsafe extern "C" fn() -> *mut c_void;
type Length = unsafe extern "C" fn(*mut c_void) -> usize;
type Get = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type SetEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, i32);
type Unref = unsafe extern "C" fn(*mut c_void);

/// A function of the WebKitGTK this process loaded, if it has one by that name.
unsafe fn symbol<T: Copy>(name: &CStr) -> Option<T> {
    let pointer = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
    (!pointer.is_null()).then(|| std::mem::transmute_copy(&pointer))
}

/// Turn the throttling off in `settings` (a `WebKitSettings*`); how many of its switches were found.
unsafe fn keep_timers(settings: *mut c_void) -> usize {
    let (Some(all), Some(length), Some(get), Some(identifier), Some(set), Some(unref)) = (
        symbol::<AllFeatures>(c"webkit_settings_get_all_features"),
        symbol::<Length>(c"webkit_feature_list_get_length"),
        symbol::<Get>(c"webkit_feature_list_get"),
        symbol::<Identifier>(c"webkit_feature_get_identifier"),
        symbol::<SetEnabled>(c"webkit_settings_set_feature_enabled"),
        symbol::<Unref>(c"webkit_feature_list_unref"),
    ) else {
        return 0;
    };
    let list = all();
    if list.is_null() {
        return 0;
    }
    let mut found = 0;
    for index in 0..length(list) {
        let feature = get(list, index);
        let name = identifier(feature);
        if !name.is_null() && OFF.contains(&CStr::from_ptr(name)) {
            set(settings, feature, 0);
            found += 1;
        }
    }
    unref(list);
    found
}

/// For every webview, from `on_webview_ready`.
pub fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let label = webview.label().to_string();
    let result = webview.with_webview(move |platform| {
        use glib::translate::ToGlibPtr;
        use webkit2gtk::WebViewExt;
        let Some(settings) = platform.inner().settings() else { return };
        let raw: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
        // SAFETY: `raw` is this webview's live WebKitSettings; the functions are WebKitGTK's own,
        // looked up by name, and the feature list is released after use.
        let found = unsafe { keep_timers(raw.cast()) };
        if found < OFF.len() {
            eprintln!("[kimochi] {label}: WebKit hidden-page timer throttling stays on ({found} of {} switches)", OFF.len());
        }
    });
    if let Err(error) = result {
        eprintln!("[kimochi] {}: WebKit timer settings: {error}", webview.label());
    }
}
