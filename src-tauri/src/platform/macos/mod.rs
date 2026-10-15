//! macOS desktop points throughout: never use a WebView's DPR.
//! Everything here is macOS 14+ only; no cross-platform behaviour is implied.
//!
//! This is the macOS half of `crate::platform`: every public item here is part of the
//! per-OS contract described in `platform/mod.rs`, and the shared types it returns live
//! there.
mod focus;
pub mod instance;
mod spaces;

use super::{AppIdentity, DisplayInfo, FrontWindow, Modifiers, PointerSample};
use block2::RcBlock;
use kimochi_capture::{Platform, Rect, SourceId};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, AllocAnyThread, ClassType};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSCursor,
    NSCursorFrameResizeDirections, NSCursorFrameResizePosition, NSImage, NSPanel, NSScreen,
    NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace, NSWorkspaceApplicationKey,
    NSWorkspaceDidActivateApplicationNotification, NSWorkspaceDidWakeNotification,
    NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    ns_string, NSDictionary, NSNotification, NSPoint, NSRect, NSSize, NSString,
};
use serde_json::{json, Value};
use std::path::Path;

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
pub fn cursor() -> Option<PointerSample> {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() {
            return None;
        }
        let p = CGEventGetLocation(e);
        let flags = CGEventGetFlags(e);
        CFRelease(e);
        Some(PointerSample {
            x: p.x,
            y: p.y,
            down: CGEventSourceButtonState(0, 0),
            modifiers: Modifiers::from_flags(flags),
        })
    }
}

impl Modifiers {
    /// Decode `CGEventFlags`. Caps Lock (`0x10000`) is deliberately not a modifier
    /// here: it is a lock rather than a held key, and Yomitan has no input for it.
    pub fn from_flags(flags: u64) -> Self {
        Self {
            shift: flags & 0x0002_0000 != 0,
            ctrl: flags & 0x0004_0000 != 0,
            alt: flags & 0x0008_0000 != 0,
            meta: flags & 0x0010_0000 != 0,
        }
    }
}

/// The opaque id the UI uses for a display: a CoreGraphics display id, minted by the
/// one codec so the UI never builds `macos:` strings itself.
pub fn display_source_id(display_id: u32) -> String {
    SourceId::display(Platform::MacOs, display_id).to_string()
}

