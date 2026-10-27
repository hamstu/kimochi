//! System sleep/wake and application activation: the Windows counterpart of the macOS
//! `NSWorkspace` notifications (Electron's `powerMonitor`, which Tauri does not wrap).
//!
//! The callbacks are `'static` but not `Send`, exactly as on macOS, and for the same
//! reason they are honoured the same way: everything is created **on the calling
//! thread**, which must be the main (UI) thread, and the callbacks run there. That
//! thread already runs tao's message loop, and that loop is what delivers both the
//! message-only window's `WM_POWERBROADCAST` and the out-of-context WinEvent callback,
//! so no extra thread and no marshalling is needed. Called from a thread with no
//! message loop, nothing would ever fire; `setup` (where `main.rs` calls it) is the
//! main thread.
use super::{process_name, rules, window_pid};
use std::cell::{Cell, RefCell};
use windows::core::w;
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassExW, DEVICE_NOTIFY_WINDOW_HANDLE,
    EVENT_SYSTEM_FOREGROUND, HWND_MESSAGE, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    PBT_APMSUSPEND, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WM_POWERBROADCAST,
    WNDCLASSEXW,
};

struct Handlers {
    on_sleep: Box<dyn Fn()>,
    on_wake: Box<dyn Fn()>,
    on_activate: Box<dyn Fn(String)>,
    suspended: Cell<bool>,
    /// The process last reported active, so a focus change between two windows of the
    /// same application is not reported as that application activating again (macOS
    /// notifies per application, not per window).
    last_pid: Cell<u32>,
}

thread_local! {
    static HANDLERS: RefCell<Option<Handlers>> = const { RefCell::new(None) };
}

/// Observe sleep, wake and application activation for the life of the process.
///
/// Sleep/wake come from a message-only window registered with
/// `RegisterSuspendResumeNotification`: message-only windows do not receive broadcast
/// messages, and `WM_POWERBROADCAST` is a broadcast unless a window asks for it this
/// way. A user-initiated resume produces two resume events; it is reported as one wake.
///
/// Activation comes from `EVENT_SYSTEM_FOREGROUND`, reported once per change of
/// foreground *process*, with the image stem as the name. Our own process is included,
/// as `NSWorkspaceDidActivateApplicationNotification` includes Kimochi on macOS.
///
/// The observers live for the whole process; there is nothing to unregister.
pub fn observe_workspace(
    on_sleep: impl Fn() + 'static,
    on_wake: impl Fn() + 'static,
    on_activate: impl Fn(String) + 'static,
) {
    HANDLERS.with(|h| {
        *h.borrow_mut() = Some(Handlers {
            on_sleep: Box::new(on_sleep),
            on_wake: Box::new(on_wake),
            on_activate: Box::new(on_activate),
            suspended: Cell::new(false),
            last_pid: Cell::new(0),
        })
    });
    unsafe {
        let instance = GetModuleHandleW(None).ok().map(|m| m.into());
        let class = w!("KimochiWorkspaceObserver");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(power_proc),
            hInstance: instance.unwrap_or_default(),
            lpszClassName: class,
            ..Default::default()
        };
        // Zero when the class already exists (a second call); creation still works.
        RegisterClassExW(&wc);
        match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            instance,
            None,
        ) {
            Ok(hwnd) => {
                // The handle is intentionally leaked: it lives as long as the process.
                let _ =
                    RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);
            }
            Err(e) => eprintln!("platform: power notifications unavailable: {e}"),
        }
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(activate_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_invalid() {
            eprintln!("platform: foreground notifications unavailable");
        }
    }
}

unsafe extern "system" fn power_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_POWERBROADCAST {
        let event = match wparam.0 as u32 {
            PBT_APMSUSPEND => Some(rules::PowerEvent::Suspend),
            PBT_APMRESUMEAUTOMATIC => Some(rules::PowerEvent::ResumeAutomatic),
            PBT_APMRESUMESUSPEND => Some(rules::PowerEvent::ResumeSuspend),
            _ => None,
        };
        if let Some(event) = event {
            let _ = HANDLERS.try_with(|h| {
                if let Some(h) = h.borrow().as_ref() {
                    let (report, suspended) = rules::power_transition(h.suspended.get(), event);
                    h.suspended.set(suspended);
                    match report {
                        Some(true) => (h.on_sleep)(),
                        Some(false) => (h.on_wake)(),
                        None => {}
                    }
                }
            });
            return LRESULT(1); // TRUE: no objection to the power change
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn activate_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    if event != EVENT_SYSTEM_FOREGROUND || hwnd.is_invalid() {
        return;
    }
    // Per window, before the per-process filter: switching desktops within one app counts.
    super::window::follow_desktop(hwnd);
    let pid = window_pid(hwnd);
    if pid == 0 {
        return;
    }
    // `try_with` here and in `power_proc`: these callbacks can still arrive while the UI
    // thread's locals are being destroyed at exit, and a panic cannot unwind into Windows.
    let _ = HANDLERS.try_with(|h| {
        if let Some(h) = h.borrow().as_ref() {
            if h.last_pid.replace(pid) == pid {
                return;
            }
            if let Some(name) = process_name(pid) {
                (h.on_activate)(name);
            }
        }
    });
}
