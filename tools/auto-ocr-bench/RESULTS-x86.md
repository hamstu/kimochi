# Auto OCR settle on x86 Windows with a GPU: `perf/auto-ocr-settle` verified, and two more fixes

2026-11-02. The branch was developed and measured on a Windows 11 ARM64 VM with CPU-only ONNX
(`README.md`). This is the same harness on real x86 hardware with a discrete GPU, where DirectML works,
so both regimes (DirectML and forced CPU) were measured for `main` and the branch. The work and the
fixes it led to are on `perf/auto-ocr-settle-x86`.

## Machine

| | |
| --- | --- |
| CPU | Intel Core i7-7700K, 4 cores / 8 threads, 4.2 GHz |
| GPU | NVIDIA GeForce GTX 1080, 8 GB, driver 582.28 (32.0.15.8228) |
| RAM | 16 GB |
| Display | 2560x1440 at 100 % (96 DPI), 165 Hz, one monitor |
| OS | Windows 11 Pro 10.0.26200 |
| Toolchain | rustc 1.99.1, Node 25.6.1, ONNX Runtime 1.22.0 DirectML build + DirectML 1.15.4 (the staged runtime) |

Builds: debug builds with the isolated profile `dev.kimochi.vmtest` (`TAURI_CONFIG`,
`--no-default-features`); `kimochi-base.exe` from `origin/main` (303d80c), `kimochi-final.exe` from
`origin/perf/auto-ocr-settle` (a18546f). For the baseline runs `ui/scene.ts` and `ui/scene-scanner.ts`
were swapped to `main`'s version in the live Vite checkout. Fake game window 1924x1004 (captured frame
1910x997), 90 ms per glyph, 8 lines per case, shipped Auto OCR defaults. Both exes carry one extra
diagnostic, `KIMOCHI_OCR_CPU=1`, which pins every local engine to the CPU (an uncommitted patch on the
`main` checkout, committed on the x86 branch).

## Backends used

From the app log (`watcher-backend`, logged by the x86 branch) and `ocrbench`:

| Engine | default (`Auto`) | with `KIMOCHI_OCR_CPU=1` |
| --- | --- | --- |
| PaddleOCR | DirectML (adapter 0, the GTX 1080) | CPU |
| MeikiOCR | DirectML | CPU |
| OneOCR | Windows' own engine (no ONNX) | n/a |

The log also shows the CUDA provider tried and skipped before DirectML (`onnxruntime_providers_cuda.dll`
is not staged); that costs nothing after load.

## 1. `main` vs branch

Median over 8 lines of last glyph to result applied (`medianTotalMs`), the accurate pass
(`medianSecondPassMs`), and how many lines the overlay showed exactly right (and after 1.5 s when that
differs). "CPU" rows are the forced-CPU runs; the others ran the engine on DirectML.

| Case | `main` | branch (a18546f) | branch + x86 fixes |
| --- | --- | --- | --- |
| PaddleOCR, DirectML | 1449 ms (2nd pass 277 ms), 8/8 | 602 ms (28), 8/8 | **480 ms** (21), 8/8 |
| PaddleOCR + blink, DirectML | 2055 ms (266), 8/8 | 606 ms (29), 8/8 | **435 ms** (19), 8/8 |
| PaddleOCR, CPU | 4081 ms (802), 8/8 | 713 ms (20), 8/8 | **546 ms** (19), 8/8 |
| PaddleOCR + blink, CPU | 4950 ms (768), 7/7, 1 timed out | 745 ms (21), 7/8 | |
| MeikiOCR, DirectML | 6533 ms (1465), 5/7, 1 timed out | 608 ms (16), 6/8 | **527 ms** (19), 6/8 |
| MeikiOCR + blink, DirectML | 8828 ms (1699), 3/5, 3 timed out | 760 ms (19), 7/8 | |
| MeikiOCR, CPU | 8157 ms (1468), 5/5, 3 timed out | 704 ms (18), 6/8 | |
| MeikiOCR + blink, CPU | 7925 ms (1504), 6/7, 1 timed out | 889 ms (17), 5/8, 6/8 after 1.5 s | |
| OneOCR (reference, branch only) | | 1103 ms (56), 7/8 | |
| OneOCR + blink (reference) | | 1354 ms (64), 7/7, 1 timed out | |

A time-out is a line whose accurate pass did not arrive within 12 s of the last glyph. The last column
is the branch with the frame-key fix below (same scheduler, same engines).

Per-look cost of the watcher (median `observerMs` of the looks that read, not the identical-pixels
cache hits) and the round trip of `capture_frame` as the overlay sees it:

| Case | `main` look / round trip | branch look / round trip |
| --- | --- | --- |
| PaddleOCR, DirectML | 83 / 467 ms | 90 / 168 ms |
| PaddleOCR, CPU | 507 / 700 ms | 108 / 164 ms (regions; a whole read is 450-480 ms) |
| MeikiOCR, DirectML | 1226 / 1475 ms | 156 / 228 ms |
| MeikiOCR, CPU | 1185 / 1406 ms | 158 / 212 ms |
| OneOCR | | 345 / ~400 ms |

What the numbers say:

- All three of the branch's mechanisms show up here. The accurate pass is 16-30 ms (the scan reuses the
  watcher's read; `main` paid 270-800 ms for a second read plus a wait on the DirectML lock), the
  confirming look comes sooner, and on the CPU PaddleOCR reads regions of 80-150 ms instead of whole
  frames of 450-500 ms.
- `main`'s MeikiOCR numbers are dominated by the unoptimised dev-build pre-processing that the branch's
  `[profile.dev.package.*]` overrides fix (1.2 s a look here, 734 ms on the ARM VM), so most of the
  MeikiOCR gap is a debug-build artefact. The PaddleOCR gap is real in release too.
- On `main` the round trip was ~380 ms more than the look on DirectML: the RGBA to RGB conversion ran
  unoptimised in the app crate. The branch moved it to the capture crate (3 ms).
- With a GPU the settle floor is the scheduler, not the engine: two looks 250 ms apart
  (`adaptivePollMin`) plus the confirming one.

Accuracy: PaddleOCR 8/8 in every non-blink case on both builds. The MeikiOCR misses are the same two
sentences on `main` and the branch, on either backend: it drops the 、 in 「となっても、この世」 and reads
「？」 as `?` in 「言うの？　信じ」 (the README saw the second on the ARM VM too). One transient miss on
the branch (MeikiOCR + blink, CPU: 「帰りました」 without its 。, right 1.5 s later) and one on
PaddleOCR + blink, CPU (line 2 read as two boxes, the second not matched by the harness's filter).

## ocrbench (release crates, the app's models and ONNX Runtime)

The last frame the app scanned (1910x997, the fake game). Medians of 7 runs after a warm-up; `first` is
the warm-up call itself, which on DirectML includes building the session for a new input shape.

| PaddleOCR | DirectML | CPU |
| --- | --- | --- |
| full frame, d=960 | 73 ms (det 27, rec 46), first 291 | 376 ms (det 122, rec 255), CER 5.8 % |
| downscaled 0.5 | 63 ms, CER 11.5 % | 332 ms, CER 13.5 % |
| full frame, d=736 | 58 ms (det 15, rec 42), CER 0 % | 284 ms (det 64, rec 221), CER 0 % |
| one-line crop 1720x80 | 8 ms, first 391 | 23 ms |
| one-line crop 560x80 | 8 ms, first 229 | 32 ms |

| MeikiOCR | DirectML | CPU |
| --- | --- | --- |
| full frame | 303 ms (det 42, rec 262), CER 13.5 % | 263 ms (det 78, rec 185), CER 13.5 % |
| downscaled 0.5 | 282 ms, CER 11.5 % | 267 ms |
| one-line crop 1720x80 | 38 ms (det 22, rec 16) | 81 ms (det 63, rec 18) |
| one-line crop 560x80 | 39 ms | 106 ms (det 84, rec 22) |
| 960x397 region (the dialogue box) | 126 ms (det 31, rec 95) | 135 ms (det 93, rec 42) |

A busy 2560x1392 frame (a manga page in a browser, ~60 lines): PaddleOCR 193 ms on DirectML
(det 24, rec 169) vs 872 ms on the CPU; MeikiOCR 673 ms on DirectML (rec 632) vs 507 ms on the CPU.
PNG-encoding that frame costs 16.5 ms (2.3 MB); the flat game frame 4 ms (70 KB). RGBA to RGB 3-5 ms.

- **MeikiOCR's recogniser is slower on DirectML than on the CPU here** (262 vs 185 ms for 13 lines,
  632 vs 420 on the busy frame): one 960x32 inference per line, and DirectML's per-run overhead
  (~20 ms) dominates. Its detector is faster on DirectML (42 vs 78 ms). That is why the app's MeikiOCR
  looks cost the same on both backends (156 vs 158 ms). Batching lines in the recogniser, or running
  detection on DirectML and recognition on the CPU, would be changes in the `meikiocr` crate.
