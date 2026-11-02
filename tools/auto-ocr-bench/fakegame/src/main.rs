//! A fake game for driving Kimochi end to end: Japanese text at known positions, with ground
//! truth (`truth.json`, per line and per glyph, screen pixels) and an input log (`input.jsonl`:
//! window messages, raw input with INPUTSINK, and GetAsyncKeyState transitions while unfocused).
//!
//!   fakegame --name g1 --out <dir> [--mode windowed|borderless|exclusive] [--render gdi|d3d]
//!            [--rect x,y,w,h] [--skip focused|always] [--blink]
//!
//! Control: `\\.\pipe\fakegame-<name>`, one command per connection, reply is one line.
//!   next | prev | line N | mode M | minimize | restore | move x y w h | blink on|off
//!   text a|b | truth | ping | quit
//! Keys while focused: Space/Enter/click advance, Ctrl skips (polled like VN engines), F11 cycles
//! the mode, M minimises.
#![windows_subsystem = "windows"]

use std::collections::VecDeque;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use windows::core::{w, Interface, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Pipes::*;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Input::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const WM_CMD: u32 = WM_APP + 1;
const TIMER_FRAME: usize = 1;
const TIMER_SKIP: usize = 2;
const TIMER_BLINK: usize = 3;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Windowed,
    Borderless,
    Exclusive,
}

struct D3d {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    swap: IDXGISwapChain1,
    driver: &'static str,
    w: u32,
    h: u32,
}

struct Dib {
    dc: HDC,
    bmp: HBITMAP,
    bits: *mut u32,
    w: i32,
    h: i32,
}

struct Glyph {
    ch: String,
    cell: RECT,
    ink: Option<RECT>,
}

struct Line {
    id: String,
    kind: &'static str,
    text: String,
    vertical: bool,
    rect: RECT,
    glyphs: Vec<Glyph>,
}

struct State {
    hwnd: isize,
    name: String,
    out: PathBuf,
    mode: Mode,
    render: &'static str,
    skip_always: bool,
    skip_off: bool,
    /// Like many VN engines: polls keys while WM_ACTIVATEAPP last said the app is active.
    skip_when_active: bool,
    app_active: bool,
    /// Behave like exclusive fullscreen without DXGI: minimise on focus loss, return on focus.
    min_on_blur: bool,
    blink: bool,
    blink_on: bool,
    line: usize,
    custom: Option<Vec<String>>,
    frame: u64,
    windowed_rect: RECT,
    d3d: Option<D3d>,
    dib: Option<Dib>,
    lines: Vec<Line>,
    log: Option<File>,
    started: Instant,
    last_move_log: Instant,
    exclusive_error: Option<String>,
    advances: u64,
}

unsafe impl Send for State {}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static HWND_RAW: AtomicIsize = AtomicIsize::new(0);
static CMDS: Mutex<VecDeque<(String, mpsc::Sender<String>)>> = Mutex::new(VecDeque::new());

const SCRIPT: &[(&str, &str, &str)] = &[
    ("春香", "今日はいい天気ですね。", "散歩に行きませんか？"),
    ("春香", "あの桜の木の下で、", "昔の約束を思い出したの。"),
    ("太郎", "回想シーンはメニューから", "いつでも見られるよ。"),
    ("春香", "猫が窓の外で", "静かに眠っている。"),
    ("太郎", "明日は早く起きて、", "駅まで迎えに行く。"),
    ("春香", "ありがとう。", "また会いましょう。"),
];
const MENU: &[&str] = &["回想", "想回", "設定", "終", "回　想", "音　楽", "Ｃ Ｇ"];

fn st() -> std::sync::MutexGuard<'static, State> {
    STATE.get().unwrap().lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
}

fn hwnd() -> HWND {
    HWND(HWND_RAW.load(Ordering::Relaxed) as *mut c_void)
}