/// Run `f` inside an autorelease pool, so AppKit objects created by a worker thread are
/// released when it returns rather than accumulating for the life of the thread.
pub fn with_pool<R>(f: impl FnOnce() -> R) -> R {
    objc2::rc::autoreleasepool(|_| f())
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
                source_id: display_source_id(0),
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
                source_id: display_source_id(id),
                bounds: to_top_left(screen.frame()),
                work_area: to_top_left(screen.visibleFrame()),
                scale_factor: screen.backingScaleFactor(),
            }
        })
        .collect()
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
    let Some(PointerSample { x, y, .. }) = cursor() else {
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

/// No native input regions on macOS: `Ok(false)`, so the shared cursor poll keeps
/// toggling `ignoresMouseEvents` exactly as before. AppKit has no per-region
/// click-through for a window; `ignoresMouseEvents` is whole-window.
pub fn set_input_regions(
    _w: &tauri::WebviewWindow,
    _regions: Option<&[Rect]>,
) -> Result<bool, String> {
    Ok(false)
}

// The plain left-right and up-down resize cursors are deprecated in favour of directional
// ones, but they are still the ones a CSS `col-resize`/`row-resize` should look like.
#[allow(deprecated)]
pub fn panel_cursor(w: &tauri::WebviewWindow, kind: &str) -> Result<(), String> {
    // Recheck ownership after the DOM round trip. Never set another app's cursor.
    let Some((x, y)) = panel_pointer(w)? else {
        return Ok(());
    };
    if cursor().is_some_and(|p| p.down) {
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
            "col-resize" | "ew-resize" => NSCursor::resizeLeftRightCursor(),
            "row-resize" | "ns-resize" => NSCursor::resizeUpDownCursor(),
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
        (*p).setCollectionBehavior(overlay_behavior((*p).collectionBehavior()));
        Ok(true)
    }
}

/// Where an overlay-family panel may appear: on every Space, full-screen ones included.
///
/// A window belongs to the Space it was opened on, so without this the overlay, the
/// pop-up and the dictionary stayed on the desktop Kimochi started on: a game in its
/// own full-screen Space got no Quick Shot, no text and no pop-up. Joining all Spaces
/// puts them on whichever one is showing; `FullScreenAuxiliary` is what lets a window of
/// another application sit over a full-screen app at all. Ignoring the window cycle keeps
/// Cmd-` from landing on a transparent surface.
fn overlay_behavior(current: NSWindowCollectionBehavior) -> NSWindowCollectionBehavior {
    (current - NSWindowCollectionBehavior::MoveToActiveSpace)
        | NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::IgnoresCycle
}

/// Metadata only: avoids ScreenCaptureKit enumeration and all pixel/icon work.
/// The window server already knows which normal windows are on the current desktop.
/// Capture still resolves the selected ID through fresh ScreenCaptureKit content.
///
/// Windows on another Space are listed too, as off screen: a game in full screen has a
/// Space of its own and is never on the one Kimochi's window is on, so the picker would
/// otherwise never offer it. `source_spaces` names where they are.
pub fn picker_sources() -> Result<Vec<kimochi_capture::Source>, String> {
    objc2::rc::autoreleasepool(|_| unsafe {
        if !CGPreflightScreenCaptureAccess() {
            return Err(
                "permission: Allow Screen Recording for Kimochi in System Settings.".into(),
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
                    id: SourceId::display(Platform::MacOs, id).to_string(),
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
        let spaces = spaces::Spaces::current();
        // kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements when the Spaces can be
        // told apart, so windows on other Spaces come too; on screen only when they cannot.
        let options = if spaces.is_some() { 1 << 4 } else { 1 | (1 << 4) };
        let ptr = CGWindowListCopyWindowInfo(options, 0);
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
            let string = |key: &NSString| -> Option<String> {
                entry
                    .objectForKey(key)
                    .map(|v| (&*(Retained::as_ptr(&v) as *const NSString)).to_string())
            };
            let name = string(ns_string!("kCGWindowName")).filter(|s| !s.trim().is_empty());
            // Empty-title windows are overwhelmingly framework helper surfaces, not app
            // documents. They remain capturable by ID, but do not belong in the picker.
            let Some(name) = name else { continue };
            if !picker_window_eligible(layer, pid, own, b.size.width, b.size.height, &name) {
                continue;
            }
            let on_screen = entry
                .objectForKey(ns_string!("kCGWindowIsOnscreen"))
                .is_some_and(|value| msg_send![&*value, boolValue]);
            // Off screen and on no other Space: hidden, minimised or merely retained.
            if !on_screen && !spaces.as_ref().is_some_and(|s| s.elsewhere(id).is_some()) {
                continue;
            }
            sources.push(kimochi_capture::Source {
                id: SourceId::window(Platform::MacOs, id, pid).to_string(),
                kind: "window",
                name,
                app: string(ns_string!("kCGWindowOwnerName")),
                bounds: Some(Rect {
                    x: b.origin.x,
                    y: b.origin.y,
                    width: b.size.width,
                    height: b.size.height,
                }),
                on_screen: Some(on_screen),
            });
        }
        Ok(sources)
    })
}

/// Mission Control's name for the Space each off-screen window source is on ("Full screen",
/// "Desktop 2"), keyed by source id. Windows on the Space that is showing are left out.
pub fn source_spaces(sources: &[kimochi_capture::Source]) -> std::collections::HashMap<String, String> {
    let Some(spaces) = spaces::Spaces::current() else {
        return Default::default();
    };
    sources
        .iter()
        .filter(|source| source.kind == "window" && source.on_screen == Some(false))
        .filter_map(|source| {
            let number = SourceId::parse(&source.id)?.handle_u32()?;
            Some((source.id.clone(), spaces.elsewhere(number)?))
        })
        .collect()
}

fn picker_window_eligible(layer: u32, pid: u32, own: u32, width: f64, height: f64, title: &str) -> bool {
    let fixture = matches!(title, "Kimochi Japanese Fixture" | "Kimochi Split-Word Fixture");
    layer == 0 && (pid != own || fixture) && readable_window(layer, 1., width, height)
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
///
/// `None` for anything that is not a local window id with a numeric `CGWindowID`.
pub fn window_bounds(id: &SourceId) -> Option<(Rect, bool)> {
    if !id.is_window() || !id.is_local() {
        return None;
    }
    let window_number = id.handle_u32()?;
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
/// app whose windows are all minimised — answers with no window (what used to be window
/// `0`), which matches no real window. That is deliberate: it is still an answer about *who has focus*, and the
/// caller needs the process id to recognise our own windows.
///
/// `None` only when there is no frontmost application at all, which the caller treats
/// as "do not change what is shown".
pub fn front_window() -> Option<FrontWindow> {
    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    let (window, pid) = front_window_number(pid)?;
    let owner = u32::try_from(pid).unwrap_or(0);
    Some(FrontWindow {
        window: (window != 0).then(|| SourceId::window(Platform::MacOs, window, owner)),
        pid: owner,
    })
}

fn front_window_number(pid: i32) -> Option<(u32, i32)> {
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
/// app, unlike the current Electron path. The pid in `AppIdentity` is not used here.
pub fn app_icon_png(app: &AppIdentity, target: isize) -> Option<Vec<u8>> {
    let workspace = NSWorkspace::sharedWorkspace();
    let wanted = NSString::from_str(&app.name);
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

    #[test]
    fn picker_rejects_helper_surfaces_but_keeps_normal_windows() {
        assert!(picker_window_eligible(0, 2, 1, 800., 600., "Game"));
        assert!(!picker_window_eligible(3, 2, 1, 800., 600., "Game"));
        assert!(!picker_window_eligible(0, 1, 1, 800., 600., "Game"));
        assert!(!picker_window_eligible(0, 2, 1, 1., 1., "Game"));
        assert!(!picker_window_eligible(0, 2, 1, 30., 40., "Game"));
        assert!(!picker_window_eligible(0, 2, 1, f64::NAN, 600., "Game"));
        assert!(!picker_window_eligible(0, 2, 1, 800., f64::INFINITY, "Game"));
    }

    #[test]
    fn picker_allows_own_ocr_fixtures_only() {
        assert!(picker_window_eligible(0, 1, 1, 640., 400., "Kimochi Japanese Fixture"));
        assert!(picker_window_eligible(0, 1, 1, 760., 560., "Kimochi Split-Word Fixture"));
        assert!(!picker_window_eligible(0, 1, 1, 800., 600., "Kimochi"));
        assert!(!picker_window_eligible(3, 1, 1, 640., 400., "Kimochi Japanese Fixture"));
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
}

/// The process id of the frontmost application, whoever it is.
pub fn frontmost_pid() -> Option<u32> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|a| u32::try_from(a.processIdentifier()).ok())
}

/// Make Kimochi the active application without raising the rest of its windows.
///
/// For the controller menu: a game reads its controller only while it is the active
/// application, so taking activation is what stops the menu's stick and button presses
/// from also steering the game. `prefer` (the overlay) is made key by the caller; on macOS
/// the application has to be activated as well, since a non-activating panel can become
/// key while the game stays active and keeps reading the controller.
///
/// Activation brings the application's windows forward, so on its own this put the main
/// window and Settings in front of the game the reader was looking at, under the menu.
/// Every ordinary window of ours that is behind the game is therefore stepped out of the
/// way first (`orderOut`) and put back behind the game's window once the activation has
/// happened; panels (the overlay, the pop-up) are left alone, being what should come
/// forward. `activateIgnoringOtherApps:` is deprecated from macOS 14 in favour of
/// cooperative activation, but a background app asking for itself has nobody to yield to
/// it, and the old call still takes effect. Must run on the main thread.
pub fn activate_self(_prefer: Option<&tauri::WebviewWindow>) -> Result<(), String> {
    let mtm = objc2::MainThreadMarker::new().ok_or("activate_self requires the main thread")?;
    let app = NSApplication::sharedApplication(mtm);
    if !app.isActive() {
        step_aside(&app);
    }
    unsafe {
        let _: () = msg_send![&*app, activateIgnoringOtherApps: true];
    }
    Ok(())
}

/// The ordinary windows `activate_self` ordered out, front to back, and the foreign
/// window they go back behind. Window numbers rather than windows: `NSWindow` is not `Send`.
static STEPPED_ASIDE: std::sync::Mutex<Option<(isize, Vec<isize>)>> = std::sync::Mutex::new(None);
static ACTIVATION_OBSERVER: std::sync::Once = std::sync::Once::new();

/// Should activation never arrive (refused, or Kimochi was already on its way out),
/// the stepped-aside windows come back after this long anyway.
const STEP_ASIDE_LIMIT_NS: i64 = 750_000_000;

/// Window numbers of every on-screen window, front to back.
fn window_order() -> Vec<isize> {
    objc2::rc::autoreleasepool(|_| unsafe {
        // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
        let ptr = CGWindowListCopyWindowInfo(1 | (1 << 4), 0);
        let Some(list): Option<Retained<objc2_foundation::NSArray<NSDictionary<NSString, AnyObject>>>> =
            Retained::from_raw(ptr.cast())
        else {
            return Vec::new();
        };
        list.iter()
            .filter_map(|entry| {
                let value = entry.objectForKey(ns_string!("kCGWindowNumber"))?;
                let number: isize = msg_send![&*value, integerValue];
                Some(number)
            })
            .collect()
    })
}

/// Order out each ordinary window of ours that is behind the frontmost application's
/// window, remembering where they were; `restore_stepped_aside` puts them back.
fn step_aside(app: &NSApplication) {
    restore_stepped_aside(app);
    let own = std::process::id();
    let Some(front) = frontmost_pid().filter(|pid| *pid != own) else { return };
    let Some((anchor, _)) = i32::try_from(front).ok().and_then(front_window_number) else { return };
    let anchor = anchor as isize;
    let order = window_order();
    let Some(anchor_at) = order.iter().position(|n| *n == anchor) else { return };
    let mut behind: Vec<(usize, isize)> = Vec::new();
    for window in app.windows().iter() {
        let panel: bool = unsafe { msg_send![&*window, isKindOfClass: NSPanel::class()] };
        // Level 0 only: a pinned window floats above the game and stays where it is.
        if panel || !window.isVisible() || window.level() != 0 {
            continue;
        }
        let number = window.windowNumber();
        if let Some(at) = order.iter().position(|n| *n == number).filter(|at| *at > anchor_at) {
            behind.push((at, number));
        }
    }
    if behind.is_empty() {
        return;
    }
    behind.sort_unstable();
    let numbers: Vec<isize> = behind.into_iter().map(|(_, number)| number).collect();
    for number in &numbers {
        if let Some(window) = app.windowWithWindowNumber(*number) {
            window.orderOut(None);
        }
    }
    *STEPPED_ASIDE.lock().unwrap_or_else(|p| p.into_inner()) = Some((anchor, numbers));
    ACTIVATION_OBSERVER.call_once(|| unsafe {
        let center = objc2_foundation::NSNotificationCenter::defaultCenter();
        let handler = RcBlock::new(|_: std::ptr::NonNull<NSNotification>| {
            // On the next turn of the main loop, once AppKit has finished ordering the
            // activated application's windows.
            restore_soon(0);
        });
        // Lives for the whole process, like the workspace observers.
        let _ = center.addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSApplicationDidBecomeActiveNotification),
            None,
            None,
            &handler,
        );
    });
    restore_soon(STEP_ASIDE_LIMIT_NS);
}

extern "C" {
    static _dispatch_main_q: std::ffi::c_void;
    fn dispatch_time(when: u64, delta: i64) -> u64;
    fn dispatch_after_f(
        when: u64,
        queue: *const std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
}

/// Run `restore_stepped_aside` on the main queue after `delay_ns`.
fn restore_soon(delay_ns: i64) {
    extern "C" fn work(_: *mut std::ffi::c_void) {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            restore_stepped_aside(&NSApplication::sharedApplication(mtm));
        }
    }
    unsafe {
        dispatch_after_f(
            dispatch_time(0, delay_ns),
            std::ptr::addr_of!(_dispatch_main_q),
            std::ptr::null_mut(),
            work,
        );
    }
}

/// Put the stepped-aside windows back behind the window they were behind, in their
/// old order, without making any of them key. Once only; later calls find nothing.
fn restore_stepped_aside(app: &NSApplication) {
    let Some((anchor, numbers)) = STEPPED_ASIDE.lock().unwrap_or_else(|p| p.into_inner()).take() else {
        return;
    };
    let mut relative = anchor;
    for number in numbers {
        let Some(window) = app.windowWithWindowNumber(number) else { continue };
        window.orderWindow_relativeTo(objc2_app_kit::NSWindowOrderingMode::Below, relative);
        relative = number;
    }
}

/// Bring the application owning process `pid` to the front, with all its windows: what clicking a
/// window source in the sidebar does, since it may be behind other windows.
///
/// Kimochi is the active app when this is asked for (the reader just clicked it), so under macOS
/// 14's cooperative activation it yields first; older systems take the activation flags alone.
pub fn activate_process(pid: u32) -> Result<(), String> {
    let pid = i32::try_from(pid).map_err(|_| "invalid: process id out of range".to_string())?;
    unsafe {
        let app: *mut AnyObject = msg_send![
            objc2::class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app.is_null() {
            return Err("gone: that application is no longer running".into());
        }
        let shared: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
        let yields: bool =
            msg_send![shared, respondsToSelector: objc2::sel!(yieldActivationToApplication:)];
        if yields {
            let _: () = msg_send![shared, yieldActivationToApplication: app];
        }
        // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps.
        let activated: bool = msg_send![app, activateWithOptions: 3usize];
        if activated {
            Ok(())
        } else {
            Err("native: the application did not come to the front".into())
        }
    }
}

/// Whether window `id` is a full-screen app's window: on a full-screen Space, or, where
/// Accessibility is allowed and the Spaces cannot be read, the window's own `AXFullScreen`.
/// `None` when neither can say; the shared rule then goes by whether it fills its display.
pub fn window_fullscreen(id: &SourceId) -> Option<bool> {
    let number = id.handle_u32()?;
    if let Some(spaces) = spaces::Spaces::current() {
        return Some(spaces.is_full_screen(number));
    }
    focus::is_full_screen(i32::try_from(id.pid()?).ok()?, number)
}

/// Bring window source `id` to the front: that window, not just its application, switching to
/// its Space when it is on another (a full-screen app). Falls back to `activate_process`.
/// Main thread, as `activate_process`.
pub fn activate_window(id: &SourceId) -> Result<(), String> {
    let pid = id.pid().filter(|pid| *pid > 0).ok_or("invalid: the window has no process")?;
    if let Some(number) = id.handle_u32() {
        if focus::front_window(i32::try_from(pid).map_err(|_| "invalid: process id out of range")?, number) {
            return Ok(());
        }
    }
    activate_process(pid)
}

/// Accessibility: `Some(granted)`; this platform has the permission.
pub fn accessibility_status() -> Option<bool> {
    Some(focus::trusted())
}

/// Ask for Accessibility (the system prompt, and its Settings pane). Whether it is granted now.
pub fn request_accessibility() -> Result<bool, String> {
    Ok(focus::request())
}

// ---------------------------------------------------------------- system links

fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("native: {e}"))
}

/// Opens the Screen Recording pane. Requesting permission is an explicit user
/// action; nothing in this app probes or prompts on its own.
pub fn open_capture_settings() -> Result<(), String> {
    open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
}

// ---------------------------------------------------------------- command runner

/// One word for `zsh -c`, quoted only when it has to be, so ordinary flags and model
/// names reach the shell exactly as they always have.
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '=' | ':' | ',' | '@' | '+' | '%')
        });
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// Spawn a user-installed CLI with stdout and stderr piped.
///
/// Spawned through `zsh -ilc` so the user's interactive shell PATH applies (fnm/nvm
/// shims and ~/.local/bin live in .zshrc, which plain login shells don't read). Text
/// for the program goes through `stdin`, never argv, so no shell-quoting of user text is
/// needed; the arguments themselves are quoted where necessary.
pub fn run_cli(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    cwd: Option<&Path>,
) -> Result<std::process::Child, String> {
    let line = std::iter::once(program)
        .chain(args.iter().copied())
        .map(shell_word)
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = std::process::Command::new("/bin/zsh");
    command.arg("-ilc").arg(line);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    super::spawn_cli(command, stdin)
}

