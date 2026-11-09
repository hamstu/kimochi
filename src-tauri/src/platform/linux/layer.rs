//! Optional native Wayland panels. All GTK calls execute on the GTK main thread.
//! Keep the library loaded for the process lifetime: GTK retains its callbacks.
use glib::object::ObjectType as _;
use kimochi_capture::Rect;
use std::ffi::{c_char, c_int, c_void};
use std::sync::OnceLock;

struct Api {
    is_layer: unsafe extern "C" fn(*mut c_void) -> c_int,
    init: unsafe extern "C" fn(*mut c_void),
    namespace: unsafe extern "C" fn(*mut c_void, *const c_char),
    layer: unsafe extern "C" fn(*mut c_void, c_int),
    keyboard: unsafe extern "C" fn(*mut c_void, c_int),
    exclusive: unsafe extern "C" fn(*mut c_void, c_int),
    anchor: unsafe extern "C" fn(*mut c_void, c_int, c_int),
    margin: unsafe extern "C" fn(*mut c_void, c_int, c_int),
    monitor: unsafe extern "C" fn(*mut c_void, *mut c_void),
}
static API: OnceLock<Option<Api>> = OnceLock::new();
static REGION_EDITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn region_editing() -> bool {
    REGION_EDITING.load(std::sync::atomic::Ordering::SeqCst)
}

/// Called during Tauri setup, after GTK initialization and before panel creation.
pub fn initialize() {
    API.get_or_init(|| {
        // Prefer native layers when supported; explicit 0 disables them.
        if super::session().backend != super::Backend::Wayland
            || std::env::var("KIMOCHI_WAYLAND_OVERLAY").as_deref() == Ok("0")
        {
            return None;
        }
        unsafe {
            let library = libc::dlopen(
                c"libgtk-layer-shell.so.0".as_ptr(),
                libc::RTLD_NOW | libc::RTLD_LOCAL,
            );
            if library.is_null() {
                eprintln!(
                    "Wayland layer-shell unavailable: {}",
                    std::ffi::CStr::from_ptr(libc::dlerror()).to_string_lossy()
                );
                return None;
            }
            macro_rules! symbol {
                ($name:literal, $ty:ty) => {{
                    let pointer = libc::dlsym(library, concat!($name, "\0").as_ptr().cast());
                    if pointer.is_null() {
                        eprintln!("Wayland layer-shell unavailable: missing {}", $name);
                        return None;
                    }
                    std::mem::transmute::<*mut c_void, $ty>(pointer)
                }};
            }
            let supported = symbol!("gtk_layer_is_supported", unsafe extern "C" fn() -> c_int);
            if supported() == 0 {
                eprintln!(
                    "Wayland layer-shell unavailable: compositor does not support the protocol"
                );
                return None;
            }
            let api = Api {
                is_layer: symbol!(
                    "gtk_layer_is_layer_window",
                    unsafe extern "C" fn(*mut c_void) -> c_int
                ),
                init: symbol!(
                    "gtk_layer_init_for_window",
                    unsafe extern "C" fn(*mut c_void)
                ),
                namespace: symbol!(
                    "gtk_layer_set_namespace",
                    unsafe extern "C" fn(*mut c_void, *const c_char)
                ),
                layer: symbol!(
                    "gtk_layer_set_layer",
                    unsafe extern "C" fn(*mut c_void, c_int)
                ),
                keyboard: symbol!(
                    "gtk_layer_set_keyboard_mode",
                    unsafe extern "C" fn(*mut c_void, c_int)
                ),
                exclusive: symbol!(
                    "gtk_layer_set_exclusive_zone",
                    unsafe extern "C" fn(*mut c_void, c_int)
                ),
                anchor: symbol!(
                    "gtk_layer_set_anchor",
                    unsafe extern "C" fn(*mut c_void, c_int, c_int)
                ),
                margin: symbol!(
                    "gtk_layer_set_margin",
                    unsafe extern "C" fn(*mut c_void, c_int, c_int)
                ),
                monitor: symbol!(
                    "gtk_layer_set_monitor",
                    unsafe extern "C" fn(*mut c_void, *mut c_void)
                ),
            };
            eprintln!("Wayland layer-shell enabled: keyboard=NONE; native input regions");
            Some(api)
        }
    });
}

pub fn available() -> bool {
    API.get().is_some_and(Option::is_some)
}

