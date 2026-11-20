//! The cursor hook's harness (`cursor/`).
//!
//! `vh-cursortest game <scene>` is a fake game: a window with a PeekMessage game loop that hides
//! the system cursor the way one family of engines does:
//!
//! | scene | how it hides the cursor | engines that do this |
//! |---|---|---|
//! | `showcursor` | `while (ShowCursor(FALSE) >= 0);` at start and again every second | Unreal, Unity, most fullscreen modes |
//! | `setcursor` | `SetCursor(NULL)` in `WM_SETCURSOR` | SDL, Chromium (`cursor: none`), Unity |
//! | `frame` | class without a cursor, `SetCursor(NULL)` every frame | engines that set the cursor from their loop |
//! | `blank` | a transparent `CreateCursor` cursor in `WM_SETCURSOR` | engines with a blank `.cur` |
//! | `idle` | `ShowCursor(FALSE)` after 1 s without mouse movement, back on movement | Ren'Py, KiriKiri, many VN engines |
//! | `cached` | like `idle`, through a `ShowCursor` it looked up itself (no import slot); a 100 ms timer | engines that resolve user32 at run time or keep the pointer |
//! | `dynamic` | `SetCursor(NULL)` through a `GetProcAddress` lookup, in `WM_SETCURSOR` | engines that load user32 functions at run time |
//! | `prehidden` | `ShowCursor(FALSE)` once, before the hook arrives, never again | a game hidden before Kimochi attached |
//!
//! `vh-cursortest [scene...]` (all scenes by default) runs each: start the game, put the
//! pointer over it, and read the screen's cursor (`GetCursorInfo`: showing, and not blank)
//! after each step:
//!
//! 1. no hook: hidden (the scene hides it);
//! 2. hook injected, not asked: still hidden (the hook does nothing on its own);
//! 3. asked (`Local\kimochi_cursor_<pid>` held), the pointer moving: visible;
//! 4. asked, the pointer resting past the hook's grace: hidden again where the game hides a
//!    resting cursor (its idle hide stands); the `WM_SETCURSOR` scenes only hide on movement;
//! 5. asked, moving again: visible;
//! 6. no longer asked: hidden again (the game's own choice restored).
//!
//! The runner moves the real pointer and needs an unlocked desktop. Build the DLL alongside
//! (`cargo build -p vh-cursor -p vh-cursortest`, the same target): it is loaded from beside
//! this exe. Both bitnesses: run each target's harness.
//!
//! `CURSORTEST_HOOKD=<kimochi-hookd-<arch>.exe>` loads the hook with Kimochi's helper, as the app
//! does; `CURSORTEST_ALSO=<dll>` loads another DLL first (the voice hook).
#[allow(dead_code)]
#[path = "../../cli/src/inject.rs"]
mod inject;
#[allow(dead_code)]
#[path = "../../cursor/src/visible.rs"]
mod visible;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const SCENES: &[&str] = &["showcursor", "setcursor", "frame", "blank", "idle", "cached", "dynamic", "prehidden"];
/// Scenes whose cursor the game keeps hidden while the pointer rests (the others hide it only in
/// `WM_SETCURSOR`, which comes with movement, so the arrow the hook set stays).
const HIDE_AT_REST: &[&str] = &["showcursor", "frame", "idle", "cached", "prehidden"];
/// The hook's grace after the pointer last moved (`cursor/src/hooks.rs`), plus a margin.
const PAST_GRACE: Duration = Duration::from_millis(4200);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `look`: the screen's cursor now, as JSON (for probing real games): showing, blank, the
    // pointer, and the top-level window under it with its process.
    if args.first().map(String::as_str) == Some("look") {
        let mut info: CURSORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        let ok = unsafe { GetCursorInfo(&mut info) } != 0;
        let p = POINT { x: info.ptScreenPos.x, y: info.ptScreenPos.y };
        let under = unsafe { GetAncestor(WindowFromPoint(p), GA_ROOT) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(under, &mut pid) };
        println!(
            "{{\"ok\":{ok},\"showing\":{},\"blank\":{},\"x\":{},\"y\":{},\"hwnd\":{},\"pid\":{pid}}}",
            info.flags & CURSOR_SHOWING != 0,
            info.flags & CURSOR_SHOWING != 0 && visible::invisible(info.hCursor),
            p.x,
            p.y,
            under as usize
        );
        return;
    }
    if args.first().map(String::as_str) == Some("game") {
        let scene = args.get(1).cloned().unwrap_or_default();
        if !SCENES.contains(&scene.as_str()) {
            eprintln!("unknown scene {scene:?}; one of {}", SCENES.join(", "));
            std::process::exit(2);
        }
        unsafe { game(&scene) };
        return;
    }
    let scenes: Vec<&str> = if args.is_empty() { SCENES.to_vec() } else { args.iter().map(String::as_str).collect() };
    let mut failed = 0;
    for scene in &scenes {
        match run(scene) {
            Ok(()) => println!("{scene:<11} PASS"),
            Err(e) => {
                failed += 1;
                println!("{scene:<11} FAIL  {e}");
            }
        }
    }
    println!("{}/{} scenes passed ({}-bit)", scenes.len() - failed, scenes.len(), usize::BITS);
    std::process::exit(if failed == 0 { 0 } else { 1 });
}

