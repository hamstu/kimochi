//! Kimochi's own windows: placement, hit testing, cursors, z-order, focus policy and the
//! non-activating "panel" conversion. Physical virtual-screen pixels (see `mod.rs`).
//!
//! ## Why there is a window subclass, and what it guards against
//!
//! macOS gets non-activation from one property of `NSPanel`. Windows spreads it over
//! several mechanisms, and tao rewrites some of them behind our back:
//!
//!  - `WS_EX_NOACTIVATE` stops a *click* from activating the window, but not
//!    `ShowWindow(SW_SHOW)` or `SetWindowPos` without `SWP_NOACTIVATE`. tao shows a
//!    window with `SW_SHOW` (tao PR #1358 is about exactly this), so `window.show()`
//!    can still take focus from the reader's game.
//!  - tao keeps its own copy of the window's state (`WindowFlags`) and, whenever *any*
//!    flag changes — `set_ignore_cursor_events`, which the cursor poll toggles constantly,
//!    included — rewrites `GWL_STYLE`/`GWL_EXSTYLE` wholesale from that copy and calls
//!    `ShowWindow(SW_HIDE)` if it believes the window is hidden. Styles added with
//!    `SetWindowLongPtrW` alone would be wiped on the next toggle, and a window shown
//!    with `SW_SHOWNA` behind tao's back would be *hidden again* on the next toggle.
//!
//! So `make_panel` installs a subclass (`SetWindowSubclass`, runs before tao's own
//! window procedure) that, while the window is passive:
//!
//!  - answers `WM_MOUSEACTIVATE` with `MA_NOACTIVATE`;
//!  - adds `SWP_NOACTIVATE` to every `WM_WINDOWPOSCHANGING`, which is how `ShowWindow`
//!    and `SetWindowPos` deliver activation, so tao's `SW_SHOW` no longer activates;
//!  - re-asserts `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` (and strips `WS_EX_APPWINDOW`)
//!    in `WM_STYLECHANGING`, so tao's style rewrites cannot remove them.
//!
//! and `order_front` both shows with `SW_SHOWNA` *and* calls tao's `show()` so tao's
//! visibility flag stays true (the subclass makes that second show non-activating).
//!
//! `promote_to_key` (editing mode) lifts the guard for one window until it is
//! deactivated again (`WM_ACTIVATE`/`WA_INACTIVE`), so passive is the default and focus
//! is only ever taken deliberately (plan §11 decision 6).
//!
//! **Known risk, unverified until the Phase 3 spike:** WebView2 renders into a child
//! HWND owned by the `msedgewebview2.exe` browser process. Its `WM_MOUSEACTIVATE` goes
//! to *that* window first; `DefWindowProc` forwards it to the parent chain (and so to
//! this subclass), but Chromium's own handler may answer it itself, and Chromium calls
//! `SetFocus` on its child on mouse-down. Cross-process parent/child windows share an
//! input queue, so that `SetFocus` can still pull activation to this app. If the spike
//! shows it does, the fallback is the macOS-era design that already exists: keep the
//! window click-through (`set_ignore_cursor_events`) except over published regions,
//! and accept that clicking a region activates.
use super::{cursor, rect_of, rules, window_pid};
use kimochi_capture::Rect;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, GetAncestor, GetForegroundWindow, GetWindow,
    GetWindowLongPtrW, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, LoadCursorW, SendMessageTimeoutW, SetCursor, SetForegroundWindow,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, WindowFromPoint, ASFW_ANY, GA_ROOT, GWL_EXSTYLE,
    GWL_STYLE, GW_OWNER, HWND_TOP, HWND_TOPMOST, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND,
    IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE,
    IDC_WAIT, MA_NOACTIVATE, SMTO_ABORTIFHUNG, SMTO_ERRORONEXIT, STYLESTRUCT, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE, SW_SHOWNA, WA_INACTIVE,
    WINDOWPOS, WM_ACTIVATE, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NULL, WM_STYLECHANGING,
    WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

