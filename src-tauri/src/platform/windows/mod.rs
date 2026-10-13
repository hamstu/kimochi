//! Windows desktop integration: the same contract as `platform::macos`, over Win32.
//!
//! **Coordinates are PHYSICAL virtual-screen pixels throughout**, top-left origin, and
//! may be negative (a monitor left of or above the primary). That is the space
//! `GetCursorPos`, `GetWindowRect`, `MONITORINFO` and `DWMWA_EXTENDED_FRAME_BOUNDS` all
//! report in a Per-Monitor-V2 DPI-aware process, which tao makes this process at
//! startup, and it is the only global plane that is not a fiction under mixed DPI. It
//! plays the role "macOS desktop points" play in `platform::macos`. Tauri's logical
//! positions/sizes are never used here: they are per-monitor and would shear across a
//! 100 % / 150 % boundary. Every window is addressed through `WebviewWindow::hwnd()`.
//!
//! The one exception is `panel_pointer`, which returns a *window-local* point in the
//! window's CSS pixels (physical / the window's DPI scale), because its only consumer
//! is the window's own DOM; on macOS points and CSS pixels coincide, here they do not.
//!
//! Handles on the wire: windows are `windows:window:0x{HWND:X}:{pid}` and displays
//! `windows:display:0x{HMONITOR:X}`, upper-case hex with a `0x` prefix, byte-identical
//! to capture-core's `win_rules::hex_handle` (see `display_source_id`).
//!
//! Threading: the window functions (`place`, `order_front`, `promote_to_key`,
//! `make_panel`, `panel_cursor`, `activate_*`) are meant to run on the main (UI) thread,
//! exactly as on macOS. Win32 would accept most of them from another thread, but it then
//! sends cross-thread messages synchronously, which deadlocks if the main thread is
//! waiting on the caller; `make_panel` refuses outright because `SetWindowSubclass` only
//! works on the owning thread. The read-only queries (`cursor`, `displays`,
//! `picker_sources`, `window_bounds`, `front_window`, ...) are safe from any thread.
use super::{DisplayInfo, Modifiers, PointerSample};
use kimochi_capture::{Platform, Rect, SourceId};
use serde_json::{json, Value};
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MENU, VK_RBUTTON, VK_RWIN,
    VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    MONITORINFOF_PRIMARY, SM_SWAPBUTTON,
};

mod cli;
mod icon;
mod mouseguard;
mod rules;
mod sources;
mod window;
mod workspace;

pub use cli::run_cli;
pub use icon::app_icon_png;
pub use mouseguard::{start_mouse_guard, stop_mouse_guard, update_mouse_guard};
pub use sources::{front_window, frontmost_app, frontmost_pid, picker_sources, window_bounds};
pub use window::{
    activate_process, activate_self, bounds, inspect, make_panel, order_front, panel_cursor,
    panel_pointer, place, promote_to_key, start_fullscreen_watch,
};
pub use workspace::observe_workspace;

// ---------------------------------------------------------------- input regions

/// No native input regions on Windows (yet): `Ok(false)`, and the shared cursor poll
/// keeps toggling click-through. `WS_EX_TRANSPARENT` (what Tauri's
/// `set_ignore_cursor_events` sets) is all-or-nothing for the whole window, and a
/// window region (`SetWindowRgn`) would clip painting as well as hit-testing. Answering
/// `WM_NCHITTEST` with `HTTRANSPARENT` outside the regions would be the per-region
/// route, but WebView2 hosts its content in a child HWND of another process's
/// composition, which takes the hit test before the top-level window is asked.
pub fn set_input_regions(
    _w: &tauri::WebviewWindow,
    _regions: Option<&[Rect]>,
) -> Result<bool, String> {
    Ok(false)
}

// ---------------------------------------------------------------- pointer

/// Where the pointer is, whether the primary button is down, and which modifiers are
/// held — the Windows counterpart of the one synthesised `CGEvent` on macOS.
///
/// `GetAsyncKeyState` reads the physical key state no matter which window has the
/// keyboard, which is the point: the modifier that triggers a Yomitan scan is pressed
/// while the reader's game has focus. Two honest limits:
///
///  - the *primary* button is whichever the user configured (`SM_SWAPBUTTON`), not
///    always `VK_LBUTTON`;
///  - while an elevated (administrator) window is in front, User Interface Privilege
///    Isolation hides its input from this non-elevated process, so the buttons and
///    modifiers read as up. The position is still reported.
///
/// `None` when the cursor position cannot be read, which is what the secure desktop
/// (lock screen, UAC prompt) looks like.
pub fn cursor() -> Option<PointerSample> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    let held =
        |vk: VIRTUAL_KEY| (unsafe { GetAsyncKeyState(i32::from(vk.0)) } as u16) & 0x8000 != 0;
    let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
        VK_RBUTTON
    } else {
        VK_LBUTTON
    };
    Some(PointerSample {
        x: f64::from(p.x),
        y: f64::from(p.y),
        down: mouseguard::primary_down().unwrap_or_else(|| held(primary)),
        modifiers: Modifiers {
            shift: held(VK_SHIFT),
            ctrl: held(VK_CONTROL),
            alt: held(VK_MENU),
            meta: held(VK_LWIN) || held(VK_RWIN),
        },
    })
}

// ---------------------------------------------------------------- displays

struct Monitor {
    handle: HMONITOR,
    bounds: Rect,
    work_area: Rect,
}

