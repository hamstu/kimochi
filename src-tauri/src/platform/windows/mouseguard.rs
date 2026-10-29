//! Consume overlay presses before the foreground game can observe them. Native
//! transparent-window routing alone does not prevent games polling mouse state.
//! The hook only reads a prepared snapshot with try_lock and queues fixed-size
//! messages. Region conversion and WebView delivery happen off the hook thread.
use crate::state::Service;
use kimochi_capture::{Rect, SourceId};
use std::cell::RefCell;
use std::time::{Duration, Instant};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc::{self, SyncSender},
    Mutex,
};
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM, POINT};
use windows::Win32::System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, GetSystemMetrics, IsWindowVisible,
    PeekMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WindowFromPoint, GetCursorPos, GetForegroundWindow, GA_ROOT, HC_ACTION, MSG, MSLLHOOKSTRUCT, KBDLLHOOKSTRUCT, PM_NOREMOVE, SM_SWAPBUTTON,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_USER,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
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
    keys: SyncSender<(u32, bool, bool, bool)>,
    key_owners: [bool; 256],
    keys_down: [bool; 256],
    owners: [Option<Target>; 2],
    swapped: bool,
}
thread_local! { static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) }; }
static TARGETS: Mutex<Vec<Target>> = Mutex::new(Vec::new());
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);
static PRIMARY_DOWN: AtomicBool = AtomicBool::new(false);
static REGION: AtomicBool = AtomicBool::new(false);
static NAV: AtomicBool = AtomicBool::new(false);
static BLOCKED_MODIFIERS: AtomicU32 = AtomicU32::new(0);
static HOVER_LEASE: AtomicBool = AtomicBool::new(false);
static FOCUS_PENDING: AtomicBool = AtomicBool::new(false);
static RETURN_WINDOW: Mutex<Option<(usize, usize)>> = Mutex::new(None);
static LAST_HOVER: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_FOCUS_TRY: Mutex<Option<Instant>> = Mutex::new(None);

fn modifier_bit(key: u32) -> u32 {
    match key { 16 | 160 => 1, 161 => 2, 17 | 162 => 4, 163 => 8, _ => 0 }
}

pub(super) fn modifier_down(key: u16) -> bool {
    let bits = BLOCKED_MODIFIERS.load(Ordering::Relaxed);
    match key { 16 => bits & 3 != 0, 17 => bits & 12 != 0, _ => false }
}

pub fn set_keyboard_guard(region: bool, navigation: bool) {
    REGION.store(region, Ordering::Relaxed);
    NAV.store(navigation, Ordering::Relaxed);
}

fn key_name(key: u32) -> Option<&'static str> {
    match key {
        13 => Some("Enter"), 27 => Some("Escape"), 32 => Some(" "),
        37 => Some("ArrowLeft"), 38 => Some("ArrowUp"),
        39 => Some("ArrowRight"), 40 => Some("ArrowDown"), _ => None,
    }
}

// Preserve OS escape routes. Blocked Shift/Control state is supplied to pointer polling.
fn protected_key(key: u32) -> bool {
    matches!(key, 9 | 18 | 91..=92 | 164..=165)
}

fn captures_key(owned: bool, down: bool, was_down: bool, modal: bool, hover: bool, ours: bool, source: bool) -> bool {
    owned || down && !was_down && (modal && (ours || source) || hover && source && !ours)
}

/// Quick Shot has a display, not a source HWND. Its editing keys must still reach the
/// selector while a foreign application owns the keyboard. Keep ordinary typing and
/// system escape routes subject to the existing focus policy.
fn region_key_target(region: bool, key: u32, source: bool) -> bool {
    source || region && matches!(key, 13 | 27 | 32)
}

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
    update_hover_focus(app);
}