fn hwnd(w: &tauri::WebviewWindow) -> Result<HWND, String> {
    w.hwnd().map_err(|e| e.to_string())
}

fn window_rect(hwnd: HWND) -> Result<Rect, String> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r) }.map_err(|e| format!("native: {e}"))?;
    Ok(rect_of(r))
}

fn ex_style(hwnd: HWND) -> u32 {
    unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 }
}

/// The window's DPI scale (DPI / 96): physical pixels per CSS pixel at zoom 100 %.
fn window_scale(hwnd: HWND) -> f64 {
    match unsafe { GetDpiForWindow(hwnd) } {
        0 => 1.,
        dpi => f64::from(dpi) / 96.,
    }
}

// ---------------------------------------------------------------- geometry

/// Move and size a window in physical virtual-screen pixels, without activating it or
/// changing its z-order.
///
/// Moving across monitors with different DPI makes Windows send `WM_DPICHANGED`, and
/// tao answers it by resizing the window to the system's suggested (rescaled) rect from
/// *inside* this `SetWindowPos`. The first call therefore lands the window on the new
/// monitor with the wrong size; a second call, now on a monitor whose DPI no longer
/// changes, sticks. Twice at most, and only if the first did not hold.
pub fn place(w: &tauri::WebviewWindow, r: Rect) -> Result<(), String> {
    let hwnd = hwnd(w)?;
    let (x, y) = (r.x.round() as i32, r.y.round() as i32);
    let (cx, cy) = (
        r.width.round().max(1.) as i32,
        r.height.round().max(1.) as i32,
    );
    for _ in 0..2 {
        unsafe { SetWindowPos(hwnd, None, x, y, cx, cy, SWP_NOACTIVATE | SWP_NOZORDER) }
            .map_err(|e| format!("native: {e}"))?;
        let now = window_rect(hwnd)?;
        if now.x as i32 == x
            && now.y as i32 == y
            && now.width as i32 == cx
            && now.height as i32 == cy
        {
            break;
        }
    }
    Ok(())
}

/// The window's outer rectangle in physical virtual-screen pixels. Kimochi's windows
/// are undecorated, so there is no invisible resize border to subtract.
pub fn bounds(w: &tauri::WebviewWindow) -> Result<Rect, String> {
    window_rect(hwnd(w)?)
}

/// The pointer's position inside this window, if it is over this window and nothing
/// else is in front of it there; `None` otherwise.
///
/// Returned in the window's CSS pixels (local physical offset / DPI scale), because the
/// window's own page hit-tests with it. `WindowFromPoint` answers "who is under this
/// point" the way the system routes a click: it skips hidden, disabled and
/// `WS_EX_TRANSPARENT` (click-through) windows, so the click-through overlay never
/// occludes a panel, and the WebView2 child window it returns walks up (`GA_ROOT`) to
/// the top-level window that hosts it.
pub fn panel_pointer(w: &tauri::WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    let Some(sample) = cursor() else {
        return Ok(None);
    };
    let hwnd = hwnd(w)?;
    let r = window_rect(hwnd)?;
    let (x, y) = (sample.x, sample.y);
    if x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height {
        return Ok(None);
    }
    let hit = unsafe {
        WindowFromPoint(POINT {
            x: x as i32,
            y: y as i32,
        })
    };
    if hit.is_invalid() {
        return Ok(None);
    }
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    if root != hwnd {
        return Ok(None);
    }
    let scale = window_scale(hwnd);
    Ok(Some(((x - r.x) / scale, (y - r.y) / scale)))
}