- d=736 was again ~45 % cheaper detection with no loss on this frame, but the furigana and the title
  are the lines that move between 960 and 736; not changed.
- Downscaling the source does not help on either backend, as on the ARM VM.

## 2. The README's "worth checking" list

### DirectML does pay per input shape

The `ppocr` crate already knows: ONNX Runtime 1.22's DirectML provider degrades a dynamic session once it
has seen a second shape, so on DirectML the crate pins one session per detector input shape and keeps
four (`DETECTION_SESSIONS`). Measured with one shared engine (`SHARE=1`, `b=dml`), reading the same line
through crops of growing width (each a new detector input after rounding to 32 px):

| crop | first call (new shape) | then |
| --- | --- | --- |
| 560x80 | 212 ms | 8 ms |
| 600x80 | 209 ms | 9 ms |
| 640x80 | 208 ms | 9 ms |
| 700x80 | 239 ms | 9 ms |
| 760x80 | 218 ms | 9 ms |
| 560x80 again (evicted by then) | 210 ms | 9 ms |
| full frame again (still cached) | 65 ms | 66 ms |

On the CPU the same sequence costs 33-37 ms per crop whatever the shape. So a region read on DirectML is
~8 ms once its shape has a session and ~210-240 ms when it has not, and a line typing out produces a new
width every few glyphs, which would thrash a four-entry cache. **Keeping PaddleOCR's `on_cpu` guard is
right.** Regions on DirectML would need their sizes quantised to a handful of shapes (widths in 256 px
steps, two heights, say) so the cache hits; with a whole DirectML read at 66-90 ms and the scheduler's
250 ms floor the latency gain would be small, so it was not pursued.

### MeikiOCR regions and `KIMOCHI_WATCH_VERIFY=1`

Three settle passes with verify on (every incremental look also read whole; these runs are slower by
design): PaddleOCR on the CPU (30 incremental looks), MeikiOCR on DirectML (29) and MeikiOCR + blink on the
CPU (37). The incremental regions were one region of 4 % of the frame (PaddleOCR) or 8.5 % (MeikiOCR,
widened to 480x272).

- **No disagreement in a line whose pixels changed** in the PaddleOCR pass: every reading of the typing
  line matched the whole-frame reading glyph for glyph.
- MeikiOCR: the typing line matched in all but the 、 case, where on one look the region read
  「となってもこの世」 and the whole read 「となっても、この世」, and both dropped it on the final look (the
  same instability as on `main`). Once the region read had 「静かな夜だった。」 where the whole read lost
  the 。.
- Most "differ" verdicts (24/30, 14/29, 26/37) are in lines whose pixels did not change: the whole read
  of the same unchanged title or furigana varies between looks (「[settle]」/「[ettle]」/「[sttle]」,
  「さく5のやくそく」/「さ<5のや<そく」, 「CＧ」/「ＣＧ」) because the detector sees the whole downscaled frame
  and its boxes shift by a pixel when another line changes. The incremental reading keeps the first
  reading by design, which is the steadier behaviour.

### OneOCR