// ---------------------------------------------------------------------------------------------
// The fake game.

static mut SCENE: &str = "";
static mut BLANK: HCURSOR = null_mut();
static mut LAST_MOVE: Option<Instant> = None;
static mut IDLE_HIDDEN: bool = false;

/// The game's calls, each through its import slot. Inlined into the game loop, the compiler
/// would load the slot once, before the loop, and never see the hook put there later (C++ games
/// built with MSVC read the slot on every call).
#[inline(never)]
fn show(on: bool) -> i32 {
    unsafe { ShowCursor(on as i32) }
}
#[inline(never)]
fn set(cursor: HCURSOR) -> HCURSOR {
    unsafe { SetCursor(cursor) }
}

type FnSetCursor = unsafe extern "system" fn(HCURSOR) -> HCURSOR;
type FnShowCursor = unsafe extern "system" fn(i32) -> i32;
static mut CACHED: Option<FnShowCursor> = None;

/// The idle scenes' hide and show: through the import slot, or (`cached`) the looked-up pointer.
unsafe fn idle_show(on: bool) {
    match CACHED {
        Some(f) => {
            f(on as i32);
        }
        None => {
            show(on);
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_SETCURSOR if (lparam as u32 & 0xFFFF) == HTCLIENT => match SCENE {
            "setcursor" => {
                set(null_mut());
                return 1;
            }
            "blank" => {
                set(BLANK);
                return 1;
            }
            "dynamic" => {
                let user32 = LoadLibraryW(wide("user32.dll").as_ptr());
                if let Some(f) = GetProcAddress(user32, c"SetCursor".as_ptr().cast()) {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, FnSetCursor>(f)(null_mut());
                }
                return 1;
            }
            _ => {}
        },
        WM_MOUSEMOVE if SCENE == "idle" || SCENE == "cached" => {
            LAST_MOVE = Some(Instant::now());
            if IDLE_HIDDEN {
                idle_show(true);
                IDLE_HIDDEN = false;
            }
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            return 0;
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn game(scene: &str) {
    SCENE = Box::leak(scene.to_string().into_boxed_str());
    let instance = GetModuleHandleW(null());
    // All AND bits set, no XOR bits: draws nothing.
    let and = [0xFFu8; 32 * 32 / 8];
    let xor = [0u8; 32 * 32 / 8];
    BLANK = CreateCursor(instance, 0, 0, 32, 32, and.as_ptr().cast(), xor.as_ptr().cast());
    let class_name = wide("vh_cursortest_game");
    let class = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        hCursor: if scene == "frame" { null_mut() } else { LoadCursorW(null_mut(), IDC_ARROW) },
        ..std::mem::zeroed()
    };
    RegisterClassW(&class);
    let title = wide(&format!("vh-cursortest {scene}"));
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST,
        class_name.as_ptr(),
        title.as_ptr(),
        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        200,
        200,
        640,
        480,
        null_mut(),
        null_mut(),
        instance,
        null(),
    );
    SetForegroundWindow(hwnd);
    if scene == "cached" {
        let user32 = LoadLibraryW(wide("user32.dll").as_ptr());
        CACHED = GetProcAddress(user32, c"ShowCursor".as_ptr().cast())
            .map(|f| std::mem::transmute::<unsafe extern "system" fn() -> isize, FnShowCursor>(f));
        // A game's timers keep messages coming while the pointer rests.
        SetTimer(hwnd, 1, 100, None);
    }
    let hide_all = || while show(false) >= 0 {};
    match scene {
        "showcursor" => hide_all(),
        "prehidden" => {
            show(false);
        }
        _ => {}
    }
    LAST_MOVE = Some(Instant::now());
    println!("ready {} {}", hwnd as usize, std::process::id());
    let mut rehide = Instant::now();
    let mut msg: MSG = std::mem::zeroed();
    loop {
        while PeekMessageW(&mut msg, null_mut(), 0, 0, PM_REMOVE) != 0 {
            if msg.message == WM_QUIT {
                return;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        match scene {
            "showcursor" if rehide.elapsed() > Duration::from_secs(1) => {
                hide_all();
                rehide = Instant::now();
            }
            "frame" => {
                set(null_mut());
            }
            "idle" | "cached" if !IDLE_HIDDEN && LAST_MOVE.is_some_and(|t| t.elapsed() > Duration::from_secs(1)) => {
                idle_show(false);
                IDLE_HIDDEN = true;
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(16));
    }
}

// ---------------------------------------------------------------------------------------------
// The runner.

struct Game {
    child: std::process::Child,
    hwnd: HWND,
    pid: u32,
}
impl Drop for Game {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start(scene: &str) -> Result<Game, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe)
        .args(["game", scene])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start the game: {e}"))?;
    let mut line = String::new();
    BufReader::new(child.stdout.take().ok_or("no stdout")?).read_line(&mut line).map_err(|e| e.to_string())?;
    let mut parts = line.split_whitespace().skip(1);
    let hwnd = parts.next().and_then(|h| h.parse::<usize>().ok()).ok_or_else(|| format!("bad line {line:?}"))?;
    let pid = parts.next().and_then(|p| p.parse().ok()).ok_or_else(|| format!("bad line {line:?}"))?;
    Ok(Game { child, hwnd: hwnd as HWND, pid })
}

fn nudge(dx: i32, dy: i32) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 },
        },
    };
    unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
}