/// Set the system cursor for a CSS `cursor` value, or the resize cursor on a resizable
/// window's frame edge, mirroring the macOS adapter.
///
/// Best effort, and mostly redundant on Windows: WebView2 sets the CSS cursor itself on
/// hover whether or not the window is active (unlike WKWebView in an inactive window,
/// which is why macOS needs this; capabilities report `nativeHoverWorkaround: false`).
/// `SetCursor` only shows while the pointer is over a window of the calling thread, so
/// call it on the main thread; the next `WM_SETCURSOR` from the WebView2 child may
/// replace it.
pub fn panel_cursor(w: &tauri::WebviewWindow, kind: &str) -> Result<(), String> {
    // Recheck ownership after the DOM round trip. Never set another app's cursor.
    let Some((x, y)) = panel_pointer(w)? else {
        return Ok(());
    };
    if cursor().is_some_and(|s| s.down) {
        return Ok(()); // Leave native dragging/resizing cursor tracking alone.
    }
    let hwnd = hwnd(w)?;
    let r = window_rect(hwnd)?;
    let scale = window_scale(hwnd);
    let edge = rules::resize_edge(
        x,
        y,
        r.width / scale,
        r.height / scale,
        w.is_resizable().map_err(|e| e.to_string())?,
    );
    use rules::CursorShape::*;
    let id = match rules::cursor_shape(kind, edge) {
        Arrow => IDC_ARROW,
        Hand => IDC_HAND,
        Move => IDC_SIZEALL,
        Cross => IDC_CROSS,
        No => IDC_NO,
        IBeam => IDC_IBEAM,
        SizeWE => IDC_SIZEWE,
        SizeNS => IDC_SIZENS,
        SizeNWSE => IDC_SIZENWSE,
        SizeNESW => IDC_SIZENESW,
        Wait => IDC_WAIT,
        AppStarting => IDC_APPSTARTING,
        Help => IDC_HELP,
    };
    let cursor = unsafe { LoadCursorW(None, id) }.map_err(|e| format!("native: {e}"))?;
    unsafe { SetCursor(Some(cursor)) };
    Ok(())
}

/// Diagnostic snapshot, keyed like the macOS one where a counterpart exists.
pub fn inspect(w: &tauri::WebviewWindow) -> Result<Value, String> {
    let hwnd = hwnd(w)?;
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) as u32 };
    let ex = ex_style(hwnd);
    let foreground = unsafe { GetForegroundWindow() };
    let own = std::process::id();
    Ok(json!({
        "hwnd": rules::hex_handle(hwnd.0 as usize),
        "style": format!("{style:#010x}"),
        "ex_style": format!("{ex:#010x}"),
        "topmost": ex & WS_EX_TOPMOST.0 != 0,
        "no_activate": ex & WS_EX_NOACTIVATE.0 != 0,
        "tool_window": ex & WS_EX_TOOLWINDOW.0 != 0,
        "app_window": ex & WS_EX_APPWINDOW.0 != 0,
        "layered": ex & WS_EX_LAYERED.0 != 0,
        // Click-through: what `set_ignore_cursor_events(true)` sets.
        "ignores_mouse": ex & WS_EX_TRANSPARENT.0 != 0,
        "visible": unsafe { IsWindowVisible(hwnd) }.as_bool(),
        "minimized": unsafe { IsIconic(hwnd) }.as_bool(),
        "can_become_key": ex & WS_EX_NOACTIVATE.0 == 0 || editing(hwnd),
        "is_key": foreground == hwnd,
        "app_active": !foreground.is_invalid() && window_pid(foreground) == own,
        "panel_subclass": is_panel(hwnd),
        "editing": editing(hwnd),
        "dpi_scale": window_scale(hwnd),
    }))
}

// ---------------------------------------------------------------- z-order and focus