fn log(s: &mut State, v: Value) {
    let mut v = v;
    v["t"] = json!(now_ms());
    v["fg"] = json!(unsafe { GetForegroundWindow() }.0 as isize == s.hwnd);
    if let Some(f) = s.log.as_mut() {
        let _ = writeln!(f, "{}", v);
        let _ = f.flush();
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn rect_json(r: &RECT) -> Value {
    json!([r.left, r.top, r.right, r.bottom])
}

fn main() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let name = arg("--name").unwrap_or_else(|| "g1".into());
    let out = PathBuf::from(arg("--out").unwrap_or_else(|| ".".into()));
    std::fs::create_dir_all(&out).unwrap();
    let mode = match arg("--mode").as_deref() {
        Some("borderless") => Mode::Borderless,
        Some("exclusive") => Mode::Exclusive,
        _ => Mode::Windowed,
    };
    let render: &'static str = if arg("--render").as_deref() == Some("d3d") || mode == Mode::Exclusive { "d3d" } else { "gdi" };
    let r: Vec<i32> = arg("--rect").unwrap_or_else(|| "300,200,2400,1350".into()).split(',').map(|x| x.parse().unwrap()).collect();
    let windowed_rect = RECT { left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3] };
    let log = OpenOptions::new().create(true).append(true).open(out.join("input.jsonl")).ok();
    STATE
        .set(Mutex::new(State {
            hwnd: 0,
            name: name.clone(),
            out,
            mode: Mode::Windowed,
            render,
            skip_always: arg("--skip").as_deref() == Some("always"),
            skip_off: arg("--skip").as_deref() == Some("off"),
            skip_when_active: arg("--skip").as_deref() == Some("active"),
            app_active: false,
            min_on_blur: args.iter().any(|a| a == "--min-on-blur"),
            blink: args.iter().any(|a| a == "--blink"),
            blink_on: true,
            line: 0,
            custom: None,
            frame: 0,
            windowed_rect,
            d3d: None,
            dib: None,
            lines: vec![],
            log,
            started: Instant::now(),
            last_move_log: Instant::now(),
            exclusive_error: None,
            advances: 0,
        }))
        .ok();

    unsafe {
        let inst = GetModuleHandleW(None).unwrap();
        let class = w!("KimochiFakeGame");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            hInstance: inst.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassExW(&wc);
        let title = wide(&format!("Kimochi Fake Game [{name}] ({render})\0"));
        let h = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            windowed_rect.left,
            windowed_rect.top,
            windowed_rect.right - windowed_rect.left,
            windowed_rect.bottom - windowed_rect.top,
            None,
            None,
            Some(inst.into()),
            None,
        )
        .unwrap();
        HWND_RAW.store(h.0 as isize, Ordering::Relaxed);
        st().hwnd = h.0 as isize;

        let devices = [
            RAWINPUTDEVICE { usUsagePage: 1, usUsage: 6, dwFlags: RIDEV_INPUTSINK, hwndTarget: h },
            RAWINPUTDEVICE { usUsagePage: 1, usUsage: 2, dwFlags: RIDEV_INPUTSINK, hwndTarget: h },
        ];
        let _ = RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32);

        let _ = ShowWindow(h, SW_SHOW);
        if render == "d3d" {
            init_d3d(h);
        }
        set_mode(mode);
        if args.iter().any(|a| a == "--minimized") {
            let _ = ShowWindow(h, SW_MINIMIZE);
        }
        SetTimer(Some(h), TIMER_SKIP, 100, None);
        SetTimer(Some(h), TIMER_BLINK, 500, None);
        if render == "d3d" {
            SetTimer(Some(h), TIMER_FRAME, 33, None);
        }
        redraw();

        std::thread::spawn(poll_async_keys);
        std::thread::spawn(move || pipe_server(name));

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe fn init_d3d(h: HWND) {
    let mut s = st();
    let levels = [D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0];
    let mut made = None;
    for (driver, name) in [(D3D_DRIVER_TYPE_HARDWARE, "hardware"), (D3D_DRIVER_TYPE_WARP, "warp")] {
        let mut device = None;
        let mut ctx = None;
        if D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
        .is_ok()
        {
            made = Some((device.unwrap(), ctx.unwrap(), name));
            break;
        }
    }
    let Some((device, ctx, driver)) = made else {
        log(&mut s, json!({"src":"game","ev":"d3d-failed"}));
        s.render = "gdi";
        return;
    };
    let factory: IDXGIFactory2 = CreateDXGIFactory1().unwrap();
    let mut rc = RECT::default();
    let _ = GetClientRect(h, &mut rc);
    let (w, hgt) = ((rc.right - rc.left).max(1) as u32, (rc.bottom - rc.top).max(1) as u32);
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: w,
        Height: hgt,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
        Flags: DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH.0 as u32,
        ..Default::default()
    };
    match factory.CreateSwapChainForHwnd(&device, h, &desc, None, None) {
        Ok(swap) => {
            s.d3d = Some(D3d { device, ctx, swap, driver, w, h: hgt });
            log(&mut s, json!({"src":"game","ev":"d3d","driver":driver}));
        }
        Err(e) => {
            log(&mut s, json!({"src":"game","ev":"swapchain-failed","err":e.to_string()}));
            s.render = "gdi";
        }
    }
}

