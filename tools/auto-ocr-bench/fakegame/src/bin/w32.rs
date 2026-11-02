//! Win32 probes and real input for the e2e harness. Every command prints one JSON value.
//!
//!   w32 windows [--pid P]... [--all]     top-level windows in z-order (topmost first)
//!   w32 fg                               foreground window, focus, active and capture
//!   w32 pos                              cursor position
//!   w32 move X Y                         move the real cursor (SendInput, absolute)
//!   w32 path X1 Y1 X2 Y2 MS              glide the cursor over MS milliseconds
//!   w32 click [left|right|middle|x1|x2] [tap|down|up]
//!   w32 key VK|name [tap|down|up]        e.g. key space, key 0x2D, key ctrl down
//!   w32 chord ctrl+shift+a [HOLDMS]      press in order, release in reverse
//!   w32 activate HWND                    bring a window to the front (Alt trick)
//!   w32 show HWND min|restore|max|hide   ShowWindow
//!   w32 close HWND                       WM_CLOSE
//!   w32 monitors                         monitors, DPI and modes
//!   w32 setres W H [DEVICE]              change a display's resolution (temporary)
//!   w32 dpi [PERCENT]                    the primary display's scaling, or set it (undocumented API)
//!   w32 shot X Y W H OUT.bmp             BitBlt the screen (capture-excluded windows show black/absent)
use serde_json::{json, Value};
use std::ffi::c_void;
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const DPI_STEPS: [u32; 12] = [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500];

#[repr(C)]
struct DpiGet {
    header: windows::Win32::Devices::Display::DISPLAYCONFIG_DEVICE_INFO_HEADER,
    min_rel: i32,
    cur_rel: i32,
    max_rel: i32,
}
#[repr(C)]
struct DpiSet {
    header: windows::Win32::Devices::Display::DISPLAYCONFIG_DEVICE_INFO_HEADER,
    rel: i32,
}

/// Display scaling through DisplayConfig's undocumented relative-scale records (type -3 to
/// read, -4 to write), as Settings → Display does. Scale steps are relative to the
/// recommended one.
fn dpi(set: Option<u32>) -> Value {
    use windows::Win32::Devices::Display::*;
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        let _ = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm);
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        let _ = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None);
        let Some(path) = paths.first() else { return json!({"error": "no display path"}) };
        let header = |kind: i32, size: usize| DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_TYPE(kind),
            size: size as u32,
            adapterId: path.sourceInfo.adapterId,
            id: path.sourceInfo.id,
        };
        let mut get = DpiGet { header: header(-3, std::mem::size_of::<DpiGet>()), min_rel: 0, cur_rel: 0, max_rel: 0 };
        let r = DisplayConfigGetDeviceInfo(&mut get.header);
        let recommended = (-get.min_rel) as usize;
        let current = DPI_STEPS.get((recommended as i32 + get.cur_rel) as usize).copied();
        let mut out = json!({"get": r, "raw": [get.min_rel, get.cur_rel, get.max_rel], "current": current, "recommended": DPI_STEPS.get(recommended), "max": DPI_STEPS.get((recommended as i32 + get.max_rel) as usize)});
        if let Some(want) = set {
            let Some(idx) = DPI_STEPS.iter().position(|v| *v == want) else { return json!({"error": "unsupported percent"}) };
            let mut rec = DpiSet { header: header(-4, std::mem::size_of::<DpiSet>()), rel: idx as i32 - recommended as i32 };
            out["set"] = json!(DisplayConfigSetDeviceInfo(&mut rec.header));
        }
        out
    }
}

fn text(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}

fn r(rc: &RECT) -> Value {
    json!([rc.left, rc.top, rc.right, rc.bottom])
}

fn exe_of(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 512];
        let mut n = buf.len() as u32;
        let _ = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n);
        let _ = CloseHandle(h);
        text(&buf).rsplit('\\').next().unwrap_or("").to_string()
    }
}