// A foreground lease also stops games that read input only while active from
// polling the controller under a hovered dictionary. Never activate the main
// window, and never pull focus back after an intentional Alt-Tab elsewhere.
fn update_hover_focus(app: &tauri::AppHandle) {
    let mut point = POINT::default();
    let foreground = unsafe { GetForegroundWindow() }.0 as usize;
    let leased = HOVER_LEASE.load(Ordering::Relaxed);
    let target = unsafe { GetCursorPos(&mut point) }.ok().and_then(|()| target_at(point))
        .filter(|target| foreground == target.source || foreground == target.window
            || leased && super::window_pid(HWND(foreground as *mut _)) == std::process::id());
    if REGION.load(Ordering::Relaxed) || NAV.load(Ordering::Relaxed) {
        *LAST_HOVER.lock().unwrap() = Some(Instant::now());
        return;
    }
    if target.is_some() { *LAST_HOVER.lock().unwrap() = Some(Instant::now()); }
    if target.is_none() && leased && LAST_HOVER.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(120)) { return; }
    if target.is_none() && leased && crate::gamepad::buttons_held()
        && LAST_HOVER.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(1500)) { return; }
    if target.is_none() && !HOVER_LEASE.load(Ordering::Relaxed) { return; }
    if target.is_some() && HOVER_LEASE.load(Ordering::Relaxed) { return; }
    if !leased {
        if target.is_none_or(|target| target.source == 0 || target.source != foreground) { return; }
        let mut retry = LAST_FOCUS_TRY.lock().unwrap();
        if retry.is_some_and(|t| t.elapsed() < Duration::from_millis(500)) { return; }
        *retry = Some(Instant::now());
    }
    if FOCUS_PENDING.swap(true, Ordering::Relaxed) { return; }
    let handle = app.clone();
    if app.run_on_main_thread(move || {
        if !REGION.load(Ordering::Relaxed) && !NAV.load(Ordering::Relaxed) {
            let foreground = unsafe { GetForegroundWindow() };
            let mut previous = RETURN_WINDOW.lock().unwrap();
            let was_leased = previous.is_some();
            if let Some(target) = target {
                if target.source != 0 && foreground.0 as usize == target.source {
                    let label = if target.popup { "popup-host" } else { "overlay" };
                    if let Some(window) = handle.get_webview_window(label) {
                        if super::promote_to_key(&window).unwrap_or(false) {
                            *previous = Some((target.source, target.window));
                        }
                    }
                }
            } else if let Some((source, owner)) = previous.take() {
                if foreground.0 as usize == owner {
                    super::window::restore_input_focus(HWND(source as *mut _));
                }
            }
            HOVER_LEASE.store(previous.is_some(), Ordering::Relaxed);
            if was_leased != previous.is_some() {
              if let Some(service) = handle.try_state::<crate::state::Shared>() {
                crate::record(&handle, &service, serde_json::json!({
                    "check": "windows-input-focus", "hover": previous.is_some(),
                    "foreground": unsafe { GetForegroundWindow() }.0 as usize,
                }));
              }
            }
        }
        FOCUS_PENDING.store(false, Ordering::Relaxed);
    }).is_err() { FOCUS_PENDING.store(false, Ordering::Relaxed); }
}