unsafe extern "C" {
    fn gtk_widget_realize(widget: *mut c_void);
    fn gtk_widget_add_events(widget: *mut c_void, events: c_int);
    fn gtk_widget_get_realized(widget: *mut c_void) -> c_int;
    fn gtk_widget_get_window(widget: *mut c_void) -> *mut c_void;
    fn gtk_widget_queue_draw(widget: *mut c_void);
    fn gdk_window_input_shape_combine_region(
        window: *mut c_void,
        region: *mut c_void,
        x: c_int,
        y: c_int,
    );
    fn cairo_region_create() -> *mut c_void;
    fn cairo_region_union_rectangle(region: *mut c_void, rectangle: *const CairoRect) -> c_int;
    fn cairo_region_destroy(region: *mut c_void);
    fn gdk_display_get_default() -> *mut c_void;
    fn gdk_display_get_n_monitors(display: *mut c_void) -> c_int;
    fn gdk_display_get_monitor(display: *mut c_void, index: c_int) -> *mut c_void;
    fn gdk_monitor_get_geometry(monitor: *mut c_void, geometry: *mut CairoRect);
}

/// Kimochi's layer surfaces, which share one output: the overlay (anchored to its edges) and the
/// panels placed by margins in its coordinates (the dictionary pop-up, the hook card…).
static LAYERS: std::sync::Mutex<Vec<tauri::WebviewWindow>> = std::sync::Mutex::new(Vec::new());
/// The output (logical geometry) they were last moved to; `None` = the compositor's choice.
static OUTPUT: std::sync::Mutex<Option<(i32, i32, i32, i32)>> = std::sync::Mutex::new(None);

/// The output (logical geometry) the layer surfaces were last moved to.
pub fn current_output() -> Option<Rect> {
    OUTPUT.lock().ok().and_then(|o| *o).map(|(x, y, width, height)| Rect {
        x: f64::from(x),
        y: f64::from(y),
        width: f64::from(width),
        height: f64::from(height),
    })
}

/// Put every layer surface on the output with this logical geometry (the one the source is on),
/// unless they are there already. The overlay's surface then has that output's size, and its
/// origin is that output's. Returns whether a move was requested.
pub fn follow_output(geometry: Rect) -> bool {
    let key = (geometry.x.round() as i32, geometry.y.round() as i32, geometry.width.round() as i32, geometry.height.round() as i32);
    if API.get().and_then(Option::as_ref).is_none() || OUTPUT.lock().is_ok_and(|o| *o == Some(key)) {
        return false;
    }
    let windows = LAYERS.lock().map(|w| w.clone()).unwrap_or_default();
    let Some(first) = windows.first().cloned() else { return false };
    if let Ok(mut output) = OUTPUT.lock() {
        *output = Some(key);
    }
    let _ = first.run_on_main_thread(move || {
        let Some(api) = API.get().and_then(Option::as_ref) else { return };
        unsafe {
            let display = gdk_display_get_default();
            if display.is_null() {
                return;
            }
            let monitor = (0..gdk_display_get_n_monitors(display))
                .map(|i| gdk_display_get_monitor(display, i))
                .find(|&m| {
                    let mut r = CairoRect { x: 0, y: 0, width: 0, height: 0 };
                    gdk_monitor_get_geometry(m, &mut r);
                    (r.x, r.y, r.width, r.height) == key
                });
            let Some(monitor) = monitor else {
                // Not moved after all: the next attempt (and `current_output`) must know.
                eprintln!("Wayland layer-shell: no GDK monitor at {key:?}");
                if let Ok(mut output) = OUTPUT.lock() {
                    *output = None;
                }
                return;
            };
            for window in &windows {
                if let Ok(gtk) = window.gtk_window() {
                    (api.monitor)(gtk.as_ptr().cast(), monitor);
                }
            }
            eprintln!("Wayland layer-shell: surfaces moved to the output at {key:?}");
        }
    });
    true
}
#[repr(C)]
struct CairoRect {
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
}

