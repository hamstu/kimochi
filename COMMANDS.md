# Kimochi — native command & event reference

The interface between the Rust backend in `src-tauri/` and the web frontends (the React panels
in `frontend/` and the overlay / OCR code in `ui/`). Every `invoke('…')` in the frontends must be
a command registered here (`scripts/command-contract.test.mjs`); update this file alongside any
change to the interface.

Tests run with the Command Line Tools Swift runtime on the link path:

```sh
cd src-tauri
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
RUSTFLAGS="-C link-arg=-Wl,-rpath,/usr/lib/swift" cargo test
```

## Conventions

Commands are `snake_case`. Tauri converts JavaScript camelCase argument keys to Rust
snake_case, so call them as `invoke('source_thumbnail', { sourceId })`.

Errors are strings carrying a machine-readable prefix, so callers can branch without
parsing prose. The text after the prefix is human-facing and actionable.

| Prefix | Meaning | Caller should |
| --- | --- | --- |
| `busy:` | The single capture backend is in use. | Retry; always safe. |
| `permission:` | Screen Recording is not granted. | Prompt via `permission()`. |
| `gone:` | The source or frame no longer exists. | Re-run `source_catalog()` or recapture. Never falls back to a different source. |
| `invalid:` | Bad arguments, or a crop outside its reference. | Fix the request. |
| `native:` | An AppKit / ScreenCaptureKit / HTTP call failed. | Surface the message. |

A tag can follow the prefix. `gone: pick-again: …` is a system-picker source that only comes
back through the picker (`pickAgain: true` from `nativeError()`). `gone: hidden: …` is a window
source that still exists but is out of view for now: minimised (an exclusive-fullscreen game
minimises whenever it loses focus), on another virtual desktop or workspace, or showing no
image (`hidden: true`). A hidden source does not turn Auto OCR off; the automatic loop waits for
it at its base error backoff without counting the failure towards suspension.

`Rect` is `{x, y, width, height}` in **macOS desktop points, top-left origin**, and may
be negative on secondary displays. Never derive it from a WebView's `devicePixelRatio`.

`Crop` is `{x, y, width, height, reference_width, reference_height}` in integer pixels
against the saved reference frame. capture-core rescales each axis independently against
the current capture, so a crop stays correct when a source moves between a 1× and a
Retina display.

`CaptureRequest` is `{source_id, crop: Crop | null}`.

**Source vocabulary.** capture-core calls a screen a `display`. The renderer's
`CaptureSource` and its `isScreenSource` check call it a `screen`. `source_catalog()`
reports the native word; everything **persisted or handed to the frontend** —
`lastSelectedSource.type`, `snapshot().source.type` — uses `screen`. Records written
before this normalisation are converted on read.

## Settings

A generic dotted-key JSON store, replacing Electron's `settings:get` / `settings:set`.

| Command | Signature |
| --- | --- |
| `settings_get` | `({key}) -> Value \| null` |
| `settings_set` | `({key, value}) -> ()` |
| `settings_all` | `() -> Value` — whole document, defaults merged |

Emits `settings:changed` with `{key, value}` to every window after a successful write.
Writes are atomic: the document is staged, persisted through a temp file and rename,
and rolled back in memory if the write fails, so memory and disk cannot disagree.
Grouped writes (see `commit_source`) persist once, so a multi-key change cannot be
left half-applied.

Keys and defaults mirror `src/main/settings.ts`:

`hasCompletedOnboarding`, `windowPositions.<id>`, `nativeWindowBounds.<label>`,
`nativeWindowPinned.<label>`, `cropRegions.<appName>`, `cropScanEnabled.<appName>`,
`ankiCropRegions.<appName>`,
`hotkeys.<name>.{accelerator,enabled,gamepadButton}`, `scannedTextFontSize` (14),
`scannedTextHistory[]`, `audioSettings.voiceId`,
`autoScanSettings.{enabled,scanDelay,gamepadButton}` (a `triggerKeys` left by an older version is ignored),
`autoOCRSettings.{pollInterval,imageHashThreshold,localOCRSimilarityThreshold,localOCRGateEnabled,adaptivePollingEnabled,adaptivePollMin,adaptivePollMax}`,
`texthookerSettings.{copyToClipboard,sendToWebSocket,webSocketUrl}`,
`gamepadSettings.{enabled,preferredGamepadIndex}` (enabled defaults true),
`lastSelectedSource.{sourceId,type,name,appName}`,
`yomitanSettings.{popupType,customApiUrl}` (`popupType`: `'builtin'` (Built-in Yomitan) \| `'custom-api'` (Yomitan API) \| `'hachidori'` \| `'tenten'`; an empty `customApiUrl` means `http://127.0.0.1:19633`), `serverSettings.{mode}` (`'cloud'`),
`textOverlayGrouping.{enabled,proximityThreshold,filterSmallText,filterSmallTextThreshold}`
(`false, 100, true, 0.75`), `overlayOpacity` (80), `liveOverlayEnabled` (false),
`ocrMode` (`'googlelens' | 'cloud' | 'meikiocr' | 'mangaocr' | 'livetext' | 'oneocr'`;
`'local'` is the retired name for `'meikiocr'`, and a stored `'websocket'` — the removed OwOCR
mode — reads as the default), default `'googlelens'` for a new install only: a settings file that
exists but never recorded `ocrMode` loads as `'cloud'`, the engine it was using. `endpoint` (unset
by default — see below).

**The OCR endpoint follows `serverSettings.mode` unless genuinely overridden.** A custom
`endpoint` wins; otherwise the URL is derived as `<base>/api/v1/ocr` from the mode
(`https://kimochiapp.com` or `http://localhost:3000`, from
`src/shared/constants.ts`). An `endpoint` that merely *equals* one of those two built-in
defaults (or their retired `<base>/detect-text` form) does **not** count as custom — otherwise an inherited cloud default, or one the
POC's preferences round-tripped, would permanently pin the app to cloud and make the
Local toggle silently do nothing. `preferences()` reports the resolved endpoint, so the
value shown is the value a scan will use.

**Kimochi's own server needs a signed-in Kimochi account.** Nobody is authenticated any other
way: Rust sends the account's token (see Kimochi account below) as `Authorization: Bearer` to
the metered `/api/v1/*` endpoints on either built-in base (cloud and `localhost:3000`). A
custom `endpoint` never receives it. Without an account the request is refused before anything
is sent ("Kimochi cloud OCR needs a Kimochi account. Sign in from Settings → Account…"), and a
`401` from the server signs the account out locally. The token never reaches a webview, a log or
a diagnostic: the frontend learns only `cloudAccess` (a boolean: someone is signed in) from
`platform_capabilities`, which also reports `ocrEngines.cloud` unavailable when signed out, and
is re-sent as `platform-capabilities` on sign-in and sign-out. The UI
then lists Cloud OCR only while it is still the selected engine (shown as unavailable; the
setting is not migrated) and hides read-aloud and its voice setting.

`serverSettings` is an object, not a flat `serverMode` scalar, because `background.ts`
and `AudioPlayer.tsx` read it through `useSetting<ServerSettings>('serverSettings', …)`.
`textOverlayGrouping` and `overlayOpacity` never appear in `src/main/settings.ts`
because `electron-store` is permissive and they are written only through `useSetting`;
their defaults come from the call sites (`OverlayApp.tsx:46-51`), the only authority
for them.

**Map keys are literal.** `cropRegions`, `cropScanEnabled` and `ankiCropRegions` are keyed by application
name, and an application name may contain a dot (`Node.js`). Those writes go through a
path-segment API rather than a dotted string, so a dotted name stays one map entry
instead of silently nesting a new object and diverging from Electron's shape.

`preferences()` / `save_preferences({prefs})` are retained as a typed view over the same
store, so the existing POC UI keeps working.

**Migration, not reset.** On first run against the new schema, the POC's flat
`preferences.json` is read and carried over: endpoint, controller/log pins, the selected
source, and its single global crop, which becomes a per-descriptor `cropRegions` entry.
The old file is left in place and never rewritten.

## Panels

Mirrors `src/main/native-windows.ts`.

| Command | Signature |
| --- | --- |
| `panel` | `({label, action, rect?}) -> PanelInfo` |
| `panel_content_height` | `({label, height}) -> ()` |
| `panel_pointer` | `() -> [x, y] \| null` |
| `panel_cursor` | `({kind}) -> ()` |

`action`: `show`, `show_inactive`, `hide`, `drag`, `place`, `minimize`, `restore`,
`pin`, `unpin`, `inspect`. The main window also accepts `mini` and `expand`:
temporary compact bounds and forced pin, restored on expand; `PanelInfo.mini` reports
the current mode. Compact bounds and the forced pin are not saved to settings.
Selecting a full-screen source or entering full screen switches to Mini mode once
the source is visible and settled. Expanding manually lasts until a new full-screen
transition or a different source; leaving full screen does not force expansion.
On Windows, `region_keys(true)` hides the main window; `false` restores it only
if it was visible when editing began. Windows modal navigation intercepts its
keyboard input and takes focus on the overlay, returning focus on close. Hovering
interactive overlay regions also leases focus from the selected source, returning
it on leave unless the reader switched to another app. Gamepad interception is
limited to focus handoff; background controller polling is not intercepted.
`show_inactive` presents without stealing focus, which is
what passive updates must use so the source application keeps keyboard focus.

`PanelInfo` is `{label, native, bounds, scale, pinned, focused, resizable, visible}`,
where `native` reports `{level, opaque, ignores_mouse}`.

