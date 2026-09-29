//! macOS desktop points throughout: never use a WebView's DPR.
//! Everything here is macOS 14+ only; no cross-platform behaviour is implied.
use block2::RcBlock;
use kimochi_capture::Rect;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, AllocAnyThread, ClassType};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSCursor,
    NSCursorFrameResizeDirections, NSCursorFrameResizePosition, NSImage, NSPanel, NSScreen,
    NSWindow, NSWindowStyleMask, NSWorkspace, NSWorkspaceApplicationKey,
    NSWorkspaceDidActivateApplicationNotification, NSWorkspaceDidWakeNotification,
    NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    ns_string, NSDictionary, NSNotification, NSPoint, NSRect, NSSize, NSString,
};
use serde::Serialize;

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Bounds {
    origin: Point,
    size: Size,
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGDisplayBounds(id: u32) -> Bounds;
    fn CGGetActiveDisplayList(count: u32, ids: *mut u32, actual: *mut u32) -> i32;
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> Point;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGEventGetFlags(event: *const std::ffi::c_void) -> u64;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut std::ffi::c_void;
    /// Reads a CFDictionary-encoded CGRect, so window bounds need no manual
    /// X/Y/Width/Height parsing.
    fn CGRectMakeWithDictionaryRepresentation(
        dict: *const std::ffi::c_void,
        rect: *mut Bounds,
    ) -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const std::ffi::c_void);
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// Passive read. Never call the `WithOptions` variant automatically: that one
    /// prompts, and permission requests belong to an explicit user action.
    fn AXIsProcessTrusted() -> bool;
}

const WINDOW_LIST_INCLUDING_WINDOW: u32 = 1 << 3;

/// Where the pointer is, whether a button is down, and which modifiers are held.
///
/// All three come off one synthesised event, because that is what a `CGEvent` created
/// with no source *is*: a snapshot of the current input state. The modifiers matter as
/// much as the position here — Yomitan's scan trigger is a modifier, and a modifier
/// only ever reaches the window holding the keyboard, which while somebody reads their
/// game is their game. Reading it from the event rather than from
/// `CGEventSourceFlagsState` also keeps this to the one call already proven to work
/// without any additional macOS grant.
pub fn cursor() -> Option<(f64, f64, bool, u64)> {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() {
            return None;
        }
        let p = CGEventGetLocation(e);
        let flags = CGEventGetFlags(e);
        CFRelease(e);
        Some((p.x, p.y, CGEventSourceButtonState(0, 0), flags))
    }
}

pub fn displays() -> Vec<Rect> {
    unsafe {
        let mut ids = [0; 16];
        let mut count = 0;
        if CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) != 0 {
            return vec![];
        }
        ids[..count as usize]
            .iter()
            .map(|id| {
                let b = CGDisplayBounds(*id);
                Rect {
                    x: b.origin.x,
                    y: b.origin.y,
                    width: b.size.width,
                    height: b.size.height,
                }
            })
            .collect()
    }
}

fn primary_height() -> f64 {
    unsafe { CGDisplayBounds(CGMainDisplayID()).size.height }
}

#[derive(Serialize, Clone)]
pub struct DisplayInfo {
    pub id: u32,
    pub bounds: Rect,
    /// Excludes the menu bar and Dock, like Electron's `workArea`.
    pub work_area: Rect,
    pub scale_factor: f64,
}

/// NSScreen owns the work area and backing scale; CoreGraphics owns the display id.
/// Both are read here and converted to top-left desktop points in one place.
pub fn display_infos() -> Vec<DisplayInfo> {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        // Called off the main thread: report geometry without work area rather than
        // inventing one.
        return displays()
            .into_iter()
            .map(|bounds| DisplayInfo {
                id: 0,
                bounds,
                work_area: bounds,
                scale_factor: 1.0,
            })
            .collect();
    };
    let flip = primary_height();
    let to_top_left = |r: NSRect| Rect {
        x: r.origin.x,
        y: flip - r.origin.y - r.size.height,
        width: r.size.width,
        height: r.size.height,
    };
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| {
            let id = screen
                .deviceDescription()
                .objectForKey(ns_string!("NSScreenNumber"))
                .map(|value| unsafe { msg_send![&*value, unsignedIntValue] })
                .unwrap_or(0u32);
            DisplayInfo {
                id,
                bounds: to_top_left(screen.frame()),
                work_area: to_top_left(screen.visibleFrame()),
                scale_factor: screen.backingScaleFactor(),
            }
        })
        .collect()
}