fn swap() -> Option<IDXGISwapChain1> {
    st().d3d.as_ref().map(|d| d.swap.clone())
}

/// Copies the frame into the swap chain and presents it, outside the state lock (DXGI may send
/// window messages from Present during mode changes).
fn present() {
    let (swap, ctx, bits, w) = {
        let s = st();
        let (Some(d), Some(dib)) = (s.d3d.as_ref(), s.dib.as_ref()) else { return };
        if d.w as i32 != dib.w || d.h as i32 != dib.h {
            return;
        }
        (d.swap.clone(), d.ctx.clone(), dib.bits as usize, dib.w)
    };
    unsafe {
        if let Ok(tex) = swap.GetBuffer::<ID3D11Texture2D>(0) {
            ctx.UpdateSubresource(&tex, 0, None, bits as *const c_void, (w * 4) as u32, 0);
        }
        let _ = swap.Present(0, DXGI_PRESENT(0));
    }
}

fn monitor_rect(h: HWND) -> RECT {
    unsafe {
        let m = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(m, &mut mi);
        mi.rcMonitor
    }
}

fn set_mode(mode: Mode) {
    let h = hwnd();
    unsafe {
        let prev = st().mode;
        if prev == Mode::Exclusive {
            if let Some(sw) = swap() {
                let _ = sw.SetFullscreenState(false, None);
            }
        }
        if prev == Mode::Windowed && mode != Mode::Windowed {
            let mut r = RECT::default();
            let _ = GetWindowRect(h, &mut r);
            if !IsIconic(h).as_bool() {
                st().windowed_rect = r;
            }
        }
        match mode {
            Mode::Windowed => {
                SetWindowLongPtrW(h, GWL_STYLE, (WS_OVERLAPPEDWINDOW | WS_VISIBLE).0 as isize);
                let r = st().windowed_rect;
                let _ = SetWindowPos(h, Some(HWND_NOTOPMOST), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            }
            Mode::Borderless | Mode::Exclusive => {
                SetWindowLongPtrW(h, GWL_STYLE, (WS_POPUP | WS_VISIBLE).0 as isize);
                let m = monitor_rect(h);
                let _ = SetWindowPos(h, Some(HWND_TOP), m.left, m.top, m.right - m.left, m.bottom - m.top, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            }
        }
        st().mode = mode;
        if mode == Mode::Exclusive {
            let res = swap().map(|sw| sw.SetFullscreenState(true, None));
            let mut s = st();
            match res {
                Some(Ok(())) => {
                    s.exclusive_error = None;
                    log(&mut s, json!({"src":"game","ev":"exclusive","ok":true}));
                }
                Some(Err(e)) => {
                    s.exclusive_error = Some(e.to_string());
                    log(&mut s, json!({"src":"game","ev":"exclusive","ok":false,"err":e.to_string()}));
                }
                None => {
                    s.exclusive_error = Some("no d3d".into());
                }
            }
        }
    }
    resize();
}

fn resize() {
    let h = hwnd();
    unsafe {
        let mut rc = RECT::default();
        let _ = GetClientRect(h, &mut rc);
        let (w, hh) = ((rc.right - rc.left).max(1), (rc.bottom - rc.top).max(1));
        let mut s = st();
        if let Some(d) = s.d3d.as_mut() {
            if d.w != w as u32 || d.h != hh as u32 {
                let ok = d.swap.ResizeBuffers(0, w as u32, hh as u32, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH);
                if ok.is_ok() {
                    d.w = w as u32;
                    d.h = hh as u32;
                }
            }
        }
        let need = match &s.dib {
            Some(d) => d.w != w || d.h != hh,
            None => true,
        };
        if need {
            if let Some(d) = s.dib.take() {
                let _ = DeleteObject(d.bmp.into());
                let _ = DeleteDC(d.dc);
            }
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            ReleaseDC(None, screen);
            let bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -hh,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let bmp = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
            SelectObject(dc, bmp.into());
            s.dib = Some(Dib { dc, bmp, bits: bits as *mut u32, w, h: hh });
        }
    }
    redraw();
}

fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16)
}