pub fn start_mouse_guard(app: &tauri::AppHandle) -> Result<(), String> {
    let mut running = RUNNING.lock().unwrap();
    if running.is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::sync_channel::<Press>(1024);
    let (keys, key_receiver) = mpsc::sync_channel(1024);
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("kimochi-mouse-guard".into())
        .spawn(move || unsafe {
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
            HOOK.with(|state| {
                *state.borrow_mut() = Some(Hook {
                    sender,
                    keys,
                    key_owners: [false; 256],
                    keys_down: [false; 256],
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
            let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
            if let Err(error) = &keyboard {
                let _ = UnhookWindowsHookEx(hook);
                HOOK.with(|state| state.borrow_mut().take());
                let _ = ready_tx.send(Err(format!("keyboard guard: {error}")));
                return;
            }
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(hook);
            if let Ok(keyboard) = keyboard { let _ = UnhookWindowsHookEx(keyboard); }
            HOOK.with(|state| state.borrow_mut().take());
            PRIMARY_DOWN.store(false, Ordering::Relaxed);
            BLOCKED_MODIFIERS.store(0, Ordering::Relaxed);
        })
        .map_err(|error| error.to_string())?;
    *running = Some(ready_rx.recv().map_err(|error| error.to_string())??);
    let app = app.clone();
    let key_app = app.clone();
    std::thread::Builder::new().name("kimochi-key-delivery".into()).spawn(move || {
        for (key, down, region, nav) in key_receiver {
            let Some(name) = key_name(key) else { continue };
            let payload = serde_json::json!({ "key": name, "type": if down { "keydown" } else { "keyup" } });
            if region && matches!(key, 13 | 27 | 32) { let _ = key_app.emit("region-key", &payload); }
            if nav { let _ = key_app.emit("controller-key", &payload); }
        }
    }).map_err(|e| e.to_string())?;
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

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let key = info.vkCode;
        if key < 256 && (down || up) && !protected_key(key) {
            let consumed = HOOK.with(|state| {
                let mut state = state.borrow_mut();
                let Some(hook) = state.as_mut() else { return false };
                let region = REGION.load(Ordering::Relaxed);
                let nav = NAV.load(Ordering::Relaxed);
                let foreground = unsafe { GetForegroundWindow() };
                let ours = super::window_pid(foreground) == std::process::id();
                let mut point = POINT::default();
                let hover = unsafe { GetCursorPos(&mut point) }.is_ok() && target_at(point).is_some();
                let source = TARGETS.try_lock().ok().is_some_and(|targets| targets.iter().any(|t| t.source == foreground.0 as usize));
                let owned = hook.key_owners[key as usize];
                let was_down = hook.keys_down[key as usize];
                hook.keys_down[key as usize] = down;
                if !captures_key(owned, down, was_down, region || nav, hover, ours, region_key_target(region, key, source)) { return false; }
                if down && (region || nav) && key_name(key).is_some()
                    && hook.keys.try_send((key, true, region, nav)).is_err() { return owned; }
                if up { let _ = hook.keys.try_send((key, false, region, nav)); }
                hook.key_owners[key as usize] = down;
                if down { BLOCKED_MODIFIERS.fetch_or(modifier_bit(key), Ordering::Relaxed); }
                else { BLOCKED_MODIFIERS.fetch_and(!modifier_bit(key), Ordering::Relaxed); }
                true
            });
            if consumed { return LRESULT(1); }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_shot_editing_keys_work_with_a_foreign_foreground_and_no_window_source() {
        // Quick Shot leaves the game focused and its full-display target has source == 0.
        // Previously Escape was delivered to that game, leaving the selector stuck open.
        for key in [13, 27, 32] {
            let target = region_key_target(true, key, false);
            assert!(captures_key(false, true, false, true, false, false, target));
            // Closing the selector on key-down must not leak the matching release.
            assert!(captures_key(true, false, true, false, false, false, false));
            assert!(!captures_key(false, true, false, false, false, false,
                region_key_target(false, key, false)));
        }
        for key in [9, 18, 65, 91, 162] {
            assert!(!captures_key(false, true, false, true, false, false,
                region_key_target(true, key, false)), "foreign app keeps key {key}");
        }
    }

    #[test]
    fn a_claimed_key_keeps_its_release_after_the_menu_closes_or_focus_changes() {
        assert!(captures_key(false, true, false, true, false, false, true));
        assert!(captures_key(true, false, true, false, false, false, false));
        assert!(captures_key(true, true, true, false, false, false, false));
    }

    #[test]
    fn keys_held_before_opening_do_not_lose_their_release() {
        assert!(!captures_key(false, false, true, true, false, true, false));
        assert!(!captures_key(false, true, true, true, false, true, false));
    }

    #[test]
    fn another_application_keeps_its_keys_and_dictionary_fields_keep_typing() {
        assert!(!captures_key(false, true, false, true, false, false, false));
        assert!(!captures_key(false, true, false, false, true, true, false));
        assert!(captures_key(false, true, false, false, true, false, true));
    }

    #[test]
    fn system_escape_routes_stay_available_but_menu_modifiers_are_guarded() {
        for key in [9, 18, 91, 92, 164, 165] { assert!(protected_key(key)); }
        for key in [13, 16, 17, 27, 37, 160, 163] { assert!(!protected_key(key)); }
        assert_eq!(modifier_bit(160) | modifier_bit(161), 3);
        assert_eq!(modifier_bit(162) | modifier_bit(163), 12);
    }
}

fn target_at(point: POINT) -> Option<Target> {
    let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
    TARGETS.try_lock().ok()?.iter().find(|target| {
        let r = target.rect;
        f64::from(point.x) >= r.x && f64::from(point.x) < r.x + r.width
            && f64::from(point.y) >= r.y && f64::from(point.y) < r.y + r.height
            && unsafe { IsWindowVisible(HWND(target.window as *mut _)) }.as_bool()
            && (root.0 as usize == target.window || root.0 as usize == target.source)
    }).copied()
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
