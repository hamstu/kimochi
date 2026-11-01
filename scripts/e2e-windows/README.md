# Native Windows desktop tests

These drive the **real debug app**, a native fake Japanese VN, the real mouse and keyboard,
and WebView2 DevTools. Browser previews and mocked OCR are not used. Run only on an unattended,
logged-in Windows desktop. Focus and the pointer move throughout a scenario.

This is an initial test base, not complete Windows certification. The reliable starting point is
GDI/windowed. Borderless and display capture remain diagnostic; true DXGI exclusive fullscreen
and live DPI switching are not included. The development prototype could change display modes
and did not stay exclusively fullscreen through capture, so it is deliberately excluded here.

## Build and isolate the app

Requirements: the repo's existing Node/Rust/MSVC setup, .NET Framework's built-in C# compiler,
and WebView2. No npm packages or toolchains are installed by the harness.

From the repository root, with at least 8 GiB free on C: and on the drive the build lives on
(`build.ps1` checks both):

```powershell
$env:CARGO_BUILD_JOBS='4'
Get-PSDrive C,G
node scripts/prepare.mjs
npm run build:frontend
node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --config scripts/e2e-windows/tauri.e2e.json
```

`prepare.mjs` removes `dist/app`; build the frontend **after** prepare. Do not substitute a bundle
or release build. Keep the repository's configured Cargo target directory.

The override uses **dev.kimochi.e2e** for both profile trees, and **kimochi-e2e:** for deep links.
It never needs the installed app's profile. The runner queries both actual native profile paths
and refuses the installed identifier before changing app settings. Do not run a second copy of
the same test profile, and do not point these commands at the installed executable.

An isolated profile needs an available OCR engine and dictionary. Set it up once in the app, or
copy from an offline backup of the installed profile into the separate test profile:

- Local `EBWebView` contains IndexedDB dictionaries. Yomitan needs its enabled dictionaries and
  options in roaming `chrome-local.json`; Hachidori needs dictionary metadata plus its IDBFS/OPFS
  data on the matching origin; 10ten needs its chrome-local-tenten settings and IndexedDB data.
  Copying an extension binary alone does not copy its dictionary. 10ten may finish a normal
  dictionary download after startup.
- Local `extensions`, `models`, and `oneocr` hold installed engine/model/cache data. Copy, never
  share writable folders or modify the original. Do not copy accounts, keys or reading history.
- Native runtime staging must exist as usual. On the Arcade PC, installed
  `Local/Kimochi/meikiocr/runtime` and `Local/Kimochi/oneocr` can be copied read-only into their
  corresponding gitignored `src-tauri/resources` development directories.

Current lookup assertions support **10ten**, and the measured scan baseline uses **OneOCR**.
The hover runner verifies that downloaded 10ten is the effective native engine and its dictionary
data is ready before testing; a download in progress or different engine is a setup failure,
not a failed popup assertion. Wait for 10ten's automatic dictionary update to finish first.
The runner enables Show overlay through the real UI. It uses isolated Shift+F8/F9 bindings;
these are changes to the test profile. Other copies of Kimochi, including hung shutdown threads,
can hold the default shortcuts. Record `hotkeys_reapply` failures before attributing them to OCR.

## Run

Keep binaries, copied profiles and evidence outside the repository:

```powershell
$env:KIMOCHI_E2E_DIR="$env:USERPROFILE\dev\kimochi-scratch\e2e-run"
$env:KIMOCHI_E2E_EXE="$PWD\src-tauri\target\debug\kimochi.exe"   # or wherever your cargo target is
& scripts/e2e-windows/build.ps1 -RunDir $env:KIMOCHI_E2E_DIR

node scripts/e2e-windows/run.mjs scan window gdi windowed
node scripts/e2e-windows/run.mjs hover window gdi windowed
node scripts/e2e-windows/run.mjs windows window gdi windowed
node scripts/e2e-windows/run.mjs quickshot window gdi windowed
node scripts/e2e-windows/run.mjs focus window gdi windowed
node scripts/e2e-windows/run.mjs keys window gdi windowed
node scripts/e2e-windows/run.mjs alt window gdi windowed
node scripts/e2e-windows/run.mjs selfocr display gdi windowed
node scripts/e2e-windows/quit.mjs 22
```

Quit the app before the quit-series command. Other scenarios can reuse a live **isolated** app;
otherwise they launch the configured binary with remote debugging on loopback port 19333.
The fake game and app remain open for inspection after a scenario. Stop the game by writing
`close` to `<run>/game/command.txt`; quit Kimochi normally. No scheduled tasks are used.

Runners lease a fixed loopback port (19334) before touching the desktop. A second scenario or
quit-series process fails immediately, even with a different run directory; the OS releases the
lease when the first process exits. Use one fake-game run directory at a time. The runner also
checks that the game's ground-truth HWND matches the actual game before proceeding.

`source` may be `window` or `display`; `mode` may be `windowed` or `borderless`. The `auto` case
checks a text change without closing the fake game. The `windows` case additionally moves,
resizes, minimises, restores and closes it. It is a **window-source** lifecycle assertion:
a display remains valid when an application closes. For a longer minimise test:

```powershell
$env:KIMOCHI_E2E_HIDDEN_MS='45000'
node scripts/e2e-windows/run.mjs windows window gdi windowed
Remove-Item Env:KIMOCHI_E2E_HIDDEN_MS
```