/// Keep a rectangle inside a live display's work area, shrinking it first if the
/// display is smaller. Mirrors Electron's `clampBounds`, so an unplugged monitor can
/// never strand a saved window offscreen.
pub fn clamp_to_visible(rect: Rect) -> Rect {
    let screens = display_infos();
    if screens.is_empty() {
        return rect;
    }
    let overlap = |a: &Rect, b: &Rect| {
        let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
        let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
        w.max(0.0) * h.max(0.0)
    };
    let area = screens
        .iter()
        .max_by(|a, b| {
            overlap(&rect, &a.work_area)
                .partial_cmp(&overlap(&rect, &b.work_area))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|s| s.work_area)
        .unwrap();
    let width = rect.width.min(area.width);
    let height = rect.height.min(area.height);
    Rect {
        width,
        height,
        x: rect.x.max(area.x).min(area.x + area.width - width),
        y: rect.y.max(area.y).min(area.y + area.height - height),
    }
}

// Called by synchronous Tauri commands / setup on the main thread.
pub fn place(w: &tauri::WebviewWindow, r: Rect) -> Result<(), String> {
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let h = primary_height();
        (*p).setFrame_display(
            NSRect::new(
                NSPoint::new(r.x, h - r.y - r.height),
                NSSize::new(r.width, r.height),
            ),
            true,
        );
        Ok(())
    }
}

pub fn bounds(w: &tauri::WebviewWindow) -> Result<Rect, String> {
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let b = (*p).frame();
        let h = primary_height();
        Ok(Rect {
            x: b.origin.x,
            y: h - b.origin.y - b.size.height,
            width: b.size.width,
            height: b.size.height,
        })
    }
}

// Read-only hit testing also works while WKWebView suppresses inactive mouse events.
// Respect occlusion by other windows instead of highlighting through them.
pub fn panel_pointer(w: &tauri::WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    let Some((x, y, _, _)) = cursor() else {
        return Ok(None);
    };
    let r = bounds(w)?;
    if x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height {
        return Ok(None);
    }
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let h = primary_height();
        let front = NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(
            NSPoint::new(x, h - y),
            0,
            objc2::MainThreadMarker::new().ok_or("Pointer hit test requires the main thread")?,
        );
        Ok((front == (*p).windowNumber()).then_some((x - r.x, y - r.y)))
    }
}

pub fn panel_cursor(w: &tauri::WebviewWindow, kind: &str) -> Result<(), String> {
    // Recheck ownership after the DOM round trip. Never set another app's cursor.
    let Some((x, y)) = panel_pointer(w)? else {
        return Ok(());
    };
    if cursor().is_some_and(|(_, _, down, _)| down) {
        return Ok(()); // Leave native dragging/resizing cursor tracking alone.
    }
    let r = bounds(w)?;
    let edge = resize_edge(
        x,
        y,
        r.width,
        r.height,
        w.is_resizable().map_err(|e| e.to_string())?,
    );
    unsafe {
        if let Some(edge) = edge {
            // Frame resize cursors are public on recent macOS. Guard older hosts.
            let supported: bool = objc2::msg_send![NSCursor::class(), respondsToSelector:
                objc2::sel!(frameResizeCursorFromPosition:inDirections:)];
            if supported {
                NSCursor::frameResizeCursorFromPosition_inDirections(
                    edge,
                    NSCursorFrameResizeDirections::All,
                )
                .set();
            }
            return Ok(());
        }
        match kind {
            "pointer" => NSCursor::pointingHandCursor(),
            "grab" => NSCursor::openHandCursor(),
            "grabbing" => NSCursor::closedHandCursor(),
            "crosshair" => NSCursor::crosshairCursor(),
            "not-allowed" => NSCursor::operationNotAllowedCursor(),
            "text" => NSCursor::IBeamCursor(),
            _ => NSCursor::arrowCursor(),
        }
        .set();
    }
    Ok(())
}