// ---------------------------------------------------------------- capabilities

fn os_version() -> String {
    let v = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    format!("{}.{}.{}", v.majorVersion, v.minorVersion, v.patchVersion)
}

/// The macOS-specific part of `platform_capabilities`; see `platform::capabilities_payload`
/// for how it is combined with capture, OCR and observer state.
pub fn capabilities() -> Value {
    json!({
        "os": "macos",
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "keys": {"primaryModifier": "meta", "labels": "symbols", "superName": "Command"},
        "capture": {
            "canOpenSettings": true,
            "restartAfterGrant": true,
            "pickerRequired": false,
            "windowCapture": true,
            "excludesOwnWindows": true,
        },
        "sources": {
            "catalog": true,
            "thumbnails": true,
            "icons": true,
            "followWindowBounds": true,
            "foregroundTracking": true,
        },
        "overlay": {
            "passive": true,
            "inputRegions": "poll",
            "nonActivating": true,
            "nativeHoverWorkaround": true,
        },
        "input": {"globalShortcuts": true},
        "ownAppNames": ["Kimochi", "Kimochi Next", "Kimochi Next POC"],
        "tray": true,
        "gamepad": true,
        "ocrAccelerators": {"meikiocr": "coreml", "mangaocr": "metal"},
    })
}