The lifecycle test catches the bug addressed by draft #29; quit catches #30; Quick Shot's Escape
case catches #32. The lifecycle case also checks fresh overlay alignment after moving/resizing
and rejects silent scanner suspension while minimised. Running against unfixed main is expected
to expose these failures. A second Quick Shot shortcut before a box is drawn closes the editor
like Esc (since 0.3.0; it was ignored before, #25), and its check asserts that. Never silently
combine fixes: record the binary's Git SHA
and any extra test patches in your handoff.

For GPU comparison, quit first, set `KIMOCHI_E2E_DISABLE_GPU=1`, then launch with run.mjs again.
Remove that environment variable and restart to return to normal GPU use.

### What each scenario guards

| Scenario | Checks | Guards |
| --- | --- | --- |
| `scan` | Source picked in the real UI, scan by the real shortcut, cell-centre alignment | — |
| `hover` | Shift-hover opens 10ten's lookup near the word and on screen; entering keeps it; leaving closes it | #38 (pop-up closes on leave) |
| `auto`, `windows` | Auto OCR follows text; move/resize then fresh alignment; long minimise waits; restore resumes; closing stops it | #29 |
| `quickshot` | Open, Esc with a game focused, second press, draw + Enter reads only the game | #32 |
| `focus` | A hover leaves the game in front; Space after a lookup reaches the game; Ctrl/Space typed into a second window ("Kimochi E2E Chat") don't move a game that reads keys while it believes it is active | #38 (#27) |
| `keys` | The bound shortcut's key-down never reaches the game; how many pages an (unbound) Ctrl chord would skip, for #16 | #16, #19 |
| `alt` | A lone Alt on the main window starts no menu loop (`GetGUIThreadInfo`) and WebView2 still answers | #36 |
| `selfocr` | A display scan draws no overlay text over Kimochi's own main window | #35 |
| `quit.mjs N` | N launch/quit cycles; exit code, timing and leftover HWNDs per PID | #30 |

The fake game's VN behaviour is driven over `command.txt`: `skip off|focused|active` (Ctrl held
skips a page every 100 ms: never, while it is the foreground window, or while `WM_ACTIVATEAPP` last
said the app is active, as many engines do) and `minimize-on-blur on|off` (exclusive fullscreen's
habit of minimising on focus loss, for #2/#17 without DXGI). `truth.json` reports `advances` and
`believesActive`; `input.jsonl` logs `WM_ACTIVATEAPP`/`WM_NCACTIVATE` and every `advance` with
its reason. `Desktop.exe guiinfo` prints the foreground thread's GUI state (menu mode, capture).

### Traps

- **Scale.** Page coordinates are CSS pixels: `(screenX * screenScale + x) * devicePixelRatio` is
  the physical point, never `screenX + x * devicePixelRatio` (the two agree only at 100 %).
  `screenScale` is `__KIMOCHI_PLATFORM__.screenScale` (1 unless Windows Text size has WebView2
  rendering above the display's scale, when `screenX` is that much too small; COMMANDS.md,
  "Webview scale"). A fixed point such as "move the pointer to 600, 420" can land inside a pop-up
  at 200 %; derive points from what is on screen.
- **Never tap Alt to get foreground rights**: it starts the menu loop that #36 removed from Kimochi's
  windows but not from other apps. `Desktop.exe focus` attaches thread input instead.
- **Leftover fake games** under or over the game under test swallow clicks. The runner checks the
  ground-truth HWND; close strays (`close` into their `command.txt`) before a run.
- **A quit-hung Kimochi keeps its global shortcuts** (`hotkeys_save` reports them as failed). Builds
  before #30 can leave one; end it before trusting shortcut results.
- **Very large displays.** On a 6880×2880 VM with a debug build, a display capture's first frame can
  miss the 500 ms first-frame wait ("Display produced no image in time"), which fails Quick Shot's
  draw-and-scan; at 3440×1440 it passes. Record the display mode with results.

## Evidence and boundaries

Each case writes `evidence/<scenario>-.../result.json` with per-check timings, plus native
snapshots/logs, DOM word rectangles, ground truth and alignment measurements. The hover case
includes 10ten's actual shadow DOM/definition. Failure artifacts are retained; failed harness
setup must not be counted as a product failure. Results on stdout are concise; exit status is
nonzero on failure. The quit series records process exit code/timing and remaining HWNDs for
each launched PID. It does not infer exit from disappearing windows.

Ground truth records physical screen coordinates, DPI, every line and glyph cell, and each
known word (selected menu/dialogue vocabulary). It measures **cell-centre** alignment, not ink outlines; the existing repository
alignment metrics score actual DOM Range rectangles. Menu, horizontal VN dialogue, vertical
Japanese, small furigana-like text and Space/Enter text advancement are included. IPC supports
`advance`, `windowed`, `borderless`, `minimize`, `restore`, `move x y width height`, and `close`.
Every key/mouse window message and asynchronous key transition is appended to `game/input.jsonl`.

Capture protection hides overlays/popups from screenshots. DOM, native visibility/affinity/z-order
and input logs are the assertions; ordinary screenshots alone do not establish overlay success.
The script reuses `scripts/cdp.mjs` and `overlay-alignment-metrics.mjs`.

Quick Shot checks both complete current dialogue lines and rejects recognisable Kimochi UI
text. It does not yet inspect the raw captured pixels or render a unique per-run dialogue token,
so it cannot rule out every self-capture or stale-history failure.

Known gaps: popup-entry/leave and fast-hover stability need further work; a 10ten popup-entry
failure was observed in native runs. Multi-monitor, DPI, exclusive fullscreen,
NVIDIA recording, tray Quit, browser-process memory attribution and a full input-leak matrix
remain outside this initial suite. Test every supported claim before broadening it.