/// Moves the pointer to the middle of the game's window and jiggles it, as a reader looking for
/// it would.
fn wiggle(hwnd: HWND) {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetWindowRect(hwnd, &mut rect) };
    let (x, y) = ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    unsafe { SetCursorPos(x, y) };
    for (dx, dy) in [(6, 0), (0, 6), (-6, 0), (0, -6)] {
        nudge(dx, dy);
        std::thread::sleep(Duration::from_millis(30));
    }
}

/// What the screen shows: `Ok(true)` when the cursor is showing and not blank. An error when the
/// pointer is not over the game (the test would say nothing).
fn visible(hwnd: HWND) -> Result<bool, String> {
    let mut info: CURSORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
    if unsafe { GetCursorInfo(&mut info) } == 0 {
        return Err(format!("GetCursorInfo failed (error {}); is the desktop locked?", unsafe {
            windows_sys::Win32::Foundation::GetLastError()
        }));
    }
    let under =
        unsafe { GetAncestor(WindowFromPoint(POINT { x: info.ptScreenPos.x, y: info.ptScreenPos.y }), GA_ROOT) };
    if under != hwnd {
        return Err(format!(
            "the pointer ({}, {}) is not over the game window (it is over {under:p})",
            info.ptScreenPos.x, info.ptScreenPos.y
        ));
    }
    Ok(info.flags & CURSOR_SHOWING != 0 && !visible::invisible(info.hCursor))
}

/// Wiggles, waits `settle`, and reads the cursor.
fn look(game: &Game, settle: Duration) -> Result<bool, String> {
    wiggle(game.hwnd);
    std::thread::sleep(settle);
    visible(game.hwnd)
}

/// Loads `dll` into the game: with Kimochi's helper when `CURSORTEST_HOOKD` names it (the app's
/// own path: `kimochi-hookd-<arch>.exe inject --pid <pid> --dll <dll>`), else directly.
fn load(pid: u32, dll: &std::path::Path) -> Result<(), String> {
    if let Some(helper) = std::env::var_os("CURSORTEST_HOOKD") {
        let out = Command::new(helper)
            .args(["inject", "--pid", &pid.to_string(), "--dll"])
            .arg(dll)
            .output()
            .map_err(|e| format!("cannot run the helper: {e}"))?;
        return if out.status.success() {
            Ok(())
        } else {
            Err(format!("the helper failed: {}", String::from_utf8_lossy(&out.stdout).trim()))
        };
    }
    let process = inject::open_process(pid)?;
    inject::inject(process.0, pid, dll)
}

fn run(scene: &str) -> Result<(), String> {
    let dll = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("kimochicursor.dll");
    if !dll.is_file() {
        return Err(format!("{} is missing; build vh-cursor for this target", dll.display()));
    }
    let game = start(scene)?;
    // The idle scenes hide after a second without movement.
    let settle = Duration::from_millis(if matches!(scene, "idle" | "cached") { 2200 } else { 500 });
    std::thread::sleep(Duration::from_millis(300));
    let expect = |step: &str, want: bool| -> Result<(), String> {
        let got = look(&game, settle)?;
        if got == want {
            Ok(())
        } else {
            Err(format!("{step}: the cursor is {} (expected {})", word(got), word(want)))
        }
    };
    expect("before the hook", false)?;
    // `CURSORTEST_ALSO=<dll>`: another hook first (the voice hook), to check the two get along.
    if let Some(other) = std::env::var_os("CURSORTEST_ALSO") {
        load(game.pid, std::path::Path::new(&other))?;
    }
    load(game.pid, &dll)?;
    std::thread::sleep(Duration::from_millis(600));
    expect("hooked, not asked", false)?;
    let name = wide(&format!("Local\\kimochi_cursor_{}", game.pid));
    let event = unsafe { CreateEventW(null(), 1, 0, name.as_ptr()) };
    if event.is_null() {
        return Err("cannot create the event".into());
    }
    std::thread::sleep(Duration::from_millis(400));
    let asked = (|| {
        expect("asked, moving", true)?;
        if HIDE_AT_REST.contains(&scene) {
            wiggle(game.hwnd);
            std::thread::sleep(PAST_GRACE);
            if visible(game.hwnd)? {
                return Err("asked, resting: the cursor is visible (expected hidden: the game's own hide)".to_string());
            }
        }
        expect("asked, moving again", true)
    })();
    unsafe { CloseHandle(event) };
    asked?;
    std::thread::sleep(Duration::from_millis(400));
    expect("no longer asked", false)?;
    Ok(())
}

fn word(visible: bool) -> &'static str {
    if visible {
        "visible"
    } else {
        "hidden"
    }
}
