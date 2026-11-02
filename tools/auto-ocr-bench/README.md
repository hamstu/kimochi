# Auto OCR settle benchmark (perf/auto-ocr-settle)

Throwaway harness for verifying the `perf/auto-ocr-settle` branch on other hardware. **Drop this
folder (and its line in `eslint.config.mjs`) before merging.** Windows only (Win32 fake game,
WebView2 DevTools).

It measures one thing: how long after the **last glyph** of a typed-out line Auto OCR applies its
result, and whether that result is the exact text.

## What's here

| Path | What |
| --- | --- |
| `fakegame/` | `fakegame.exe`: a fake VN window with known Japanese text, driven over a named pipe (`text a\|b` sets the dialogue lines; `--blink` adds a blinking element, like an animated "next" arrow or icon, which defeats the identical-pixels cache). `w32.exe`: Win32 helper (focus, clicks). |
| `scen-settle.mjs` | The scenario: types each sentence glyph by glyph (90 ms per glyph), then reads Kimochi's own `auto-ocr-trace.jsonl` for the accurate pass of a frame captured **after** the last glyph, and checks the overlay's text (right away: `exact`; 1.5 s later: `eventual`). |
| `app.mjs`, `lib.mjs`, `overlay.mjs` | Start/stop the debug app with DevTools, pick the source, read overlay boxes. |
| `ocrbench/` | Standalone engine benchmark (PaddleOCR / MeikiOCR via the same crates, models and ONNX Runtime as the app): detection vs recognition time, downscaling, detector size, threads, crops, with character error rate. |
| `vmtest.conf.json` | Tauri config overlay giving the test build its own identifier/profile. |

## Setup (once)

1. Build the fake game: `cd tools/auto-ocr-bench/fakegame && cargo build`.
2. Build Kimochi with an isolated profile, so the real one is never touched:
   `cd src-tauri && TAURI_CONFIG='{"identifier":"dev.kimochi.vmtest"}' cargo build --no-default-features`,
   then copy `target/debug/kimochi.exe` to `target/debug/kimochi-<name>.exe` (one copy per build
   under test; resources resolve next to the exe). Debug builds call `deep_link().register_all()`,
   which repoints `kimochi://` at the test exe: back up `HKCU\Software\Classes\kimochi` first if you care.
3. Keep the Vite dev server running (the debug exe loads every window from it):
   `node node_modules/vite/bin/vite.js --config vite.dev.config.ts`. **`ui/` is served live from the
   working tree**, so to measure the old scheduler you must `git stash` the `ui/` changes too, not just
   swap the exe.