OneOCR looks cost ~340-350 ms here (whole frame, PNG over the worker's pipe), so it settles in 1.1-1.35 s
against ~0.5 s for the ONNX engines. PNG encoding is not where that time goes (4 ms for this frame, 17 ms
for a busy 2560x1392 one), so passing raw pixels would save ~20 ms a look at most: not done. Region reads
would help more (OneOCR's cost scales with area) but mean rebuilding its richer result (groups, word
polygons) from merged lines; left as the candidate.

### Larger sources

On the busy 2560x1392 frame the pixel plumbing stays small (RGBA to RGB 5 ms, PNG 17 ms, `captureMs`
~10 ms at 1910x997); the engines scale as in the table above.

## 3. Where a look's time went, and two fixes

`KIMOCHI_CAPTURE_AUDIT=1` now times the stages around the engine (`watch-look` in the app log). On the
branch as pushed, a PaddleOCR look on DirectML while a small element blinked:

| stage | ms |
| --- | --- |
| capture (readback, convert, unpremultiply) | 6.5 |
| content fingerprint (capture crate) | 2 |
| **frame key for the observer's cache (app crate)** | **31** |
| RGBA to RGB (capture crate) | 3 |
| incremental plan (changed tiles) | 1 |
| engine (PaddleOCR, whole frame) | 80 |
| worker round trip beyond the engine | 2 |
| `capture_frame` total | 135 |
| round trip as the overlay sees it | ~170 |

### Fix 1: the frame key is hashed in the capture crate

`text_observer::frame_key` and `hash::content_fingerprint` were the same SipHash over the same fields
(the scan reuse depends on them matching). The observer's copy was instantiated in the unoptimised app
crate: 31 ms for a 1910x997 frame, against 2 ms for the same hash in the capture crate. Now there is one
`hash::content_key`, the fingerprint formats it, and the observer calls it (a test pins the two
together). Per look: 31 ms → 2 ms in development builds; `capture_frame` 135 → 104 ms (PaddleOCR) and
104 → 73 ms (MeikiOCR). Settle medians moved as the last column of the first table shows (PaddleOCR
602 → 480 ms, 713 → 546 on the CPU, MeikiOCR 608 → 527). In release builds both hashes were already
optimised, so this changes nothing there except that one definition cannot drift from the other; the
frame is still hashed twice per look (2 ms), which passing the key through `TextObserver::observe`
would remove and was not worth the API change.

### Fix 2: the Source panel's live dot repainted the panel on every display frame

`scen-idle.mjs` measures the CPU time of the app and its WebView2 processes while Auto OCR watches a
still screen (a finished line, nothing changing; the panel and overlay visible). Looks were 1.1-1.3 a
second, all identical-pixel cache hits of ~7 ms, so the native side added ~1 % of a core. The WebView2
processes added ~45 %:

| 30 s, static screen | one-core % | renderer | GPU process | app | panel main thread |
| --- | --- | --- | --- | --- | --- |
| no source picked | 27 % | 3.8 s | 0.8 s | 2.9 s | |
| source picked, Auto OCR off | 33-42 % | 4.4 s | 2.4 s | 5.2 s | 0.7 s |
| Auto OCR on | **78-88 %** | 11.6-11.8 s | 7.3-7.8 s | 5.4-6.2 s | 5.7-6.0 s |
| Auto OCR on, panel animations off (`--no-anim`) | 43 % | 4.9 s | 1.0 s | 5.3 s | 1.3 s |
| Auto OCR on, after the fix | **48-52 %** | 4.9-5.8 s | 3.2 s | 5.3-5.4 s | 1.4-1.5 s |

A Chromium trace (`scen-trace.mjs`) showed the panel's renderer scheduling a style recalculation and a
paint ~165 times a second with no script behind it, and the GPU process drawing 4.6× as many frames as
with Auto OCR off; `document.getAnimations()` in the panel (`scen-state.mjs`) listed one running
animation: `src-pulse` on `.src-live-dot`, the green dot in the Source card's "Auto" badge, which
animated its `box-shadow`. A box-shadow animation is main-thread paint on every display frame, and the
badge sits in a `backdrop-filter`, redone each time. The pulse is now a `::after` halo animating only
`transform` and `opacity` (compositor-only), in twelve steps so the compositor draws a dozen frames per
2 s pulse rather than one per display frame. Same look (checked with magnified screenshots across the
pulse); 88 % → 48-52 % of a core while Auto OCR is on, the floor with no animation being 43 %.

The remaining ~15 % of a core with Auto OCR on against a picked source is the panel's 250 ms `snapshot`
poll (21 KB, ~5 ms each) and 50 ms pointer poll, the overlay's ticks and the remaining compositor
frames, in a debug build with DevTools attached.

## Other things that look wrong or worth a look

- `main`'s MeikiOCR watcher at 1.2 s a look and PaddleOCR's RGB conversion at ~380 ms were both
  debug-build-only costs; the branch fixes them, but anyone benchmarking on `main` with a debug build
  measures mostly that.
- The app at rest (no source, Auto OCR off) used ~10 % of a core in the native process and ~12 % in
  the renderer over 30 s, in a debug build with a remote-debugging port open. Not Auto OCR's, not
  investigated.
- MeikiOCR's recogniser on DirectML is slower than on the CPU (above); on this class of GPU MeikiOCR
  gains nothing from DirectML.
- The `state` broadcast never fired during the idle runs (the panel polls `snapshot` instead), so the
  100 ms fingerprint loop in `spawn_state_broadcast` is doing its job.

## What was run

`scen-settle.mjs` for 4 cases × 2 builds × 2 regimes (plus repeats after the fix), 3 verify passes,
2 OneOCR runs, `ocrbench` on the game frame and a busy 2560x1392 frame for both engines and backends,
the DirectML shape sequence, and `scen-idle.mjs` / `scen-state.mjs` / `scen-trace.mjs` for the idle
cost. Every run's `log.txt` and `result.json` are under `runs/` on the machine; the app logs with the
`watcher-backend`, `watch-look` and `watch-verify` lines under `logs/`.
