//! What keeps the cursor on screen while Kimochi asks for it (`ON`) and the pointer is moving
//! (or moved in the last `GRACE`): the reader must see where they are pointing. Resting, the game
//! decides again, so an idle hide (Ren'Py after 30 s, Majiro after 3 s) still happens; the next
//! movement brings the cursor back. Games hide it three ways, often more than one at once:
//!
//! 1. `ShowCursor(FALSE)`: a per-thread display count; below 0 the cursor is hidden whatever its
//!    shape (Unreal, Unity, Ren'Py's idle hide, KiriKiri, most engines' fullscreen modes). The
//!    hook keeps a *virtual* count per thread and returns that, so a game's
//!    `while (ShowCursor(FALSE) >= 0)` still ends, while the real count stays at 0 or above.
//! 2. `SetCursor(NULL)`, mostly in `WM_SETCURSOR` (SDL, Chromium's `cursor: none`, Unity): the
//!    hook sets the arrow instead.
//! 3. A blank cursor (`CreateCursor` with a transparent mask, an empty `.cur`), or a window class
//!    without one: `SetCursor` with a blank cursor gets the arrow too.
//!
//! The import-table hooks (1, 2, 3) catch calls from the game's own modules. A thread hook on the
//! game's UI threads catches the rest: after every `WM_SETCURSOR` over the client area it puts the
//! arrow back if the window left none (calls the IAT does not see: a `GetProcAddress` lookup, a
//! system DLL), and on mouse movement it lifts a count left below 0 (hidden before Kimochi came,
//! by a module it does not patch). Turned off, or the pointer resting, each thread's real count is
//! put back to the game's own, so the game hides the cursor again exactly as it meant to.
use crate::util::{guard, lock, log};
use crate::visible::invisible;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GetCursor, GetCursorPos, GetWindowThreadProcessId, IsWindowVisible, LoadCursorW,
    PostThreadMessageW, SetCursor, SetWindowsHookExW, ShowCursor, CWPRETSTRUCT, HCURSOR, HTCLIENT, IDC_ARROW,
    WH_CALLWNDPROCRET, WH_GETMESSAGE, WM_NULL, WM_SETCURSOR,
};

/// Whether Kimochi wants the cursor kept visible now (`lib::poll`).
pub static ON: AtomicBool = AtomicBool::new(false);
/// How long after the pointer last moved the cursor stays kept visible: across a pause mid-sweep
/// and while the reader settles on a word. Past it the game's own choice stands until it moves.
const GRACE: Duration = Duration::from_secs(3);
/// The pointer as last seen, and when it was last seen to move.
struct Pointer {
    at: Option<(i32, i32)>,
    moved: Option<Instant>,
}
static POINTER: Mutex<Pointer> = Mutex::new(Pointer { at: None, moved: None });
/// Whether the cursor was being kept at the last `tick`.
static KEEPING: AtomicBool = AtomicBool::new(false);

/// Whether the pointer moved in the last `GRACE` (the first look only records where it is).
fn moved_lately() -> bool {
    let mut p = POINT { x: 0, y: 0 };
    let read = unsafe { GetCursorPos(&mut p) } != 0;
    let mut pointer = lock(&POINTER);
    if read && pointer.at != Some((p.x, p.y)) {
        if pointer.at.is_some() {
            pointer.moved = Some(Instant::now());
        }
        pointer.at = Some((p.x, p.y));
    }
    pointer.moved.is_some_and(|t| t.elapsed() < GRACE)
}

/// Whether to keep the cursor visible now: asked, and the pointer moving.
fn keep() -> bool {
    ON.load(Ordering::Relaxed) && moved_lately()
}

/// From the hook's own thread, four times a second: when keeping starts or stops, wakes each
/// hooked UI thread with a `WM_NULL`, so its message hook lifts or restores its count even when
/// the game posts nothing (resting pointer, no timers).
pub fn tick() {
    let now = keep();
    if KEEPING.swap(now, Ordering::SeqCst) == now {
        return;
    }
    for tid in lock(&HOOKED_THREADS).iter() {
        unsafe { PostThreadMessageW(*tid, WM_NULL, 0, 0) };
    }
}