unsafe fn font(px: i32) -> HFONT {
    CreateFontW(-px, 0, 0, 0, FW_MEDIUM.0 as i32, 0, 0, 0, SHIFTJIS_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, 0, w!("Yu Gothic UI"))
}

unsafe fn fill(dc: HDC, r: RECT, c: COLORREF) {
    let b = CreateSolidBrush(c);
    FillRect(dc, &r, b);
    let _ = DeleteObject(b.into());
}

/// Draws `text` horizontally at (x, y) and returns its glyph cells in client pixels.
unsafe fn text_h(dc: HDC, x: i32, y: i32, px: i32, color: COLORREF, text: &str) -> (RECT, Vec<Glyph>) {
    let f = font(px);
    let old = SelectObject(dc, f.into());
    SetTextColor(dc, color);
    SetBkMode(dc, TRANSPARENT);
    let mut tm = TEXTMETRICW::default();
    let _ = GetTextMetricsW(dc, &mut tm);
    let chars: Vec<char> = text.chars().collect();
    let mut glyphs = vec![];
    let mut prev = 0;
    for i in 0..chars.len() {
        let prefix: String = chars[..=i].iter().collect();
        let mut sz = SIZE::default();
        let _ = GetTextExtentPoint32W(dc, &wide(&prefix), &mut sz);
        glyphs.push(Glyph { ch: chars[i].to_string(), cell: RECT { left: x + prev, top: y, right: x + sz.cx, bottom: y + tm.tmHeight }, ink: None });
        prev = sz.cx;
    }
    let _ = TextOutW(dc, x, y, &wide(text));
    SelectObject(dc, old);
    let _ = DeleteObject(f.into());
    (RECT { left: x, top: y, right: x + prev, bottom: y + tm.tmHeight }, glyphs)
}

/// One character per cell, top to bottom.
unsafe fn text_v(dc: HDC, x: i32, y: i32, px: i32, color: COLORREF, text: &str) -> (RECT, Vec<Glyph>) {
    let f = font(px);
    let old = SelectObject(dc, f.into());
    SetTextColor(dc, color);
    SetBkMode(dc, TRANSPARENT);
    let mut tm = TEXTMETRICW::default();
    let _ = GetTextMetricsW(dc, &mut tm);
    let step = tm.tmHeight;
    let mut glyphs = vec![];
    let mut maxw = 0;
    for (i, c) in text.chars().enumerate() {
        let s = c.to_string();
        let mut sz = SIZE::default();
        let _ = GetTextExtentPoint32W(dc, &wide(&s), &mut sz);
        let cy = y + i as i32 * step;
        let cx = x + (px - sz.cx) / 2;
        let _ = TextOutW(dc, cx, cy, &wide(&s));
        glyphs.push(Glyph { ch: s, cell: RECT { left: cx, top: cy, right: cx + sz.cx, bottom: cy + step }, ink: None });
        maxw = maxw.max(sz.cx);
    }
    SelectObject(dc, old);
    let _ = DeleteObject(f.into());
    let n = glyphs.len() as i32;
    (RECT { left: x, top: y, right: x + px.max(maxw), bottom: y + n * step }, glyphs)
}

/// The ink box of each glyph: pixels in its cell that differ from the background `bg`.
fn ink(dib: &Dib, cell: &RECT, bg: COLORREF) -> Option<RECT> {
    let bgr = ((bg.0 & 0xff) << 16) | (bg.0 & 0xff00) | ((bg.0 >> 16) & 0xff);
    let mut r = RECT { left: i32::MAX, top: i32::MAX, right: i32::MIN, bottom: i32::MIN };
    for y in cell.top.max(0)..cell.bottom.min(dib.h) {
        for x in cell.left.max(0)..cell.right.min(dib.w) {
            let p = unsafe { *dib.bits.add((y * dib.w + x) as usize) } & 0xffffff;
            if p != bgr {
                r.left = r.left.min(x);
                r.top = r.top.min(y);
                r.right = r.right.max(x + 1);
                r.bottom = r.bottom.max(y + 1);
            }
        }
    }
    (r.left != i32::MAX).then_some(r)
}