/// Show a window in front without taking the keyboard from whatever has it.
///
/// `ShowWindow(SW_SHOWNA)` makes it visible without activation; tao's `show()` then
/// brings tao's own visibility flag in line — without it, tao would hide the window
/// again on its next style rewrite (see the module docs). With the panel subclass in
/// place that `show()` cannot activate; on a window `make_panel` was not applied to
/// (`KIMOCHI_NO_PANEL`) it may, which is the documented "old behaviour".
///
/// Then it is raised: to the top of the topmost band for an always-on-top window, to the
/// top of the normal band otherwise, never activating.
pub fn order_front(w: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = hwnd(w)?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNA);
    }
    w.show().map_err(|e| e.to_string())?;
    let after = if ex_style(hwnd) & WS_EX_TOPMOST.0 != 0 {
        HWND_TOPMOST
    } else {
        HWND_TOP
    };
    unsafe {
        SetWindowPos(
            hwnd,
            Some(after),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        )
    }
    .map_err(|e| format!("native: {e}"))
}

/// Fullscreen games can enter the topmost band ahead of an already-topmost
/// overlay. Repair only that ordering, without showing hidden windows, pinning
/// unpinned panels, changing our windows' relative order, or activating them.
pub fn start_fullscreen_watch(app: &tauri::AppHandle, service: crate::state::Shared) {
    let app = app.clone();
    std::thread::spawn(move || {
        let pending = Arc::new(AtomicBool::new(false));
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if app.get_webview_window("overlay").is_none() {
                break;
            }
            if fullscreen_foreground().is_none() || pending.swap(true, Ordering::Relaxed) {
                continue;
            }
            let handle = app.clone();
            let service = service.clone();
            let finished = pending.clone();
            if app
                .run_on_main_thread(move || {
                    repair_fullscreen_order(&handle, &service);
                    finished.store(false, Ordering::Relaxed);
                })
                .is_err()
            {
                break;
            }
        }
    });
}

fn fullscreen_foreground() -> Option<HWND> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid()
        || window_pid(foreground) == std::process::id()
        || ex_style(foreground) & WS_EX_TOPMOST.0 == 0
        || rules::is_tool_window(ex_style(foreground))
        || !unsafe { IsWindowVisible(foreground) }.as_bool()
        || unsafe { IsIconic(foreground) }.as_bool()
    {
        return None;
    }
    let bounds = window_rect(foreground).ok()?;
    super::displays()
        .into_iter()
        .any(|display| rules::covers_display(bounds, display))
        .then_some(foreground)
}

fn repair_fullscreen_order(app: &tauri::AppHandle, service: &crate::state::Service) {
    let Some(foreground) = fullscreen_foreground() else {
        return;
    };
    let order = super::sources::top_level_windows();
    let Some(source_rank) = order.iter().position(|h| *h == foreground) else {
        return;
    };
    let windows = app.webview_windows();
    let pinned: Vec<_> = order
        .iter()
        .enumerate()
        .filter_map(|(rank, hwnd)| {
            if ex_style(*hwnd) & WS_EX_TOPMOST.0 == 0
                || !unsafe { IsWindowVisible(*hwnd) }.as_bool()
                || unsafe { IsIconic(*hwnd) }.as_bool()
            {
                return None;
            }
            windows
                .values()
                .find(|w| w.hwnd().ok() == Some(*hwnd))
                .map(|w| (rank, *hwnd, w.label().to_owned()))
        })
        .collect();
    if !pinned.iter().any(|(rank, _, _)| *rank > source_rank) {
        return;
    }
    let mut raised = Vec::new();
    let mut errors = Vec::new();
    // Raise back-to-front so dictionary popups stay ahead of their own panels.
    for (_, hwnd, label) in pinned.into_iter().rev() {
        match unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
        } {
            Ok(()) => raised.push(label),
            Err(error) => errors.push(format!("{label}: {error}")),
        }
    }
    service.log(
        json!({"check": "fullscreen-order", "sourceHwnd": foreground.0 as usize,
        "raised": raised, "errors": errors}),
    );
}