4. Start the test build once by hand (`node tools/auto-ocr-bench/app.mjs start`, with
   `KIMOCHI_BUILD=kimochi-<name>`), finish onboarding, and download the PaddleOCR and MeikiOCR
   models in Settings (or copy `%LOCALAPPDATA%\dev.kimochi.app\models\{ppocr,meikiocr}` into
   `%LOCALAPPDATA%\dev.kimochi.vmtest\models\`). Quit it.

## Running

```sh
cd tools/auto-ocr-bench
KIMOCHI_BUILD=kimochi-final node scen-settle.mjs --engine ppocr  --build kimochi-final --lines 8
KIMOCHI_BUILD=kimochi-final node scen-settle.mjs --engine ppocr  --build kimochi-final --lines 8 --blink
KIMOCHI_BUILD=kimochi-final node scen-settle.mjs --engine meikiocr --build kimochi-final --lines 8
```

Each run writes `runs/<stamp>-settle-<label>/{log.txt,result.json}` and prints a `SUMMARY` with
`medianTotalMs` (last glyph → result applied), `medianSecondPassMs` (the accurate pass),
`exact`/`eventual` (out of `n`). The scenario rewrites `autoOCRSettings` in the test profile to
the shipped defaults (override with `--settings '{"minRequestSpacingMs":0}'`). Kill stray debug
builds first if a run attaches to the wrong one: the harness kills `target\debug\*.exe` it finds.

Diagnostics (environment of the app, passed through by `app.mjs`):

- `KIMOCHI_WATCH_FULL=1`: no incremental looks (A/B the region reads).
- `KIMOCHI_WATCH_VERIFY=1`: after every incremental look, also read the whole frame and log
  `{"check":"watch-verify","same":…}` to the app log (`logs/app-*.log`). Expect differences only
  in text whose pixels did not change (which keeps its earlier reading by design), never in a line
  that changed.
- `KIMOCHI_CAPTURE_AUDIT=1`: per-capture timing in evidence.

Engine benchmark:

```sh
cd tools/auto-ocr-bench/ocrbench && cargo build --release
R=../../../src-tauri/resources/meikiocr/runtime   # the staged ONNX Runtime
PATH="$R:$PATH" ORT_DYLIB_PATH="$R/onnxruntime.dll" MODELS="$LOCALAPPDATA/dev.kimochi.app/models/ppocr" \
  ./target/release/ocrbench.exe ppocr frame.png truth.txt s=1 s=0.5 s=1,d=736 s=1,t=4 "c=380:810:820:75"
```

Variants: `s=` scale, `d=` PaddleOCR detector max side, `t=` threads, `c=x:y:w:h` crop. `truth.txt`
is one expected line per line. Any frame works; `%APPDATA%\<identifier>\last-ocr-frame.png` is the
last frame the app scanned.

## Results on the first machine

Windows 11 ARM64 VM (Parallels on Apple Silicon, 8 vCPU, 24 GB; display 6880x2880 @ 200%).
DirectML is refused there, so everything ran on the CPU. Debug builds, game window 1924x1004.

Last glyph → result applied, median of 8 lines:

| | `main` | branch |
| --- | --- | --- |
| PaddleOCR | 2.75 s | 0.70 s |
| PaddleOCR + blinking element | 3.24 s | 0.63 s |
| MeikiOCR | 4.32 s (3/8 timed out) | 0.61 s |
| MeikiOCR + blinking element | — | 0.67 s |

All 8/8 exact on the branch for PaddleOCR (MeikiOCR reads 「？」 as `?` on one sentence, on
`main` too).

Engine costs on the real 1924x1004 game frame (release build, `ocrbench`):

| | full frame | downscaled 0.5 | one-line region |
| --- | --- | --- | --- |
| PaddleOCR | 334 ms (det 187, rec 146) | 323 ms, same accuracy | 54 ms |
| MeikiOCR | 156 ms (det 74, rec 82) | 171 ms, CER 1.9 → 5.8 % | 90 ms |
| MeikiOCR, unoptimised dev build | 734 ms | | |

Downscaling the source does not help: both detectors already shrink to ~960 px, and recognition
reads fixed-height line crops. ORT's default thread count was the fastest here.

## Worth checking on x86 / a real GPU

- **DirectML.** With a GPU the watcher reads in 10-40 ms, so the cadence budget matters less and
  the accurate-pass reuse matters relatively more. PaddleOCR only reads regions on the CPU
  (`pp_ocr::runs_on_cpu`): a GPU backend may compile per input shape. Worth measuring whether
  DirectML actually pays for new shapes; if not, regions could be allowed there too.
- **MeikiOCR regions** are widened to at least 480x272 (its detector scales every input to
  960x544). Check accuracy on small text with `KIMOCHI_WATCH_VERIFY=1`.
- **OneOCR** gets the accurate-pass reuse but not region reads (its observer PNG-encodes every
  frame and returns a richer result). Region reads, or passing raw pixels instead of a PNG, are the
  obvious next steps there.
- Larger sources (a 4K display source): the per-look pixel work (conversion, hashing, diff) is
  linear in pixels; measure `captureMs`/`roundTripMs` in the trace.
- A detector max side of 736 instead of 960 cut PaddleOCR's detection by ~35 % with no loss on the
  game frame (640 started merging words), but the watcher and the scan must keep the same setting
  for the reuse to stay exact.