fn redraw() {
    let h = hwnd();
    let mut guard = st();
    let s = &mut *guard;
    let Some(dib) = s.dib.as_ref() else { return };
    let dc = dib.dc;
    let (w, hh) = (dib.w, dib.h);
    let dpi = unsafe { GetDpiForWindow(h) }.max(96) as i32;
    let k = |v: i32| v * dpi / 96;
    let mut lines = vec![];
    unsafe {
        let bg = rgb(46, 64, 92);
        fill(dc, RECT { left: 0, top: 0, right: w, bottom: hh }, bg);
        // Title with furigana.
        let (r, g) = text_h(dc, k(110), k(48), k(30), rgb(255, 255, 255), "桜の約束");
        lines.push(Line { id: "title".into(), kind: "title", text: "桜の約束".into(), vertical: false, rect: r, glyphs: g });
        let (r, g) = text_h(dc, k(110), k(28), k(13), rgb(230, 230, 230), "さくらのやくそく");
        lines.push(Line { id: "furigana".into(), kind: "furigana", text: "さくらのやくそく".into(), vertical: false, rect: r, glyphs: g });
        // Vertical column.
        let (r, g) = text_v(dc, k(40), k(110), k(28), rgb(255, 240, 200), "縦書きの文章です");
        lines.push(Line { id: "vertical".into(), kind: "vertical", text: "縦書きの文章です".into(), vertical: true, rect: r, glyphs: g });
        // Menu.
        let mx = w - k(170);
        for (i, item) in MENU.iter().enumerate() {
            let y = k(60) + i as i32 * k(52);
            fill(dc, RECT { left: mx - k(10), top: y - k(6), right: mx + k(120), bottom: y + k(40) }, rgb(20, 28, 40));
            let (r, g) = text_h(dc, mx, y, k(26), rgb(255, 255, 255), item);
            lines.push(Line { id: format!("menu{i}"), kind: "menu", text: item.to_string(), vertical: false, rect: r, glyphs: g });
        }
        // VN text box.
        let bx = RECT { left: w * 5 / 100, top: hh * 68 / 100, right: w * 95 / 100, bottom: hh * 96 / 100 };
        fill(dc, bx, rgb(12, 12, 24));
        let (speaker, a, b) = match &s.custom {
            Some(c) => ("??".to_string(), c.first().cloned().unwrap_or_default(), c.get(1).cloned().unwrap_or_default()),
            None => {
                let e = SCRIPT[s.line % SCRIPT.len()];
                (e.0.to_string(), e.1.to_string(), e.2.to_string())
            }
        };
        let (r, g) = text_h(dc, bx.left + k(20), bx.top + k(12), k(24), rgb(255, 214, 120), &speaker);
        lines.push(Line { id: "name".into(), kind: "name", text: speaker, vertical: false, rect: r, glyphs: g });
        for (i, t) in [a, b].iter().enumerate() {
            if t.is_empty() {
                continue;
            }
            let (r, g) = text_h(dc, bx.left + k(28), bx.top + k(50) + i as i32 * k(46), k(32), rgb(255, 255, 255), t);
            lines.push(Line { id: format!("dialogue{i}"), kind: "dialogue", text: t.clone(), vertical: false, rect: r, glyphs: g });
        }
        if s.blink && s.blink_on {
            let _ = text_h(dc, bx.right - k(50), bx.bottom - k(46), k(26), rgb(255, 255, 255), "▼");
        }
        let _ = GdiFlush();
        let bgs = |kind: &str| match kind {
            "menu" => rgb(20, 28, 40),
            "name" | "dialogue" => rgb(12, 12, 24),
            _ => bg,
        };
        for l in lines.iter_mut() {
            for g in l.glyphs.iter_mut() {
                g.ink = ink(dib, &g.cell, bgs(l.kind));
            }
        }
        if s.d3d.is_none() {
            let _ = InvalidateRect(Some(h), None, false);
        }
    }
    s.lines = lines;
    s.frame += 1;
    write_truth(s);
    drop(guard);
    present();
}

