//! Bound mouse buttons (`mouse_buttons`) on macOS: an active `CGEventTap` that sees only
//! other-mouse presses and releases (middle, back, forward; never left or right, never moves or
//! drags). It exists only while a button is bound, on a thread of its own.
//!
//! An active tap (one that can swallow events) needs Accessibility. Kimochi never asks for it
//! here: without it the binding is reported as failed and Settings explains why.
//!
//! The callback sits on the system's input path for those two event types, so it does what the
//! Windows hook does: an atomic load, thread-local reads, a `try_send`, nothing that allocates
//! or locks.
use crate::mouse_buttons::{self, Button, Step};
use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type CFTypeRef = *const c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;
type TapCallback = extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: TapCallback,
        info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: CFTypeRef, port: CFMachPortRef, order: isize) -> CFRunLoopSourceRef;
    fn CFMachPortInvalidate(port: CFMachPortRef);
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFTypeRef);
    fn CFRunLoopRunInMode(mode: CFTypeRef, seconds: f64, return_after_source_handled: bool) -> i32;
    fn CFRunLoopStop(run_loop: CFRunLoopRef);
    fn CFRelease(value: CFTypeRef);
    static kCFRunLoopDefaultMode: CFTypeRef;
}

const SESSION_EVENT_TAP: u32 = 1; // kCGSessionEventTap
const HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
const TAP_DEFAULT: u32 = 0; // kCGEventTapOptionDefault: may swallow
const OTHER_MOUSE_DOWN: u32 = 25;
const OTHER_MOUSE_UP: u32 = 26;
const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
const BUTTON_NUMBER: u32 = 3; // kCGMouseEventNumber
const SOURCE_STATE_ID: u32 = 45; // kCGEventSourceStateID
const HID_SYSTEM_STATE: i64 = 1; // kCGEventSourceStateHIDSystemState: the hardware

/// The running tap's run loop (as an address) and its stop flag.
static RUNNING: Mutex<Option<(usize, Arc<AtomicBool>)>> = Mutex::new(None);
// Per tap thread, where its callback runs: a tap still tearing down after a quick unbind and
// rebind cannot clear the new tap's pointer or its swallowed presses.
thread_local! {
    static SENDER: RefCell<Option<SyncSender<u8>>> = const { RefCell::new(None) };
    /// The live tap, so the callback can turn it back on after the system turned it off.
    static TAP: Cell<CFMachPortRef> = const { Cell::new(std::ptr::null_mut()) };
    /// Presses swallowed and not yet released (`mouse_buttons::step`).
    static OWNED: Cell<u8> = const { Cell::new(0) };
}

/// macOS numbers the other buttons from 2: middle, then back (3) and forward (4).
fn button(number: i64) -> Option<Button> {
    match number {
        2 => Some(Button::Middle),
        3 => Some(Button::Back),
        4 => Some(Button::Forward),
        _ => None,
    }
}

extern "C" fn callback(_proxy: CGEventTapProxy, kind: u32, event: CGEventRef, _info: *mut c_void) -> CGEventRef {
    if kind == DISABLED_BY_TIMEOUT || kind == DISABLED_BY_USER_INPUT {
        let tap = TAP.get();
        if !tap.is_null() {
            unsafe { CGEventTapEnable(tap, true) };
        }
        return event;
    }
    let down = match kind {
        OTHER_MOUSE_DOWN => true,
        OTHER_MOUSE_UP => false,
        _ => return event,
    };
    let Some(button) = button(unsafe { CGEventGetIntegerValueField(event, BUTTON_NUMBER) }) else {
        return event;
    };
    let injected = unsafe { CGEventGetIntegerValueField(event, SOURCE_STATE_ID) } != HID_SYSTEM_STATE;
    let mut owned = OWNED.get();
    let step = mouse_buttons::step(&mut owned, mouse_buttons::armed(), button, down, injected);
    OWNED.set(owned);
    match step {
        Step::Pass => event,
        Step::Swallow => std::ptr::null_mut(),
        Step::Fire => {
            SENDER.with(|sender| {
                if let Some(sender) = sender.borrow().as_ref() {
                    let _ = sender.try_send(button as u8);
                }
            });
            std::ptr::null_mut()
        }
    }
}

/// Install the tap when a button is bound (`wanted`) and remove it when none is.
pub fn sync(app: &tauri::AppHandle, wanted: bool) -> Result<(), String> {
    let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    if !wanted {
        if let Some((run_loop, stop)) = running.take() {
            stop.store(true, Ordering::SeqCst);
            unsafe { CFRunLoopStop(run_loop as CFRunLoopRef) };
        }
        return Ok(());
    }
    if !super::focus::trusted() {
        return Err("mouse buttons need Accessibility (System Settings → Privacy & Security)".into());
    }
    if running.is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::sync_channel::<u8>(16);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<usize, String>>();
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    std::thread::Builder::new()
        .name("kimochi-mouse-tap".into())
        .spawn(move || unsafe {
            let mask = (1u64 << OTHER_MOUSE_DOWN) | (1u64 << OTHER_MOUSE_UP);
            let tap = CGEventTapCreate(SESSION_EVENT_TAP, HEAD_INSERT, TAP_DEFAULT, mask, callback, std::ptr::null_mut());
            if tap.is_null() {
                let _ = ready_tx.send(Err("macOS refused the mouse button tap".into()));
                return;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            if source.is_null() {
                CFMachPortInvalidate(tap);
                CFRelease(tap);
                let _ = ready_tx.send(Err("macOS refused the mouse button tap".into()));
                return;
            }
            SENDER.with(|slot| *slot.borrow_mut() = Some(sender));
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
            TAP.set(tap);
            CGEventTapEnable(tap, true);
            let _ = ready_tx.send(Ok(run_loop as usize));
            // In slices, so a stop that lands before the loop starts is still seen.
            while !stopping.load(Ordering::SeqCst) {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, false);
            }
            CGEventTapEnable(tap, false);
            TAP.set(std::ptr::null_mut());
            CFMachPortInvalidate(tap);
            CFRelease(source);
            CFRelease(tap);
            SENDER.with(|slot| slot.borrow_mut().take());
        })
        .map_err(|e| e.to_string())?;
    let run_loop = ready_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| {
            stop.store(true, Ordering::SeqCst);
            "the mouse button tap did not start".to_string()
        })??;
    *running = Some((run_loop, stop));
    let app = app.clone();
    std::thread::Builder::new()
        .name("kimochi-mouse-shortcuts".into())
        .spawn(move || {
            // Ends when the tap thread drops its sender.
            for button in receiver {
                mouse_buttons::fire(&app, button);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_buttons_map_to_middle_back_and_forward() {
        assert_eq!(button(2), Some(Button::Middle));
        assert_eq!(button(3), Some(Button::Back));
        assert_eq!(button(4), Some(Button::Forward));
        for number in [0, 1, 5, 31] {
            assert_eq!(button(number), None);
        }
    }
}
