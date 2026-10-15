//! What is on the desktop: the source catalog, live window geometry, and which window
//! the reader is in. Metadata only (USER + DWM); never pixels, so none of it needs a
//! capture session or any permission. Physical virtual-screen pixels (see `mod.rs`).
use super::super::FrontWindow;
use super::{hwnd_from, monitors, process_name, rules, window_pid, window_text};
use kimochi_capture::{Platform, Rect, Source, SourceId};
use std::collections::HashMap;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW,
    GetWindowRect, IsIconic, IsWindow, IsWindowVisible, GA_ROOTOWNER, GWL_EXSTYLE, GWL_STYLE,
    GW_OWNER, WS_CAPTION,
};

/// Every top-level window, front to back (`EnumWindows` order is z-order).
pub(super) fn top_level_windows() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the `&mut Vec` passed below, alive for the whole call.
        let list = unsafe { &mut *(data.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL(1)
    }
    let mut list: Vec<HWND> = Vec::new();
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize)) };
    list
}

/// DWM hides ("cloaks") windows that USER still calls visible: other virtual desktops,
/// suspended UWP apps, windows mid-animation. A cloaked window is not on screen.
fn cloaked(hwnd: HWND) -> bool {
    let mut value = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut value as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok()
        && value != 0
}

/// The window's visible frame. `GetWindowRect` includes the invisible resize borders
/// Windows 10+ draws around every standard window (7 or so pixels on three sides), so
/// a capture crop or overlay aligned to it would be off; DWM's extended frame bounds are
/// what the user sees, and are always physical pixels.
fn frame_bounds(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if dwm.is_err() {
        unsafe { GetWindowRect(hwnd, &mut r) }.ok()?;
    }
    Some(super::rect_of(r))
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn owned(hwnd: HWND) -> bool {
    unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|o| !o.is_invalid())
}

fn window_source_id(hwnd: HWND, pid: u32) -> SourceId {
    SourceId::window(Platform::Windows, rules::hex_handle(hwnd.0 as usize), pid)
}

/// Monitors, then every window a reader could pick, front to back.
///
/// Windows needs no capture permission to list windows, so unlike macOS this never
/// fails for lack of a grant; it is still a `Result` for the shared contract.
pub fn picker_sources() -> Result<Vec<Source>, String> {
    let mut sources: Vec<Source> = monitors()
        .into_iter()
        .enumerate()
        .map(|(index, m)| Source {
            id: super::display_source_id(super::monitor_id(m.handle)),
            kind: "display",
            name: format!("Display {}", index + 1),
            app: None,
            bounds: Some(m.bounds),
            on_screen: Some(true),
        })
        .collect();
    let own = std::process::id();
    let mut names: HashMap<u32, Option<String>> = HashMap::new();
    for hwnd in top_level_windows() {
        let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
        if !visible {
            continue; // Cheapest test first: most top-level windows are hidden.
        }
        let title = window_text(hwnd);
        if title.trim().is_empty() {
            continue;
        }
        let iconic = unsafe { IsIconic(hwnd) }.as_bool();
        // A minimised window's rectangle is the iconic placeholder, not where it will be:
        // the size rule skips it and the source says nothing rather than something wrong.
        let frame = frame_bounds(hwnd);
        if frame.is_none() && !iconic {
            continue;
        }
        let pid = window_pid(hwnd);
        let class = class_name(hwnd);
        // Cloaked because it is on another desktop: open, and readable once the reader goes
        // there, so listed (off screen) rather than dropped with the suspended UWP surfaces.
        let elsewhere = cloaked(hwnd) && super::desktops::elsewhere(hwnd).is_some();
        let is_cloaked = cloaked(hwnd) && !elsewhere;
        let meta = rules::WindowMeta {
            visible,
            iconic,
            cloaked: is_cloaked,
            has_owner: owned(hwnd),
            tool_window: false,
            app_window: false,
            title_nonempty: !title.trim().is_empty(),
            class_name: &class,
            pid,
            own_pid: own,
            width: frame.map_or(0., |b| b.width),
            height: frame.map_or(0., |b| b.height),
        }
        .with_ex_style(unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32);
        if !rules::listable(&meta) {
            continue;
        }
        let app = names
            .entry(pid)
            .or_insert_with(|| process_name(pid))
            .clone();
        let bounds = frame.filter(|_| !iconic);
        sources.push(Source {
            id: window_source_id(hwnd, pid).to_string(),
            kind: "window",
            name: title,
            app,
            bounds,
            on_screen: Some(
                !elsewhere
                    && bounds.is_some_and(|b| {
                        rules::on_screen(visible, iconic, is_cloaked, b.width, b.height)
                    }),
            ),
        });
    }
    Ok(sources)
}