/// Enter editing mode: give this window the keyboard, deliberately.
///
/// **Unlike macOS, this activates Kimochi.** macOS can make a non-activating panel key
/// while another application stays active; Windows has no such state — keyboard focus
/// lives in the foreground window's thread, so taking it means becoming the foreground
/// application, and the game loses focus (and, for many games, pauses or stops reading
/// the controller). Callers must therefore invoke this only for explicit editing — a
/// click into a text field, a shortcut that asks for input — per plan §11 decision 6,
/// never from hover (`spawn_cursor_poll`'s "arriving on the dictionary takes the
/// keyboard" must be gated off on Windows).
///
/// Must run on the main thread. Returns whether focus actually had to be taken.
pub fn promote_to_key(w: &tauri::WebviewWindow) -> Result<bool, String> {
    let hwnd = hwnd(w)?;
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Ok(false);
    }
    if unsafe { GetForegroundWindow() } == hwnd {
        return Ok(false);
    }
    // Lift the passive guard until this window is deactivated again.
    set_editing(hwnd, true);
    let taken = force_foreground(hwnd);
    if taken {
        unsafe {
            let _ = SetFocus(Some(hwnd));
        }
    } else {
        set_editing(hwnd, false);
    }
    Ok(taken)
}

/// `SetForegroundWindow`, with the documented workaround for the foreground lock.
///
/// The system only lets a process take the foreground when it already has it, was
/// started by the one that has it, or received the last input event; otherwise
/// `SetForegroundWindow` merely flashes the taskbar button. Attaching our input queue to
/// the current foreground thread's for the duration of the call makes us share its
/// foreground right. Detached immediately: an attached queue shares key state and would
/// stall us if that thread hung.
fn force_foreground(target: HWND) -> bool {
    unsafe {
        // Lets whichever process we hand the foreground to keep it (activate_process).
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let _ = SetForegroundWindow(target);
        if foreground_ready(target) {
            return true;
        }
        let foreground = GetForegroundWindow();
        let theirs = if foreground.is_invalid() {
            0
        } else {
            GetWindowThreadProcessId(foreground, None)
        };
        let ours = GetCurrentThreadId();
        if theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool() {
            let _ = BringWindowToTop(target);
            let _ = SetForegroundWindow(target);
            let _ = AttachThreadInput(ours, theirs, false);
        }
        foreground_ready(target)
    }
}

/// Return a completed hover lease to its exact source window, not a launcher.
pub(super) fn restore_input_focus(target: HWND) {
    if unsafe { IsWindowVisible(target) }.as_bool() { let _ = force_foreground(target); }
}

/// Across input queues, SetForegroundWindow can return before the target handles
/// its activation notification. WM_NULL waits for that notification to be handled
/// without changing the target. Bound the wait for a hung/exiting application, and
/// use the actual foreground HWND as the result, not the API's return value.
fn foreground_ready(target: HWND) -> bool {
    unsafe {
        if GetForegroundWindow() == target {
            return true;
        }
        let _ = SendMessageTimeoutW(
            target,
            WM_NULL,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            500,
            None,
        );
        GetForegroundWindow() == target
    }
}

/// Turn a finished window into a non-activating panel, as the Electron overlay was and
/// as `NSPanel` is on macOS: clicking it must not take the keyboard out of the reader's
/// game, and it must not appear in the taskbar or Alt+Tab.
///
/// Adds `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` (removing `WS_EX_APPWINDOW`) while keeping
/// every other style, refreshes the frame, drops the taskbar button, and installs the
/// panel subclass described in the module docs. Must run on the window's own (main)
/// thread: `SetWindowSubclass` fails silently anywhere else, so that is checked first.
///
/// Returns whether the window was converted. `KIMOCHI_NO_PANEL=1` skips it, which
/// leaves the old behaviour: clicks activate the app.
pub fn make_panel(w: &tauri::WebviewWindow) -> Result<bool, String> {
    if std::env::var_os("KIMOCHI_NO_PANEL").is_some() {
        return Ok(false);
    }
    let hwnd = hwnd(w)?;
    let owner = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if owner != unsafe { GetCurrentThreadId() } {
        return Err(
            "native: a window becomes a panel on the thread that owns it (the main thread)".into(),
        );
    }
    if !is_panel(hwnd) {
        if !unsafe { SetWindowSubclass(hwnd, Some(panel_proc), PANEL_SUBCLASS_ID, 0) }.as_bool() {
            return Err("native: SetWindowSubclass failed; clicks will activate the app".into());
        }
        PANELS.lock().unwrap().push(hwnd.0 as usize);
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let wanted = (ex | PANEL_EX) & !WS_EX_APPWINDOW.0;
        if wanted != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as i32 as isize);
        }
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        );
    }
    // A tool window applied to an already-visible window keeps its taskbar button until
    // the taskbar is told; tao does that through ITaskbarList.
    let _ = w.set_skip_taskbar(true);
    let applied = ex_style(hwnd);
    Ok(applied & PANEL_EX == PANEL_EX)
}