| Label | Page | Notes |
| --- | --- | --- |
| `controller` | `app/panel.html` | Fixed width, sizes to content, pinned by default |
| `log` | `app/panel.html` | Pinned by default |
| `settings`, `capture`, `debug`, `stream` | `app/panel.html` | Label-parameterised React shell |
| `sync-log` | `app/panel.html` | The sync log (see Sync); centred |
| `source-picker` | `app/source-picker.html` | The only source UX |
| `welcome` | `app/welcome.html` | Onboarding |
| `dictionary` | `app/panel.html` | The active engine's own options page in an iframe (Yomitan `/settings.html`, `hachidori://localhost/settings.html`, `tenten://localhost/options.html`); renamed from `yomitan`, so its saved bounds start fresh |
| `fixture` | `ui/fixture.html` | Diagnostic Japanese test source |
| `fixture-chunks` | `ui/fixture-chunks.html` | Split-word source for cloud OCR lookahead checks (macOS menu, debug builds: Panels → Split-Word Fixture) |
| `overlay` | `ui/overlay.html` | Transparent, click-through, hosts the dictionary backend (Yomitan, or an extension engine's background and offscreen iframes) |

There is deliberately **no** `sources` or `crop` panel. The POC's `ui/sources.html` is
kept on disk for history but is not registered, because there is exactly one source UX
now and offering the old screen as a second, stale path would be worse than removing
it. Crop editing lives inside the picker via `open_source_picker({editCurrent: true})`.

Bounds persist to `nativeWindowBounds.<label>`, pins to `nativeWindowPinned.<label>`.
`controller` and `log` start pinned, every other panel unpinned — Electron's defaults.
Closing hides and marks the panel dismissed rather than destroying it, so reopening
restores native bounds. Saved bounds are clamped into a live display's work area at
creation, and every open panel is pulled back when the display layout changes, so
unplugging a monitor cannot strand a window offscreen.

`panel_pointer` and `panel_cursor` are the inactive-window hover and cursor fixes: an
AppKit frontmost-window hit test in desktop points, respecting occlusion by other
windows. They do not focus or raise windows and do not dispatch synthetic mouse events.
Do not replace them with a DOM-only hover path — WebKit suppresses mouse events in
inactive windows ([WebKit 187545](https://bugs.webkit.org/show_bug.cgi?id=187545)).

Verification status differs between the two. First-gesture dragging and inactive button
hover are **user-confirmed**. `panel_cursor`'s cursor shapes and first-gesture corner
resizing are **physically unverified** — `NSCursor.set` returning successfully is not
proof that a background window's cursor visibly changed.

On Windows the panels do not run the bridge (`useNativeHover` is off there): WebView2 keeps
`:hover` and the cursor current in an inactive window by itself, and a second highlight from
`GetCursorPos` disagreed with Chromium's whenever another pointer (a pen tablet in range) moved
last, or whenever the webview's scale differed from the window's DPI scale (see **Webview
scale** under System). `panel_pointer` still answers there, measured from the client area: `GetWindowRect`
includes the invisible resize borders (about 7 px a side at 100 %).

`panel_cursor` is only called while the webview itself receives no real mouse events
(`CursorOwnership` in `frontend/shell/nativeCursor.ts`). Whenever it does (the key window,
and Windows/Linux always) the webview sets the cursor on every move, and a second writer
made it flicker between arrow, hand and I-beam. Never call it unconditionally on a timer.
On macOS it also does nothing in the key window or while Kimochi is not the active app:
the window server ignores a background app's `NSCursor.set` (measured: the visible cursor
never changes), so an inactive Kimochi window shows the arrow. Making it work would need
the private `SetsCursorInBackground` connection property, which would also leave hands and
I-beams over the game; not used. What remains is a non-key window of the active app.
Over an iframe the panel asks the framed page: it posts `kimochi:cursor-probe` `{id, x, y}`
(frame-relative) to the frame's `src` origin, and the extension host injected into the frame
(`installFrameCursorResponder`, from `host/ext/entry.js`) answers `kimochi:cursor`
`{id, cursor}` to its parent only. No answer within 40 ms means the arrow.

**Events:** `state` (the full snapshot, emitted whenever anything a panel renders
changes — panels should subscribe rather than poll); `panel:state` `{label, visible, pinned, bounds}` on every show/hide/place/
pin path; `panel:closed` `{label}`;
`source-picker-open` `{editCurrent}` on every picker open, so a mounted picker resets
rather than showing the previous session's selection.

## Source picker

| Command | Signature |
| --- | --- |
| `source_catalog` | `() -> [{id, kind, name, app, bounds, on_screen, icon?}]` |
| `source_icon` | `({appName}) -> {icon: string|null}` |
| `source_thumbnail` | `({sourceId}) -> {url}` |
| `source_preview` | `({sourceId}) -> {url, width, height}` |
| `commit_source` | `({sourceId, crop}) -> {sourceId, crop, key}` |
| `commit_anki_crop` | `({sourceId, crop: Crop\|null}) -> {sourceId, crop, key}` |
| `clear_source` | `() -> {sourceId: null, previous}` |
| `open_source_picker` | `({editCurrent}) -> PanelInfo` |
| `source_picker_state` | `() -> {sourceId, crop, editCurrent}` |

`kind` is `"display"` or `"window"`. Displays sort first, then windows by application
and title; the UI is free to re-sort.

**Kimochi's own windows are excluded**, matched on owning process id parsed from
capture-core's `macos:window:{id}:{pid}` rather than on an application name. Selecting
the picker or the overlay would capture our own interface and feed OCR its own output.

`source_catalog` reads display/window-server metadata only; its `icon` field is null.
It excludes Kimochi, offscreen/minimized windows, nonzero window layers, empty titles,
and surfaces smaller than 80 × 60 desktop points. Capture still resolves a fresh
ScreenCaptureKit source by ID. Icons and thumbnails never block the catalog.

`source_icon` is best-effort, requested lazily for visible cards and resolved in-process by matching the owning application against
`NSRunningApplication` localized names and encoding its closest icon representation to
PNG, cached per application. Windows with no owning running application have no icon,
so keep a fallback glyph. This is cheaper than Electron's current path, which shells
out to `PlistBuddy` and `sips` per app.

`source_thumbnail` returns a small downscaled **data URI**, TTL-cached for 10 seconds.
It box-averages the captured RGBA directly and encodes once at thumbnail size — a full
frame is never PNG-encoded just to be scaled down. `source_preview` returns an opaque
`capture://` **URL**, not a data URI, because full previews are multi-megabyte and
base64 through the IPC bridge would copy them repeatedly. Treat both `url` values as
opaque.

Every thumbnail is one real ScreenCaptureKit capture — there is no batch thumbnail API,
unlike Electron's `desktopCapturer`. They serialize behind the same mutex as `scan`, so
request them lazily for visible rows only and retry on `busy:`.

Thumbnails and previews are local only: never sent to OCR, never written to the
evidence log, which records counts, dimensions and timings but no pixels.

**Source ids are session-scoped and are never trusted across launches.** capture-core
says so explicitly, and a recycled id would silently address a different window. The
persisted `lastSelectedSource` record is descriptive; at startup it is resolved against
a fresh enumeration, off the UI thread: an exact id match counts only if the description
still matches too, otherwise a unique kind/app/name match wins and the live id replaces
the stored hint. If several live sources match, or none do, the app stays **unselected**
and says so in `status` rather than claiming a restore that did not happen. Enumeration
needs Screen Recording but does not prompt for it — capture-core preflights and returns
an error instead of opening a dialog.

`commit_source` is the only picker command that mutates state. Reads never touch
selection, crop, scan or revision, so opening the picker cannot disturb a running scan.
It persists `cropRegions`, `cropScanEnabled` and `lastSelectedSource` in **one settings
transaction**, keyed per source descriptor — application name, then window title, then
normalised kind. It invalidates the previous scan when the source changes **or when the
crop changes on the same source**, since the old text no longer matches the new region.

`commit_anki_crop` saves (or, with `null`, clears) a source's **Anki crop**: the part of it
that goes on Anki cards as the screenshot, the whole source when there is none. It is
validated like a commit's crop and stored in `ankiCropRegions` under the same key as the
source's `cropRegions` entry. It changes nothing else: not the selection, not the OCR crop,
not the scan on screen. The snapshot carries the selected source's as `ankiCrop`.

`clear_source` deselects the source: `lastSelectedSource` becomes null, so nothing is restored at
the next launch either, and the scan on screen is dropped (a new revision). Saved crops stay, so
choosing that source again brings its region back.

## Capture and OCR

| Command | Signature |
| --- | --- |
| `enumerate` | `() -> [Source]` |
| `permission` | `() -> bool` — **requests** Screen Recording access |
| `permission_status` | `() -> "granted" \| "not_granted"` — read-only, never prompts |
| `accessibility_status` | `() -> bool \| null` — macOS Accessibility, read-only, never prompts; `null` where the platform has no such permission |
| `request_accessibility` | `() -> bool` — shows the system's Accessibility prompt and opens its Privacy & Security pane; whether it is granted now |
| `source_window_state` | `() -> {sourceId, bounds, onScreen, fullscreen, settling, display} \| null` — the tracked window's last `source-bounds`, for a page opened after it |
| `capture_frame` | `({request, observe?, observerMode?, observerEngine?}) -> {id, info, url, observation, …}` — with `observe`, the watcher reads the frame: `observerMode: 'image'` hashes it instead, and `observerEngine` (`'ppocr'`, `'meikiocr'`, `'livetext'` / `'oneocr'` on their OS; default Live Text on macOS, MeikiOCR elsewhere) names the engine, chosen by `ui/watcher.ts` |
| `ocr_frame` | `({id, engine?}) -> {id, info, ocr}` — pure; `engine` is a native `ocrMode` (`'googlelens'`, `'cloud'` when omitted, `'meikiocr'`, `'mangaocr'`, and `'livetext'` / `'oneocr'` on their OS) |
| `scan_state` | `({scanning?, status?, scan?, publish?}) -> {revision, published}` |
| `scan` | `({request, ocr}) -> {id, info, ocr}` |
| `clear` | `() -> ()` |
| `snapshot` | `() -> ViewState` |
| `regions` | `({rects}) -> ()` |
| `overlay_text_boxes` | `({rects}) -> ()` — the overlay's text boxes in desktop points, drawn or not; ignored from any other window |
| `view_flags` | `({flags}) -> ()` |
| `place_overlay` | `({rect}) -> ()` |
| `desktop` | `() -> [Rect]` |
| `displays` | `() -> [{id, bounds, work_area, scale_factor}]` |
| `watch_source` | `({sourceId \| null}) -> ()` |

**Ownership split.** `capture_frame` performs a native capture and nothing else: no
network, no OCR, no endpoint call, and **no mutation of `revision`, `scan` or
`regions`** — it runs as often as twice a second and bumping the revision would force
the overlay to re-render every word box each tick. Its `url` is
`capture://localhost/{id}`, drawable straight into a canvas. It is the primitive for
any frontend-side processing; that orchestration lives in the overlay webview, not in
Rust.

**`ocr_frame` is what a change-detection loop must use after its gate passes.**
Recapturing at that point would OCR a *different* image than the one that was compared,
and would pair the returned text with geometry it does not belong to. `capture_frame`
and `scan` share one monotonic frame-id space, and each frame is stored with its own
`FrameInfo`, so `ocr_frame` returns text alongside the geometry it was actually
produced from. Ids never repeat, so a stale URL cannot resolve to a newer frame.

**`capture_frame` and `ocr_frame` are both pure — neither publishes anything.**
Publication is the caller's job, through `scan_state`, because only the caller knows
whether an OCR followed and whether the result is still current. A result that arrives
after the source changed has to be dropped by the caller's freshness guard, and it
cannot be dropped if Rust has already published it through the snapshot.

`scan_state({scanning?, status?, scan?, publish?})` is how the overlay drives what the
controller and the capture/debug panels show. Every field is optional and an omitted
field leaves its state untouched:

- `scanning` — sets the busy flag, so `isScanning` lights up for the
  `capture_frame` → `ocr_frame` pipeline, which nothing else sets.
- `status` — sets the status line. Separate from `publish` on purpose, so a mid-scan
  status update does not bump the revision and force every window to re-render. This is
  also the only way a caller's errors (a capture permission failure, a `gone:` source,
  an unreachable endpoint) become visible to the user rather than ending in diagnostics.
- `publish` — when true, replaces `view.scan` with `scan` and bumps the revision.
  `scan: null` with `publish: true` clears the result, like `clear`.

`scan` is validated loosely: text-only engines legitimately send
`{id, info, ocr: {fullText, textAnnotations: []}}` with no geometry. A repeated publish
of the same frame id is ignored rather than re-rendering, and a result with no `id`
always publishes.

**Publishing a numeric `id` pins that frame, and this is load-bearing.** The image store
keeps the newest captured frame plus the published one. Without the pin, the auto-OCR
loop breaks the Capture Preview in a way nobody would trace back to its cause: the loop
captures a probe frame every 500 ms–5 s, the dHash gate discards most of them as
unchanged, but each probe still replaced the newest frame — evicting the image that the
published `snapshot().scan.id` was still pointing at. The preview would go blank
mid-session while the snapshot still named a frame that no longer existed. The pinned
slot is bounded (one published, one latest), shares bytes through an `Arc` rather than
copying pixels, and is released by `clear`. Source previews are stored separately and
bounded on their own.

`scan` (the command) retains its POC signature, remains the Rust-side OCR
path, and is the one place that still publishes its own result — it is a self-contained
diagnostic path with no caller-side guard to respect. Note the consequence: a result
arriving by that route reaches the view **without** passing a caller's freshness check,
so a caller that also runs its own guard should keep rejecting unexpected frame ids
rather than assuming everything published came through it.

**There is no capture blink.** The forked `capture-core` in `../capture-core` excludes
current-process windows from the display `SCContentFilter`, so the overlay no longer has
to be hidden around each capture and the 80 ms settle delay is gone. Window capture is
unchanged and never included our windows to begin with. That native exclusion is
**deliberately untested at runtime** — it is a user test, not a verified claim.

`regions` publishes the DOM's interactive rectangles. A 16 ms native cursor poll toggles
`ignoresMouseEvents`, keeping capture alive through a mouse drag; it does not test pixel
alpha and does not wait for a foreground-app event. Regions are ignored while the
overlay is hidden, so a hidden overlay never swallows clicks. A window that publishes an
*empty* set gives the mouse back too — the dictionary's window does exactly that between
two lookups, and a window left on screen with nothing in it that still swallows clicks
is worse than one that is merely there.

A rectangle's `focus` flag asks for the keyboard when the pointer arrives on it, on the
rising edge and only then. Scanned words do **not** set it: a word is something to point
at, the keyboard it would be taking belongs to the game being read, and a lookup needs no
focus (see `pointer`). The dictionary's window does set it, so clicks, selection and
scrolling work the moment a reader reaches for it.

The overlay and the dictionary window are **non-activating panels** (`NSPanel` with
`NSWindowStyleMaskNonactivatingPanel`, as the Electron overlay's `type: 'panel'` was).
AppKit cannot be asked for that at creation through Tauri, so each window is re-classed
once it exists, guarded by an instance-size check and with `hidesOnDeactivate` turned off
— it defaults to *on* for panels, which would hide the overlay the moment the reader
clicked back into their game. The outcome is recorded as `window-panel`. `KIMOCHI_NO_PANEL=1`
skips the conversion, which restores the old behaviour: clicking either window activates
Kimochi, and activating an application raises *every* window it owns above the one being
read.

`view_flags({flags})` lets the owning renderer publish `autoOcrEnabled`,
`textOverlayVisible`, `debugOverlayVisible` and `overlayVisible` into the snapshot, so
panels can render those toggles without each keeping its own copy.

`watch_source` emits `source-bounds` `{sourceId, bounds, onScreen, fullscreen, settling,
display}` when the tracked window moves, resizes, changes on-screen state or goes in or out
of full screen. It polls `CGWindowListCopyWindowInfo` for one window id ten times a second
rather than re-running a full `SCShareableContent` enumeration per tick, which would be far
too expensive at this cadence, and needs no Screen Recording permission because it reads
geometry, not pixels. `fullscreen` is a full-screen app (on macOS, a window on a full-screen
Space) or a window that fills its display; `display` is that display. `settling` is a
full-screen app away from its display while macOS slides its Space in or out: `bounds` then
stay where it last rested, and the overlay hides its text until it settles. Going in or out of
full screen clears the scan and switches the window's crop to the one saved for that shape.

`activate_source` brings the window itself forward (`platform::activate_window`), switching
to its Space or virtual desktop; on macOS through SkyLight, plus `AXRaise` when Accessibility
is allowed, and the application otherwise.

A second watch emits `source-focus` `{focused, present, held, covered, source_front}` when the answer to
"should the scanned text be on screen at all" changes, and mirrors it into the snapshot
as `sourceFocus`. It is a question about a **window**, not an application: two windows
of one app are two sources and only one of them is being read. The comparison is
against the frontmost ordinary window **of the frontmost application** — the active
app is asked first, then the window server for which of *its* windows is in front.
Not the topmost window on the desktop: Kimochi's own windows float above everything, so
by z-order alone the captured window would never be in front once the overlay was up,
and its text would never come back.

Three rules make it usable rather than merely correct. A **display** capture is always
in front, because there is no window whose focus could be lost. While one of Kimochi's
**own** windows is the frontmost ordinary window the previous answer is *held*, because
hovering the scanned text focuses the overlay and clicking the dictionary focuses the
popup — recomputing then would hide the text being read and close the popup that took
the focus. While one of Kimochi's **ordinary** windows has the keyboard (the main window,
mini mode, Settings, Diagnostics, Dictionary settings, onboarding), the text stays only
while none of those windows covers it: the answer is then `source_front` — whether the
captured window was in front the last time another application was — unless a visible,
unminimised Kimochi window intersects one of the overlay's text boxes, in which case it
is false with `covered: true`. Both sides are cached in desktop points and kept current
by events (`cover.rs`): each window's move, resize, focus, minimise, show and hide, and
the overlay's `overlay_text_boxes`, which it sends whenever its text or the source moves,
*whether or not the text is drawn* — hidden text that reported nothing would count as
uncovered and come straight back. A change that flips the answer wakes the watch at once.
Where window frames are not trustworthy (Wayland, and gamescope / Steam Deck Gaming Mode)
every visible Kimochi window counts as covering, which is the old rule: the text goes
whenever Kimochi itself is in front. Any other application takes precedence immediately. With no frontmost
application at all the last answer stands rather than a guess being made, and an
application with no ordinary window on screen answers with window `0`, which matches no
real window while still identifying who has focus.

The overlay clears its text *and* republishes its hit regions at once when this closes:
an invisible rectangle that still takes the mouse is worse than a visible one.

`pointer` `{x, y, over, blocked, down, shift, ctrl, alt, meta}` carries the desktop
cursor and the held modifiers to the overlay. The overlay is click-through except over
the words themselves and the reader's own application owns both the pointer and the
keyboard, so it sees no `mousemove` of its own until the pointer is already on a word,
and no `keydown` at all. That costs two things: the proximity effect, whose job is to
say a word is *there* before it is pointed at, and the lookup itself, because Yomitan's
scan trigger is a modifier.

Both are answered by this one event. The overlay turns each sample into an ordinary
`pointermove` for the original `TextScanner` (`ui/scan-input.ts`), so a lookup needs no
focus at all — which is what lets somebody hold Shift over a word while their game keeps
the keyboard. The modifiers are read off the same `CGEvent` the cursor position comes
from, so this needs no macOS grant that capture did not already need.

It is bounded rather than streamed: only while the overlay has regions published and is
visible, only while the cursor is over the display it covers, and at half the cursor
poll's rate *while moving* — a modifier or button change is sent at once, because
holding Shift without moving is how a reader asks for the word already under the
pointer. One last sample with `over: false` is sent on the way out so the effect fades
instead of freezing lit. `blocked` marks a point another window claims: over the
dictionary, the text under the pointer is the popup's own.

Popups never have the keyboard either, so the same samples reach them. The Log's Yomitan
popup window gets `popup-host:pointer` `{x, y, down, shift, ctrl, alt, meta}` while the
pointer is over it, and the overlay's own samples over a Yomitan popup go into that popup:
each hands the sample to the innermost popup under it (`replayIntoPopup` in
host/popup-bridge.js), whose scanner opens Yomitan's nested popup.

### The Yomitan API pop-up stack

`show_popover({term, cursorX, cursorY, anchor?, width, height, baseUrl, …, level?})` opens
the API pop-up; `level` (0–4, default 0) is its place in a stack of windows,
`reader-popup`, then `reader-popup-2` … `reader-popup-5`, each built the first time the
one below it shows. A word Shift-scanned inside the pop-up at one level opens the next;
showing a level closes those above it. `hide_popover({level?})` closes a level and every
one above it (default: all), and a click inside a pop-up closes only the ones on top of it.

- `popover:show` is addressed to one level's window.
- `popover:hide` `{level}` goes to every window: the lowest level that closed. The Log and
  the overlay clear their scanned word only when level 0 closes.
- `popover:pointer` `{x, y, screenX, screenY, shift}` goes to the pop-up under the pointer
  (`x`, `y` in its own viewport), so Shift-scanning inside it needs no focus.
- `popover:cards` `[{x, y, width, height}]` (desktop points) lists the visible pop-ups. The
  Log has the keyboard and keeps getting the pointer's moves over a pop-up; it does not scan
  the line under one.

### `snapshot()` and the `state` event

Carries the POC fields (`revision`, `scan`, `status`, `logs`, `interactive`, `regions`,
`origin`, `dictionary`, `dismiss`) plus, so panels can stop polling expensive sources:
`source` (the frontend-shaped descriptor), `crop`, `cropEnabled`, `ankiCrop` (the selected
source's Anki crop, or null), `isScanning`,
`autoOcrEnabled`, `overlayVisible`, `textOverlayVisible`, `debugOverlayVisible`,
`frontmostApp`, `sourceFocus`, and `action` `{name, seq}`.

`regions` is keyed by the window label that published each set: the overlay owns the
words it drew and the dictionary popup owns the popup, and a press has to be
attributable to one of them or clicking the dictionary would count as clicking away
from it.

## Actions, hotkeys and input

All input paths converge on one dispatcher, so a keyboard shortcut, a gamepad button, the
gamepad auto-scan trigger, the tray and a panel can never fire two different code paths
for the same action.

| Command | Signature |
| --- | --- |
| `hotkeys_load` | `() -> HotkeysSettings` — defaults merged with overrides |
| `hotkeys_save` | `({hotkeys}) -> {registered, failed}` |
| `hotkeys_reapply` | `() -> {registered, failed}` |
| `trigger_action` | `({name}) -> ()` |

All names live in one list, `actions::ACTIONS`, which the command-contract test reads
and compares against the names the frontend actually calls, so a button cannot ship
against an action that does not exist.

**Commands** — `triggerScan`, `toggleOverlay`, `setCropArea`, `setAnkiCropArea`, `playAudio`,
`selectAndScan`. Bindable to a shortcut or a gamepad button. Rust performs the native
part Electron performed: restoring the overlay for `triggerScan`, `setCropArea`,
`setAnkiCropArea`, `playAudio` and `selectAndScan`, toggling it for `toggleOverlay`, and focusing it for
`selectAndScan`.

**View toggles** — `toggleAutoOcr`, `toggleTextOverlay`, `toggleDebugOverlay`. Pure
pass-throughs: Rust does **not** flip these flags. The overlay owns the state and writes
it back through `view_flags`; flipping here as well would toggle twice and leave the
switch looking dead.

**Hover affordances** — `hoverSelectRegionOn/Off`, `hoverSourceOn/Off`. Emit-only, with
no overlay side effect: forcing the overlay open because the pointer crossed the
controller's Source button would be a worse bug than the one the restore behaviour
fixes.

All of them emit `hotkey` `{name, seq}`; everything beyond the native part above is the
renderer's decision.
With Quick Shot on, a `triggerScan` that arrives while its region editor is up does not
start another: with no box drawn it cancels (as Escape), with one it scans it (as Return), and
mid-drag, or within 300 ms of the editor opening, it does nothing (`shortcutPressOutcome` in
`ui/region-select.js`). It is keyed on the action, so every trigger behaves the same.

Accelerators use Electron's exact syntax and defaults from `src/shared/defaults.ts`.
Verified against the parser rather than assumed: `global-hotkey` accepts
`COMMANDORCONTROL` (mapping to Super on macOS) and digit names such as `8` → `Digit8`,
so `CommandOrControl+Shift+8` registers unchanged. Per-key registration failures are
reported in `failed` instead of disabling the whole set silently.

**Mouse buttons.** An accelerator of `MouseMiddle`, `MouseBack` or `MouseForward` (always on its
own, never with modifiers; left and right cannot be bound) is not a global shortcut: the
platform's input hook catches the button and swallows its press and release, only while a button
is bound and the shortcuts are not suspended (`mouse_buttons.rs`). Injected input is never
swallowed. On Windows the hook is the overlay's existing `WH_MOUSE_LL` mouse guard; on macOS an
active `CGEventTap` for other-mouse down/up, created only while a button is bound and only when
Accessibility is already allowed (Kimochi never asks for it for this). Linux has no hook. Where a
button cannot fire, it is reported in `failed` with the reason, and `platform_capabilities`
`keys.mouseButtons` (`available`, `needsAccessibility`, `unsupported`) tells Settings whether to
record one.

**Auto-scan trigger.** The gamepad button in `autoScanSettings.gamepadButton` fires
`triggerScan` after `autoScanSettings.scanDelay` (see `gamepad.rs`). Kimochi does not watch
individual keyboard keys in other applications on any platform: a keyboard scan is a
global shortcut (`hotkeys`), which needs no Accessibility or other input permission (a bound
mouse button on macOS is the exception, above).

**Gamepad is owned by Rust, not the webview.** Emits `gamepad`
`{gamepads, activeGamepadIndex, buttonStates, axisStates}` in the shape of
`src/renderer/src/hooks/useGamepad.ts`. Buttons use the W3C standard mapping order, so
`gamepadButton` indices stored by the Electron build keep pointing at the same physical
buttons, and dispatch is rising-edge so holding a button does not repeat. This lives
natively because the whole point of the feature is to fire while a *game* holds focus,
and the overlay that would host a browser gamepad module is deliberately unfocused and
click-through — exactly where WebKit is least likely to report devices. **Unverified:**
gilrs reads HID through IOKit, and whether events arrive on a plain polling thread
without a CFRunLoop has not been tested in-app.

## Output, history and relay

| Command | Signature |
| --- | --- |
| `texthooker_send` | `({text}) -> ()` |
| `history_add` | `({text}) -> entry` |
| `history_delete` | `({id}) -> ()` |
| `history_clear` | `() -> ()` |
| `ext_relay` | `({target \| null, payload}) -> ()` |
| `yomitan_request` | `({url, body}) -> Value` |
| `tts_speak` | `({text, voiceId}) -> ArrayBuffer` (audio) |

`texthooker_send` copies to the clipboard and broadcasts to the texthooker **WebSocket
server**, which Kimochi hosts because `texthooker-ui` connects *to* us — a webview
cannot listen on a port. Mirrors `src/main/texthooker.ts`: restarts only when the
toggle or URL changes, and warns rather than throwing when the port is taken. The
handshake and every send are bounded by a 2 second timeout, the accept loop re-checks
for shutdown after each handshake, and broadcast happens outside the server lock, so one
stalled client cannot freeze publishing or a settings change.

History add/delete go through Rust with the 50-entry cap applied there, so the overlay
and the Log panel cannot race each other with read-modify-write cycles on one key. Each
change re-emits `settings:changed` for `scannedTextHistory`.

`ext_relay_listen` registers a Tauri `Channel` for the calling window. Native forgets it when
that window's page starts loading again (reload or navigation) and when the window closes, so a
page that does not register one (Yomitan's overlay host) gets events, never a dead channel left by
the previous page. `ext_relay` sends `{from: <sender label>, to: target, seq, payload}` directly
over that channel for addressed messages, using Tauri's fast body transport for large results.
Without a channel it emits `ext-relay:<target>`
for an addressed message, or `ext-relay` when `target` is null. Receivers subscribe to
both their addressed event and the broadcast event. Separate event names keep large replies
out of unrelated WebViews; receivers still check addresses and deduplicate per-sender sequences.
Deliberately generic: no Yomitan knowledge lives in Rust.
`ext_relay_bytes` is the same addressed transport with a UTF-8 JSON binary request body and an
`x-kimochi-target` header. Native validates JSON without constructing its object tree, stamps the
envelope, and forwards it through the channel. A receiver without a channel uses the event fallback.
It exists so the Log panel and the dictionary settings window can reach the single
dictionary backend in the overlay without standing up a second one.

`tts_speak` POSTs `{text, voiceId}` to `<server base>/api/v1/tts` with the signed-in account's
token (ElevenLabs behind it) and returns the audio bytes; the webviews play them through an
object URL. It refuses when signed out, before sending anything (see the account note under
Settings), and a `401` signs the account out locally. It replaced the webview-side POST through
the HTTP plugin so the token never reaches JS.

`yomitan_request` POSTs JSON to a user-configured Yomitan-compatible API and returns its
JSON — the transport for the Dictionary tab's Test button, tokenize and termEntries.
Electron fetched these from the main process so any address worked; routing them through
the HTTP plugin instead would force the capability file to enumerate ports, while the
URL field is free text. Validation lives here instead: an `http`/`https` scheme, a host,
and never URL credentials or a query string. **Plain HTTP to any host is accepted,
including a LAN address**, which is what the Electron build did — this is the user
pointing the app at their own server. It is **not callable from `overlay`**, which hosts
the extension's own code; that panel-only boundary is what makes the permissive URL rule
safe, since the caller is always our own UI acting on a configured address, no captured
pixels are involved, and only the term being looked up is sent.

The **OCR endpoint** is validated separately and more strictly: HTTPS anywhere, plain
HTTP only on loopback. Auto-OCR calls it on a timer and it carries captured pixels, so
sending those across a network in the clear stays refused.

**Single backend, single database.** `dist/spike/shim.js` (built from `host/yomitan/overlay.js`) is injected into `overlay` only.
The `dictionary` window gets `/spike/panel-shim.js` instead, resolved through Tauri's asset
resolver at window creation so this crate does not compile against a file another
workstream owns. No window sets a data store identifier, so every webview shares one
`WKWebsiteDataStore` and `tauri://localhost` resolves to the same IndexedDB everywhere.
**That is a static reading of the code, not a runtime observation** — the launch smoke
test is to open the dictionary window (Yomitan engine) and confirm its installed dictionary count matches
what the overlay reports.

## Dictionary engines

Hachidori and 10ten run unmodified beside Yomitan through the generic extension host
(`host/ext/`, bundled to `dist/spike/ext-host.js`). This is the native
surface.

| Command | Signature |
| --- | --- |
| `storage_load` | `({extension?}) -> Value` |
| `storage_save` | `({extension?, value}) -> ()` |
| `storage_backup` | `({extension}) -> string \| null` |
| `dictionary_engine_apply` | `({repair?}) -> ()` |
| `dictionary_engine_effective` | `() -> {selected, effective, ready: {yomitan, hachidori, tenten}}` |
| `dictionary_runtime_status` | `({engine}) -> {engine, phase, settingsReady, message, progress?}` |
| `extension_window_ensure` | `({engine, reload?}) -> {label, action}` |
| `ext_save_file` | raw bytes, header `x-kimochi-filename` (percent-encoded) `-> {saved, path?, bytes?}` |

`ext_save_file` keeps a file an engine's settings page downloads (`<a download>` on a `blob:` or
`data:` URL: Hachidori's backup, debug info and Anki add-on), which a webview frame has no download
UI for. The page's host (`host/ext/page.js`) reads the bytes and hands them to its window's
document, which sends them as the raw body; native shows a save dialog with the suggested name
(directories and reserved characters stripped) and writes the file. `saved: false` when the
dialog is cancelled. Only the `dictionary` and `welcome` windows may call it. Web links in those
pages, and `window.open`, go to the system browser through the hub's `tabs.create` path.

`dictionary_runtime_status` and the `dictionary-readiness` event describe **lookup** readiness,
separately from extension-download readiness. `settingsReady` becomes true once the host's
background/offscreen contexts have initialized, so its settings can open while data downloads.
Settings buttons stay hidden until then. `phase` is `starting`, `downloading`, `installing`,
`setup-needed`, `ready` or `failed`; `progress` is a percentage when the engine supplies one.
The overlay publishes changes through `report` (`check: "dictionary-readiness"`); native keeps
the latest value per engine so newly opened Settings and onboarding see the current state.
Native stamps each stored value with a rising `seq` (`0` for the "nothing reported yet"
default); a window keeps the higher one, because its first `dictionary_runtime_status` answer
can arrive after a newer event.
Hachidori uses `hd_status` and observes `hd_setup_progress` without starting any installation.
10ten uses the same `options` runtime port as its options page (`dbstateupdated`); every data
series must be `ok` and database updates idle. Yomitan requires an installed, enabled dictionary.
These adapters leave upstream extension files unchanged. Engine hosts can be reachable before
their data is ready: settings work during setup, while overlay/transcript lookups stay gated.

`storage_load` / `storage_save` persist `chrome.storage`. Without `extension` they read and
write Yomitan's `chrome-local.json`, exactly as before; with an engine id they use
`chrome-local-<id>.json` beside it. The id must match `[a-z0-9-]{1,32}` or the call fails
with `invalid:`, so it can never name a path (`src-tauri/src/chrome_storage.rs`):

- `storage_save` writes a temp file unique to the write, flushes it to disk and renames it over
  the file, after keeping the replaced version as `<file>.prev` (a hard link). A crash or a
  second Kimochi process writing at the same time leaves a whole file, old or new.
- `storage_load` answers `{}` only when the file and its `.prev` are both missing. A file that
  is not a JSON object is moved aside to `<file>.corrupt-<epoch ms>` and `.prev` is loaded (and
  put back in place); a missing file with a `.prev` loads the `.prev`. Either records
  `{check: 'storage-recovered', file, from, reason: 'corrupt' | 'missing', error, quarantined}`.
  With no usable `.prev`, or on any other read error, it fails (`storage-load-failed` is
  recorded) and never answers `{}`: callers must then not write. The extension hub retries three
  times and then runs the session on its seed without saving (`ext-host-storage-load-failed`,
  `action: 'read-only'`); Yomitan's start fails rather than writing default options.

`storage_backup` copies an extension engine's `chrome-local-<id>.json` to
`chrome-local-<id>.json.bak-<epoch ms>` beside it and answers that name (`null` when there
is no file). Only the newest 10 `.bak-` copies of a file are kept (likewise `.corrupt-`). `extension` is required and must be an engine id, so Yomitan's file is never
backed up or rewritten through it. The overlay's hub calls it before resetting metadata that
describes extension data missing from this launch's WebKit store: the file is shared by every
launch (it is named by the app identifier), the WebKit store is not (a bundle and the bare dev
executable get different ones). Records
`{check: 'storage-backup', extension, file}`; the host then reports `ext-host-storage-desync`.

**The effective engine.** No engine is bundled (see "Dictionary engine downloads" below), so
the engine the windows run is the *effective* one: the setting's host engine when its files
can be served, else `none`. `none` installs neither the Yomitan shims nor the generic host;
lookups answer "No dictionary is set up yet. Choose and download one in Settings →
Dictionary.", and the Log and the dictionary window say the same. Native's preludes carry the
effective engine, and the overlay mirrors it (`dictionary_engine_effective`), so a selected
engine whose files are missing (a removed download, a pin bump still downloading) never leaves
a window running a dead host. `dictionary_engine_effective` answers `selected` (the setting's
host engine), `effective`, and `ready` per engine.

`dictionary_engine_apply` refuses with `invalid: <engine> is not downloaded` when the setting
names an engine whose files are missing, so a switch never reloads the windows into a host
with no files; Settings and onboarding switch only once the download is ready. With
`repair: true` (the overlay's startup repair of a stale mirror) it reloads into the effective
engine, `none` included, whatever the setting says. Otherwise it reloads
(`location.reload()`) every extension-hosting window that exists, in this order: `overlay`, `log`, `dictionary`, `popup-host`, `welcome`. Call
it after saving `yomitanSettings.popupType` and writing the `localStorage` mirror
`kimochi.dictionaryEngine`: the reload re-runs the document-start scripts, which read the
new engine. The mirror and the prelude name the *host* engine: `'builtin'` resolves to
`yomitan`, and `'custom-api'` to `none`, because the Yomitan API engine splits and looks words up
through the browser's Yomitan and needs no host (the overlay installs its lookups itself), so
switching to or from it reloads the windows like any other switch, and a switch to it is never
refused for a missing download. A window not built yet needs nothing, because its prelude reads the store when
it is built. Call it once per switch: Settings is the only caller on a switch (the overlay
calls it only from its startup repair of a stale mirror). The Log comes back on Settings →
Dictionary because Settings records its route in `sessionStorage` first
(`kimochi.engineSwitch`); other in-page state that is not
persisted is dropped, and the transcript is history and comes back. Records
`{check: 'dictionary-engine-apply', engine, reloaded, failed}`. It also settles the
extension windows (below): any other engine's `ext-<id>` window is closed, the active
engine's is reloaded with the rest, or created in a later main-thread turn when there is
none yet; each step records `{check: 'extension-window', engine, label, action}` with
`action` `closed`, `reloaded` or `created`.

**Extension windows.** Each extension engine's background document (and Hachidori's
offscreen document, an iframe inside it) runs in a hidden window of its own, labelled
`ext-hachidori` / `ext-tenten`, whose top document is
`<origin>/__kimochi/ext-background.html?engine=<id>`. As a top document on the extension's
own origin its IndexedDB and OPFS are first-party and survive a quit; as an iframe of the
overlay (the earlier design) WebKit kept them only for the session, so Hachidori's imported
dictionaries and 10ten's `jpdict` database were gone after every relaunch. Native creates
the window at startup when the active engine is an extension engine, and on a switch as
above. The window is never shown and never focused: `visible(false)`, `focused(false)`,
`focusable(false)`, `skip_taskbar`, no decorations, 1×1 (never shown, so not content-protected), background
throttling off like the overlay's, and it is not a panel, so `panel` refuses its label. Its
document-start scripts, for all frames, are the platform prelude, the label prelude
(label `ext-<id>`, no frame band, no popup host) and `ext-host.js`; never a Yomitan shim.
Its navigation allowlist is the engine's own origin (and `about:blank`). It shares the one
website data store with every other window.

`extension_window_ensure` is the overlay hub's way to ask for it when it starts:
idempotent (`action: 'kept'` when it exists), `created` otherwise; `reload: true` (a retry
after a failed start) reloads an existing one (`reloaded`). It refuses an `engine` that is
not the active extension engine (`invalid:`), so an overlay still running the previous
engine cannot bring that window back. Records `{check: 'extension-window', engine, label,
action, cause: 'ensure'}` (`cause` is `startup` or `apply` for native's own calls; a failure
records `action: 'failed'` with the error).

**Origins.** Each extension is served from its own custom scheme, named by its id:
`hachidori://localhost/` and `tenten://localhost/` on macOS and Linux,
`http://hachidori.localhost/` and `http://tenten.localhost/` on Windows (Tauri's WebView2
bridge, as for `tauri://` and `capture://`). `/<path>` is `dist/ext/<id>/<path>`,
`/__kimochi/<path>` is `dist/spike/<path>`, and anything else, a directory path (`/`, a
trailing slash) or a `..` segment (also percent-encoded) is a 404. A bundle checks the
embedded file list first, because Tauri's asset resolver would otherwise answer a missing
file with `index.html`; `tauri dev` reads `dist/` from disk. Every response carries
`Access-Control-Allow-Origin: *` and `Cache-Control: no-store`, with a `Content-Type` from
the file extension (`.js`/`.mjs` `text/javascript`, `.wasm` `application/wasm`, fonts,
images, audio; `.ljson`, `.idx` and anything unknown `application/octet-stream`). The
`overlay`'s navigation allowlist accepts these origins (WebKit asks it about subframes);
each `ext-<id>` window accepts its own engine's origin only; the panels and `popup-host`
set no allowlist.

**Document-start scripts.** `overlay`, `log`, `dictionary`, `welcome` and `popup-host` get,
for all frames: the platform prelude; the label prelude (`__kimochiPanelLabel`, frame
band, popup host, plus `__kimochiDictionaryEngine` and `__kimochiExtensionOrigins`); their
Yomitan shim (`shim.js` in the overlay, `panel-shim.js` elsewhere, both built from `host/yomitan/`); then
`ext-host.js`. Exactly one shim installs, depending on the engine. The overlay is named
`overlay` but stays outside the frame bands, numbering from 0. `__kimochiDictionaryEngine`
comes from `yomitanSettings.popupType` when the window is built (`builtin` is `yomitan`),
except in a frame on an extension origin, which is always that extension's engine: it
cannot read the app origin's `localStorage` mirror, and the prelude keeps its build-time
value across a reload. A debug build without `ext-host.js` records `ext-host-missing` and
builds the window without it; a release build refuses, because a bundle without it is broken.

**IPC and extension code.** Tauri injects `__TAURI_INTERNALS__`, the invoke key and
`withGlobalTauri`'s `__TAURI__` into each window's main frame only, and counts the
registered extension schemes as *local* origins for the ACL. An extension-origin iframe
(an options page in `dictionary`, the offscreen document) has no IPC and reaches native
through its top document by `postMessage`. The `ext-<id>` windows are the one place an
extension-origin document is a main frame, so the extension's own background script runs
next to `__TAURI__` there. Two things contain it:

- **Capability.** `capabilities/extension-windows.json` covers `ext-hachidori` and
  `ext-tenten` only, and grants `core:event:allow-listen` (the host hears `ext-relay`) and
  `http:default` with exactly `network.json`'s URL scope (the background and its offscreen
  frame download dictionaries through plugin-http themselves). No emit, window, webview,
  shell, fs, dialog or clipboard permission, and no other capability lists these windows
  (`scripts/http-scope.test.mjs` checks both). Plugin commands are subject to this ACL.
- **Invoke guard.** App commands are not (the app defines no ACL manifest), so `main.rs`
  wraps `generate_handler!`: a call from a webview whose label starts with `ext-` is
  rejected with `invalid: <command> is not available to an extension window` unless the
  command is in `extensions::EXTENSION_WINDOW_COMMANDS`: `ext_relay`, `ext_relay_listen`,
  `ext_relay_bytes`, `report` and `anki_connect_relay`.
  Storage, capture and window commands are the hub's, in the overlay, and are refused
  there. Each refused command is recorded once per launch as
  `{check: 'extension-window-command-refused', window, command}`.

`ext_relay` accepts any window label as sender and target, so the extension windows relay
like the Log; nothing native checks a sender's origin.

### Hachidori's loopback origin

Hachidori imports on several threads only when its pages are cross-origin isolated. WebKit never
isolates a page served by a URL scheme handler, and WebView2, which does, cannot load a worker's
own workers from `http://hachidori.localhost` (Hachidori's pthreads), so its engine would never
start (`platform::CROSS_ORIGIN_ISOLATION` is false: the scheme sends no COOP/COEP). So
`loopback.rs` also serves Hachidori's tree (exactly what its scheme serves, `extensions::lookup`)
over HTTP at **`http://127.0.0.1:<port>`**, with the manifest's COOP/COEP, and that becomes
Hachidori's origin (`platform::extension_origin`) once its storage lives there, on macOS, Windows
and Linux. 10ten keeps its scheme.

- **Port.** Part of the origin, so chosen once and kept in `extension-origins.json` (app data
  directory, per flavor: `release` prefers 27631, a dev build 27632, the next free one up to 24
  above on a first run). Bound before any window is built. If the saved port is taken after the
  switch, Hachidori does not start (`extension_window_ensure` fails with `unavailable: …`) rather
  than show no dictionaries or load another program's pages; `{check: 'hachidori-origin'}` in the
  log says which session it is (`scheme`, `loopback`, `unavailable`) and why.
- **Who may load it.** `Host` must be `127.0.0.1:<port>`; a request carrying `Origin` or
  `Referer` must come from the loopback origin, the app origin or (dev) the dev server, else 403
  (`{check: 'hachidori-loopback-refused'}`). It serves only the public extension release and host
  scripts, never user data; the dictionaries stay in WebKit's storage.
- **IPC.** Tauri treats the page as remote, and remote pages never reach app commands, so the
  extension window's commands are also the inline plugin **`kimochi-ext`** (`main.rs`
  `ext_ipc_plugin`, permissions from `build.rs`): `plugin:kimochi-ext|ext_relay`,
  `ext_relay_listen`, `ext_relay_bytes`, `report`, `anki_connect_relay`, same arguments and
  replies as the app commands. Native's prelude sets `window.__kimochiExtCommandPrefix` there and
  the host prefixes those names (`host/ext/primitives.js` `extCommand`). Granted at runtime to
  `ext-hachidori` for exactly that origin, with `extension-windows.json`'s permissions
  (`loopback::add_capabilities`); the plugin itself refuses any window/command pair not in
  `loopback::plugin_command_allowed`.
- **The one-time copy.** Until Hachidori's storage has been copied the session keeps its scheme
  origin (`hachidori://localhost`, `http://hachidori.localhost` on Windows). A hidden window `ext-migrate-hachidori` (15 s after launch) loads
  `/__kimochi/ext-migrate.html?step=export` on the old origin, then `?step=import` on the loopback
  origin (`host/ext/migrate.js`), through these `kimochi-ext` commands, which only that window
  may call (static capability `extension-migration.json` for the scheme page, the same at runtime
  for the loopback page):

| Command | Args → returns | Notes |
| --- | --- | --- |
| `ext_migration_begin` | `() -> {to, page}` | fresh staging directory (`<app local data>/extension-migration/hachidori-<flavor>/`) |
| `ext_migration_put` | raw bytes → `index` | one part (localStorage, a database schema, a record) |
| `ext_migration_exported` | `({records, bytes}) -> {parts}` | the totals the import must reproduce |
| `ext_migration_manifest` | `() -> {parts, records, bytes}` | |
| `ext_migration_get` | `({index}) -> ArrayBuffer` | |
| `ext_migration_done` | `({records, bytes, isolated}) -> ()` | totals must match, and the storage file's `dictionaryState` must not have changed since `begin` |
| `ext_migration_failed` | `({error}) -> ()` | |

  Every record is read back and compared (shape and SHA-256 of each binary part) before
  `done`. A verified copy of the `dictionaryState` the storage file still describes switches
  the **next** launch; a changed one copies again; three failures stop retrying; a loopback page
  that is not isolated records `unsupported` and never switches. The old origin's data is only
  read, never removed. Progress is `{check: 'hachidori-migration', phase}` in the log
  (`started`, `copied`, `stale`, `failed`, `unsupported`). Settings need no copy: `chrome.storage`
  is `chrome-local-hachidori.json`, whatever the origin.
- **Linux.** WebKitGTK also needs JavaScriptCore's `useSharedArrayBuffer` (`main` sets
  `JSC_useSharedArrayBuffer=1` before any web process starts, `loopback::prepare_environment`),
  or `SharedArrayBuffer` stays hidden even on the isolated page.
- **Opting out.** `KIMOCHI_HACHIDORI_THREADS=0` keeps Hachidori on one thread on its scheme:
  nothing is copied or moved. Once Hachidori has moved to the loopback origin it has no effect,
  since going back would leave `chrome.storage` describing dictionaries the scheme origin does
  not have.

## Kimochi account

Optional accounts on the Kimochi server (`https://kimochiapp.com`), in
`src-tauri/src/account.rs` (accounts, switching) and `src-tauri/src/profile.rs` (profiles).

**Accounts.** This computer can be signed in to several accounts at once (on Kimochi cloud and,
in a debug build, the local server); one is active. `accounts.json` in the app data folder lists
them (key `<cloud|local>-<user id>`, server mode, user id, cached user and usage, never a token)
and which is active (`null`: none). Each token (`kmc_…`) lives alone in `accounts/<key>.json`
(mode 600 on Unix) and is sent only as `Authorization: Bearer` to its own account's server. No
command or event carries it. The server in use (`serverSettings.mode`) follows the active
account; `account::token()` answers only for the active account on that server. The single
`account.json` / `account-local.json` of earlier versions are imported once: the account that was
in use becomes active, with a copy of the Local profile as its data.

**Profiles.** Every account has its own profile folder, `<AppLocalData>/profiles/<key>/`, holding
`sessions.json`, `sessions/`, `presets.json`, `stats.json`, `profile-settings.json` and its
`sync/` state; the Local profile (no account) is `<AppLocalData>` itself, as before. Settings are
one live `settings.json`: machine keys (`profile::MACHINE_KEYS`: window places, capture source,
scan history, server choice, OCR engine, dictionary engine, …) and every secret (`is_private`)
belong to the computer and are shared by all profiles; everything else is the profile's and is
swapped on a switch (the profile not in use keeps it in its `profile-settings.json`).
`texthookerSourceSessions` follows the profile but is not synced. A switch (`account_switch`):
holds the Log so its pending writes reach the old profile, saves the current preferences to the
old profile, prepares the new one, writes its preferences into the live settings (emitting
`settings:changed` per key), sets `serverSettings.mode`, and reloads the windows that show
profile data (`log`, `settings`, `diagnostics`, `sync-log`). An account's profile is
made the first time it is used here: a **copy** of the Local profile when the account has nothing
synced (`GET /api/v1/sync/status` `records: 0`), otherwise filled from the server before the
windows reload (or empty when the server cannot be reached; it fills in once online). Each case
is written to the sync log. Nothing is merged across accounts.

The webviews address profile files as `<root>/<path>` under `BaseDirectory.AppLocalData`, with
`root` from `profile_current` (`frontend/texthooker/core/profile.ts`); paths stored inside the
files (a notebook image's `path`) stay profile-relative.

In a debug build, `KIMOCHI_SERVER=local|cloud` in the environment overrides
`serverSettings.mode` (`npm run dev:local` sets `local`); release builds ignore it, and accounts
on the other server cannot be switched to while it is set.

| Command | Signature |
| --- | --- |
| `account_status` | `() -> AccountStatus` |
| `account_link_start` | `() -> {code, verifyUrl, expiresIn}` — adds an account: `POST /api/v1/link/start` on the sign-in server (`linkServer`) with the computer's name and OS, opens `verifyUrl` in the browser, and polls `/api/v1/link/poll` every `interval` s on a thread until approved (then the account is saved and switched to), denied, expired or cancelled |
| `account_link_open` | `() -> ()` — opens the pending `verifyUrl` again |
| `account_link_cancel` | `() -> AccountStatus` |
| `account_switch` | `({key: string \| null}) -> AccountStatus` — makes that account's profile (`null`: the Local profile) the one in use; see Profiles. Refused (`invalid:`) for an account on the server `KIMOCHI_SERVER` rules out |
| `account_sign_out` | `({key?}) -> AccountStatus` — default the active account: switches to the Local profile if it was active, deletes its token file, then `POST /api/v1/sign-out` (best effort, so it works offline). The account stays listed (`signedIn: false`) with its profile |
| `account_remove` | `({key}) -> AccountStatus` — signs out, deletes `profiles/<key>/` and forgets the account (what has synced stays on the server) |
| `account_refresh` | `() -> AccountStatus` — `GET /api/v1/me` and `/api/v1/usage` for the active account |
| `account_open_web` | `() -> ()` — opens `<active account's server>/account` |
| `account_set_server` | `({mode: 'cloud' \| 'local'}) -> AccountStatus` — **debug builds only** (an `invalid:` error in release, and while `KIMOCHI_SERVER` pins the server): the server new sign-ins go to (`accountLinkServer`, a machine setting); with no account active it is also `serverSettings.mode` (emitting `settings:changed`). Cancels a sign-in in progress, then emits `account-changed` and `platform-capabilities` |
| `profile_current` | `() -> {key: string \| null, root: string}` — the profile in use; `root` is `""` for Local or `profiles/<key>` |
| `cloud_translate` | `({text}) -> string` — `POST /api/v1/translate` (JA → EN-US), account only |

```ts
AccountStatus = {
  signedIn,                               // the active account has a token here
  cloud,                                  // ...and has Kimochi Cloud (trial, plan, lifetime, grant): its features show and Sync runs
  user?, usage?,                          // the active account's cached /me user and /usage answer
  linking?: {code, verifyUrl, expiresAt}, // a sign-in waiting for the browser (expiresAt: ms)
  server?: {mode, url, forced},           // the server in use; forced: KIMOCHI_SERVER (debug)
  linkServer?: {mode, url, forced},       // where "Add account" signs in
  accounts: [{key, user, server, signedIn, active, available}], // most recently used first
  profile: {key, root, needsSignIn},      // needsSignIn: the active account's token was revoked
  switching: boolean
}
```

`cloudAccess` in `platform_capabilities` is the same `cloud`. A free account sees no Kimochi cloud
feature and does not sync; the server answers `403 plan_required` if asked anyway, which makes
native re-read the user (as it also does every 30 minutes), so a plan bought or ended on the website
shows without a restart.

Events: `account-changed` (an `AccountStatus`, on every change) and `account-link` `{status,
code, message?}` (`pending` | `approved` | `denied` | `expired` | `cancelled` | `error`). On
approval the main window comes forward on Settings → Account (`settingsActiveTab: 'account'`
plus `main:show-settings`). A `401` to the active account's token forgets the token (the account
stays active with `needsSignIn`). After a metered call the usage is refreshed in the background.

**Errors** from the metered endpoints are worded in `cloud::describe_failure`: `402
quota_exceeded` ("You've used this month's 500 Kimochi cloud scans. They reset on Nov 1.";
`storage` names the sync storage limit), `403` (suspended: the server's message), `503
not_configured`, `429`, and anything else with its status.

**Explain via Kimochi cloud.** `explain_run` with `provider: 'kimochi'` POSTs `{prompt}` to
`/api/v1/explain` and emits the streamed text as `explain:chunk`, then `explain:done` (or
`explain:error`, including for the server's trailing `[error: …]` line), with the same
requestId and the same cancel and supersede rules as the CLI providers.

**Translation.** The Log's `translationProvider` (`superTexthooker`; `'auto'` (default) |
`'deepl'` | `'kimochi'`) picks `cloud_translate` or `deepl_translate`; `auto` is Kimochi cloud
while signed in, otherwise the DeepL key.

**Deep link.** `tauri-plugin-deep-link` registers `kimochi://` (`plugins.deep-link` in
`tauri.conf.json`; installed by the bundles, registered at runtime by an AppImage or a debug
build on Windows and Linux). On Windows and Linux the single-instance plugin (feature
`deep-link`) forwards a second launch's URL to the running copy. `kimochi://account` brings the
main window forward on Settings → Account; any other `kimochi://` URL just brings it forward.

## Sync

The active account's profile kept the same on every computer signed in to it
(`src-tauri/src/sync.rs` runs it, `sync_core.rs` is the logic, `sync_log.rs` the log; it talks to
the Kimochi server's `/api/v1/sync/*` endpoints). Signed in means syncing; there is no switch. The Local
profile never syncs.

**When.** A cycle runs about 4 s after the last local change (at most 30 s after the first): the
Log calls `sync_local_changed` after it writes its files, and every settings write pokes it.
Also at start, when the main window gains focus (`reason: 'focus'`, at most every 15 s), on
`sync_now`, and every 60 s. Each cycle starts with `GET /api/v1/sync/status`; offline, it still
notes what changed (with the time) and logs going offline once, and `Back online` when it is.

**Records** (`collection`, `id` → JSON): `prefs` (one per settings leaf of the profile's synced
keys, path segments joined by `/`, JSON Pointer escaping), `sessions` (`<sid>`), `lines`
(`<sid>/<uid>`), `notebook` (`<sid>/<entryId>`, each image as `sha256` of a blob), `presets`
(name, secrets stripped), `anki` (`<sid>/<noteId>`: `{sid, card}`, the session's Anki card records, see "AnkiConnect"),
`stats` (`<deviceId>`: this computer's totals, pushed, never merged) and `conflicts`. A line's `uid` is random for new lines; lines written before uids get one derived
from session id, numeric id, time and text (FNV-1a 64, `l` + 16 hex digits, the same in Rust
and `store.ts`), written to the file the next time it is saved. A line deleted on purpose
(Delete, Clear, a fuller OCR reading replacing fragments) is remembered in `lines.json`'s
`deleted: [{uid, at}]` (the last 5000); a line the line limit trims is not a delete.

**State** (`<profile>/sync/state.json`): the server cursor and, per record, the `rev` and content
hash last agreed with the server, plus the clock stamp of each local change not yet accepted.
`<profile>/sync/conflicts.json` holds the conflict copies; `<profile>/sync/trash/` holds session
folders deleted by another computer for 30 days. The device id is `<AppData>/device-id`.

**Merging.** Only one side changed → that side. Both changed → the newer hybrid-logical-clock
stamp wins (ties by device id) and the other version is kept as a `conflicts` record, synced to
every computer, restorable or dismissible (`sync_conflict_resolve`). Lines merge field by field
(only a different `text` is a conflict). Anki card records merge without a conflict: the newer
record's fields, every enhancement either side noted and the earlier `addedAt`; a card missing from
`anki.json` is never a delete (only deleting its session is). An edit beats a concurrent delete. The first sync of a
record (no shadow): preferences and presets take the account's version; sessions and notebook
entries the one with the later `updatedAt`. Deleted sessions' lines and entries are deleted too.
Settings that are machine keys or secrets are never sent and are ignored if received.

**The Log's files.** The `log` window owns the profile's files while it runs. To merge into them
Sync emits `sync:hold` `{id}` to it; the Log (`host.ts`) finishes its queued work, writes what is
pending, pauses its writes and answers `sync_hold_ready({id})` (20 s timeout: the cycle is
retried later). Sync writes the files (each atomically), then emits `sync:release` `{id, changed:
{sessions, lines: [sid], notebook: [sid], anki: [sid], presets}}`, and the Log reloads what changed (the open
Log updates in place) and resumes. Preferences are applied to the live settings directly
(`settings:changed` per top-level key, with the same side effects as `settings_set`).

| Command | Signature |
| --- | --- |
| `sync_status` | `() -> SyncStatus` |
| `sync_now` | `() -> SyncStatus` — a cycle now |
| `sync_local_changed` | `({reason?: 'write' \| 'focus'}) -> ()` |
| `sync_hold_ready` | `({id}) -> ()` — the Log holds its writes for `sync:hold` `id` |
| `sync_conflict_resolve` | `({id, action: 'restore' \| 'dismiss'}) -> SyncStatus` — restore puts the kept version back as a new change (it then syncs and wins), dismiss drops it; both remove the conflict everywhere |
| `sync_export` | `({path}) -> number` — saves `GET /api/v1/sync/export` (a ZIP of every synced record as JSON plus the image blobs) to `path`; the byte count |
| `sync_log` | `() -> [{t, kind, text}]` — the sync log, oldest first |
| `sync_log_clear` | `() -> ()` — emits `sync-log-cleared` |

```ts
SyncStatus = {
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out',
  account: string | null,                 // the active profile key
  lastSyncAt: number | null, pending: number, origin: 'copied-local' | 'server' | 'empty' | null,
  lastError: string | null, used: number | null, limit: number | null,  // sync storage, bytes
  conflicts: [{id, collection, recordId, data, hlc, deviceId, winnerHlc, detectedAt}],
  deviceId: string
}
```

Events: `sync-status` (a `SyncStatus`), `sync-log` (one `{t, kind, text}` entry as it is added;
`kind`: `info`, `pull`, `push`, `merge`, `conflict`, `error`, `net`, `profile`), `sync-log-cleared`,
and to the `log` window `sync:hold` / `sync:release`.

**The sync log** keeps the last 2000 entries in memory and in `<AppLocalData>/sync-log.jsonl`
(compacted once it passes 2500 lines), each entry's text cut to 600 characters. It never contains a
token. The `sync-log` panel (`app/panel.html`, 760 × 520, centred; opened with `panel('sync-log',
'show')` from Settings → Account → Sync) shows it as monospaced lines with Copy all, Clear and
Sync now.

## Activity feed

| Command | Signature |
| --- | --- |
| `activity_post` | `({text, tone?, key?}) -> ()` — `tone`: `info` (default) \| `busy` \| `ok` \| `warn` \| `error` |

Broadcasts `activity` `{text, tone, key, at}` to every window, the poster included; `at` is
stamped natively (epoch ms) so all windows share one clock, and `text` is flattened to one line
of at most 300 characters. Native code posts through `activity::post` (model downloads, from
`model_store::install`). Nothing is stored: each window's feed (`ui/activity.ts`) lives in
memory for that window's lifetime, coalescing repeats and letting the next post with a `busy`
entry's key settle it. The Log shows it as the activity ticker; the overlay's scan pipeline
posts through `postActivity` in `ui/native.js`, with its wording in `ui/scan-activity.ts`.

## System, tray and lifecycle

| Command | Signature |
| --- | --- |
| `system_state` | `() -> {frontmostApp, displays}` |
| `app_quit` | `() -> ()` |
| `open_screen_capture_preferences` | `() -> ()` |
| `webview_scale_sync` | `(ratio) -> number \| null` |

**Webview scale (Windows).** Everything native on Windows takes one CSS pixel to be the window's
DPI scale (`GetDpiForWindow / 96`) in physical pixels: Tauri's logical sizes, the overlay's
desktop points, the mouse hook's press positions and `panel_pointer`. WebView2 can render at a
larger device scale factor than that (a reader on a 100 % display had every webview at
`devicePixelRatio` 1.5, its outer size shrunk too, so not page zoom), and every point native
handed a page then landed 1.5 times as far from the corner. The Windows `platform_prelude`
reports each top-level page's `devicePixelRatio` to `webview_scale_sync` on load and on every
change; native reads the page zoom WebView2 applies and sets the one that brings a CSS pixel
back to the DPI scale (`webview_scale.rs`), recording `webview-scale` `{window, ratio, dpiScale,
zoom, applied}` whenever it changes one. It returns the zoom in force (1 when nothing needed
changing), and `null` on other systems, where it does nothing. Pages on Hachidori's loopback
origin cannot reach it and keep WebView2's scale.

Emits `system-suspend` and `system-resume` from
`NSWorkspaceWillSleepNotification` / `NSWorkspaceDidWakeNotification` — the macOS
equivalent of Electron's `powerMonitor`, which Tauri does not wrap. Consumers should
tear down and re-establish capture state across a sleep exactly as Electron does.

Emits `frontmost-app` `{appName, pid}` once per change of frontmost *application*, from
`platform::observe_workspace`: `NSWorkspaceDidActivateApplicationNotification` on macOS,
an `EVENT_SYSTEM_FOREGROUND` WinEvent hook on Windows, and `_NET_ACTIVE_WINDOW` changes on
X11 (Wayland does not say which application is active, so nothing is emitted there). The
starting value is `snapshot().frontmostApp`. **The name is raw and
unfiltered on purpose.** Kimochi's own windows are not filtered out, because a consumer
needs to distinguish "Kimochi is frontmost" (where the previous foreign app should stay
the effective focus) from "no signal yet" (where text must be shown, never hidden).

The tray icon opens a native menu on either click: Open Kimochi, Mini Mode (checked while the
main window is mini; `tray::sync_mini` keeps it current), Settings… and Quit Kimochi. macOS draws
`resources/tray-template@2x.png` as a template (the icon's brackets and キ without the tile,
from `branding/tray-template.svg`); Windows and Linux show the full-colour `icons/32x32.png`.
There is no tray window and no tray command or event.

## Debug info

Settings → About → Debug info (`src-tauri/src/debug_report.rs`, `ui/debug-report.ts`).

| Command | Signature |
| --- | --- |
| `debug_report` | `() -> DebugReport` |
| `debug_bundle_save` | `(markdown: string) -> {saved, path?}` |
| `debug_verbose_set` | `(enabled?: bool) -> bool` (without `enabled`, whether it is on) |

`DebugReport` is `{generatedAt, app: {version, commit, build, tauri, webview}, os: {name,
version, arch, session}, hardware: {cpu, cores, memoryBytes, gpus}, displays, capture, ocr:
{selected, engines, models, cloudAccess}, observer, dictionary: {selected, downloads}, session:
{sourceKind, sourceFocus, autoOcr, scanning, status, overlayVisible, textOverlayVisible,
overlayThrottled, frontmostApp}, settings, windows: [{label, visible, minimized, focused, scale,
bounds}], input, verboseLogging, recentEvents}`, redacted: settings come from a fixed list of fields,
never the whole file; a key that names a secret (token, key, password, cookie, …) has its value
replaced, and every string loses bearer tokens, JWTs, URL query strings, `key=` values, e-mail
addresses, long opaque strings and the user's name in paths. `debug_bundle_save` asks where to
save, then writes a zip of `report.md` (the page's Markdown, redacted again), `report.json` and
the redacted last 512 KB of `evidence.jsonl`, `evidence.1.jsonl`, `auto-ocr-trace.jsonl`,
`auto-ocr-trace.1.jsonl` and `sync-log.jsonl`. `input` is Windows only (`null` elsewhere):
`{pointerDevices: [{type, product, maxContacts}], digitizer, maxTouches}`, the pens,
touchscreens and Windows Ink tablets that reach the webviews as pointers of their own.
`debug_verbose_set` lasts until the app quits, and each change emits `verbose-logging` (the new
`bool`) so open windows start or stop their own diagnostics. While on, window focus changes
(`window-focus`) and every scan (`scan`) are recorded too, and pointer diagnostics:
`pointer-trace` from each panel and from the overlay while its region editor is open
(`ui/pointer-diagnostics.js`: the window's geometry beside native's, pointer down/up/cancel,
moves at 5 a second per pointer, hover changes, and each region-editor gesture with the pointer
that drove it and the ones it ignored), and on Windows `pointer-press` for every press the mouse
hook delivers to the overlay (screen and local point, and whether it came from a mouse, a pen or
touch, or was injected). Elements are described by tag, classes, role and label, never their
text.
The shared `ocr_frame` path records `scan` phases `started`, `complete` and `failed`, with
engine, frame id, dimensions, elapsed milliseconds, annotation/line counts and backend where
available. It never includes pixels or recognized text. Debug capture status uses `capture.permission`;
the capabilities command retains `capture.authorization`.
`scan-failed` and `ocr-failed` are always recorded, with the engine and its error.
`ocr-empty` is always recorded when frame OCR returns zero annotations, with id, engine,
backend (when provided), width, height and elapsed ms; it contains no recognized text.

Every `evidence.jsonl` record carries `at` (Unix ms), and the file is rotated to
`evidence.1.jsonl` past 8 MB.

## Yomitan API setup

The Yomitan API engine (`popupType: 'custom-api'`) looks words up through the Yomitan in the
user's browser. Yomitan talks to Kimochi through a native-messaging **helper** (host name
`yomitan_api`) that the *browser* starts while Yomitan's "Enable Yomitan API" setting is on; the
helper serves HTTP on `127.0.0.1:19633` (an empty `customApiUrl` means that address). Installed
and reachable are separate facts and are reported separately: installed but not reachable
normally means the browser is closed, the setting is off, or the browser suspended the helper.

| Command | Signature |
| --- | --- |
| `yomitan_host_status` | `() -> HostStatus` |
| `yomitan_api_check` | `({url}) -> ApiStatus` |
| `install_yomitan_native_host` | `() -> string` (the installer's output) |
| `yomitan_probe` | `({baseUrl}) -> latencyMs` (the Log's reader: a `/tokenize` round trip) |
| `yomitan_tokenize`, `yomitan_ankifields` | the API pop-up's Shift-scan, in the Log and the overlay (`ui/scan-text.ts`), and its entries. `yomitan_ankifields({baseUrl, text, includeMedia?, maxEntries?})`: `maxEntries` (1–32, default 32) returns only the first entries. With media, Yomitan fetches every returned entry's audio, trying its audio sources in turn (online ones too), which takes seconds for a common word; the pop-up asks for the first entry's media alone (`maxEntries: 1`, tens of milliseconds) so its audio plays at once, and every entry's in the background |

`yomitan_host_status` only reads. It looks for `yomitan_api.json` in every browser's
`NativeMessagingHosts` folder (macOS `~/Library/Application Support/<Google/Chrome, Chromium,
BraveSoftware/Brave-Browser, Microsoft Edge, Vivaldi, Arc/User Data, Mozilla>`; Linux
`~/.config/<google-chrome, chromium, BraveSoftware/Brave-Browser, microsoft-edge, vivaldi>` and
`~/.mozilla/native-messaging-hosts`), and on Windows reads the default value of
`HKCU\Software\<Google\Chrome | Chromium | BraveSoftware\Brave-Browser | Microsoft\Edge | Vivaldi |
Mozilla>\NativeMessagingHosts\yomitan_api` (`reg query`) and reads the manifest it names.
`HostStatus` is `{os, installed, method, browsers: [{browser, browserName, manifestPath, hostPath,
method, hostExists, problem}]}`. `method` is classified from the program the manifest names:
`'official'` (yomidevs/yomitan-api: `yomitan_api.py`, or its `yomitan_api.bat` wrapper),
`'kimochi'` (the Go helper: `yomitan-host-*`, `go-yomitan-native-messaging-host`) or `'unknown'`;
it is null when the manifest cannot be read as a `yomitan_api` manifest. `installed` is true when
at least one registration's program exists, and the top-level `method` prefers Kimochi's, then
the official one.

`yomitan_api_check` POSTs `/serverVersion` (answered by the helper itself, 1.5 s timeout), then
`/yomitanVersion` (a round trip into the extension, 4 s): `ApiStatus` is `{url, server, yomitan,
yomitanVersion, latencyMs, error}`. Connection failures are answers, not errors; only an address
`validate_configured_api_url` refuses (`invalid:`) rejects. Not callable from `overlay`, like
`yomitan_request`. The setup wizard calls it every second while it is open (never overlapping),
Settings → Dictionary every five seconds.

`install_yomitan_native_host` is the only command that writes registrations, and only runs from
the wizard's Install button. It downloads the latest release asset `yomitan-host-<os>-<arch>` of
[hamstu/go-yomitan-native-messaging-host](https://github.com/hamstu/go-yomitan-native-messaging-host).
On macOS and Linux the binary's own `install` copies it into every browser's folder and writes the
manifests there; the download is then deleted. On Windows Kimochi keeps the binary at
`<app local data>/yomitan-host/yomitan-host.exe`, writes `yomitan_api.json` (Chromium
`allowed_origins`) and `yomitan_api_firefox.json` (Firefox `allowed_extensions`) beside it, and
sets each browser's `HKCU` key above with `reg add`.

## AnkiConnect

Kimochi's own AnkiConnect requests (the Yomitan API pop-up and its card builder) go to
`superTexthooker.ankiConnectUrl` (default `http://127.0.0.1:8765`, set in Settings → Anki), with the
optional `superTexthooker.ankiConnectKey` (AnkiConnect's `apiKey`; a private setting, never synced).
The dictionary extensions' go where their own Anki settings say, with their own key. All of them
leave from Rust
(`src-tauri/src/reader/ankiconnect.rs`) on AnkiConnect's classic endpoint (`/`, API version 6), so
they carry no Origin header and AnkiConnect's `webCorsOriginList` never applies.

| Command | Signature |
| --- | --- |
| `anki_probe`, `anki_deck_names`, `anki_model_names`, `anki_model_field_names`, `anki_find_notes`, `anki_gui_browse`, `anki_store_media_file`, `anki_add_note` | `({url, …})`: Kimochi's own calls (the Yomitan API pop-up's Add to Anki and its card builder). `url` is validated; the configured key is added. |
| `anki_connect_status` | `({url?, key?}) -> Status`: the connection check behind Settings → Anki; the configured address and key when omitted |
| `anki_connect_relay` | `({url, body}) -> {status, body}`: a dictionary extension's AnkiConnect request, to the `url` it asked for |

`anki_connect_status` asks `requestPermission` (no key needed; it reports whether AnkiConnect
wants one), then `version` with the key, and changes nothing. `Status` is tagged by `state`:
`connected {url, version, latencyMs, keyRequired}`, `keyRequired`, `keyRejected`,
`notRunning {suggestion}`, `timeout`, `notAnkiConnect {detail, suggestion}` (something else answers:
a wrong port), `blocked {status}` (HTTP 403), `invalidUrl {error}` or `error {message}`, each with
`url`. `suggestion` is the default address when the configured one fails and AnkiConnect answers
there.

`anki_connect_relay` exists because a webview request carries its page's Origin (`tauri://localhost`,
`http://tauri.localhost` on Windows, `hachidori://localhost`, …), plugin-http forwards it, and
AnkiConnect's default `webCorsOriginList` (`["http://localhost"]`) refuses it with HTTP 403.
`host/anki-relay.js` picks the extensions' AnkiConnect requests out of their remote `fetch` (Built-in
Yomitan's `hub.fetchRemote` in `host/network-entry.js`, the extension host's in `host/ext/network.js`):
a POST whose body is a JSON object with a string `action`, a numeric `version` and nothing but
`params` and `key` besides. Rust refuses any other body, validates `url` as it does the address in
Settings → Anki, and sends the body unchanged (the extension's API key in it), so the extension's
own Anki settings stay in charge. The extension windows may invoke it (`extensions::EXTENSION_WINDOW_COMMANDS`).
A card the relay adds may afterwards be given its line's audio (see "Sentence audio" below).

### The session's cards (the Anki tab)

Every card Kimochi sees added is recorded with the Log's open session (`sessions.json`'s
`activeId`), in `<profile>/sessions/<sid>/anki.json` (`{version: 1, cards: [AnkiCard]}`,
`src-tauri/src/anki_cards.rs`): Kimochi's own pop-up's through `anki_add_note` (which takes the
pop-up's `term` and `reading`), and a dictionary extension's through `anki_connect_relay` (an
`addNote` AnkiConnect accepted, whether or not sentence audio is on; its word is the field named
Expression, Word, Term, … or the note's shortest field, its reading a field named Reading or Kana).
When sentence audio fills a card's fields, its record notes which (`enhanced`). The record is only
a reference: nothing is read back from Anki, and Kimochi never edits or deletes the card. The
records sync with the session (the `anki` collection, see "Sync").

`AnkiCard` is `{noteId, term, reading?, deck?, addedAt, via: 'kimochi' | 'extension', engine,
enhanced: ('sentenceAudio' | 'wordAudio')[], deleted?, updatedAt}` (`deleted`: removed from the tab, kept so Sync
carries it; `merge` keeps it whichever side wins); `engine` is `yomitan-api` for the pop-up's
cards, else the selected engine (`yomitan`, `hachidori`, …). Times are Unix ms.

| Command | Signature |
| --- | --- |
| `anki_add_note` | also takes `term?` and `reading?`: the card's word, for its record (else read from the fields) |
| `anki_cards_list` | `({sessionId}) -> AnkiCard[]`: the cards recorded in that session of the profile in use, oldest first (deleted ones left out) |
| `anki_cards_delete` | `({sessionId, noteId, fromAnki})`: marks the card `deleted` in that session (kept so Sync carries it, never listed again) and announces it; with `fromAnki`, first deletes the note from Anki (`deleteNotes` through Kimochi's AnkiConnect), and if Anki refuses, nothing changes |

| Event | Payload |
| --- | --- |
| `anki-cards:changed` | `{sessionId, card: AnkiCard}`: a card was recorded, given audio, or deleted (`deleted: true`) |

## Sentence audio

While `sentenceAudio.enabled` is on, Kimochi keeps the last `sentenceAudio.seconds` (10–120,
default 30) of what the computer plays in memory, gives each Log line the clip of its voice, and
gives each new card the audio of the line it was mined from (`src-tauri/src/sentence_audio/`, with
the listener in `speech-core/`). `sentenceAudio` is a machine key: never synced, shared by every
profile. Its other fields: `field` (the note field the line's audio goes in, default
`SentenceAudio`), `wordField` (the note field the mined word's audio goes in; empty, the default,
for none), `clips` (line clips kept on disk, 5–100, default 15), `startOffsetMs` and `endOffsetMs`
(−5000–5000, moving every clip's ends), `trim` (cut a clip placed by timing to its speech, default
on).

| Command | Signature |
| --- | --- |
| `sentence_audio_status` | `() -> Status`: the recording's state, for Settings → Anki |
| `sentence_audio_line` | `({uid, text, ts, source, scan})`: the Log added a line (or changed one's text, same `uid`); `ts` its arrival in Unix ms, `source` its `LineSource`, `scan` the OCR scan it was read in or null (a scan's lines are decided together: blocks said apart each get their own voice, parts of one box share it, and a block that looks like a name box needs a strong match of its own). Ignored while recording is off. |
| `sentence_audio_forget` | `({uids})`: the Log deleted these lines, or a fuller reading of the same text replaced them; their kept clips are removed and their voice is free for other lines again |
| `sentence_audio_debug` | `() -> {status: Status, clips, listener}`: for Diagnostics → Sentence audio. `listener` (null until recording starts) is `{heardUntil, transcribedUntil, speaking, speechDetection, recogniser, lines, heard}`: the newest 40 lines, newest first, each `{uid, text, ts, appeared, scan, outcome (waiting, voiced, silent, missed), how, score, heard, clip: [from, to], provisional, window: [from, to], decidedAt, changes, note}` (`note`: why it was decided as it was), and what the recogniser heard in the last minute, `{startMs, endMs, text}` |
| `sentence_audio_lines` | `() -> LineAudio[]`: what is known about recent lines' audio (the decided ones, and every kept clip), for the Log |
| `sentence_audio_clip` | `({uid}) -> string \| null`: line `uid`'s clip as base64 MP3, or null when none is kept |
| `sentence_audio_attach` | `({url, noteId, sentence, field, word, wordField, reading})`: the Yomitan API pop-up added note `noteId` at `url` (with the configured key) from `sentence` for `word`; its audio follows in the background into `field` (or `sentenceAudio.field` when null), and the word's into `wordField` (or `sentenceAudio.wordField`), looked for by `word`, then `reading`. Runs whenever sentence audio is on, recording or not: the line is the best match among the lines heard and the clips kept |
| `sentence_audio_add_to_note` | `({noteId}) -> ()`: the Anki tab's Add sentence audio: reads the note back through Kimochi's AnkiConnect and puts its line's kept clip in its empty sentence-audio field (and the word's in the word-audio field); errors say why not |

| Event | Payload |
| --- | --- |
| `sentence-audio-line` | `LineAudio`: the listener decided (or decided again) a line's audio. A line matched by its words keeps its clip (a later decision only ever brings a better match), and a line without one is tried again for 40 s as more speech is transcribed. |

`LineAudio` is `{uid, state, durationMs?, how?, message?}`: `state` `voiced` (a clip, `durationMs`
long, found by its words, `how: "matched"`, or by timing, `"timed"`), `silent` (no voice was
detected near the line) or `missed` (its audio was no longer held; `message` says why).

`Status` is tagged by `state`: `off`, `needsModel` (on, waiting for the speech model, whose
download turning it on starts: nothing is recorded without it), `starting`, `recording {source, excludesOwnAudio}` (what is
recorded, and whether Kimochi's own sounds are left out), `noPermission {message}` (macOS: Screen
Recording not granted), `unavailable {message}` (this computer cannot record its audio now: no
PipeWire, no output device; retried every 30 s), `unsupported {message}` (no backend on this OS) or
`error {message}` (retried every 5 s), each with `platform` (`macos`, `windows`, `linux`), `held`
(seconds of audio held), `level` (0–1, the last half second), `recogniser` (the speech model in the
listener, tagged by `state`: `absent`, `loading`, `ready` or `failed {message}`) and `last`
(`{at, ok, message}`: what happened to the last card's audio, or null).

Where the audio comes from (`capture-core/src/audio/`): macOS, a ScreenCaptureKit display stream with
`capturesAudio` and `excludesCurrentProcessAudio`; Windows, WASAPI process loopback of everything
but Kimochi's process tree (WebView2 included; Windows 10 2004+), else loopback of the default
output (Kimochi's sounds included), restarted when the default output changes; Linux, a PipeWire
capture stream on the default output's monitor (`stream.capture.sink`; Kimochi's sounds included).

The listener (`speech-core/src/listener.rs`) follows its own copy of the recording, ten times a
second. Speech is Silero VAD's, helped by loudness against the background (Silero misses
drawn-out exclamations and gasps under music). With the speech model downloaded (the model store's
`sensevoice` engine, below), the recording is transcribed in chunks that end in pauses, each once.
A line is decided once its voice must be over (the next line has arrived and the speech before it
has been heard, or a quiet spell for the newest line, which is decided again when the next arrives):

- its window runs from 1 s before its anchor (never before the previous line's) to 300 ms after the
  next line's anchor. The anchor is when the line arrived, or for an OCR'd line when automatic
  OCR's quick readings (`capture_frame` with `observe`) first showed its text drawing in. An OCR'd
  line not seen drawing in is looked for up to 20 s back.
- matched: its text, folded (katakana as hiragana; punctuation, long-vowel marks, small vowels and
  small tsu dropped), is found in what was heard by local alignment, at half its characters (or a
  third and five characters, or its first three in a row). The clip is that speech, widened to the
  speech and loud bursts around it that are the line's own; every character gets a time, which is
  how a word's audio is cut out of it.
- otherwise timed: the speech near the anchor (leading speech that ends before the line arrived is
  the previous line's). An OCR'd line not seen drawing in is only timed without the model.
- no speech at all: `silent`.

A voiced line's clip is padded 150 ms before and 300 ms after, moved by the offsets, kept at
the loudness it was recorded at (as the game played it), faded over 50 ms and encoded as mono MP3 at 96 kbit/s into
`<app local data>/sentence-audio/` (the newest `clips` kept, with `clips.json`).

A card's audio: its line is the newest Log line whose text best matches the card's sentence (the
pop-up's) or any of its fields (an extension's), else the newest line. The card waits (up to 15 s
after the line arrived) for the line to be decided, then takes its clip. A word-audio field gets
the mined word (the pop-up's term; for an extension's card, a field named Expression, Word, Term,
… or its shortest field found in the line) cut from a matched clip, 80 ms before and 150 ms after.
Then `notesInfo`, `storeMediaFile` (`kimochi_<ms>.mp3`, `kimochi_<ms>_word.mp3`) and
`updateNoteFields` put `[sound:…]` in the fields, but only those the note has and that are empty.
An extension's card is noticed by `anki_connect_relay` (an `addNote` AnkiConnect accepted); its
follow-up calls use the address and key of the extension's request. Neither the extension's
request nor its reply changes.

## Screenshots

Each new OCR scan (`history_add`, not skipped) captures its source again, whole (its own frame is
cut to the OCR crop area), and keeps it as JPEG (longest edge 1920) in
`<app local data>/screenshots/`, indexed by `shots.json`, the newest `cardScreenshot.kept` (10–500,
default 50) (`src-tauri/src/screenshots.rs`). A Quick Shot's source is its display. Each Log line
finds its scan's screenshot by `ocr.scanId` (or, for a scan read as one text, its ingest id).
Setting `cardScreenshot`: `{enabled (default on), field (default Picture), kept}`;
`screenshotAnnotations` (default on) is the viewer's eye.

The `capture:` protocol serves `shot/<scan>` (the kept JPEG) and `shot/<scan>/card` (a card's
picture: the source's Anki crop area, from `ankiCropRegions`, when it has one; longest edge 1280).
`capture_frame_source` (Hachidori's `tabs.captureVisibleTab`) answers with `shot/<scan>/card` while
the scan's screenshot is kept (the newest one without a scan), `id` 0, before falling back to the
image store's frames.

A card gets the screenshot of the kept scan whose text matches its fields best (newest on a tie),
in its empty picture field (`storeMediaFile`, then `updateNoteFields` with `<img>`), marked
`screenshot` in the Anki tab: after a relayed `addNote` while `cardScreenshot.enabled` is on, and
through the commands below.

| Command | Signature |
| --- | --- |
| `screenshots_list` | `() -> Shot[]`: every kept screenshot, oldest first: `{scan, url, at, width, height, text, crop: [x, y, w, h] \| null, marks: [{text, bbox: [x0, y0, x1, y1], vertical}], key}`, in the picture's pixels; `crop` is the OCR crop area, `key` the source's crop key (null for a Quick Shot) |
| `screenshot_status` | `() -> {kept, last: {at, ok, message} \| null}`: how the last card's screenshot went, for Settings |
| `screenshot_attach` | `({url, noteId, sentence, scan, field})`: the Yomitan API pop-up added note `noteId` at `url`; the screenshot of `scan` (or the scan matching `sentence`) follows into `field` (or `cardScreenshot.field`). Ignored while off |
| `screenshot_add_to_note` | `({noteId}) -> ()`: the Anki tab's Add screenshot: reads the note back through Kimochi's AnkiConnect and puts its scan's screenshot in its empty picture field; errors say why not |

| Event | Payload |
| --- | --- |
| `screenshot-added` | `Shot`: a scan's screenshot was kept |

## Dictionary engine downloads

Yomitan, Hachidori and 10ten are not bundled. Each is pinned to one upstream GitHub release by
`extensions/<id>.source.json` (version, tag, commit, asset URL, SHA-256, size) and
`extensions/<id>.sha256.json` (every file of the unpacked release and its SHA-256), both
compiled in, beside `extensions/<id>.previous.json` (the last few pins' maps, newest first,
written by `scripts/sync-extension.mjs` when the version moves; see "Updates" below).
Implementation: `src-tauri/src/extension_store.rs`.

`engine` is `"yomitan"`, `"hachidori"` or `"tenten"`. Every command answers with the engine's
`ExtensionStatus` after acting:

| Command | Signature |
| --- | --- |
| `extension_status` | `({engine}) -> ExtensionStatus` |
| `extension_download_start` | `({engine}) -> ExtensionStatus` — no-op while downloading or ready |
| `extension_download_pause` | `({engine}) -> ExtensionStatus` — keeps the `.part` |
| `extension_download_resume` | `({engine}) -> ExtensionStatus` — continues from the `.part` (HTTP Range) |
| `extension_download_retry` | `({engine}) -> ExtensionStatus` — after `failed`; also resumes |
| `extension_download_cancel` | `({engine}) -> ExtensionStatus` — stops and removes what was fetched; leaves a ready engine alone, and an update's earlier release |
| `extension_delete` | `({engine}) -> ExtensionStatus` — removes the downloaded engine, an earlier release and its update; refused (`invalid:`) for the engine the setting names |

```ts
ExtensionStatus = {
  engine, name, version,             // "tenten", "10ten Japanese Reader", "1.28.0"
  state: 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying' | 'ready',
  source: 'downloaded' | 'development' | null,  // where a ready engine is served from
  file,                              // "<version>.zip" while downloading or verifying it; "unpacking"
  receivedBytes, totalBytes, overallReceived, overallTotal,  // bytes of the zip
  message,                           // why it failed
  update: ExtensionUpdate | null     // while an earlier release is in use (state is then 'ready')
}
ExtensionUpdate = {                  // the pinned release (`version`) downloading in the background
  from,                              // the release in use until then, "26.8.24.0"
  state: 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying',  // absent: not started
  file, receivedBytes, totalBytes, overallReceived, overallTotal, message,
  retryAt                            // Unix seconds of the next automatic try, after a failure
}
```

The download commands act on an update the same way (`start`/`resume`/`retry` run it, `pause`
holds it); the UI offers no Cancel for one.

Emits `extension-download` with an `ExtensionStatus` on every state change and about four
times a second while bytes arrive, and posts to the activity feed ("Downloading Yomitan… 40%",
"Yomitan ready", "Yomitan download failed: …", key `extension:<id>`). An update posts only for
the engine the setting names ("Updating Yomitan to 26.10.22.0… 40%", "Yomitan update failed: ….
Still using 26.8.24.0; trying again later", "Yomitan updated to 26.10.22.0"); the others update
quietly.

**Store.** `<app local data>/extensions/<id>/`: the zip is downloaded as
`<version>.zip.part` with the OCR models' transfer (resume by Range, restart on 416 or an
ignored Range, Content-Length and size checks, SHA-256), renamed to `<version>.zip`, then
unpacked into `.staging-<version>-…` by a port of `scripts/sync-extension.mjs`'s reader
(stored and deflate only; ZIP64, encryption, symlinks, absolute paths, drive letters,
backslashes and `..` refused; size and CRC checked). Every file is hashed as it is written and
the set must equal the pinned map exactly (nothing missing, changed or added); then the
staging tree is renamed to `<version>/` (retried on Windows while an antivirus holds a file)
and `installed.json` records it. The `<version>/` directory is the commit point. Other
versions, stray parts and staging directories are removed after an install and at start-up,
except an earlier release still in use (below), and the one a switch just left, which goes at the
next start-up.
Removing an engine removes its program files only: its dictionaries (the WebView's storage for
its origin, and `chrome-local-<id>.json` or Yomitan's `chrome-local.json`) are kept.

**Serving.** Only paths in the pinned map are answered (`hachidori://`, `tenten://` and, at
the app origin root, Yomitan's paths through the app's asset provider), from the installed
tree; under `tauri dev` only, the developer cache `extensions/<id>/` is used when nothing is
installed (unless `KIMOCHI_EXTENSIONS_NO_DEV_TREE` is set). No component of the path may be a
link, and each file is hashed against the map the first time it is served in a session
(`{check: 'extension-file-refused', engine, file, reason}` when not).

**When the windows move.** Settings → Dictionary and onboarding download first and switch
(`dictionary_engine_apply`) only once the engine is ready. A download finishing, or an engine
being removed, that changes the effective engine (the engine the setting already names became
usable, or the one in use went away) makes native write the mirror and reload the windows once
(`{check: 'dictionary-engine-follow', from, engine}`). At launch, when setup is complete and
the selected engine is not usable (an app update moved its pin, or the build the user upgraded
from bundled it), its download starts on its own (`dictionary-engine-startup`): the user
already chose it, and their dictionaries are untouched. A first run chooses in onboarding.

**Updates.** An app update that moves an engine's pin does not take the engine away. When the
user's download is one of the releases in `<id>.previous.json`, its tree is kept and served,
checked against that compiled-in map, while the new release downloads in the background; the
status says `ready` with `update` set. Each session serves one release per engine: the new tree
being renamed into place does not change what a window gets. When the new release is verified
the session moves to it (`{check: 'extension-update-switched', engine, from, to}`), and the
windows running that engine reload onto it (`{check: 'dictionary-engine-updated', engine,
effective, applied}`); their dictionaries and settings are in the origin's storage and stay.

Only engines the user downloaded and kept are updated (an earlier release's tree, or an
`installed.json` naming another version: a release too old to be in `previous.json` is
removed at start-up and downloaded anew). The engine the setting names goes first; the others
follow one at a time, quietly. `<app local data>/extensions/updates.json` records
`{<id>: {pin, failures}}`: an update fires once per app update, when the pin differs from the
recorded one (`{check: 'extension-update-planned', engine, from, to, new}`); a later launch with
the same pin carries an unfinished one on (from its `.part`, after a quit or while offline). A
failure is tried again after 1, 5, 15, then 30 minutes; after 5 failures in all it waits for the
user (Update or Retry in Settings → Dictionary). The earlier release stays in use throughout.
Removing the engine drops its record.

## OCR model downloads

The local engines' models (and sentence audio's speech model) are not bundled; only the ONNX
Runtime libraries are. They are
downloaded on demand into `<app local data>/models/<engine>/` (`app_local_data_dir`: the app
data directory on macOS and Linux, `%LOCALAPPDATA%` rather than the roaming profile on
Windows) from the pinned list in `src-tauri/ocr-models.json` (repository, revision, URL,
SHA-256 and size per file). Implementation: `src-tauri/src/model_store.rs`.

`engine` is `"meikiocr"`, `"mangaocr"`, `"ppocr"` (PaddleOCR) or `"sensevoice"` (SenseVoice-Small, sentence audio's
speech recogniser; never an `ocrMode`). Every command answers with the engine's
`ModelStatus` after acting:

| Command | Signature |
| --- | --- |
| `model_status` | `({engine}) -> ModelStatus` |
| `model_download_start` | `({engine}) -> ModelStatus` — no-op while downloading or ready |
| `model_download_pause` | `({engine}) -> ModelStatus` — keeps the `.part` files |
| `model_download_resume` | `({engine}) -> ModelStatus` — continues from the `.part` files (HTTP Range) |
| `model_download_retry` | `({engine}) -> ModelStatus` — after `failed`; also resumes |
| `model_download_cancel` | `({engine}) -> ModelStatus` — stops and removes everything downloaded; leaves a ready engine alone |
| `model_delete` | `({engine}) -> ModelStatus` — unloads the engine and removes its downloaded models |

```ts
ModelStatus = {
  engine, name,                      // "meikiocr", "MeikiOCR"
  state: 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying' | 'ready',
  source: 'downloaded' | 'bundled' | 'development' | null,  // where ready models live
  file, receivedBytes, totalBytes,   // the file in progress (downloading / verifying)
  overallReceived, overallTotal,     // bytes across every file of the engine
  message                            // why it failed
}
```

Emits `model-download` with a `ModelStatus` on every state change and about four times a
second while bytes arrive, and re-emits `platform-capabilities` on every state change (and
about once a second during a download) so the gate's reason stays current.

**Behaviour.** Each file is written as `<name>.part`, its size and SHA-256 are checked, and
only then is it renamed into place, so a final path never holds a partial file;
`verified.json` beside the files records what was verified. A checksum mismatch discards
that file's `.part` and fails; a dropped connection fails and keeps it, so Retry resumes. A
server that ignores the Range header restarts that file. Downloads run on their own thread,
outlive every panel, and are paused (not discarded) on quit; the next launch reports
`paused`. Setting `ocrMode` (`settings_set`) to a local engine whose models are `absent`
starts the download; a `paused` or `failed` one waits for Resume or Retry. The pickers (the
sidebar and the engine list in Settings → OCR & Overlay, both through `frontend/bridge/useEngineSelection.ts`) ask first
when the picked engine is `absent` ("Download Manga OCR?", with the size) and save `ocrMode`
only on Download; Cancel leaves it unchanged. Nothing starts at launch: an engine selected
before its models were downloaded (an upgrade from a build that bundled them) reports
`absent`, and that engine's panel in Settings → OCR & Overlay offers "Download (539 MB)". Auto OCR
never starts a download either: it watches with an engine that is already here (`ui/watcher.ts`),
and with none, compares pictures instead.

**Resolution order** for an engine's models: the downloaded store when complete and
verified, then `<resources>/<engine>/models` (a build that still bundles them), then
`src-tauri/resources/<engine>/models` (development). Bundled and development copies make the
status `ready` with that `source`; they cannot be deleted from the app.

**Gating.** While an engine's models are not usable, `platform_capabilities` reports it
`available: false` with a human `reason` — `Model not downloaded`, `Downloading model… 32%`,
`Verifying model…`, `Model download paused`, `Model download failed: <message>` — and adds
`model: <state>` so pickers keep the engine selectable, listed by name alone. Every scan
path refuses with the same reason: `ocr_frame` and `scan` fail with
`"<Engine> is not ready: <reason>"`, and the observer as above. Switching to an engine whose
models are ready scans at once.

## App updates

Kimochi updates itself from the project's GitHub Releases through `tauri-plugin-updater`
(`src-tauri/src/updater.rs`). The endpoint, `plugins.updater.endpoints` in `tauri.conf.json`, is
the *latest* release's `latest.json`, which GitHub resolves to the newest published,
non-prerelease release: the rolling `nightly` pre-release and the draft a `v*` tag creates are
never offered, so only a release someone published by hand is. CI signs each platform's bundle
with the minisign key whose public half is `plugins.updater.pubkey`, and composes `latest.json`
(`scripts/updater-artifacts.mjs`, the `manifest` job in `ci.yml`); the app verifies the
signature before anything is installed. The user starts every download and every restart.

Every command answers with the `UpdateStatus` after acting:

| Command | Signature |
| --- | --- |
| `update_status` | `() -> UpdateStatus` |
| `update_check` | `() -> UpdateStatus` — the user's own check; its failure is shown. Returns `checking` at once; the result follows on the event. No-op while downloading, ready or installing |
| `update_download` | `() -> UpdateStatus` — from `available` (or a failed download); no-op while downloading or once ready |
| `update_cancel` | `() -> UpdateStatus` — stops a download; the offer stays |
| `update_install` | `() -> UpdateStatus` — from `ready`: swaps the bundle in and restarts. Replies `installing`; the process is replaced when the swap is done (on Windows the installer relaunches the app) |
| `update_retry` | `() -> UpdateStatus` — the failed step again: the download, the install (without a new download), or the check |
| `update_dismiss` | `() -> UpdateStatus` — "Not now": hides the sidebar notice for this run (Settings still shows it); a download, or a different version, brings it back |
| `changelog` | `() -> string` — `CHANGELOG.md` as built into this binary, for What's new (not an `UpdateStatus`) |

```ts
UpdateStatus = {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed',
  currentVersion,                    // the running build
  version, notes, date, size,        // the offered release (available and later); size when the manifest names it
  receivedBytes, totalBytes,         // the download in progress
  message, stage,                    // why it failed, at which step: 'check' | 'download' | 'install'
  checkedAt,                         // the last successful check, ms since the epoch
  dismissed,                         // "Not now" was pressed for this offer
  automatic                          // whether this build checks on its own
}
```

Emits `update-status` with an `UpdateStatus` on every state change and about four times a
second while bytes arrive. Posts "Kimochi 0.2.0 is available" / "… is ready to install" on the
activity feed (key `update`).

**Behaviour.** A bundle checks on its own twenty seconds after launch and every six hours;
a failed automatic check goes to `evidence.jsonl` (`update-check`) and leaves the status alone
(`idle` before any successful check, `none` after one), so a laptop that is offline never nags.
A `tauri dev` binary (`debug_assertions`) does not check on its own (there is no `.app` or
AppImage to replace) and says so in Settings; `KIMOCHI_UPDATE_ENDPOINT` replaces the endpoint and
turns automatic checks on, for testing against a local manifest. The download is held in memory until the user restarts; quitting discards it. On
Windows the NSIS installer runs passively (`plugins.updater.windows.installMode`) and relaunches
the app; on Linux an AppImage is replaced in place and a `.deb` goes through `pkexec dpkg -i`
(`latest.json` carries a `linux-<arch>-deb` entry beside `linux-<arch>`; the plugin picks by
the installed bundle type). Before the process is replaced the platform's own threads are
stopped exactly as `app_quit` does.

**What's new.** `changelog` returns the embedded `CHANGELOG.md` (Keep a Changelog); the panels
parse it (`ui/changelog.ts`) and show the released versions newest first in a dialog over the
main window (`frontend/main/WhatsNewDialog.tsx`), marking the running one. While the changelog
has no released section yet, the Unreleased section is shown under the running version, so the
dialog is never empty. Settings → About → Updates → What's new opens it; while an update is
offered (`version` set; `available`, `downloading`, `ready` or `failed`) the offered release's
`notes` from the manifest come first, as "Coming in Kimochi x.y.z". The main window also opens it
once on the first launch of a new version: the `lastSeenVersion` setting holds the version last
announced; when it is unset (a fresh install, or the first build that has the setting) it is
set silently, and when it differs from `currentVersion` the dialog opens and the setting is
updated.

## Capabilities

`capabilities/core.json` grants `core:event:default` plus a few read-only window
queries (`is-visible`, `is-focused`, `is-minimized`, `scale-factor`) to our own window
labels. Without `core:event:default` a React panel's `event.listen` would build fine and
fail silently at runtime.

`capabilities/network.json` scopes `http:default` to `overlay`, `log`, `settings`,
`dictionary` and `popup-host` — `dictionary` because dictionary downloads from the
dictionary settings window go through the same plugin —
allowing only the local Yomitan API (`19633`), plus the dictionary hosts the engines
download from (GitHub for Yomitan and Hachidori, `api.jiten.moe`, `data.10ten.life`, `jitendex.org`, and
`huggingface.co`, where Yomitan's recommended dictionaries for languages other than Japanese live). It is deliberately not a general internet grant.
AnkiConnect is not in it: plugin-http sends the webview's Origin, which AnkiConnect's default
`webCorsOriginList` refuses with HTTP 403, so every AnkiConnect request comes from Rust (the
`anki_*` commands at the address in Settings → Anki, and `anki_connect_relay` for the dictionary
extensions at the address in their own settings). Kimochi's own server (cloud OCR,
text to speech, translation, explanations, accounts and backup) is deliberately absent: it takes
an account token, so only Rust calls it. Google Lens
(`ocrMode: 'googlelens'`) needs nothing here either: `ocr_frame` posts the frame to
`lensfrontend-pa.googleapis.com` from Rust (`src-tauri/src/google_lens.rs`), never from a webview.

## Platform gaps

Real limitations, recorded rather than papered over.

- **macOS only.** Capture, overlay geometry, icons, cursors, power and window tracking
  are all macOS 14+ implementations. No cross-platform capture
  behaviour is claimed or implemented; Windows and Linux need separate backends.
- **Panels on a captured display.** Own-process exclusion covers Kimochi's windows in
  display captures; it has not been observed at runtime.
- **Inactive-window hover** is handled for panel button affordances through the native
  pointer hit test. It does not make arbitrary webview hover work in background windows.
- **Transparent windows** use Tauri's macOS private API feature, which is unsuitable for
  a Mac App Store claim.

## Optional Hyprland window geometry (Linux only)

`linux_window_geometry({operation, sourceId, windowAddress?}) -> Value` operates on
the current portal window share. `status` reports availability/link state;
`candidates` lists native Wayland clients matching the real captured frame size;
`link` explicitly associates the selected candidate for this app/share lifetime.
`pointer` returns optional read-only compositor `{x,y}` coordinates without
capturing a frame or claiming knowledge of buttons/modifiers. The Hyprland layer
uses these to recover missed leave events and clear stale hover/reading holds.
Unique matches are automatic; ambiguous matches use the source panel's
**Relink window overlay…** dialog. Capture permission still comes from the portal.
Only Hyprland with native layer-shell and one unrotated output at (0,0) is enabled.
Missing/unsupported geometry retains the source-image crop fallback and does not
place annotations at an invented origin. See `platform/linux/DEPS.md` for limits.

## Optional GNOME Shell overlay (Linux only)

`gnome_overlay({operation, payload}) -> Value` supports status/install/update, annotation
present/clear/highlight, own-window placement, crop, window tracking, controller and shortcuts.
The optional GNOME46 Wayland extension provides the compositor geometry and non-activating
placement unavailable through standard Wayland. It supports a screen or a linked portal window
on one monitor; window streams are never placed at guessed desktop coordinates.

When status advertises `sharedOverlay`, `surface` with `{operation:"open",sourceKind,sourceId}`
leases the calling app's already-created annotation WebView after a validated `present`.
It returns the mapped surface rectangle (the requested monitor before first map), which native
uses for size/origin. Pointer samples and native input shapes use that same actual origin,
including compositor panel/dock constraints; source capture bounds remain independent.
Placement is requested once per surface/monitor allocation, rather than repeatedly fighting
Mutter's constraints. Shell verifies the owner
and PID, controls stacking and visibility, and emits bounded `Pointer` samples to the shared
DOM renderer/scanner. GTK refuses keyboard focus and applies only the renderer's word input
regions. The original floating dictionary host owns its own popup input and focus.
`{operation:"close"}` releases the surface. Missing heartbeats, source changes/closure, owner
loss, lock and extension disable hide it; capture suspension hides the WebView along with the
other annotation surfaces. Native layer-shell and X11 retain the same existing renderer.

With `windowPolicy`, the GNOME46 adapter removes only the validated passive annotation
surface from Shell app/window lists and overview previews. Its per-window property and
per-app list filters are restored on unmanagement or extension disable; the ordinary
reader remains selectable. No Shell/dock files, modal state or global prototypes change.
Filtering never synthesizes native `skip-taskbar` notifications or application
`windows-changed` signals: GNOME46 counts native property transitions, and a notification
without a real native transition corrupts its application window accounting.
`own-window` also accepts `{label,pinned:boolean}` for ordinary Kimochi panels; native
pin/unpin and inspection use Mutter's actual above state. Saved pins are restored after
startup and extension updates, and owner loss releases the bridge's pin requests.
`present.textRects` supplies up to 2000 mapped text rectangles, independently of the
controller's bounded word metadata. The source remains visible with Kimochi focused
unless one of its ordinary windows intersects a text rectangle (including its 8-point
margin). Coverage geometry survives hiding so it cannot trigger a hide/show cycle.

Legacy `gnome-overlay-lookup` still serves controller navigation and older annotation adapters.
The versioned extension loader reloads implementation updates without logout; initial discovery
or a loader change may require login. Installation never logs out the user automatically.
Loader imports carry an enable-generation token, so disabling or superseding an update
cancels stale imports before they can create another implementation. A recognized loader
upgrade preserves a hash-named backup and reports `needsLogin:true` even if the old loader
is still serving the previous implementation.

## Gaming Mode sources

In Gaming Mode, when Gamescope's PipeWire node is present, capture uses it directly instead of the
portal (`capabilities.session.captureBackend: "gamescope-pipewire"`, `capture.pickerRequired:
false`, `sources.catalog`/`thumbnails`/`icons: true`). `source_catalog` lists
`gamescope:window:{appid}:{pid}` for each running game or app (Gamescope's
`GAMESCOPE_FOCUSABLE_APPS`, without Steam's client and Kimochi), named as Steam's library names it
(`appmanifest_<appid>.acf`, or the non-Steam shortcut), and `gamescope:display:0` ("Screen",
whatever is in front). `source_icon` returns Steam's cached icon for those names. Capturing an app
asks Gamescope to compose only that app (its `focus_appid` format property), so a game is read even
while Kimochi is in front; the one stream switches apps on demand. While another client (Steam's
game recording) reads the node, capturing an app other than the streamed one fails with `busy`.
`activate_source` on an app switches Gamescope to it and hands input back to Steam; on the screen
it is `return_to_game`. At launch the saved source is restored if that app is running, else the
game being played, else the screen.

## Dictionary setup relay

The overlay's one Yomitan backend serves app-owned `__setupDictionaries` relay
requests: `catalog`, `start({dictionaryId})`, `status({id})`, and `practice`.
`active` returns the running job or null without querying the dictionary database. Engine
selection waits on this job before saving a different engine or reloading its host. A newer
choice supersedes the waiting choice; leaving the chooser cancels its pending switch.
`catalog` returns the recommended dictionaries and the installed ones, each marked `enabled`
when the current profile looks words up with it, and `job`: the latest job (running, failed or
complete) or null, so a guide step that was left, hidden or reloaded resumes its progress.
`start` returns a job ID immediately; download/import outlives the requesting panel,
then verifies import success/counts and enables the dictionary through granular
profile updates. Jobs live for the app process, not across crashes/restarts.

## Steam library (Linux)

`src-tauri/src/steam_library.rs`. Both commands are registered on every platform; outside Linux
they answer `supported: false` / `state: "unsupported"`.

`steam_library_status() -> SteamLibraryStatus`:
`{supported, steamDeck, steamOs, steamInstalled, steamRunning, gamingMode, added, appId, artwork, launcher, reason}`.
`steamDeck` is DMI `board_vendor` Valve with `product_name` Jupiter or Galileo; `steamOs` is
os-release `ID=steamos`. `steamInstalled` means a Steam root (`~/.local/share/Steam`,
`~/.steam/steam`, or the Flatpak's) exists; `steamRunning` that a `steam` process of this user does.
`gamingMode` is gamescope. `added`/`appId` come from a read-only parse of the signed-in user's
binary `userdata/<id>/config/shortcuts.vdf` (the user `config/loginusers.vdf` marks `MostRecent`, or
the only one): an entry whose Exe, LaunchOptions or ShortcutPath names the gaming-mode launcher
(`kimochi/gaming-mode/launch.sh`), `applications/kimochi-gaming-mode.desktop` or this executable.
`artwork`: all four grid images exist for that app ID. `launcher`: `$XDG_DATA_HOME/kimochi/gaming-mode/current`
points at this executable (`$APPIMAGE`, else the binary) with the embedded scripts.

`steam_library_add() -> {state, message, appId, status}`, `state` one of `added`, `pending`,
`steamNotRunning`, `failed`, `unsupported`; `status` is the status afterwards. Runs off the main
thread, one at a time. It (1) refreshes the launcher bundle when it is not current by running the
embedded `scripts/steam-deck/install-gaming-mode.sh --link <executable>` (a new `releases/<id>`
holding a symlink, `current` swapped atomically, `launch.sh` unchanged, earlier releases kept,
`kimochi-gaming-mode.desktop` with `Name=Kimochi`, `dev.kimochi.app.desktop` only when absent);
(2) if the entry already exists, only fills in missing art (no duplicate entry); (3) if Steam is
not running, returns `steamNotRunning` (the launcher stays installed for the manual route);
(4) asks the running client to add the desktop file: `steamos-add-to-steam <desktop>` when on
`PATH`, else touch `/tmp/addnonsteamgamefile` and `steam steam://addnonsteamgame/<percent-encoded path>`
(`flatpak run com.valvesoftware.Steam …` for the Flatpak); never writes `shortcuts.vdf`; (5) polls
`shortcuts.vdf` for up to 20 s and writes the missing grid art (`<appid>p.png` 600×900,
`<appid>.png` 920×430, `<appid>_hero.png` 1920×620, `<appid>_logo.png`) into
`userdata/<id>/config/grid/`, never replacing an existing image. No entry in time: `pending`.
Records `{"check":"steam-library-add", state, message, appId}` in the evidence log. At launch
(`steam_library::start`, Linux) the same missing-art fill runs once for an existing entry.
Steam shows new grid art after it restarts (switching to Gaming Mode).

### Overlay reading hold

Automatic OCR pauses both observations and recognition application while the pointer is on
overlay text or a lookup from that overlay is visible. It resumes with a fresh observation
after both have been left. Manual scans remain explicit, and source/crop changes reset the hold.
Both text and image observer modes honor pauses that begin during a capture.
`popup-host` sends `overlay-reading-popup` `{visible:boolean}` to `overlay` for the full
visible desktop lookup chain; reader-only lookups do not hold the overlay. Embedded engine
popups and the API lookup report their visibility locally. This is shared across platforms.

On GNOME, a linked portal window stream contains the selected window actor alone. Those
captures preserve annotation/popup visibility; screen streams and unlinked shares retain
Linux hide-during-capture suppression and freshness fencing. General own-window exclusion
capabilities remain false.