#[cfg(test)]
mod modifier_tests {
    use super::Modifiers;

    // The values are `CGEventFlags`, as the window server reports them.
    const SHIFT: u64 = 0x0002_0000;
    const CONTROL: u64 = 0x0004_0000;
    const OPTION: u64 = 0x0008_0000;
    const COMMAND: u64 = 0x0010_0000;
    const CAPS_LOCK: u64 = 0x0001_0000;
    /// Every sample also carries the keyboard's device state in the low bits.
    const DEVICE_NOISE: u64 = 0x0000_0102;

    #[test]
    fn nothing_held_is_no_modifiers() {
        assert_eq!(Modifiers::from_flags(0), Modifiers::default());
    }

    #[test]
    fn shift_is_the_trigger_and_is_read_alone() {
        let held = Modifiers::from_flags(SHIFT | DEVICE_NOISE);
        assert!(held.shift);
        assert!(!held.ctrl && !held.alt && !held.meta);
    }

    #[test]
    fn each_modifier_maps_to_the_name_the_dom_uses() {
        assert!(Modifiers::from_flags(CONTROL).ctrl);
        assert!(Modifiers::from_flags(OPTION).alt);
        assert!(Modifiers::from_flags(COMMAND).meta);
    }

    #[test]
    fn several_at_once_are_all_reported() {
        let held = Modifiers::from_flags(SHIFT | COMMAND);
        assert!(held.shift && held.meta);
        assert!(!held.ctrl && !held.alt);
    }

    #[test]
    fn caps_lock_is_not_a_held_key() {
        // It is a lock rather than something a reader is holding down, and Yomitan has
        // no input for it: reporting it would make a trigger fire for as long as it
        // stayed on.
        assert_eq!(Modifiers::from_flags(CAPS_LOCK), Modifiers::default());
    }
}

#[cfg(test)]
mod cli_tests {
    use super::shell_word;

    #[test]
    fn ordinary_words_reach_the_shell_unchanged() {
        for w in ["claude", "-p", "--output-format", "stream-json", "gpt-5.1", "-"] {
            assert_eq!(shell_word(w), w);
        }
    }

    #[test]
    fn anything_else_is_single_quoted() {
        assert_eq!(shell_word("a b"), "'a b'");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
        assert_eq!(shell_word(""), "''");
    }
}