const PANEL_EX: u32 = WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0;
/// Our subclass id; tao uses its own, and the pair (proc, id) is what identifies one.
const PANEL_SUBCLASS_ID: usize = 0x4B49_4D4F; // "KIMO"

/// Windows converted by `make_panel`, and those of them currently in editing mode.
/// Raw handle values; touched on the main thread in practice, a mutex keeps it sound.
static PANELS: Mutex<Vec<usize>> = Mutex::new(Vec::new());
static EDITING: Mutex<Vec<usize>> = Mutex::new(Vec::new());

/// Bring the overlay family onto the virtual desktop `foreground` is on: a window belongs
/// to one desktop, so without this the overlay, the pop-up and the dictionary stayed
/// wherever Kimochi started and a game on another desktop got none of them. Called for
/// every change of foreground window, which a desktop switch always is.
pub(super) fn follow_desktop(foreground: HWND) {
    let panels = PANELS.lock().unwrap().clone();
    super::desktops::follow(foreground, &panels);
}

fn is_panel(hwnd: HWND) -> bool {
    PANELS.lock().unwrap().contains(&(hwnd.0 as usize))
}

fn editing(hwnd: HWND) -> bool {
    EDITING.lock().unwrap().contains(&(hwnd.0 as usize))
}

fn set_editing(hwnd: HWND, on: bool) {
    let raw = hwnd.0 as usize;
    let mut list = EDITING.lock().unwrap();
    list.retain(|h| *h != raw);
    if on {
        list.push(raw);
    }
}

unsafe extern "system" fn panel_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE if !editing(hwnd) => {
            return LRESULT(MA_NOACTIVATE as isize);
        }
        WM_WINDOWPOSCHANGING if !editing(hwnd) && lparam.0 != 0 => {
            // SAFETY: for this message lParam is a valid, writable WINDOWPOS.
            let pos = unsafe { &mut *(lparam.0 as *mut WINDOWPOS) };
            pos.flags |= SWP_NOACTIVATE;
        }
        WM_STYLECHANGING if wparam.0 as i32 == GWL_EXSTYLE.0 && lparam.0 != 0 => {
            // SAFETY: for this message lParam is a valid, writable STYLESTRUCT.
            let style = unsafe { &mut *(lparam.0 as *mut STYLESTRUCT) };
            style.styleNew = (style.styleNew | PANEL_EX) & !WS_EX_APPWINDOW.0;
        }
        WM_ACTIVATE if (wparam.0 & 0xFFFF) as u32 == WA_INACTIVE => {
            // Leaving editing mode: the next activation must be deliberate again.
            set_editing(hwnd, false);
        }
        WM_NCDESTROY => {
            let raw = hwnd.0 as usize;
            PANELS.lock().unwrap().retain(|h| *h != raw);
            set_editing(hwnd, false);
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(panel_proc), PANEL_SUBCLASS_ID) };
        }
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

// ---------------------------------------------------------------- activation

/// Top-level windows of one process in z-order (front first), with the facts needed to
/// pick the one that represents it.
fn process_windows(pid: u32) -> Vec<HWND> {
    super::sources::top_level_windows()
        .into_iter()
        .filter(|h| window_pid(*h) == pid)
        .collect()
}