fn describe(h: HWND, z: usize) -> Value {
    unsafe {
        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(h, Some(&mut pid));
        let mut title = [0u16; 256];
        GetWindowTextW(h, &mut title);
        let mut class = [0u16; 256];
        GetClassNameW(h, &mut class);
        let mut rc = RECT::default();
        let _ = GetWindowRect(h, &mut rc);
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
        let mut affinity = 0u32;
        let _ = GetWindowDisplayAffinity(h, &mut affinity);
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        let style = GetWindowLongW(h, GWL_STYLE) as u32;
        let owner = GetWindow(h, GW_OWNER).map(|o| o.0 as isize).unwrap_or(0);
        json!({
            "hwnd": h.0 as isize, "z": z, "pid": pid, "tid": tid, "exe": exe_of(pid),
            "title": text(&title), "class": text(&class), "rect": r(&rc),
            "visible": IsWindowVisible(h).as_bool(), "iconic": IsIconic(h).as_bool(), "cloaked": cloaked,
            "affinity": affinity,
            "topmost": ex & WS_EX_TOPMOST.0 != 0, "layered": ex & WS_EX_LAYERED.0 != 0,
            "transparent": ex & WS_EX_TRANSPARENT.0 != 0, "noactivate": ex & WS_EX_NOACTIVATE.0 != 0,
            "toolwindow": ex & WS_EX_TOOLWINDOW.0 != 0, "disabled": style & WS_DISABLED.0 != 0,
            "owner": owner,
        })
    }
}

struct Enum {
    out: Vec<Value>,
    pids: Vec<u32>,
    all: bool,
}

unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> BOOL {
    let e = &mut *(lp.0 as *mut Enum);
    let z = e.out.len();
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, Some(&mut pid));
    if (e.pids.is_empty() || e.pids.contains(&pid)) && (e.all || IsWindowVisible(h).as_bool() || !e.pids.is_empty()) {
        e.out.push(describe(h, z));
    } else {
        e.out.push(Value::Null);
    }
    TRUE
}

fn send(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn move_to(x: i32, y: i32) {
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let nx = ((x - vx) as i64 * 65535 / (vw - 1).max(1) as i64) as i32;
        let ny = ((y - vy) as i64 * 65535 / (vh - 1).max(1) as i64) as i32;
        send(&[mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0)]);
        // SendInput's normalisation can land a pixel off; settle exactly.
        let _ = SetCursorPos(x, y);
    }
}

fn vk_of(name: &str) -> u16 {
    let n = name.to_ascii_lowercase();
    if let Some(hex) = n.strip_prefix("0x") {
        return u16::from_str_radix(hex, 16).unwrap();
    }
    if let Ok(v) = n.parse::<u16>() {
        if n.len() > 1 {
            return v;
        }
    }
    match n.as_str() {
        "ctrl" | "control" => VK_CONTROL.0,
        "lctrl" => VK_LCONTROL.0,
        "shift" => VK_SHIFT.0,
        "lshift" => VK_LSHIFT.0,
        "alt" => VK_MENU.0,
        "win" => VK_LWIN.0,
        "space" => VK_SPACE.0,
        "enter" | "return" => VK_RETURN.0,
        "esc" | "escape" => VK_ESCAPE.0,
        "tab" => VK_TAB.0,
        "insert" | "ins" => VK_INSERT.0,
        "pause" => VK_PAUSE.0,
        "scroll" | "scrolllock" => VK_SCROLL.0,
        "home" => VK_HOME.0,
        "end" => VK_END.0,
        "left" => VK_LEFT.0,
        "right" => VK_RIGHT.0,
        "up" => VK_UP.0,
        "down" => VK_DOWN.0,
        s if s.starts_with('f') && s.len() <= 3 && s[1..].parse::<u16>().is_ok() => VK_F1.0 + s[1..].parse::<u16>().unwrap() - 1,
        s if s.len() == 1 => s.as_bytes()[0].to_ascii_uppercase() as u16,
        other => panic!("unknown key {other}"),
    }
}