fn resize_edge(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    resizable: bool,
) -> Option<NSCursorFrameResizePosition> {
    use NSCursorFrameResizePosition::*;
    if !resizable {
        return None;
    }
    // Restrict this hint to the native frame edge, not a custom DOM resize handle.
    match (x < 4., x >= width - 4., y < 4., y >= height - 4.) {
        (true, _, true, _) => Some(TopLeft),
        (_, true, true, _) => Some(TopRight),
        (true, _, _, true) => Some(BottomLeft),
        (_, true, _, true) => Some(BottomRight),
        (true, _, _, _) => Some(Left),
        (_, true, _, _) => Some(Right),
        (_, _, true, _) => Some(Top),
        (_, _, _, true) => Some(Bottom),
        _ => None,
    }
}

pub fn inspect(w: &tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        Ok(serde_json::json!({
            "level": (*p).level(),
            "opaque": (*p).isOpaque(),
            "ignores_mouse": (*p).ignoresMouseEvents(),
            "style_mask": (*p).styleMask().0,
            "can_become_key": (*p).canBecomeKeyWindow(),
            "is_key": (*p).isKeyWindow(),
            "app_active": NSApplication::sharedApplication(
                objc2::MainThreadMarker::new().ok_or("inspect requires the main thread")?,
            )
            .isActive(),
        }))
    }
}

/// Show a window without taking the keyboard from whatever has it.
///
/// Tauri's `show` is `makeKeyAndOrderFront:`, which is wrong for a popup: the reader
/// is pointing at a word in another window, and a dictionary that grabs focus the
/// instant it opens stops them moving to the next word. Ordering front leaves key
/// where it is; `promote_to_key` takes it later, when the pointer actually arrives on
/// the popup.
pub fn order_front(w: &tauri::WebviewWindow) -> Result<(), String> {
    objc2::MainThreadMarker::new().ok_or("order_front requires the main thread")?;
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        (*p).orderFrontRegardless();
    }
    Ok(())
}

/// Give the window keyboard focus without taking the reader's application with it.
///
/// This exists because of a detail of Yomitan's input handling: a scan trigger may
/// include a modifier, and `TextScanner._onKeyDown` is an ordinary `keydown`
/// listener, so a window that is not key never sees the Shift the trigger requires.
///
/// What it deliberately does *not* do is activate the application. An earlier version
/// fell back to `NSApplication.activate` whenever `makeKeyWindow` did not take, which
/// it never does for a background app — so every word the pointer crossed activated
/// Kimochi, and activating an application raises *all* of its windows above every
/// other app's. The Controller and the Log jumped in front of the game on hover and
/// dropped back behind it on the next click into the game: the flicker was the reader
/// watching their own window order being rewritten twice a second.
///
/// `make_panel` is what makes the remaining call meaningful. A non-activating panel
/// can become key while another application stays active, so this moves the keyboard
/// and nothing else. On a window that is not one, an inactive app simply keeps its
/// keyboard, which is the right answer too.
///
/// Returns whether focus actually had to be taken, so a caller can log a transition
/// rather than a poll.
pub fn promote_to_key(w: &tauri::WebviewWindow) -> Result<bool, String> {
    objc2::MainThreadMarker::new().ok_or("promote_to_key requires the main thread")?;
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        if (*p).isKeyWindow() || !(*p).isVisible() || !(*p).canBecomeKeyWindow() {
            return Ok(false);
        }
        (*p).makeKeyWindow();
        Ok((*p).isKeyWindow())
    }
}

/// `NSWindowStyleMaskNonactivatingPanel`. Only an `NSPanel` honours it.
const NONACTIVATING_PANEL: usize = 1 << 7;

