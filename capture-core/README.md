# Integrated capture-core copy

Derived from `../../tauri-screen-capture/capture-core` without modifying that completed experiment.

The capture API, crop validation, frame mapping and pixel conversion are unchanged. The macOS display filter now excludes windows owned by Kimochi's current process, refreshed with each source catalog lookup. This is intended to keep the overlay and native controls out of display scans without hiding them. Independent window capture is unchanged. The permission error names this app.

Static build/tests are recorded in the migration report. Runtime exclusion and capture feedback need user testing; the original spike's evidence does not prove this filter change.

## Persistent streams

`MacCapture` keeps each captured source running as an `SCStream` (at most two at once, each stopped after 30s without a capture) and answers later captures by copying the stream's newest frame. Measured on a 3456x2234 display: a one-shot capture cost ~110ms (53ms re-listing windows, 41ms `SCScreenshotManager`, 19ms `CGImage` redraw); a crop from the running stream costs ~1–2ms and a full frame ~4–8ms. Window streams read the window's live geometry from each frame and restart on resize. Thumbnails stay one-shot, scaled on the GPU via the stream configuration. The one-shot path is also the fallback when a stream produces nothing within 500ms.

`WgcCapture` (Windows, `windows-capture` 2.x) mirrors that shape: at most two retained Windows Graphics Capture sessions, LRU eviction, a 30s idle stop, a 500ms first-frame wait, and a latest-frame mailbox each capture copies from. Ids are `windows:window:{HWND hex}:{pid}` and `windows:display:{HMONITOR hex}`. Bounds are physical virtual-screen pixels (`DWMWA_EXTENDED_FRAME_BOUNDS`); window frames are cut to that visible rectangle, so the invisible resize borders never reach a crop. Cursor capture is off; the capture border is left at the system default because removing it needs the user's separate Borderless consent. Thumbnails come from one frame, box-filtered on the CPU. Untested on real Windows so far: it type-checks with `cargo check --target x86_64-pc-windows-msvc`.
