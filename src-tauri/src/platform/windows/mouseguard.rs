//! Consume overlay presses before the foreground game can observe them. Native
//! transparent-window routing alone does not prevent games polling mouse state.
//! The hook only reads a prepared snapshot with try_lock and queues fixed-size
//! messages. Region conversion and WebView delivery happen off the hook thread.
use crate::state::Service;
use kimochi_capture::{Rect, SourceId};
use std::cell::RefCell;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Mutex,
};
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, GetSystemMetrics, IsWindowVisible,
    PeekMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WindowFromPoint, GA_ROOT, HC_ACTION, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, SM_SWAPBUTTON,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_USER,
};

#[derive(Clone, Copy)]
struct Target {
    rect: Rect,
    window: usize,
    source: usize,
    origin: (f64, f64),
    scale: f64,
    popup: bool,
}
#[derive(Clone, Copy)]
struct Press {
    target: Target,
    x: i32,
    y: i32,
    button: u8,
    down: bool,
}
struct Hook {
    sender: SyncSender<Press>,
    owners: [Option<Target>; 2],
    swapped: bool,
}
thread_local! { static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) }; }
static TARGETS: Mutex<Vec<Target>> = Mutex::new(Vec::new());
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);
static PRIMARY_DOWN: AtomicBool = AtomicBool::new(false);

pub(super) fn primary_down() -> Option<bool> {
    PRIMARY_DOWN.load(Ordering::Relaxed).then_some(true)
}

pub fn update_mouse_guard(app: &tauri::AppHandle, service: &Service) {
    let source = service
        .selection
        .lock()
        .unwrap()
        .as_deref()
        .and_then(SourceId::parse)
        .filter(SourceId::is_window)
        .and_then(|id| usize::from_str_radix(id.handle().trim_start_matches("0x"), 16).ok())
        .unwrap_or(0);
    let geometry = crate::platform::DesktopGeometry::current();
    // hwnd()/bounds() may dispatch to the UI thread. Never hold the shared view
    // lock across them: UI commands also acquire that lock.
    let (regions, overlay_visible) = {
        let view = service.view.lock().unwrap();
        (view.regions.clone(), view.overlay_visible)
    };
    let mut targets = Vec::new();
    // Popup takes precedence over a word underneath it.
    for label in ["popup-host", "overlay"] {
        if label == "overlay" && !overlay_visible {
            continue;
        }
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let Ok(hwnd) = window.hwnd() else {
            continue;
        };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            continue;
        }
        let Ok(bounds) = super::bounds(&window) else {
            continue;
        };
        let scale = f64::from(unsafe { GetDpiForWindow(hwnd) }).max(96.) / 96.;
        for region in regions.get(label).into_iter().flatten() {
            if !region.usable() {
                continue;
            }
            targets.push(Target {
                rect: geometry.rect_from_desktop(Rect {
                    x: region.x,
                    y: region.y,
                    width: region.width,
                    height: region.height,
                }),
                window: hwnd.0 as usize,
                source,
                origin: (bounds.x, bounds.y),
                scale,
                popup: label == "popup-host",
            });
        }
    }
    *TARGETS.lock().unwrap() = targets;
}

pub fn start_mouse_guard(app: &tauri::AppHandle) -> Result<(), String> {
    let mut running = RUNNING.lock().unwrap();
    if running.is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::sync_channel::<Press>(1024);
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("kimochi-mouse-guard".into())
        .spawn(move || unsafe {
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
            HOOK.with(|state| {
                *state.borrow_mut() = Some(Hook {
                    sender,
                    owners: [None, None],
                    swapped: GetSystemMetrics(SM_SWAPBUTTON) != 0,
                })
            });
            let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
            let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0) {
                Ok(hook) => hook,
                Err(error) => {
                    HOOK.with(|state| state.borrow_mut().take());
                    let _ = ready_tx.send(Err(format!("mouse click guard: {error}")));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(hook);
            HOOK.with(|state| state.borrow_mut().take());
            PRIMARY_DOWN.store(false, Ordering::Relaxed);
        })
        .map_err(|error| error.to_string())?;
    *running = Some(ready_rx.recv().map_err(|error| error.to_string())??);
    let app = app.clone();
    std::thread::Builder::new()
        .name("kimochi-mouse-delivery".into())
        .spawn(move || {
            for press in receiver {
                let label = if press.target.popup {
                    "popup-host"
                } else {
                    "overlay"
                };
                let _ = app.emit_to(
                    label,
                    "windows-pointer-button",
                    serde_json::json!({
                        "x": (f64::from(press.x) - press.target.origin.0) / press.target.scale,
                        "y": (f64::from(press.y) - press.target.origin.1) / press.target.scale,
                        "button": press.button, "down": press.down,
                    }),
                );
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn stop_mouse_guard() {
    TARGETS.lock().unwrap().clear();
    if let Some(id) = RUNNING.lock().unwrap().take() {
        let _ = unsafe { PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        let transition = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some((0, true)),
            WM_LBUTTONUP => Some((0, false)),
            WM_RBUTTONDOWN => Some((1, true)),
            WM_RBUTTONUP => Some((1, false)),
            _ => None,
        };
        if let Some((physical, down)) = transition {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let consumed = HOOK.with(|state| {
                let mut state = state.borrow_mut();
                let Some(hook) = state.as_mut() else {
                    return false;
                };
                let button = if physical == usize::from(hook.swapped) {
                    0
                } else {
                    2
                };
                if down {
                    let target = TARGETS.try_lock().ok().and_then(|targets| {
                        targets
                            .iter()
                            .find(|target| {
                                let r = target.rect;
                                let hit = f64::from(info.pt.x) >= r.x
                                    && f64::from(info.pt.x) < r.x + r.width
                                    && f64::from(info.pt.y) >= r.y
                                    && f64::from(info.pt.y) < r.y + r.height;
                                if !hit {
                                    return false;
                                }
                                let window = HWND(target.window as *mut _);
                                let root =
                                    unsafe { GetAncestor(WindowFromPoint(info.pt), GA_ROOT) };
                                unsafe { IsWindowVisible(window) }.as_bool()
                                    && !root.is_invalid()
                                    && (root == window
                                        || root.0 as usize == target.source
                                        // A display capture has no single source HWND.
                                        // Still leave other Kimochi panels above it alone.
                                        || (target.source == 0
                                            && super::window_pid(root) != super::window_pid(window)))
                            })
                            .copied()
                    });
                    if let Some(target) = target {
                        let press = Press {
                            target,
                            x: info.pt.x,
                            y: info.pt.y,
                            button,
                            down,
                        };
                        if hook.sender.try_send(press).is_ok() {
                            hook.owners[physical] = Some(target);
                            if button == 0 {
                                PRIMARY_DOWN.store(true, Ordering::Relaxed);
                            }
                            return true;
                        }
                    }
                } else if let Some(target) = hook.owners[physical].take() {
                    let _ = hook.sender.try_send(Press {
                        target,
                        x: info.pt.x,
                        y: info.pt.y,
                        button,
                        down,
                    });
                    if button == 0 {
                        PRIMARY_DOWN.store(false, Ordering::Relaxed);
                    }
                    // Consume the matching release even if the pointer left or the
                    // overlay disappeared. Never deliver half a gesture to the game.
                    return true;
                }
                false
            });
            if consumed {
                return LRESULT(1);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