/// Turn a finished window into a non-activating panel, as the Electron overlay was.
///
/// A plain window cannot be clicked without activating its application, and activating
/// an application reorders every one of its windows in front of the app the reader is
/// using. For a transparent surface that lies *over* somebody's game that is the wrong
/// bargain entirely: pointing at a word must not rearrange their desktop, and clicking
/// one must not take the keyboard out of their game.
///
/// `NSPanel` is the class that grants this, and AppKit offers no way to ask for it
/// after the fact, so the window is re-classed in place — the same technique the
/// `tauri-nspanel` plugin uses, and the same effect Electron's `type: 'panel'` has.
/// Two guards make that honest rather than hopeful:
///
///  - **the instance must be big enough.** Re-classing does not reallocate, so a class
///    whose instances are larger than this one would make every access past the old
///    end of the object a read into someone else's memory. tao's subclass adds one
///    ivar to `NSWindow` and `NSPanel` adds none, so this holds — and it is checked
///    rather than assumed, because nothing here controls either class;
///  - **`hidesOnDeactivate` must be turned off.** It defaults to *on* for panels, which
///    would hide the overlay the moment the reader clicked back into their game.
///
/// Returns whether the window was converted. `KIMOCHI_NO_PANEL=1` skips it, which
/// leaves the old behaviour: clicks activate the app.
pub fn make_panel(w: &tauri::WebviewWindow) -> Result<bool, String> {
    if std::env::var_os("KIMOCHI_NO_PANEL").is_some() {
        return Ok(false);
    }
    objc2::MainThreadMarker::new().ok_or("A window changes class on the main thread")?;
    unsafe {
        let p = w.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let panel = NSPanel::class();
        let current = (*(p as *mut AnyObject)).class();
        if current == panel {
            return Ok(true);
        }
        if panel.instance_size() > current.instance_size() {
            return Err(format!(
                "native: NSPanel instances are larger than {} ({} > {}); not re-classing",
                current.name().to_string_lossy(),
                panel.instance_size(),
                current.instance_size()
            ));
        }
        objc2::ffi::object_setClass(p as *mut AnyObject, panel);
        let mask = NSWindowStyleMask((*p).styleMask().0 | NONACTIVATING_PANEL);
        (*p).setStyleMask(mask);
        (*p).setHidesOnDeactivate(false);
        Ok(true)
    }
}

/// Metadata only: avoids ScreenCaptureKit enumeration and all pixel/icon work.
/// The window server already knows which normal windows are on the current desktop.
/// Capture still resolves the selected ID through fresh ScreenCaptureKit content.
pub fn picker_sources() -> Result<Vec<kimochi_capture::Source>, String> {
    objc2::rc::autoreleasepool(|_| unsafe {
        if !CGPreflightScreenCaptureAccess() {
            return Err(
                "permission: Allow Screen Recording for Kimochi Next POC in System Settings."
                    .into(),
            );
        }
        let mut ids = [0; 16];
        let mut count = 0;
        if CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) != 0 {
            return Err("native: Could not list displays".into());
        }
        let mut sources: Vec<_> = ids[..count as usize]
            .iter()
            .map(|id| {
                let b = CGDisplayBounds(*id);
                kimochi_capture::Source {
                    id: format!("macos:display:{id}"),
                    kind: "display",
                    name: format!("Display {id}"),
                    app: None,
                    bounds: Some(Rect {
                        x: b.origin.x,
                        y: b.origin.y,
                        width: b.size.width,
                        height: b.size.height,
                    }),
                    on_screen: Some(true),
                }
            })
            .collect();
        // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
        let ptr = CGWindowListCopyWindowInfo(1 | (1 << 4), 0);
        let list: Retained<objc2_foundation::NSArray<NSDictionary<NSString, AnyObject>>> =
            Retained::from_raw(ptr.cast()).ok_or("native: Could not list windows")?;
        let own = std::process::id();
        for entry in list.iter() {
            let number = |key: &NSString| -> Option<u32> {
                entry
                    .objectForKey(key)
                    .map(|v| msg_send![&*v, unsignedIntValue])
            };
            let Some(pid) = number(ns_string!("kCGWindowOwnerPID")) else {
                continue;
            };
            let Some(id) = number(ns_string!("kCGWindowNumber")) else {
                continue;
            };
            let layer = number(ns_string!("kCGWindowLayer")).unwrap_or(1);
            let Some(dict) = entry.objectForKey(ns_string!("kCGWindowBounds")) else {
                continue;
            };
            let mut b = Bounds {
                origin: Point { x: 0., y: 0. },
                size: Size {
                    width: 0.,
                    height: 0.,
                },
            };
            if !CGRectMakeWithDictionaryRepresentation(Retained::as_ptr(&dict).cast(), &mut b) {
                continue;
            }
            if !picker_window_eligible(layer, pid, own, b.size.width, b.size.height) {
                continue;
            }
            let string = |key: &NSString| -> Option<String> {
                entry
                    .objectForKey(key)
                    .map(|v| (&*(Retained::as_ptr(&v) as *const NSString)).to_string())
            };
            let name = string(ns_string!("kCGWindowName")).filter(|s| !s.trim().is_empty());
            // Empty-title windows are overwhelmingly framework helper surfaces, not app
            // documents. They remain capturable by ID, but do not belong in the picker.
            let Some(name) = name else { continue };
            sources.push(kimochi_capture::Source {
                id: format!("macos:window:{id}:{pid}"),
                kind: "window",
                name,
                app: string(ns_string!("kCGWindowOwnerName")),
                bounds: Some(Rect {
                    x: b.origin.x,
                    y: b.origin.y,
                    width: b.size.width,
                    height: b.size.height,
                }),
                on_screen: Some(true),
            });
        }
        Ok(sources)
    })
}