fn truth_json(s: &State) -> Value {
    let h = hwnd();
    unsafe {
        let mut wr = RECT::default();
        let _ = GetWindowRect(h, &mut wr);
        let mut origin = POINT::default();
        let _ = ClientToScreen(h, &mut origin);
        let mut cr = RECT::default();
        let _ = GetClientRect(h, &mut cr);
        let off = |r: &RECT| RECT { left: r.left + origin.x, top: r.top + origin.y, right: r.right + origin.x, bottom: r.bottom + origin.y };
        let lines: Vec<Value> = s
            .lines
            .iter()
            .map(|l| {
                json!({
                    "id": l.id, "kind": l.kind, "text": l.text, "vertical": l.vertical,
                    "rect": rect_json(&off(&l.rect)),
                    "glyphs": l.glyphs.iter().map(|g| json!({
                        "ch": g.ch, "cell": rect_json(&off(&g.cell)),
                        "ink": g.ink.as_ref().map(|r| rect_json(&off(r))),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        json!({
            "name": s.name, "pid": std::process::id(), "hwnd": s.hwnd, "frame": s.frame, "t": now_ms(),
            "mode": format!("{:?}", s.mode).to_lowercase(), "render": s.render,
            "d3dDriver": s.d3d.as_ref().map(|d| d.driver),
            "exclusiveError": s.exclusive_error,
            "dpi": GetDpiForWindow(h), "iconic": IsIconic(h).as_bool(),
            "foreground": GetForegroundWindow() == h,
            "window": rect_json(&wr), "client": rect_json(&off(&cr)),
            "minOnBlur": s.min_on_blur, "line": s.line, "advances": s.advances, "believesActive": s.app_active, "uptimeMs": s.started.elapsed().as_millis() as u64,
            "lines": lines,
        })
    }
}

fn write_truth(s: &State) {
    let v = truth_json(s);
    let tmp = s.out.join("truth.json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(&v).unwrap()).is_ok() {
        let _ = std::fs::rename(&tmp, s.out.join("truth.json"));
    }
}

fn advance(reason: &str, delta: i64) {
    {
        let mut s = st();
        let n = SCRIPT.len() as i64;
        s.line = (((s.line as i64 + delta) % n + n) % n) as usize;
        s.custom = None;
        s.advances += 1;
        let line = s.line;
        log(&mut s, json!({"src":"game","ev":"advance","reason":reason,"line":line}));
    }
    redraw();
}

fn handle_cmd(cmd: &str) -> String {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    let h = hwnd();
    match parts.first().copied().unwrap_or("") {
        "ping" => "pong".into(),
        "next" => {
            advance("cmd", 1);
            "ok".into()
        }
        "prev" => {
            advance("cmd", -1);
            "ok".into()
        }
        "line" => {
            st().line = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
            redraw();
            "ok".into()
        }
        "text" => {
            let rest = cmd.splitn(2, ' ').nth(1).unwrap_or("");
            st().custom = Some(rest.split('|').map(String::from).collect());
            redraw();
            "ok".into()
        }
        "skip" => {
            let mut s = st();
            s.skip_off = parts.get(1) == Some(&"off");
            s.skip_always = parts.get(1) == Some(&"always");
            s.skip_when_active = parts.get(1) == Some(&"active");
            "ok".into()
        }
        "blink" => {
            st().blink = parts.get(1) == Some(&"on");
            redraw();
            "ok".into()
        }
        "mode" => {
            let m = match parts.get(1).copied() {
                Some("borderless") => Mode::Borderless,
                Some("exclusive") => Mode::Exclusive,
                _ => Mode::Windowed,
            };
            set_mode(m);
            let s = st();
            match &s.exclusive_error {
                Some(e) if m == Mode::Exclusive => format!("error {e}"),
                _ => "ok".into(),
            }
        }
        "minimize" => {
            unsafe {
                let _ = ShowWindow(h, SW_MINIMIZE);
            }
            "ok".into()
        }
        "restore" => {
            unsafe {
                let _ = ShowWindow(h, SW_RESTORE);
            }
            "ok".into()
        }
        "move" => {
            let v: Vec<i32> = parts[1..].iter().filter_map(|x| x.parse().ok()).collect();
            if v.len() == 4 {
                set_mode(Mode::Windowed);
                unsafe {
                    let _ = SetWindowPos(h, None, v[0], v[1], v[2], v[3], SWP_NOZORDER);
                }
            }
            "ok".into()
        }
        "truth" => truth_json(&st()).to_string(),
        "quit" => {
            unsafe {
                let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            "ok".into()
        }
        other => format!("error unknown {other}"),
    }
}

fn pipe_server(name: String) {
    let path = wide(&format!("\\\\.\\pipe\\fakegame-{name}\0"));
    loop {
        unsafe {
            let pipe = CreateNamedPipeW(
                PCWSTR(path.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                65536,
                65536,
                0,
                None,
            );
            if pipe.is_invalid() {
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
            let _ = ConnectNamedPipe(pipe, None);
            let mut buf = vec![0u8; 8192];
            let mut n = 0u32;
            if ReadFile(pipe, Some(&mut buf), Some(&mut n), None).is_ok() {
                let cmd = String::from_utf8_lossy(&buf[..n as usize]).trim().to_string();
                let (tx, rx) = mpsc::channel();
                CMDS.lock().unwrap().push_back((cmd, tx));
                let _ = PostMessageW(Some(hwnd()), WM_CMD, WPARAM(0), LPARAM(0));
                let reply = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or_else(|_| "error timeout".into());
                let bytes = format!("{reply}\n").into_bytes();
                let mut written = 0u32;
                let _ = WriteFile(pipe, Some(&bytes), Some(&mut written), None);
                let _ = FlushFileBuffers(pipe);
                // Wait for the client to hang up, so the reply is never cut off by a disconnect.
                let mut sink = [0u8; 16];
                let _ = ReadFile(pipe, Some(&mut sink), Some(&mut n), None);
            }
            let _ = DisconnectNamedPipe(pipe);
            let _ = CloseHandle(pipe);
        }
    }
}

/// Key state transitions seen through GetAsyncKeyState, which works whatever has focus: what a
/// game polling the keyboard would see.
fn poll_async_keys() {
    let mut prev = [false; 256];
    loop {
        for vk in 1..255u16 {
            let down = unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0;
            if down != prev[vk as usize] {
                prev[vk as usize] = down;
                let mut s = st();
                log(&mut s, json!({"src":"async","vk":vk,"down":down}));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(4));
    }
}

fn msg_name(m: u32) -> Option<&'static str> {
    Some(match m {
        WM_KEYDOWN => "WM_KEYDOWN",
        WM_KEYUP => "WM_KEYUP",
        WM_SYSKEYDOWN => "WM_SYSKEYDOWN",
        WM_SYSKEYUP => "WM_SYSKEYUP",
        WM_CHAR => "WM_CHAR",
        WM_LBUTTONDOWN => "WM_LBUTTONDOWN",
        WM_LBUTTONUP => "WM_LBUTTONUP",
        WM_RBUTTONDOWN => "WM_RBUTTONDOWN",
        WM_RBUTTONUP => "WM_RBUTTONUP",
        WM_MBUTTONDOWN => "WM_MBUTTONDOWN",
        WM_MBUTTONUP => "WM_MBUTTONUP",
        WM_XBUTTONDOWN => "WM_XBUTTONDOWN",
        WM_XBUTTONUP => "WM_XBUTTONUP",
        WM_MOUSEWHEEL => "WM_MOUSEWHEEL",
        WM_ACTIVATE => "WM_ACTIVATE",
        WM_ACTIVATEAPP => "WM_ACTIVATEAPP",
        WM_SETFOCUS => "WM_SETFOCUS",
        WM_KILLFOCUS => "WM_KILLFOCUS",
        WM_MOUSEACTIVATE => "WM_MOUSEACTIVATE",
        WM_CAPTURECHANGED => "WM_CAPTURECHANGED",
        WM_NCACTIVATE => "WM_NCACTIVATE",
        _ => return None,
    })
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if let Some(name) = msg_name(m) {
        let mut s = st();
        log(&mut s, json!({"src":"wnd","msg":name,"wp":wp.0,"lp":lp.0}));
    }
    match m {
        WM_CMD => {
            loop {
                let next = CMDS.lock().unwrap().pop_front();
                let Some((cmd, tx)) = next else { break };
                let _ = tx.send(handle_cmd(&cmd));
            }
            LRESULT(0)
        }
        WM_INPUT => {
            let mut size = 0u32;
            let hdr = std::mem::size_of::<RAWINPUTHEADER>() as u32;
            GetRawInputData(HRAWINPUT(lp.0 as *mut c_void), RID_INPUT, None, &mut size, hdr);
            let mut buf = vec![0u8; size as usize];
            if GetRawInputData(HRAWINPUT(lp.0 as *mut c_void), RID_INPUT, Some(buf.as_mut_ptr() as *mut c_void), &mut size, hdr) == size {
                let ri = &*(buf.as_ptr() as *const RAWINPUT);
                let mut s = st();
                if ri.header.dwType == RIM_TYPEKEYBOARD.0 {
                    let k = ri.data.keyboard;
                    log(&mut s, json!({"src":"raw","kind":"key","vk":k.VKey,"make":k.MakeCode,"down":k.Flags & 1 == 0,"sink":wp.0 == 1}));
                } else if ri.header.dwType == RIM_TYPEMOUSE.0 {
                    let flags = ri.data.mouse.Anonymous.Anonymous.usButtonFlags;
                    if flags != 0 {
                        log(&mut s, json!({"src":"raw","kind":"mouse","buttons":flags,"sink":wp.0 == 1}));
                    }
                }
            }
            DefWindowProcW(h, m, wp, lp)
        }
        WM_MOUSEMOVE => {
            let mut s = st();
            if s.last_move_log.elapsed().as_millis() > 100 {
                s.last_move_log = Instant::now();
                let (x, y) = ((lp.0 & 0xffff) as i16, ((lp.0 >> 16) & 0xffff) as i16);
                log(&mut s, json!({"src":"wnd","msg":"WM_MOUSEMOVE","x":x,"y":y}));
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            match VIRTUAL_KEY(wp.0 as u16) {
                VK_SPACE | VK_RETURN => advance("key", 1),
                VK_F11 => {
                    let next = match st().mode {
                        Mode::Windowed => Mode::Borderless,
                        Mode::Borderless => Mode::Exclusive,
                        Mode::Exclusive => Mode::Windowed,
                    };
                    set_mode(next);
                }
                k if k.0 == b'M' as u16 => {
                    let _ = ShowWindow(h, SW_MINIMIZE);
                }
                _ => {}
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            advance("click", 1);
            LRESULT(0)
        }
        WM_TIMER => {
            match wp.0 {
                TIMER_SKIP => {
                    // Ctrl skips, polled the way VN engines poll it.
                    let ctrl = GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000 != 0;
                    let (always, off, fg, by_active, active) = { let s = st(); (s.skip_always, s.skip_off, GetForegroundWindow().0 as isize == s.hwnd, s.skip_when_active, s.app_active) };
                    let polls = if by_active { active } else { always || fg };
                    if ctrl && !off && polls {
                        advance(if fg { "ctrl-skip" } else { "ctrl-skip-unfocused" }, 1);
                    }
                }
                TIMER_BLINK => {
                    let blink = {
                        let mut s = st();
                        s.blink_on = !s.blink_on;
                        s.blink
                    };
                    if blink {
                        redraw();
                    }
                }
                // Games present every frame.
                TIMER_FRAME => present(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_ACTIVATEAPP => {
            // Exclusive fullscreen games minimise when they lose focus, and take the display back
            // when they get it again.
            let (mode, active) = (st().mode, wp.0 != 0);
            st().app_active = active;
            let min_on_blur = st().min_on_blur;
            if mode == Mode::Exclusive || min_on_blur {
                if !active {
                    let _ = ShowWindow(h, SW_MINIMIZE);
                } else if mode == Mode::Exclusive {
                    set_mode(Mode::Exclusive);
                }
            }
            DefWindowProcW(h, m, wp, lp)
        }
        WM_SIZE | WM_DPICHANGED | WM_MOVE => {
            if m == WM_DPICHANGED {
                let r = &*(lp.0 as *const RECT);
                let _ = SetWindowPos(h, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
            }
            if m == WM_MOVE {
                let s = st();
                write_truth(&s);
            } else if !IsIconic(h).as_bool() {
                resize();
            } else {
                let mut s = st();
                log(&mut s, json!({"src":"game","ev":"minimized"}));
                write_truth(&s);
            }
            LRESULT(0)
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(h, &mut ps);
            {
                let s = st();
                if s.d3d.is_none() {
                    if let Some(d) = s.dib.as_ref() {
                        let _ = BitBlt(dc, 0, 0, d.w, d.h, Some(d.dc), 0, 0, SRCCOPY);
                    }
                }
            }
            let _ = EndPaint(h, &ps);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_DESTROY => {
            if let Some(sw) = swap() {
                let _ = sw.SetFullscreenState(false, None);
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}
