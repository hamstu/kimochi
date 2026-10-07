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
    fn gtk_widget_get_realized(widget: *mut c_void) -> c_int;
    fn gtk_widget_get_window(widget: *mut c_void) -> *mut c_void;
    fn gdk_window_input_shape_combine_region(
        window: *mut c_void,
        region: *mut c_void,
        x: c_int,
        y: c_int,
    );
    fn cairo_region_create() -> *mut c_void;
    fn cairo_region_union_rectangle(region: *mut c_void, rectangle: *const CairoRect) -> c_int;
    fn cairo_region_destroy(region: *mut c_void);
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
    if !(available() || window.label() == "popup-host" && super::gnome::eligible_popup_session()) {
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