fn picker_window_eligible(layer: u32, pid: u32, own: u32, width: f64, height: f64) -> bool {
    layer == 0 && pid != own && readable_window(layer, 1., width, height)
}

/// Could a reader be looking at this window?
///
/// The same question the source picker asks, minus the ownership test, and for the
/// same reason: a window that is fully transparent or the size of a toolbar is a
/// framework surface, not something anyone is reading. It matters twice over here,
/// because an application can order such a window *in front of* the one being read —
/// OpenEmu keeps a 442x42 HUD bar at alpha 0 above its game window — and answering
/// "which window of this app is in front" with that one means the window actually
/// being read is never in front, and its scanned text never comes back.
fn readable_window(layer: u32, alpha: f64, width: f64, height: f64) -> bool {
    layer == 0
        && alpha > 0.01
        && width.is_finite()
        && height.is_finite()
        && width >= 80.
        && height >= 60.
}

/// Live geometry for one window id, in top-left desktop points.
///
/// This exists so source tracking can poll at a UI cadence: re-running a full
/// `SCShareableContent` enumeration per tick would be far too expensive, and this
/// needs no Screen Recording permission because it reads geometry, never pixels.
pub fn window_bounds(window_number: u32) -> Option<(Rect, bool)> {
    unsafe {
        let ptr = CGWindowListCopyWindowInfo(WINDOW_LIST_INCLUDING_WINDOW, window_number);
        if ptr.is_null() {
            return None;
        }
        // CFArrayRef is toll-free bridged to NSArray and arrives +1 from a Copy call.
        let list: Retained<objc2_foundation::NSArray<NSDictionary<NSString, AnyObject>>> =
            Retained::from_raw(ptr.cast())?;
        let entry = list.iter().next()?;
        let bounds_dict = entry.objectForKey(ns_string!("kCGWindowBounds"))?;
        let mut raw = Bounds {
            origin: Point { x: 0., y: 0. },
            size: Size {
                width: 0.,
                height: 0.,
            },
        };
        if !CGRectMakeWithDictionaryRepresentation(Retained::as_ptr(&bounds_dict).cast(), &mut raw)
        {
            return None;
        }
        let on_screen = entry
            .objectForKey(ns_string!("kCGWindowIsOnscreen"))
            .map(|value| msg_send![&*value, boolValue])
            .unwrap_or(false);
        Some((
            Rect {
                x: raw.origin.x,
                y: raw.origin.y,
                width: raw.size.width,
                height: raw.size.height,
            },
            on_screen,
        ))
    }
}

