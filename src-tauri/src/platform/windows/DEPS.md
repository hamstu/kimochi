# platform/windows: dependencies and integration contract

## Cargo

```toml
[target.'cfg(target_os = "windows")'.dependencies]
# Same major as tauri 2.11 / tao 0.35, so `WebviewWindow::hwnd()` returns this crate's
# `HWND` and only one copy of the bindings is compiled.
windows = { version = "0.61", features = [
  "Wdk_System_SystemServices",        # RtlGetVersion (osVersion)
  "Win32_Foundation",
  "Win32_Graphics_Dwm",               # DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS
  "Win32_Graphics_Gdi",               # monitors, icon bitmaps
  "Win32_Storage_FileSystem",         # SHGetFileInfoW's attribute type
  "Win32_System_LibraryLoader",       # GetModuleHandleW
  "Win32_System_Power",               # RegisterSuspendResumeNotification
  "Win32_System_SystemInformation",   # OSVERSIONINFOW
  "Win32_System_Threading",           # OpenProcess, QueryFullProcessImageNameW, AttachThreadInput
  "Win32_UI_Accessibility",           # SetWinEventHook
  "Win32_UI_HiDpi",                   # GetDpiForMonitor, GetDpiForWindow
  "Win32_UI_Input_KeyboardAndMouse",  # GetAsyncKeyState, SetFocus
  "Win32_UI_Shell",                   # SetWindowSubclass, SHDefExtractIconW, SHGetFileInfoW
  "Win32_UI_WindowsAndMessaging",
] }
```

`png = "0.18"` is used for icons; it is already an unconditional dependency of
`src-tauri`, so nothing to add. No `windows-capture` here (that belongs to capture-core).

Module wiring: `platform/mod.rs` already has `#[cfg(target_os = "windows")] mod windows;
pub use windows::*;`. The pure rules in `rules.rs` have no Win32 dependency and can be
`#[path]`-included anywhere to run their tests on macOS.

## Contract notes for the integrator

- **Coordinates.** Everything is physical virtual-screen pixels (top-left, may be
  negative): `cursor`, `displays`, `display_infos.bounds/work_area`, `place`, `bounds`,
  `Source.bounds`, `window_bounds`. `DisplayInfo.scale_factor` is the monitor's effective
  DPI / 96. JS still expects CSS pixels, so Rust must convert before emitting (plan
  §3.2): the `pointer` event in `spawn_cursor_poll`, `regions` published by pages, popup
  placement. **Exception:** `panel_pointer` returns window-local *CSS* pixels (physical
  offset / the window's DPI scale), because only that window's page consumes it.
- **Id formats.** Windows: `windows:window:0x{HWND:X}:{pid}` (upper-case hex, `0x`
  prefix, e.g. `windows:window:0x1A2B3C:4242`). Displays: `windows:display:0x{HMONITOR:X}`.
  These match capture-core's `windows::hex_handle` byte for byte. Ids are compared as
  strings, so the two formats must stay identical; a shared helper would be better. HMONITOR values are USER
  handles (32 significant bits) and change when the display configuration changes.
  `window_bounds` re-checks the pid in the id, because handle values get recycled.
- **`observe_workspace`** keeps the macOS signature (non-`Send` `'static` closures). It
  must be called on the main thread (it is, from `setup`). It creates its message-only
  window and WinEvent hook on the calling thread, and tao's message loop delivers both,
  so the callbacks run on the main thread as on macOS. Called from a thread with no
  message loop, nothing fires.
- **`start_key_trigger`** spawns two threads (hook + drain). `on_line` runs on the drain
  thread. Lines are the Go keytrigger format plus a `"repeat": bool` field on key events.
  Auto-repeat still arrives as `"down"`, as it did with the Go helper, so
  `watcher.rs::handle` triggers on every repeat unless it checks `repeat`. Injected input
  is ignored. `appName` is the image stem (`notepad`), not `notepad.exe`. Foreground
  events include our own process (no `WINEVENT_SKIPOWNPROCESS`, which goes against the
  original brief) because `watcher.rs` must be able to tell "Kimochi is frontmost" from
  "no signal". `stop_key_trigger()` is extra (not in the shared contract); a second
  `start_key_trigger` without a stop returns `Err`. `watcher.rs::start` still calls
  `native::accessibility_trusted()`; on Windows use `key_trigger_status()` instead.
- **`instance_report`** is not exported here: `platform/mod.rs` defines it for all OSes
  and returns `None` off macOS.
- **Main thread.** `make_panel` returns `Err` off the window's owning thread
  (`SetWindowSubclass` only works there). `place`, `order_front`, `promote_to_key`,
  `panel_cursor` and `activate_*` should run on the main thread, as they do on macOS.
  Cross-thread Win32 window calls are synchronous sends and can deadlock if the main
  thread is waiting on the caller. The read-only queries are thread-safe.
- **`promote_to_key` activates Kimochi** (Windows has no "key window of an inactive
  app"). `spawn_cursor_poll`'s "pointer arrives on the dictionary -> `promote_to_key`" and
  `reader_popup_focus` must be limited to explicit editing on Windows (plan §11
  decision 6), or hovering the popup will take focus from the game.
- **`order_front` calls tao's `show()`** after `ShowWindow(SW_SHOWNA)`. This keeps tao's
  internal VISIBLE flag true. Otherwise the next `set_ignore_cursor_events` toggle makes
  tao re-apply its flags and call `ShowWindow(SW_HIDE)`. The panel subclass makes that
  `show()` non-activating. Do not show panel windows with `w.show()` alone on Windows.
- **`make_panel`** also calls `w.set_skip_taskbar(true)`. It is applied to the overlay,
  the reader popup and the popup host, so all three leave the taskbar and Alt+Tab.
- **`panel_pointer`** uses `WindowFromPoint`, which skips click-through
  (`WS_EX_TRANSPARENT`) windows. A window that is currently click-through therefore never
  "has" the pointer. Click-through windows above a panel do not occlude it.
- **`run_cli`** resolves `.exe`/`.com` anywhere on PATH before `.cmd`/`.bat`. A shim runs
  through std's `cmd.exe` escaping. No Job Object, so killing a shim's `Child` orphans
  the `node.exe` under it.
- **`capabilities()`** also returns `os`, `osVersion`, `arch`, `ownAppNames`
  (`Kimochi`, `kimochi`) and `ocrAccelerators` (`meikiocr: directml`, `mangaocr: cpu`),
  like the macOS one. `capabilities_payload` overwrites `capture.authorization` and
  `input.keyTrigger`.