fn key(vk: u16, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let extended = matches!(VIRTUAL_KEY(vk), VK_INSERT | VK_DELETE | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_RCONTROL | VK_RMENU);
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn parse_hwnd(s: &str) -> HWND {
    HWND(s.parse::<isize>().unwrap() as *mut c_void)
}

unsafe extern "system" fn mon_cb(m: HMONITOR, _dc: HDC, _r: *mut RECT, lp: LPARAM) -> BOOL {
    let out = &mut *(lp.0 as *mut Vec<Value>);
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let _ = GetMonitorInfoW(m, &mut mi as *mut _ as *mut MONITORINFO);
    let (mut dx, mut dy) = (0u32, 0u32);
    let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
    let mut dm = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
    let _ = EnumDisplaySettingsW(PCWSTR(mi.szDevice.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm);
    out.push(json!({
        "device": text(&mi.szDevice), "rect": r(&mi.monitorInfo.rcMonitor), "work": r(&mi.monitorInfo.rcWork),
        "primary": mi.monitorInfo.dwFlags & 1 != 0, "dpi": dx, "scale": dx as f64 / 96.0,
        "mode": [dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency],
    }));
    TRUE
}

fn main() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let a: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| a.get(i).cloned().unwrap_or_default();
    let int = |i: usize| arg(i).parse::<i32>().unwrap();
    let out: Value = unsafe {
        match arg(0).as_str() {
            "windows" => {
                let mut e = Enum { out: vec![], pids: vec![], all: a.iter().any(|x| x == "--all") };
                let mut i = 1;
                while i < a.len() {
                    if a[i] == "--pid" {
                        e.pids.push(a[i + 1].parse().unwrap());
                        i += 1;
                    }
                    i += 1;
                }
                let _ = EnumWindows(Some(enum_cb), LPARAM(&mut e as *mut Enum as isize));
                Value::Array(e.out.into_iter().filter(|v| !v.is_null()).collect())
            }
            "fg" => {
                let fg = GetForegroundWindow();
                let tid = GetWindowThreadProcessId(fg, None);
                let mut gi = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
                let _ = GetGUIThreadInfo(tid, &mut gi);
                let mut p = POINT::default();
                let _ = GetCursorPos(&mut p);
                json!({
                    "fg": describe(fg, 0), "focus": gi.hwndFocus.0 as isize, "active": gi.hwndActive.0 as isize,
                    "capture": gi.hwndCapture.0 as isize, "menuOwner": gi.hwndMenuOwner.0 as isize, "flags": gi.flags.0, "cursor": [p.x, p.y],
                    "underCursor": WindowFromPoint(p).0 as isize,
                })
            }
            "pos" => {
                let mut p = POINT::default();
                let _ = GetCursorPos(&mut p);
                json!([p.x, p.y])
            }
            "move" => {
                move_to(int(1), int(2));
                json!("ok")
            }
            "path" => {
                let (x1, y1, x2, y2, ms) = (int(1), int(2), int(3), int(4), int(5).max(1));
                let start = std::time::Instant::now();
                loop {
                    let t = (start.elapsed().as_millis() as f64 / ms as f64).min(1.0);
                    move_to(x1 + ((x2 - x1) as f64 * t) as i32, y1 + ((y2 - y1) as f64 * t) as i32);
                    if t >= 1.0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(8));
                }
                json!("ok")
            }
            "click" => {
                let (down, up, data) = match arg(1).as_str() {
                    "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
                    "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
                    "x1" => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 1),
                    "x2" => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 2),
                    _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
                };
                match arg(2).as_str() {
                    "down" => send(&[mouse_input(down, 0, 0, data)]),
                    "up" => send(&[mouse_input(up, 0, 0, data)]),
                    _ => {
                        send(&[mouse_input(down, 0, 0, data)]);
                        std::thread::sleep(std::time::Duration::from_millis(40));
                        send(&[mouse_input(up, 0, 0, data)]);
                    }
                }
                json!("ok")
            }
            "key" => {
                let vk = vk_of(&arg(1));
                match arg(2).as_str() {
                    "down" => send(&[key(vk, false)]),
                    "up" => send(&[key(vk, true)]),
                    _ => {
                        send(&[key(vk, false)]);
                        std::thread::sleep(std::time::Duration::from_millis(40));
                        send(&[key(vk, true)]);
                    }
                }
                json!({"vk": vk})
            }
            "chord" => {
                let vks: Vec<u16> = arg(1).split('+').map(vk_of).collect();
                let hold = arg(2).parse::<u64>().unwrap_or(60);
                for &vk in &vks {
                    send(&[key(vk, false)]);
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                std::thread::sleep(std::time::Duration::from_millis(hold));
                for &vk in vks.iter().rev() {
                    send(&[key(vk, true)]);
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                json!({"vks": vks})
            }
            "activate" => {
                let h = parse_hwnd(&arg(1));
                if IsIconic(h).as_bool() {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                // A synthetic (null) mouse move makes this process the last input source, which lets
                // SetForegroundWindow through the foreground lock. (An Alt tap would leave the window in
                // system-menu mode, which stalls WebView2: see 18-alt-menu-mode.)
                send(&[mouse_input(MOUSEEVENTF_MOVE, 0, 0, 0)]);
                let ok = SetForegroundWindow(h).as_bool();
                std::thread::sleep(std::time::Duration::from_millis(100));
                json!({"ok": ok, "fg": GetForegroundWindow().0 as isize == h.0 as isize})
            }
            "show" => {
                let h = parse_hwnd(&arg(1));
                let cmd = match arg(2).as_str() {
                    "min" => SW_MINIMIZE,
                    "max" => SW_MAXIMIZE,
                    "hide" => SW_HIDE,
                    _ => SW_RESTORE,
                };
                json!(ShowWindow(h, cmd).as_bool())
            }
            "close" => {
                let _ = PostMessageW(Some(parse_hwnd(&arg(1))), WM_CLOSE, WPARAM(0), LPARAM(0));
                json!("ok")
            }
            "monitors" => {
                let mut v: Vec<Value> = vec![];
                let _ = EnumDisplayMonitors(None, None, Some(mon_cb), LPARAM(&mut v as *mut _ as isize));
                Value::Array(v)
            }
            "setres" => {
                let dev: Vec<u16> = arg(3).encode_utf16().chain([0]).collect();
                let name = if arg(3).is_empty() { PCWSTR::null() } else { PCWSTR(dev.as_ptr()) };
                let mut dm = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
                let _ = EnumDisplaySettingsW(name, ENUM_CURRENT_SETTINGS, &mut dm);
                dm.dmPelsWidth = int(1) as u32;
                dm.dmPelsHeight = int(2) as u32;
                dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
                let res = ChangeDisplaySettingsExW(name, Some(&dm), None, CDS_TYPE(0), None);
                json!({"result": res.0})
            }
            "dpi" => dpi(a.get(1).and_then(|v| v.parse().ok())),
            "shot" => {
                let (x, y, w, h) = (int(1), int(2), int(3), int(4));
                let screen = GetDC(None);
                let dc = CreateCompatibleDC(Some(screen));
                let bmp = CreateCompatibleBitmap(screen, w, h);
                SelectObject(dc, bmp.into());
                let _ = BitBlt(dc, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);
                let mut bi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
                    ..Default::default()
                };
                let mut px = vec![0u8; (w * h * 4) as usize];
                GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS);
                let mut file = vec![];
                let size = 54 + px.len() as u32;
                file.extend_from_slice(b"BM");
                file.extend_from_slice(&size.to_le_bytes());
                file.extend_from_slice(&[0, 0, 0, 0]);
                file.extend_from_slice(&54u32.to_le_bytes());
                file.extend_from_slice(&40u32.to_le_bytes());
                file.extend_from_slice(&w.to_le_bytes());
                file.extend_from_slice(&(-h).to_le_bytes());
                file.extend_from_slice(&1u16.to_le_bytes());
                file.extend_from_slice(&32u16.to_le_bytes());
                file.extend_from_slice(&[0u8; 24]);
                file.extend_from_slice(&px);
                std::fs::write(arg(5), file).unwrap();
                let _ = DeleteObject(bmp.into());
                let _ = DeleteDC(dc);
                ReleaseDC(None, screen);
                json!("ok")
            }
            other => json!({"error": format!("unknown command {other}")}),
        }
    };
    println!("{out}");
}