pub fn make_panel(window: &tauri::WebviewWindow) -> Result<bool, String> {
    let Some(api) = API.get().and_then(Option::as_ref) else {
        return Ok(false);
    };
    let gtk = window.gtk_window().map_err(|e| e.to_string())?;
    if window.label() == "overlay" {
        use glib::prelude::*;
        use tauri::Emitter;
        // WebKitGTK does not reliably forward wl_pointer.leave from a shaped
        // layer surface to DOM mouseleave. Deliver the native surface edge too.
        unsafe { gtk_widget_add_events(gtk.as_ptr().cast(), (1 << 13) | (1 << 12)) };
        let leaving = window.clone();
        gtk.connect_local("leave-notify-event", false, move |_| {
            let _ = leaving.emit("wayland-layer-pointer", false);
            Some(false.to_value())
        });
        let entering = window.clone();
        gtk.connect_local("enter-notify-event", false, move |_| {
            let _ = entering.emit("wayland-layer-pointer", true);
            Some(false.to_value())
        });
    }
    if let Ok(mut layers) = LAYERS.lock() {
        layers.retain(|w| w.label() != window.label());
        layers.push(window.clone());
    }
    let pointer = gtk.as_ptr().cast();
    // Hidden Tauri windows must remain unrealized until their surface role is set.
    unsafe {
        if gtk_widget_get_realized(pointer) != 0 {
            return Err(format!(
                "Wayland layer-shell: {} was realized before role assignment",
                window.label()
            ));
        }
        (api.init)(pointer);
        (api.namespace)(pointer, c"kimochi".as_ptr());
        (api.layer)(pointer, 3); // OVERLAY
        (api.keyboard)(pointer, 0); // NONE: never take the game's keyboard.
        (api.exclusive)(pointer, -1);
        for edge in 0..4 {
            (api.anchor)(
                pointer,
                edge,
                i32::from(window.label() == "overlay" || edge == 0 || edge == 2),
            );
        }
        // Create the native surface without mapping it, and make it click-through
        // before the first show. An empty reader must never block the desktop.
        gtk_widget_realize(pointer);
        let region = cairo_region_create();
        gdk_window_input_shape_combine_region(gtk_widget_get_window(pointer), region, 0, 0);
        cairo_region_destroy(region);
    }
    Ok(true)
}

pub fn input_regions(
    window: &tauri::WebviewWindow,
    regions: Option<&[Rect]>,
) -> Result<bool, String> {
    if !(available() || matches!(window.label(), "overlay" | "popup-host") && super::gnome::eligible_popup_session()) {
        return Ok(false);
    }
    let window = window.clone();
    let rectangles = regions.map(<[Rect]>::to_vec);
    let handle = window.clone();
    handle
        .run_on_main_thread(move || {
            let Ok(gtk) = window.gtk_window() else { return };
            unsafe {
                let native = gtk_widget_get_window(gtk.as_ptr().cast());
                if native.is_null() {
                    return;
                }
                let region = rectangles.as_ref().map(|rectangles| {
                    let region = cairo_region_create();
                    for r in rectangles {
                        let left = r.x.floor();
                        let top = r.y.floor();
                        let rectangle = CairoRect {
                            x: left as c_int,
                            y: top as c_int,
                            width: ((r.x + r.width).ceil() - left).max(0.) as c_int,
                            height: ((r.y + r.height).ceil() - top).max(0.) as c_int,
                        };
                        cairo_region_union_rectangle(region, &rectangle);
                    }
                    region
                });
                gdk_window_input_shape_combine_region(
                    native,
                    region.unwrap_or(std::ptr::null_mut()),
                    0,
                    0,
                );
                if matches!(window.label(), "overlay" | "popup-host") && super::gnome::eligible_popup_session() {
                    // GNOME/GTK can defer the Wayland input-region commit until a
                    // paint. Without damage, a shadow click still reaches this
                    // window despite the new shape. Queue once per shape change.
                    gtk_widget_queue_draw(gtk.as_ptr().cast());
                }
                if let Some(region) = region {
                    cairo_region_destroy(region);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn place(window: &tauri::WebviewWindow, r: Rect) -> Result<(), String> {
    let window = window.clone();
    let handle = window.clone();
    handle
        .run_on_main_thread(move || {
            let Some(api) = API.get().and_then(Option::as_ref) else {
                return;
            };
            let Ok(gtk) = window.gtk_window() else { return };
            if window.label() != "overlay" && unsafe { (api.is_layer)(gtk.as_ptr().cast()) != 0 } {
                unsafe {
                    (api.margin)(gtk.as_ptr().cast(), 0, r.x.round() as c_int);
                    (api.margin)(gtk.as_ptr().cast(), 2, r.y.round() as c_int);
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// The explicitly opened crop editor may receive keys after a user click.
/// ON_DEMAND never monopolizes the desktop keyboard; closing restores NONE.
pub fn region_keyboard(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
    REGION_EDITING.store(on, std::sync::atomic::Ordering::SeqCst);
    let window = window.clone();
    let handle = window.clone();
    handle.run_on_main_thread(move || {
        let Some(api) = API.get().and_then(Option::as_ref) else { return };
        let Ok(gtk) = window.gtk_window() else { return };
        unsafe { (api.keyboard)(gtk.as_ptr().cast(), if on { 2 } else { 0 }); }
    }).map_err(|e| e.to_string())
}