/// The window that stands for a process: front-most visible-or-minimised, unowned,
/// non-tool window, preferring titled ones.
fn main_window_of(pid: u32) -> Option<HWND> {
    let candidates: Vec<HWND> = process_windows(pid)
        .into_iter()
        .filter(|h| unsafe {
            (IsWindowVisible(*h).as_bool() || IsIconic(*h).as_bool())
                && GetWindow(*h, GW_OWNER).map_or(true, |o| o.is_invalid())
                && !rules::is_tool_window(ex_style(*h))
        })
        .collect();
    candidates
        .iter()
        .copied()
        .find(|h| !super::window_text(*h).trim().is_empty())
        .or_else(|| candidates.first().copied())
}

/// Make Kimochi the foreground application, for the controller menu: a game reads its
/// controller only while it is in front (for XInput games; raw-input/DirectInput games
/// may keep reading it in the background, which no API here can prevent).
///
/// Windows activates *windows*, not applications, so one of ours has to come forward:
/// `prefer` (the overlay the menu is drawn on) with its passive guard lifted. Only if it
/// cannot take the foreground does the front-most ordinary window come forward instead:
/// that puts the main window over the game, which is the wrong picture but still stops
/// the game reading the controller. Must run on the main thread.
pub fn activate_self(prefer: Option<&tauri::WebviewWindow>) -> Result<(), String> {
    if let Some(window) = prefer {
        let target = hwnd(window)?;
        if promote_to_key(window)? || unsafe { GetForegroundWindow() } == target {
            return Ok(());
        }
    }
    let own = std::process::id();
    let windows = process_windows(own);
    let visible = |h: &HWND| unsafe { IsWindowVisible(*h) }.as_bool();
    let target = windows
        .iter()
        .copied()
        .filter(visible)
        .find(|h| ex_style(*h) & WS_EX_NOACTIVATE.0 == 0)
        .or_else(|| windows.iter().copied().find(visible))
        .ok_or("native: Kimochi has no visible window to bring forward")?;
    if is_panel(target) {
        set_editing(target, true);
    }
    if force_foreground(target) {
        Ok(())
    } else {
        set_editing(target, false);
        Err("native: Windows did not let Kimochi come to the front".into())
    }
}

/// Bring process `pid`'s main window to the front, restoring it if minimised: what
/// clicking a window source in the sidebar does.
///
/// Kimochi is normally the foreground app when this is asked for (the reader just
/// clicked it), which is what lets Windows honour the request.
pub fn activate_process(pid: u32) -> Result<(), String> {
    let Some(target) = main_window_of(pid) else {
        return Err(
            if super::process_image_path(pid).is_none() && process_windows(pid).is_empty() {
                "gone: that application is no longer running".into()
            } else {
                "native: that application has no window to bring forward".into()
            },
        );
    };
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
    }
    if force_foreground(target) {
        Ok(())
    } else {
        Err("native: the application did not come to the front".into())
    }
}

/// Bring window source `id` itself to the front, rather than its process's main window: an
/// application can have several, and the reader clicked this one. A window on another virtual
/// desktop is activated there, and Windows switches to that desktop. Falls back to the process
/// when the window is gone.
pub fn activate_window(id: &kimochi_capture::SourceId) -> Result<Value, String> {
    let Some(target) = super::sources::resolve(id) else {
        return match id.pid().filter(|pid| *pid > 0) {
            Some(pid) => activate_process(pid).map(|()| json!({ "fallback": true })),
            None => Err("gone: that window is closed".into()),
        };
    };
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
    }
    if force_foreground(target) {
        Ok(json!({ "foreground": true }))
    } else {
        Err("native: the window did not come to the front".into())
    }
}

/// Exposed for `icon.rs`.
pub(super) fn representative_window(pid: u32) -> Option<HWND> {
    main_window_of(pid)
}