/// The window the reader is actually working in: the frontmost ordinary window **of
/// the frontmost application**.
///
/// Both halves are load-bearing, and each rules out a simpler answer that is wrong:
///
///  - not the frontmost *application* alone. A reader with two windows of one app open
///    has one of them in front, and only one of them is the window being captured;
///  - not the frontmost window by z-order alone. Kimochi's own windows are ordinary
///    layer-0 windows that float above everything, so the topmost window on this
///    desktop is almost always one of ours — which would mean the captured window is
///    never "in front" once the overlay is up, and its text would never come back.
///
/// So the active application is asked first, and the window server is asked which of
/// *its* windows is in front. Layers above 0 are menus, the Dock and panels, which are
/// never what the reader is reading.
///
/// A frontmost application with no ordinary window on screen — a menu-bar agent, or an
/// app whose windows are all minimised — answers with window `0`, which matches no real
/// window. That is deliberate: it is still an answer about *who has focus*, and the
/// caller needs the process id to recognise our own windows.
///
/// `None` only when there is no frontmost application at all, which the caller treats
/// as "do not change what is shown".
pub fn front_window() -> Option<(u32, i32)> {
    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    objc2::rc::autoreleasepool(|_| unsafe {
        // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, in
        // front-to-back order.
        let ptr = CGWindowListCopyWindowInfo(1 | (1 << 4), 0);
        if ptr.is_null() {
            return Some((0, pid));
        }
        let Some(list): Option<
            Retained<objc2_foundation::NSArray<NSDictionary<NSString, AnyObject>>>,
        > = Retained::from_raw(ptr.cast()) else {
            return Some((0, pid));
        };
        // The first window this application could be read in, and — if none of them is
        // titled, which is what a missing Screen Recording grant looks like — the first
        // that is merely visible. Titles are read for emptiness only and never kept.
        let mut fallback = None;
        for entry in list.iter() {
            let number = |key: &NSString| -> Option<f64> {
                entry
                    .objectForKey(key)
                    .map(|value| msg_send![&*value, doubleValue])
            };
            if number(ns_string!("kCGWindowOwnerPID")) != Some(f64::from(pid)) {
                continue;
            }
            let Some(dict) = entry.objectForKey(ns_string!("kCGWindowBounds")) else {
                continue;
            };
            let mut b = Bounds {
                origin: Point { x: 0., y: 0. },
                size: Size {
                    width: 0.,
                    height: 0.,
                },
            };
            if !CGRectMakeWithDictionaryRepresentation(Retained::as_ptr(&dict).cast(), &mut b) {
                continue;
            }
            let eligible = readable_window(
                number(ns_string!("kCGWindowLayer")).unwrap_or(1.) as u32,
                number(ns_string!("kCGWindowAlpha")).unwrap_or(1.),
                b.size.width,
                b.size.height,
            );
            let Some(id) = number(ns_string!("kCGWindowNumber")) else {
                continue;
            };
            if !eligible {
                continue;
            }
            let titled = entry
                .objectForKey(ns_string!("kCGWindowName"))
                .is_some_and(|v| {
                    !(&*(Retained::as_ptr(&v) as *const NSString))
                        .to_string()
                        .trim()
                        .is_empty()
                });
            if titled {
                return Some((id as u32, pid));
            }
            fallback.get_or_insert(id as u32);
        }
        Some((fallback.unwrap_or(0), pid))
    })
}

/// PNG for an application's icon, chosen from the representation closest to `target`
/// so a 32-point row does not carry a 512-pixel icon.
///
/// Resolution is by running-application localized name, which is the same identity
/// Electron matches on. It is in-process AppKit: no `PlistBuddy`/`sips` subprocess per
/// app, unlike the current Electron path.
pub fn app_icon_png(app_name: &str, target: isize) -> Option<Vec<u8>> {
    let workspace = NSWorkspace::sharedWorkspace();
    let wanted = NSString::from_str(app_name);
    let running = workspace.runningApplications();
    let app = running
        .iter()
        .find(|a| a.localizedName().is_some_and(|n| *n == *wanted))?;
    let image: Retained<NSImage> = app.icon()?;
    let best = pick_representation(&image, target);
    let rep = match best {
        Some(rep) => rep,
        // No bitmap representation: flatten through TIFF, which always produces one.
        None => {
            let tiff = image.TIFFRepresentation()?;
            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)?
        }
    };
    let data = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(data.to_vec())
}

fn pick_representation(image: &NSImage, target: isize) -> Option<Retained<NSBitmapImageRep>> {
    let reps = image.representations();
    let mut best: Option<Retained<NSBitmapImageRep>> = None;
    let mut best_width = isize::MAX;
    for rep in reps.iter() {
        // An icon's representations are NSBitmapImageRep in practice, but an icon can
        // also carry a vector rep; check before treating one as a bitmap.
        let is_bitmap: bool = unsafe { msg_send![&*rep, isKindOfClass: NSBitmapImageRep::class()] };
        if !is_bitmap {
            continue;
        }
        let width = rep.pixelsWide();
        // Smallest representation that is still at least the requested size; if none
        // qualifies, the largest available.
        let better = if best_width < target {
            width > best_width
        } else {
            width >= target && width < best_width
        };
        if best.is_none() || better {
            best_width = width;
            let bitmap: Retained<NSBitmapImageRep> =
                unsafe { Retained::retain(Retained::as_ptr(&rep) as *mut NSBitmapImageRep) }?;
            best = Some(bitmap);
        }
    }
    best
}

/// Borrow a notification delivered to an observer block.
fn note_ref(note: std::ptr::NonNull<NSNotification>) -> &'static NSNotification {
    // The block owns the notification for the duration of the call; the reference
    // never escapes the closure it is used in.
    unsafe { note.as_ref() }
}