/// The desktop each window source on another virtual desktop is on ("Desktop 2"), keyed
/// by source id.
pub fn source_spaces(sources: &[Source]) -> HashMap<String, String> {
    sources
        .iter()
        .filter(|source| source.kind == "window" && source.on_screen == Some(false))
        .filter_map(|source| {
            let hwnd = resolve(&SourceId::parse(&source.id)?)?;
            Some((source.id.clone(), super::desktops::elsewhere(hwnd)?))
        })
        .collect()
}

/// Resolve a window source id to a live handle, or `None` if it is not a Windows window
/// id, the window is gone, or the handle now belongs to a different process (USER
/// recycles handle values, so the pid in the id is checked, not trusted).
pub(super) fn resolve(id: &SourceId) -> Option<HWND> {
    if id.platform() != Platform::Windows || !id.is_window() {
        return None;
    }
    let hwnd = hwnd_from(rules::parse_hex_handle(id.handle())?);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return None;
    }
    if let Some(pid) = id.pid() {
        if window_pid(hwnd) != pid {
            return None;
        }
    }
    Some(hwnd)
}

/// Live geometry for one window source, in physical virtual-screen pixels, and whether
/// its content is on screen (visible, not minimised, not cloaked, of readable size).
///
/// Cheap enough for the 250 ms source watch: a handful of USER/DWM reads, no
/// enumeration.
pub fn window_bounds(id: &SourceId) -> Option<(Rect, bool)> {
    let hwnd = resolve(id)?;
    let rect = frame_bounds(hwnd)?;
    let shown = rules::on_screen(
        unsafe { IsWindowVisible(hwnd) }.as_bool(),
        unsafe { IsIconic(hwnd) }.as_bool(),
        cloaked(hwnd),
        rect.width,
        rect.height,
    );
    Some((rect, shown))
}

/// Whether window source `id` is a borderless full-screen window: it covers the monitor it is
/// on and has no title bar. A maximised window covers its monitor too when the taskbar hides
/// itself, but keeps its caption. Exclusive full screen is not something an overlay can sit
/// over at all, and is not told apart here. `None` when the window is gone.
pub fn window_fullscreen(id: &SourceId) -> Option<bool> {
    let hwnd = resolve(id)?;
    let rect = frame_bounds(hwnd)?;
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
    let captioned = style & WS_CAPTION.0 == WS_CAPTION.0;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }
    Some(!captioned && super::super::covers_display(rect, super::rect_of(info.rcMonitor)))
}

/// The window the reader is working in, and its process.
///
/// Windows has a single foreground *window* rather than macOS's "frontmost application,
/// then its frontmost window", so this is simpler: `GetForegroundWindow`, walked up to
/// its root owner (`GA_ROOTOWNER`) so that a dialog or popup of the captured window
/// counts as that window being in front — the picker only ever lists unowned windows.
///
/// Kimochi's panels are `WS_EX_NOACTIVATE`, so unlike macOS they never become the answer
/// by floating on top; only editing mode (or the main window being clicked) makes our
/// own pid the answer, which `source_focus` treats as "hold the previous answer".
///
/// `window` is `None` when the foreground window is not one a reader could be reading
/// (the desktop, the taskbar, a cloaked or tiny surface): still an answer about who has
/// focus. Titles are not required here, mirroring the macOS fallback for untitled
/// windows. The whole result is `None` only when there is no foreground window at all,
/// which happens transiently during activation changes and on the secure desktop; the
/// caller treats that as "do not change what is shown".
pub fn front_window() -> Option<FrontWindow> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
        return None;
    }
    let root = unsafe { GetAncestor(foreground, GA_ROOTOWNER) };
    let root = if root.is_invalid() { foreground } else { root };
    let pid = window_pid(root);
    if pid == 0 {
        return None;
    }
    let readable =
        frame_bounds(root).is_some_and(|r| {
            rules::on_screen(
                unsafe { IsWindowVisible(root) }.as_bool(),
                unsafe { IsIconic(root) }.as_bool(),
                cloaked(root),
                r.width,
                r.height,
            )
        }) && !rules::is_shell_surface(&class_name(root), !window_text(root).trim().is_empty());
    Some(FrontWindow {
        window: readable.then(|| window_source_id(root, pid)),
        pid,
    })
}

/// The foreground process's image stem (`notepad`, `kimochi`).
pub fn frontmost_app() -> Option<String> {
    frontmost_pid().and_then(process_name)
}

/// The process id of the foreground window's process, whoever it is.
pub fn frontmost_pid() -> Option<u32> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
        return None;
    }
    Some(window_pid(foreground)).filter(|pid| *pid != 0)
}