pub static REAL_SHOW: AtomicUsize = AtomicUsize::new(0);
pub static REAL_SET: AtomicUsize = AtomicUsize::new(0);

type FnShow = unsafe extern "system" fn(BOOL) -> i32;
type FnSet = unsafe extern "system" fn(HCURSOR) -> HCURSOR;

/// The real `ShowCursor`: the function the patched slot held (another hook's, if one was there
/// first), else user32's own (our module's imports are never patched).
fn real_show(show: bool) -> i32 {
    unsafe {
        match REAL_SHOW.load(Ordering::SeqCst) {
            0 => ShowCursor(show as BOOL),
            f => std::mem::transmute::<usize, FnShow>(f)(show as BOOL),
        }
    }
}

fn real_set(cursor: HCURSOR) -> HCURSOR {
    unsafe {
        match REAL_SET.load(Ordering::SeqCst) {
            0 => SetCursor(cursor),
            f => std::mem::transmute::<usize, FnSet>(f)(cursor),
        }
    }
}

fn arrow() -> HCURSOR {
    unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) }
}

/// Per thread whose count the hook has touched: the game's own display count, and the real one
/// as the hook last left it. A difference found on the next read is the game's own doing through
/// a call the hook did not see, and is added to its count, so the count stays exact.
struct Count {
    game: i32,
    left: i32,
}
static COUNTS: LazyLock<Mutex<HashMap<u32, Count>>> = LazyLock::new(Default::default);
/// When each UI thread's real count was last checked from its messages.
static CHECKED: LazyLock<Mutex<HashMap<u32, Instant>>> = LazyLock::new(Default::default);
/// Cursors already judged blank or not (handles are reused only after `DestroyCursor`).
static BLANK: LazyLock<Mutex<HashMap<usize, bool>>> = LazyLock::new(Default::default);
/// How many times something was kept from hiding the cursor, by how (for the log).
pub static KEPT: LazyLock<Mutex<HashMap<&'static str, u64>>> = LazyLock::new(Default::default);

fn kept(how: &'static str) {
    let mut kept = lock(&KEPT);
    let n = kept.entry(how).or_default();
    *n += 1;
    if *n == 1 {
        log(&format!("kept visible: {how} (first time)"));
    }
}

fn blank(cursor: HCURSOR) -> bool {
    if cursor.is_null() {
        return true;
    }
    if let Some(known) = lock(&BLANK).get(&(cursor as usize)) {
        return *known;
    }
    let is = invisible(cursor);
    let mut cache = lock(&BLANK);
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(cursor as usize, is);
    if is {
        log(&format!("cursor {cursor:p} is blank"));
    }
    is
}

/// The calling thread's count brought up to date and its real count raised to 0 if below (never
/// past it, and never lowered: reading it goes up first). Whether it was below.
fn lift(tid: u32) -> bool {
    let mut counts = lock(&COUNTS);
    let mut c = real_show(true);
    let real = c - 1;
    let count = counts.entry(tid).or_insert(Count { game: real, left: real });
    count.game += real - count.left;
    // A count far below 0 is lifted step by step; 64 steps is far more than any game nests.
    let mut steps = 0;
    while c < 0 && steps < 64 {
        c = real_show(true);
        steps += 1;
    }
    if c > 0 {
        c = real_show(false);
    }
    count.left = c;
    real < 0
}

/// Off again: the real count back to the game's own, so what it hid is hidden again.
fn restore(tid: u32) {
    let mut counts = lock(&COUNTS);
    let Some(count) = counts.remove(&tid) else { return };
    let mut c = real_show(true) - 1;
    let want = count.game + (c - count.left);
    let mut steps = 0;
    while c != want && steps < 64 {
        c = real_show(c < want);
        steps += 1;
    }
}