fn rect_of(r: RECT) -> Rect {
    Rect {
        x: f64::from(r.left),
        y: f64::from(r.top),
        width: f64::from(r.right - r.left),
        height: f64::from(r.bottom - r.top),
    }
}

/// Every monitor, primary first (the order macOS reports displays in, and what callers
/// that take "the first display" as the main one expect), then in enumeration order.
fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn collect(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the `&mut Vec` passed below, alive for the whole call.
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(h);
        BOOL(1)
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    let _ = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
        )
    };
    let mut list: Vec<(bool, Monitor)> = handles
        .into_iter()
        .filter_map(|handle| {
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            unsafe { GetMonitorInfoW(handle, &mut info) }
                .as_bool()
                .then(|| {
                    (
                        info.dwFlags & MONITORINFOF_PRIMARY != 0,
                        Monitor {
                            handle,
                            bounds: rect_of(info.rcMonitor),
                            work_area: rect_of(info.rcWork),
                        },
                    )
                })
        })
        .collect();
    list.sort_by_key(|(primary, _)| !*primary);
    list.into_iter().map(|(_, m)| m).collect()
}

/// A stable-for-the-session `u32` for a monitor: the `HMONITOR` value itself.
///
/// `HMONITOR`s are USER handles, whose significant bits fit in 32 bits on every
/// Windows version (that is what lets 32- and 64-bit processes share them), so the
/// truncation loses nothing; the hex of this `u32` equals the hex of the full handle.
/// They are recreated when the display configuration changes, exactly like a macOS
/// display id after a reconnect, which is why display ids are session-scoped.
fn monitor_id(h: HMONITOR) -> u32 {
    h.0 as usize as u32
}

pub fn displays() -> Vec<Rect> {
    monitors().into_iter().map(|m| m.bounds).collect()
}

/// Monitor bounds and work area (excludes the taskbar and app bars, like Electron's
/// `workArea`), plus the monitor's effective DPI as a scale factor (DPI / 96).
pub fn display_infos() -> Vec<DisplayInfo> {
    monitors()
        .into_iter()
        .map(|m| {
            let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
            let scale = match unsafe {
                GetDpiForMonitor(m.handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y)
            } {
                Ok(()) if dpi_x > 0 => f64::from(dpi_x) / 96.,
                _ => 1.,
            };
            let id = monitor_id(m.handle);
            DisplayInfo {
                id,
                source_id: display_source_id(id),
                bounds: m.bounds,
                work_area: m.work_area,
                scale_factor: scale,
            }
        })
        .collect()
}

/// `windows:display:0x10001`. The handle is the `HMONITOR` in upper-case hex, the same
/// string capture-core's Windows backend mints (`hex_handle(hmonitor)`), so a display
/// picked in the UI resolves there.
pub fn display_source_id(display_id: u32) -> String {
    SourceId::display(Platform::Windows, rules::hex_handle(display_id as usize)).to_string()
}

/// macOS needs an autorelease pool around AppKit-heavy work; Win32 has nothing like it.
pub fn with_pool<R>(f: impl FnOnce() -> R) -> R {
    f()
}

// ---------------------------------------------------------------- process helpers

/// The owning process of a window, `0` for a dead handle.
fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// Full Win32 path of a process's image. `PROCESS_QUERY_LIMITED_INFORMATION` is enough
/// and is granted even for most elevated processes, unlike the `PROCESS_VM_READ` the Go
/// helper asked for.
fn process_image_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let mut ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        if !ok {
            // Long paths: one retry at the maximum Win32 length.
            buf = vec![0u16; 32_768];
            len = buf.len() as u32;
            ok = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
        }
        let _ = CloseHandle(process);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The name an app is known by here: its image file stem (`notepad`, `kimochi`). The
/// Go helper sent the file name *with* `.exe`; nothing in this tree depended on the
/// extension, and the stem is what `frontmost_app` and the icon lookup agree on.
fn process_name(pid: u32) -> Option<String> {
    process_image_path(pid)
        .map(|path| rules::image_stem(&path))
        .filter(|name| !name.is_empty())
}

fn window_text(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied.max(0) as usize])
    }
}

fn hwnd_from(raw: usize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

// ---------------------------------------------------------------- system links

pub fn open_capture_settings() -> Result<(), String> {
    Err("not applicable: Windows needs no screen recording permission".into())
}

// ---------------------------------------------------------------- capabilities

/// `major.minor.build` from `RtlGetVersion`, which, unlike `GetVersionEx`, is not
/// subject to manifest-based version lying (Windows 11 reports 10.0.22000+).
fn os_version() -> String {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { RtlGetVersion(&mut info) }.is_ok() {
        format!(
            "{}.{}.{}",
            info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
        )
    } else {
        String::new()
    }
}

/// The Windows-specific part of `platform_capabilities`; `platform::capabilities_payload`
/// merges it over the shared defaults and fills in capture authorization, OCR engines
/// and observer state.
pub fn capabilities() -> Value {
    json!({
        "os": "windows",
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "session": null,
        "keys": {"primaryModifier": "ctrl", "labels": "words", "superName": "Win"},
        "capture": {
            "authorization": "granted",
            "canOpenSettings": false,
            "restartAfterGrant": false,
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
            "nativeHoverWorkaround": false,
        },
        "input": {"globalShortcuts": true},
        // The image stem is what `frontmost_app` and focus events report for this app.
        "ownAppNames": ["Kimochi", "kimochi"],
        "tray": true,
        "gamepad": true,
        "ocrAccelerators": {"meikiocr": "directml", "mangaocr": "cpu"},
    })
}