pub fn frontmost_app() -> Option<String> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|a| a.localizedName())
        .map(|n| n.to_string())
}

/// Read-only Accessibility check. Used to render an honest "Accessibility required"
/// state; it deliberately does not prompt.
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// System sleep/wake and application-activation notifications — the macOS equivalent of
/// Electron's `powerMonitor`, which Tauri does not wrap.
pub fn observe_workspace(
    on_sleep: impl Fn() + 'static,
    on_wake: impl Fn() + 'static,
    on_activate: impl Fn(String) + 'static,
) {
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let add = |name: &objc2_foundation::NSNotificationName,
               handler: RcBlock<dyn Fn(std::ptr::NonNull<NSNotification>)>| unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &handler);
        // The observer token is intentionally dropped: these observers live for the
        // whole process, and removing them on quit would be busywork.
    };
    add(
        unsafe { NSWorkspaceWillSleepNotification },
        RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| on_sleep()),
    );
    add(
        unsafe { NSWorkspaceDidWakeNotification },
        RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| on_wake()),
    );
    add(
        unsafe { NSWorkspaceDidActivateApplicationNotification },
        RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
            let name = note_ref(note)
                .userInfo()
                .and_then(|info| info.objectForKey(unsafe { NSWorkspaceApplicationKey }))
                .and_then(|app| unsafe {
                    let running =
                        Retained::as_ptr(&app) as *const objc2_app_kit::NSRunningApplication;
                    (*running).localizedName()
                })
                .map(|n| n.to_string());
            if let Some(name) = name {
                on_activate(name);
            }
        }),
    );
}

#[cfg(test)]
mod window_tests {
    use super::readable_window;

    #[test]
    fn a_window_a_reader_could_be_looking_at_is_readable() {
        // OpenEmu's game window: visible, and the size of something being read.
        assert!(readable_window(0, 1., 512., 796.));
    }

    #[test]
    fn a_fully_transparent_window_is_not_what_anyone_is_reading() {
        // The bug this exists for. OpenEmu keeps a 442x42 HUD bar at alpha 0 ordered
        // *above* its game window, so "the frontmost window of the frontmost
        // application" answered with an invisible one — and the window actually being
        // read was never in front, so its scanned text never came back.
        assert!(!readable_window(0, 0., 442., 42.));
        assert!(!readable_window(0, 0.001, 512., 796.));
    }

    #[test]
    fn a_toolbar_sized_surface_is_not_either() {
        assert!(!readable_window(0, 1., 442., 42.));
        assert!(!readable_window(0, 1., 40., 600.));
    }

    #[test]
    fn menus_panels_and_the_dock_live_above_layer_zero() {
        assert!(!readable_window(25, 1., 512., 796.));
    }

    #[test]
    fn nonsense_geometry_is_not_readable() {
        assert!(!readable_window(0, 1., f64::NAN, 796.));
        assert!(!readable_window(0, 1., 512., f64::INFINITY));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn picker_rejects_helper_surfaces_but_keeps_normal_windows() {
        assert!(picker_window_eligible(0, 2, 1, 800., 600.));
        assert!(!picker_window_eligible(3, 2, 1, 800., 600.));
        assert!(!picker_window_eligible(0, 1, 1, 800., 600.));
        assert!(!picker_window_eligible(0, 2, 1, 1., 1.));
        assert!(!picker_window_eligible(0, 2, 1, 30., 40.));
        assert!(!picker_window_eligible(0, 2, 1, f64::NAN, 600.));
        assert!(!picker_window_eligible(0, 2, 1, 800., f64::INFINITY));
    }

    #[test]
    fn resize_edge_only_on_resizable_frame_edges() {
        assert!(resize_edge(1., 1., 100., 100., false).is_none());
        assert!(resize_edge(50., 50., 100., 100., true).is_none());
        assert!(matches!(
            resize_edge(1., 1., 100., 100., true),
            Some(NSCursorFrameResizePosition::TopLeft)
        ));
        assert!(matches!(
            resize_edge(99., 50., 100., 100., true),
            Some(NSCursorFrameResizePosition::Right)
        ));
    }

    #[test]
    fn clamp_is_identity_without_displays() {
        // display_infos() is empty off a real window server; the rect must survive.
        let r = rect(10., 20., 30., 40.);
        let clamped = clamp_to_visible(r);
        assert_eq!((clamped.width, clamped.height), (30., 40.));
    }
}