pub unsafe extern "system" fn show_cursor(show: BOOL) -> i32 {
    let tid = GetCurrentThreadId();
    if !keep() {
        restore(tid);
        return real_show(show != 0);
    }
    let mut out = None;
    guard(|| {
        lift(tid);
        let mut counts = lock(&COUNTS);
        if let Some(count) = counts.get_mut(&tid) {
            count.game += if show != 0 { 1 } else { -1 };
            out = Some(count.game);
        }
        if show == 0 {
            kept("ShowCursor(FALSE)");
        }
    });
    out.unwrap_or_else(|| real_show(show != 0))
}

pub unsafe extern "system" fn set_cursor(cursor: HCURSOR) -> HCURSOR {
    if keep() {
        let mut replace = false;
        guard(|| replace = blank(cursor));
        if replace {
            kept(if cursor.is_null() { "SetCursor(NULL)" } else { "SetCursor(blank)" });
            return real_set(arrow());
        }
    }
    real_set(cursor)
}

/// After a window procedure handled `WM_SETCURSOR` over its client area: the arrow if it left
/// the cursor empty or blank.
unsafe extern "system" fn after_call(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && lparam != 0 {
        guard(|| {
            let msg = &*(lparam as *const CWPRETSTRUCT);
            if msg.message != WM_SETCURSOR || (msg.lParam as u32 & 0xFFFF) != HTCLIENT {
                return;
            }
            let tid = GetCurrentThreadId();
            if !keep() {
                restore(tid);
                return;
            }
            if blank(GetCursor()) {
                kept("WM_SETCURSOR left no cursor");
                real_set(arrow());
            }
            if lift(tid) {
                kept("display count below 0 (WM_SETCURSOR)");
            }
        });
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Messages the game's UI thread takes from its queue: lift a hidden count while the pointer
/// moves (at most every 50 ms), or put it back when it rests or Kimochi no longer asks.
unsafe extern "system" fn on_message(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && lparam != 0 {
        guard(|| {
            // Any message, not only mouse movement: a game that hides through a call the IAT
            // does not see (a looked-up pointer, a timer) can hide it between moves.
            let tid = GetCurrentThreadId();
            if !keep() {
                restore(tid);
                return;
            }
            {
                let mut checked = lock(&CHECKED);
                let now = Instant::now();
                if checked.get(&tid).is_some_and(|t| now.duration_since(*t).as_millis() < 50) {
                    return;
                }
                checked.insert(tid, now);
            }
            if lift(tid) {
                kept("display count below 0 (a message)");
            }
        });
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// UI threads the thread hooks are on.
static HOOKED_THREADS: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(Default::default);

unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
    let mut pid = 0u32;
    let tid = GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == GetCurrentProcessId() && IsWindowVisible(hwnd) != 0 {
        (*(out as *mut HashSet<u32>)).insert(tid);
    }
    1
}

/// Puts the thread hooks on every thread with a visible top-level window not hooked yet. A
/// thread's hooks end with it.
pub fn hook_ui_threads() {
    let mut threads = HashSet::<u32>::new();
    unsafe { EnumWindows(Some(collect), &mut threads as *mut HashSet<u32> as LPARAM) };
    let module = crate::MODULE.load(Ordering::SeqCst) as _;
    let mut hooked = lock(&HOOKED_THREADS);
    for tid in threads {
        if hooked.contains(&tid) {
            continue;
        }
        let a = unsafe { SetWindowsHookExW(WH_CALLWNDPROCRET, Some(after_call), module, tid) };
        let b = unsafe { SetWindowsHookExW(WH_GETMESSAGE, Some(on_message), module, tid) };
        log(&format!(
            "thread {tid}: WM_SETCURSOR hook {}, message hook {}",
            if a.is_null() { "failed" } else { "on" },
            if b.is_null() { "failed" } else { "on" }
        ));
        hooked.insert(tid);
    }
}
