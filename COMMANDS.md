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
`ankiCropRegions.<appName>`, `textHookerGames.<exe path>`,
`hotkeys.<name>.{accelerator,enabled,gamepadButton}`, `overlayLookupKey` (`shift`; or `ctrl`, `alt`,
`meta`: the modifier that opens the overlay's click-through gate, main.rs cursor poll), `scannedTextFontSize` (14),
`scannedTextHistory[]`, `audioSettings.voiceId`,
`autoScanSettings.{enabled,scanDelay,gamepadButton}` (a `triggerKeys` left by an older version is ignored),
`autoOCRSettings.{pollInterval,imageHashThreshold,localOCRSimilarityThreshold,localOCRGateEnabled,adaptivePollingEnabled,adaptivePollMin,adaptivePollMax}`,
`texthookerSettings.{copyToClipboard,sendToWebSocket,webSocketUrl}`,
`gamepadSettings.{enabled,preferredGamepadIndex,lookupButton}` (enabled defaults true; `lookupButton`, a
button index held as the lookup key (`gamepad::lookup_held`), defaults on a Steam Deck to the first
back grip no shortcut's chord uses, L4 (17) first, and to `null` elsewhere),
`lastSelectedSource.{sourceId,type,name,appName}`,
`yomitanSettings.{popupType,customApiUrl}` (`popupType`: `'builtin'` (Built-in Yomitan) \| `'custom-api'` (Yomitan API) \| `'hachidori'` \| `'tenten'`; an empty `customApiUrl` means `http://127.0.0.1:19633`), `serverSettings.{mode}` (`'cloud'`),
`textOverlayGrouping.{enabled,proximityThreshold,filterSmallText,filterSmallTextThreshold}`
(`false, 100, true, 0.75`), `overlayOpacity` (80), `liveOverlayEnabled` (false),
`ocrMode` (`'googlelens' | 'cloud' | 'meikiocr' | 'mangaocr' | 'ppocr' | 'screenai' | 'vocr' | 'livetext' | 'oneocr'`;
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
`maximize` (toggles: maximized, or back to the size before; ignored for fixed-size windows,
Mini mode and Gaming Mode; `PanelInfo.maximized` reports it), `pin`, `unpin`, `inspect`. The main window also accepts `mini` and `expand`:
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
| `capture_border_status` | `() -> "hidden" \| "denied" \| "unsupported"` — whether captures hide Windows' yellow capture border; `denied` when Settings → Privacy & security → Screenshot borders turns it off for Kimochi; read-only, never prompts |
| `open_capture_border_settings` | `() -> ()` — opens that Settings page (Windows) |
| `accessibility_status` | `() -> bool \| null` — macOS Accessibility, read-only, never prompts; `null` where the platform has no such permission |
| `request_accessibility` | `() -> bool` — shows the system's Accessibility prompt and opens its Privacy & Security pane; whether it is granted now |
| `source_window_state` | `() -> {sourceId, bounds, onScreen, fullscreen, settling, display} \| null` — the tracked window's last `source-bounds`, for a page opened after it |
| `capture_frame` | `({request, observe?, observerMode?, observerEngine?, readIfStill?}) -> {id, info, url, observation, observerSkipped, …}` — with `observe`, the watcher reads the frame (with `readIfStill`, only if the frame's `contentFingerprint` equals it; otherwise the read is skipped and `observerSkipped` is true, which Auto OCR uses to wait for text to stop moving before a slow watcher reads it): `observerMode: 'image'` hashes it instead, and `observerEngine` (`'ppocr'`, `'meikiocr'`, `'livetext'` / `'oneocr'` on their OS, and `'vocr'` / `'screenai'` when they are the reader; default Live Text on macOS, MeikiOCR elsewhere) names the engine, chosen by `ui/watcher.ts` |
| `ocr_frame` | `({id, engine?}) -> {id, info, ocr}` — pure; `engine` is a native `ocrMode` (`'googlelens'`, `'cloud'` when omitted, `'meikiocr'`, `'mangaocr'`, `'ppocr'`, `'screenai'`, `'vocr'`, and `'livetext'` / `'oneocr'` on their OS) |
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
| `layer_outputs` | `({operation: 'list'}) -> {outputs: [Rect], current: Rect \| null, pointer: {x, y} \| null}`, `({operation: 'move', rect}) -> bool` — Linux layer-shell overlay only (KDE Plasma, Hyprland, wlroots): every output and the pointer in the compositor's global logical layout, and moving the overlay to the output with that geometry. The Wayland region editor uses it to edit a shared screen on whichever of its outputs the pointer is over. No outputs elsewhere |
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
display, scaled}` when the tracked window moves, resizes, changes on-screen state or goes in or out
of full screen, and once whenever it is called (a reloaded page asking again gets the window's
bounds without waiting for it to change). On Windows, while Magpie scales the tracked window, `bounds` (and a
frame's `source_bounds`) are where Magpie draws it, `fullscreen` is true when Magpie scales it full
screen and `scaled` says so; the window's own shape, and so its crop, is unchanged (`platform::scaler`). While the Text Hooker is the input, the overlay watches
the hooked game's window, whatever source was last picked for OCR. It polls `CGWindowListCopyWindowInfo` for one window id ten times a second
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

`pointer` `{x, y, over, blocked, gate, down, shift, ctrl, alt, meta}` carries the desktop
cursor and the held modifiers to the overlay. It goes out on a move, a modifier or button
edge, and when Shift's gate (`gate`, `state::ShiftGate`) opens or shuts, which it can with the
pointer still (and on Wayland, positions stop being read once it has shut). The overlay is click-through except over
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
the API pop-up (`cursorX/Y` and `anchor` in desktop points: from a pointer event, through
`desktopPointOf`, see Webview scale below); `level` (0–4, default 0) is its place in a stack of windows,
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
`triggerScan` after `autoScanSettings.scanDelay` (see `gamepad.rs`), set in Settings → Shortcuts &
Controls. Not while one of Kimochi's windows has focus (the controller works the window there) or
while `autoScanSettings.enabled` is off. With verbose logging on, every press is recorded as
`{check: "gamepad-press", pressed, panelFocused, outcome}`, so a debug report says what it did and
why no scan followed, and the first raw button and axis events gilrs delivers are recorded as
`{check: "gamepad-raw", event, button|axis, code, value?, standardPressed}` (presses that arrive
as `Unknown` or leave `standardPressed` empty never reach a binding; `vitals` counts the rest).
A change in the connected controllers is always recorded as `{check: "gamepad", connected:
[names], backend, pads: [{name, osName, vendor, product, uuid, mapping, power}]}`, and gilrs's own
warnings and errors (a controller it lists but cannot read) as `{check: "gamepad-backend", level,
message}`. Kimochi does not watch
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
| `history_add` | `({text, detached?, groups?, engine?, merge?, frame?, session?}) -> entry` — `session`: the Log session the lines go to (the Log opens it first) |
| `history_delete` | `({id}) -> ()` |
| `history_clear` | `() -> ()` |
| `log_recent` | `({limit?}) -> [{id, text, timestamp, source}]` — the Log's newest lines (open session's `lines.json`, newest first, default 50), whatever their source; the controller's Recent text |
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
with `invalid:`, so it can never name a path (`src-tauri/src/chrome_storage.rs`). The macOS dev
build (`tauri dev`, unbundled) has a WebKit store of its own, so its engines use
`chrome-local-<id>.dev.json` instead, seeded once from the shared file
(`extensions::SEPARATE_EXTENSION_STORAGE`): a shared list always described the other build's
dictionaries, and each launch's reconcile emptied it for the other.

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
throttling off like the overlay's, and it is not a panel, so `panel` refuses its label. On macOS
it is then ordered in behind everything, fully transparent and click-through, with WebKit's
occlusion detection off (`platform::keep_engine_in_foreground`): hidden, its web process idled at
background priority and the first lookup after a pause was slow. `KIMOCHI_NO_ENGINE_GHOST` keeps it
hidden. Its
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
  directory, entry `release`, preferring 27631, the next free one up to 24 above on a first run).
  A dev build uses the installed app's entry and port, since it shares the app's webview store
  and `chrome-local-hachidori.json` (when there is no `release` entry yet, it adopts its old `dev`
  one). The exception is the bare macOS dev executable, which has a WebKit store and storage file
  of its own: it keeps entry `dev`, preferring 27632. Bound before any window is built. If the saved port is taken after the
  switch, Hachidori does not start (`extension_window_ensure` fails with `unavailable: …`) rather
  than show no dictionaries or load another program's pages; `{check: 'hachidori-origin'}` in the
  log says which session it is (`scheme`, `loopback`, `unavailable`) and why.
- **Who may load it.** `Host` must be `127.0.0.1:<port>`; a request carrying `Origin` or
  `Referer` must come from the loopback origin, the app origin or (dev) the dev server, else 403
  (`{check: 'hachidori-loopback-refused'}`). It serves only the public extension release and host
  scripts, never user data; the dictionaries stay in WebKit's storage.
- **Sharing → Link** (`relay_link.rs`, `host/ext/relay-link.js`). A Hachidori relay admits
  `/link` only from `chrome-extension://`, `moz-extension://` or `hoshi://hoshidicts` (403
  otherwise), and a page cannot choose its WebSocket's `Origin`. So in the background page a
  `ws://<host>:<port>/link` socket opens `ws://127.0.0.1:<port>/__kimochi/relay-link?to=<host>:<port>`
  instead: only from the loopback origin itself, it repeats the upgrade to the relay's `/link`
  (and nothing else) with `Origin: hoshi://hoshidicts`, answers with the relay's status (101, or
  its 403/503; 502 when unreachable), then copies bytes both ways without parsing frames
  (TCP_NODELAY on both legs). `{check: 'hachidori-relay-link', ok, to, ms | why | status}` per
  attempt, a repeated failure only once. On the scheme origin linking is unchanged.
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

## Browser bridge

The Kimochi browser extension (`browser-extension/extension/`, an MV3 extension for Chrome, Edge
and Brave) picks a picture on a web page, Kimochi reads it, and the extension lays the lines over
the picture for the browser's own dictionary pop-up. Native side: `src-tauri/src/browser_bridge.rs`.

| Command | Signature |
| --- | --- |
| `browser_bridge_status` | `() -> {enabled, listening, port, error, connected, browsers, page: {title, url}?, lastScan: {lines, ms, at}?, reading}` |
| `browser_scan_result` | `({request, result?, error?}) -> bool` — the overlay's answer to `browser-scan`; false when the request is unknown (expired, or its tab went away) |
| `browser_rescan` | `() -> bool` — asks the tab read last to read its picture again; false with no browser connected |
| `browser_extension_folder` | `({reveal?}) -> path` — the folder to Load unpacked, opened in the file manager unless `reveal: false`; a bundle copies its own into the app data directory first |
| `browser_sessions` | `({sessions: [{id, name}], active}) -> ()` — the Log's sessions, sent by the Log host whenever they change; every tab's session menu follows them |
| `browser_session_reply` | `({request, id?, error?}) -> ()` — the Log's answer to `browser-session` |
| `browser_engines` | `({engines: [{id, name, tagline, runs, icon}], selected}) -> ()` — the OCR engines as the sidebar lists them, sent by the main window whenever they or the selection change (`frontend/main/BrowserEngines.tsx`); `icon` is `{image, tile}` (a data URL), `{svg}` or `{monogram, lang?}` |

| Event | Payload |
| --- | --- |
| `browser-scan` | `{request, frame: {id, info}, reason, page: {title, url}}` — a picture is in the frame store; the overlay reads it (`onBrowserScan` in `ui/overlay.js`) |
| `browser-bridge` | the status above, on every change |
| `browser-session` | `{request, op: "create"\|"rename", id?, name?}` — the Log host makes (and opens) or renames a session and answers with `browser_session_reply` |
| `browser-engine-choose` | `{mode}` — a tab picked an OCR model; the main window chooses it as the sidebar does (with the same download question) |

**Auto** is the extension's own switch (on by default, kept in the browser): the picture is read
again when it changes, and after a full page load on the same site the page script comes back and
reads the picture in the same place on the new page (`findLike` in `content.js`). Kimochi's Auto OCR
flag isn't used in this mode.

**Sessions.** Each tab sends its lines to a Log session, and the Log opens that session when they
arrive (`history_add` `session`, `ingestHistory` in `frontend/texthooker/host.ts`). A tab's session
is the one chosen in its menu, else the one remembered for the page or a page like it
(`browserExtension.pages`, newest first, at most 300: the same address or title with only numbers
changed, or a title that is mostly the same, on the same site; `matched_session`), else a new one
named for the day, made at the page's first reading. Any number of tabs and browsers may share a
session.

**Mode.** The input source `superTexthooker.inputSource = "browser"`. A scan that isn't automatic
switches to it; an automatic one is refused under any other source. In this mode the overlay draws
nothing, its screen watcher stays off, and the scan button and shortcut call `browser_rescan`. The
picture's text goes through `publishOcrResult` (the same filters, `history_add` with `detached`),
so the Log takes it as it takes a scan. Leaving the mode sends `ended` to the extension.

**Transport.** A WebSocket at `ws://127.0.0.1:27640/kimochi-browser` (a development build:
27641), on while `browserExtension.enabled` (default on). The handshake is refused unless its
`Origin` is the extension's (`browser_bridge::ORIGINS`; a web page can't set its own `Origin`).
Messages are JSON text:

| Direction | Message |
| --- | --- |
| extension → | `{type: "hello", protocol: 1, version, browser}` |
| ← Kimochi | `{type: "welcome", protocol, app: {name, version, dev}, settings, css}` — `css` is `ui/overlay-text.css`, which the page draws its boxes with |
| ← Kimochi | `{type: "settings", settings}` — `{autoOcr, clickThrough, overlayStyle, appearance, grouping, active}`, sent again whenever any of them changes |
| extension → | `{type: "scan", id, reason: "select"\|"rescan"\|"auto", page: {title, url}, session, width, height, png}` (`png` base64, 4096 px at most on its long side; `session` null for the page's own) |
| ← Kimochi | `{type: "result", id, ms, session, lines: [{text, points: [[x, y] ×4], vertical, group, surface?}], width, height, engine, geometry, text}` — `points` in fractions of the picture |
| ← Kimochi | `{type: "sessions", sessions: {sessions: [{id, name}], active}}` (also in `welcome`) |
| extension → | `{type: "page", id, url, title}` / ← `{type: "page", id, session}` — the session remembered for this page, if any |
| extension → | `{type: "assign", url, title, session}` — the reader chose a session for this page |
| extension → | `{type: "createSession", id, name, url, title}` / ← `{type: "sessionCreated", id, session?, error?}` |
| extension → | `{type: "renameSession", session, name}`; `{type: "show"}` (bring Kimochi forward) |
| ← Kimochi | `{type: "engines", engines: {engines, selected}}` (also in `welcome`) |
| extension → | `{type: "setEngine", id}` |
| ← Kimochi | `{type: "error", id, message}` |
| ← Kimochi | `{type: "rescan"}`, `{type: "ended"}` |
| extension → | `{type: "ping"}` (every 20 s, keeps the service worker alive) / ← `{type: "pong"}`; `{type: "stop"}` |

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
| `webview_scale_sync` | `(ratio) -> {zoom, screenScale} \| null` |

**Webview scale (Windows).** Everything native on Windows takes one CSS pixel to be the window's
DPI scale (`GetDpiForWindow / 96`) in physical pixels: Tauri's logical sizes, the overlay's
desktop points, the mouse hook's press positions and `panel_pointer`. WebView2 can render at a
larger device scale factor than that (a reader on a 100 % display had every webview at
`devicePixelRatio` 1.5, its outer size shrunk too, so not page zoom), and every point native
handed a page then landed 1.5 times as far from the corner. The Windows `platform_prelude`
reports each top-level page's `devicePixelRatio` to `webview_scale_sync` on load and on every
change; native reads the page zoom WebView2 applies and sets the one that brings a CSS pixel
back to the DPI scale (`webview_scale.rs`), recording `webview-scale` `{window, ratio, dpiScale,
zoom, applied, screenScale}` whenever it changes one. It returns the zoom in force (1 when
nothing needed changing) and `screenScale`, and `null` on other systems, where it does nothing.
Pages on Hachidori's loopback origin cannot reach it and keep WebView2's scale.

Page zoom corrects CSS pixels but not Chromium's screen coordinates: with WebView2 at 1.5 on a
100 % display, `event.screenX/Y` and `window.screenX/Y` stay at two thirds of the desktop
point, zoom or no zoom. `screenScale` is the factor that takes them to desktop points
(`ratio / zoom / dpiScale`, 1.5 in that case, 1 when nothing is off); the prelude keeps the
latest in `__KIMOCHI_PLATFORM__.screenScale`, and every page that hands native a desktop point
read off a pointer event (`show_popover`'s `cursorX/Y` and `anchor`) goes through
`ui/desktop-point.ts`'s `desktopPointOf(event)`, which applies it to trusted events and leaves
the events native replays into a page (already desktop points) alone.

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
the redacted last 2 MB of `evidence.jsonl`, `evidence.1.jsonl`, `auto-ocr-trace.jsonl`,
`auto-ocr-trace.1.jsonl` and `sync-log.jsonl`. `input` is Windows only (`null` elsewhere):
`{pointerDevices: [{type, product, maxContacts}], digitizer, maxTouches}`, the pens,
touchscreens and Windows Ink tablets that reach the webviews as pointers of their own.
`debug_verbose_set(true)` lasts a day, across restarts (the deadline is kept in `verbose-until` in
the app data folder, removed when it is switched off), and each change emits `verbose-logging` (the new
`bool`) so open windows start or stop their own diagnostics. While on, window focus changes
(`window-focus`) and every scan (`scan`) are recorded too, and pointer diagnostics:
`pointer-trace` from each panel and from the overlay while its region editor is open
(`ui/pointer-diagnostics.js`: the window's geometry beside native's, pointer down/up/cancel,
moves at 5 a second per pointer, hover changes, and each region-editor gesture with the pointer
that drove it and the ones it ignored), and on Windows `pointer-press` for every press the mouse
hook delivers to the overlay (screen and local point, and whether it came from a mouse, a pen or
touch, or was injected). Elements are described by tag, classes, role and label, never their
text.
Every 5 s a `vitals` record (`src-tauri/src/vitals.rs`) gives `gapMs` (time since the last one;
well over 5000 means Kimochi or the machine stalled) and `counts` (how often, since the last
one, the overlay switched click-through on or off, had its input region set, was placed or
shown, and Kimochi raised, focused or activated a window). On Linux it adds Kimochi's own and
its child processes' CPU (% of one core), memory and threads, the system's free memory and
swap, memory/CPU/IO pressure (`avg10`) and load. The file is flushed to disk after each one.
The bundle carries the last 2 MB of each log.
The shared `ocr_frame` path records `scan` phases `started`, `complete` and `failed`, with
engine, frame id, dimensions, elapsed milliseconds, annotation/line counts and backend where
available. It never includes pixels or recognized text. Debug capture status uses `capture.permission`;
the capabilities command retains `capture.authorization`.
`scan-failed` and `ocr-failed` are always recorded, with the engine and its error.
`ocr-empty` is always recorded when frame OCR returns zero annotations, with id, engine,
backend (when provided), width, height and elapsed ms; it contains no recognized text.

Every `evidence.jsonl` record carries `at` (Unix ms), and the file is rotated to
`evidence.1.jsonl` past 8 MB.


## Bug reports

Help (the ? in the main window's title bar, `frontend/main/HelpDialog.tsx`) → Report a bug or
Request a feature (`src-tauri/src/bug_report.rs`).

| Command | Signature |
| --- | --- |
| `bug_report_send` | `(report: {kind?, name, email, description, debugMarkdown?}) -> {id}` |

Posts `multipart/form-data` to `<server>/api/v1/bug-reports` (kimochi-server `API.md` → Bug
reports): `kind` (`bug`, the default, or `feature`), `name`, `email`, `description`, `appVersion`, `platform` (`<os> <arch>`, plus
`(Steam Deck Gaming Mode)` there) and, when `debugMarkdown` is given, `debug`: the same zip as
`debug_bundle_save` (`debug_report::bundle`), built in memory (bugs only; a feature request
never sends one). The active account's token goes
along when there is one, so the report names the account; none is needed. The server emails the
report to the maintainer with Reply-To the reporter, and answers `{id}` (a reference like
`KB-7F3K2Q`, `KF-` for a feature request). A refusal (a field, the rate limit, a debug zip it can't verify) or no connection
rejects with a sentence for the reporter, the server's own `message` when it sent one.

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
| `yomitan_prefetch` | the API pop-up's Shift-scan, as soon as it knows the word under the pointer: `yomitan_prefetch({baseUrl, term})` starts fetching the word's entries (without media), and `show_popover` opens on that answer rather than asking again. Entries are kept for a minute (`reader/yomitan.rs` `ENTRIES_KEPT`); a request still on its way is shared |
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
profile. Its other fields: `voiceHook` (default true: prefer clean individual voices from the selected Windows Text Hooker game, with automatic system-audio fallback), `field` (the note field the line's audio goes in, default
`SentenceAudio`), `wordField` (the note field the mined word's audio goes in; empty, the default,
for none), `clips` (line clips kept on disk, 5–100, default 15), `startOffsetMs` and `endOffsetMs`
(−5000–5000, moving every clip's ends), `trim` (cut a clip placed by timing to its speech, default
on).

| Command | Signature |
| --- | --- |
| `sentence_audio_status` | `() -> Status`: the recording's state, for Settings → Anki |
| `sentence_audio_line` | `({uid, text, ts, source, scan})`: the Log added a line (or changed one's text, same `uid`); `ts` its arrival in Unix ms, `source` its `LineSource`, `scan` the OCR scan it was read in or null (a scan's lines are decided together: blocks said apart each get their own voice, parts of one box share it, and a block that looks like a name box needs a strong match of its own). Ignored while recording is off. |
| `sentence_audio_forget` | `({uids})`: the Log deleted these lines, or a fuller reading of the same text replaced them; their kept clips are removed and their voice is free for other lines again |
| `sentence_audio_debug` | `() -> {status: Status, clips, listener, hooked, hookError}`: for Diagnostics → Sentence audio. `listener` (null until recording starts) is `{heardUntil, transcribedUntil, speaking, speechDetection, recogniser, lines, heard}`: the newest 40 lines, newest first, each `{uid, text, ts, appeared, scan, outcome (waiting, voiced, silent, missed), how, score, heard, clip: [from, to], provisional, window: [from, to], decidedAt, changes, note}` (`note`: why it was decided as it was), and what the recogniser heard in the last minute, `{startMs, endMs, text}` |
| `sentence_audio_lines` | `() -> LineAudio[]`: what is known about recent lines' audio (the decided ones, and every kept clip), for the Log |
| `sentence_audio_clip` | `({uid}) -> string \| null`: line `uid`'s clip as base64 MP3, or null when none is kept |
| `sentence_audio_attach` | `({url, noteId, sentence, field, word, wordField, reading})`: the Yomitan API pop-up added note `noteId` at `url` (with the configured key) from `sentence` for `word`; its audio follows in the background into `field` (or `sentenceAudio.field` when null), and the word's into `wordField` (or `sentenceAudio.wordField`), looked for by `word`, then `reading`. Runs whenever sentence audio is on, recording or not: the line is the best match among the lines heard and the clips kept |
| `sentence_audio_add_to_note` | `({noteId}) -> ()`: the Anki tab's Add sentence audio: reads the note back through Kimochi's AnkiConnect and puts its line's kept clip in its empty sentence-audio field (and the word's in the word-audio field); errors say why not |

| Event | Payload |
| --- | --- |
| `sentence-audio-line` | `LineAudio`: the listener decided (or decided again) a line's audio. A line matched by its words keeps its clip (a later decision only ever brings a better match), and a line without one is tried again for 40 s as more speech is transcribed. |

`LineAudio` is `{uid, state, durationMs?, how?, message?}`: `state` `voiced` (a clip, `durationMs`
long, obtained directly from the game, `how: "hooked"`, found by its words, `"matched"`, or by timing, `"timed"`), `silent` (no voice was
detected near the line) or `missed` (its audio was no longer held; `message` says why).

`Status` is tagged by `state`: `off`, `needsModel` (legacy; recording and clean hooked clips now start while the fallback model downloads), `starting`, `recording {source, excludesOwnAudio}` (what is
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

`engine` is `"meikiocr"`, `"mangaocr"`, `"ppocr"` (PaddleOCR), `"screenai"` (Chrome Screen AI, see below), `"vocr"` (VOCR6) or
`"sensevoice"` (SenseVoice-Small, sentence audio's speech recogniser; never an `ocrMode`). Every command answers with the engine's
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
  source: 'downloaded' | 'bundled' | 'development' | 'browser' | null,  // where ready models live
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

**Packages.** A manifest file may be listed for some platforms only (`platforms`: `mac-arm64`,
`mac-amd64`, `windows-amd64`, `windows-arm64`, `linux-amd64`, `linux-arm64`); an engine with no
file for this computer cannot be downloaded (`model_download_start` fails it with "Not available
for this computer"). A file with `unpack: true` is a zip: once verified it is unpacked into
`<engine>/<name without .zip>/` and the zip is deleted; that directory then stands for the file.

### Chrome Screen AI (`screenai`)

Google's on-device OCR library from Chrome (`src-tauri/src/screen_ai.rs`, the `screenai/` crate).
Kimochi never bundles it. It uses, in order: its own download (Google's package for this
platform from Google's CIPD servers, pinned by version and SHA-256 in `ocr-models.json`;
Windows on ARM gets the x64 package), the copy owocr and GameSentenceMiner keep in
`~/.config/screen_ai/`, then a Chromium browser's component (`<user data>/screen_ai/<version>/`,
Chrome first). With a browser's copy, `model_status` reports `ready` with `source: 'browser'` and
nothing to download or delete. Google publishes no Linux ARM64 package: there only a browser's
copy works, and without one the engine is unavailable and not selectable.

The library runs in the `kimochi-screenai-worker` helper (bundled under `screenai/`; two on
Windows, `kimochi-screenai-x64.exe` and `-arm64.exe`, picked by the library's architecture),
started on the first scan (or at launch when Screen AI is the engine in use) and kept running.
Frames go to it as raw RGBA over a pipe, scaled down first when larger than the library reads
(2048 px). A worker that crashes or hangs fails that scan and is replaced on the next; a copy
whose worker cannot start is not offered again that session.

`platform_capabilities` reports `ocrEngines.screenai` as `{available: true, accelerator: 'cpu',
version, source, runtimePath}` with a copy (`source`: `'downloaded'`, `'shared'` for
`~/.config/screen_ai`, or the browser's name, such as `'Google Chrome'`), and otherwise
`{available: false, selectable, reason}`, plus `model: <state>` while only the download is
missing. It is re-sent as `platform-capabilities` when the download changes state; a copy a
browser installs meanwhile is found the next time the capabilities are asked for (the panel's
"Look again").

## Text Hooker (Windows; Linux through Proton or Wine)

The `inputSource` `"hook"`: the game behind a chosen window is hooked and its text read from
inside it. Implementation: `src-tauri/src/text_hook/` (session, process resolution, thread
choice, download store) and the `kimochi-hookd` sidecar (`hookd/`). On macOS the commands
answer `supported: false` or refuse.

On Linux a window is hookable when its process is a Wine loader running a Windows game
(`text_hook/wine.rs`): Proton (including Steam Deck Gaming Mode's `gamescope:window:{appid}:{pid}`
sources) or any Wine. The same Windows sidecar runs with the game's own `wine`, in its prefix
(`WINEPREFIX`, the sync mode and Wine's library path copied from the game's environment), which
reaches the game's wineserver from outside Proton's runtime container. Its paths are passed on
the prefix's `Z:` drive. Process ids in the protocol are then the prefix's, found by running
`kimochi-hookd processes` there and matching the game's Windows image path; `exe` is the game's
Linux path (through the prefix's drive links), which keys what is remembered per game. Linux x64
bundles ship the sidecar (cross-built with MinGW); Linux ARM64 bundles do not.

| Command | Signature |
| --- | --- |
| `texthook_targets` | `({sourceIds}) -> {[sourceId]: {hookable, bits?, exe?, reason?}}` — which windows can be hooked; `reason` says why not (Windows' own apps, Store apps, protected or elevated processes, native ARM64 processes, Kimochi; on Linux, anything not a Windows game under Proton or Wine). A window shared through the Wayland portal (`portal:window:*`) names no process: it is the one KWin or Hyprland linked the stream to, so it is not hookable until linked, after its first frames |
| `texthook_start` | `({sourceId, observerEngine?}) -> HookStatus` — hooks the window's process and its engine children (a launcher's `.bin`/`.log`/`.dat`, an Electron or NW.js game's renderers); replaces any session, except one already hooking (or hooked to) the same window, which goes on as it is. `observerEngine` is the local OCR the thread choice reads the window with (the Auto OCR watcher) |
| `texthook_stop` | `() -> HookStatus` — detaches and stops the sidecar |
| `texthook_status` | `() -> HookStatus` |
| `texthook_select` | `({key}) -> HookStatus` — the thread the Log reads, remembered for the game; `key: null` forgets it and chooses automatically again |
| `texthook_insert` | `({code}) -> ()` — inserts an H-code into every process of the hooked game now (Settings keeps it in the game's `hookCodes` too); fails when nothing is hooked |
| `texthook_game` | `({exe}) -> {thread: string | null}` — the hook code of the thread remembered for the game |
| `texthook_game_icon` | `({exe}) -> string | null` — the game's icon as a PNG data URI, saved from its window when it was last hooked (`<app local data>/texthook/icons/`) |
| `texthook_forget` | `({exe, all}) -> ()` — forgets the thread remembered for the game; with `all`, its icon too |

```ts
HookStatus = {
  supported, phase: 'idle' | 'starting' | 'downloading' | 'attaching' | 'hooked' | 'ended' | 'failed',
  detail,                         // why it failed or ended, or which engine it fell back from
  sourceId, exe, pids,
  engine: {id: 'luna' | 'textractor', name, version} | null,
  download: {done, total} | null, // bytes, while downloading the hooker
  selected, selectedBy: 'saved' | 'auto' | 'manual' | null,
  pickNote,                       // why no thread was chosen automatically yet
  fallback,                       // why the first engine was given up for the one in use
  hookFailures,                   // hook codes the hooker found but could not insert (LunaHook's
                                  // "钩子注入失败 <code>"); with nothing selected, the sidebar
                                  // suggests restarting the game
  unityText,                      // true while the voice hook DLL reads a Unity game's text
  threads: [{key, name, hookcode, preview, count, japanese, generic, selected}]
}                                 // engine hooks first, then in the order the hooker found them
                                  // (stable: not reordered by new text); `japanese` once any of a
                                  // thread's text has read as Japanese (sticky), the menu's filter
```

Events: `texthook-status` (a `HookStatus`, on every change and every hooked sentence) and
`texthook-line` (`{text, key, at, id, replaces}`: a sentence of the selected thread, consecutive
repeats dropped; `replaces` is the id of the line it finishes, or null), which the texthooker ingests as source `"hook"` while `inputSource` is `"hook"`.
A line is finished by the rest of a line still typing out when its burst ended, and, with the
game's `joinLines` on, by a piece from the same thread that carries on the line
(`clean::continues`: the line's 「 or 『 is still open and the piece does not open another 「, or
the line does not end in `。！？`, a closing bracket, `…`, `～` or a dash) and comes within
300 ms + 100 ms per character of the piece before it (the time that row takes to type out at ten
characters a second; at most 5 s), where a line the reader clicked on to comes later.
SiglusEngine sends its text box a row at a time, breaking at each line break and ruby. The joined
line replaces the line before it.

**Thread choice.** A thread is selected as soon as it speaks if it matches the one remembered
for this exe (`<app local data>/texthook/games.json`: `hookcode`, `ctx & 0xFFFF`, `ctx2 & 0xFFFF`).
Otherwise, 700 ms after new text, the window is captured and read with the local OCR, the lines
grouped into blocks, and each thread's latest sentence looked for in each block after
normalising width, punctuation and whitespace (exact containment, never fuzzy). Matches in the
largest block count double; a block found inside a longer sentence counts only for the share of
the sentence it is; engine hooks beat the generic Windows API hooks, a thread repeating itself
rapidly is halved, and of two copies of a line the one with fewer line breaks wins; a thread that
has sent more pieces gains up to 1 (some hooks start a thread per line, which never speaks again),
and one whose pieces held script codes (`clean::has_codes`) loses up to 3. Threads
under 30 % kana and kanji are never chosen, and at least 6 effective matched characters are
needed. A choice made this way or by hand is remembered for the game. A thread chosen
automatically or remembered (never one chosen by hand) is replaced while the game runs when at
least a fifth of its pieces (two or more) held script codes and another engine thread that has
sent three pieces and never a code sends at least 70 % of its latest text, codes aside: the new
thread is selected (`selectedBy: 'auto'`) and remembered, logged as `texthook-reselected`. The window is read with
`observerEngine`, else the first local engine available (`oneocr`, `ppocr`, `meikiocr`,
`livetext`).

**Game settings.** `textHookerDefaults` (`HookSettings`) and each game's record,
`textHookerGames[<exe path, lowercased>]`, edited in Settings → Text Hooker; `ui/hook-games.ts`
types both and resolves a game's settings (its own value, else the default, else Kimochi's). A
game's record holds what the reader changed for it and what was learned about it:

```ts
HookSettings = { autoHook: true, flushMs: 300, repeats: 'auto' | 'off' | 2 | 3 | 4,
                 joinLines: true, stripCodes: true,
                 speakerNames: true, autoAlign: true, opacity: 1, textSize: 0.034 }
textHookerGames[exe] = Partial<HookSettings> (textSize is `text`) & {
  exe, name, sessionId, addedAt, hookedAt,            // the game, its Log session, when hooked
  hookCodes: string[],                                 // inserted on every attach
  replacements: [{find, replace, regex?, enabled?}],   // applied in order to each line
  text, leading, box, ocrBox, surface, namesApart, nameBox   // the card (below)
}
```

`flushMs` is LunaHook's `--flush-ms`, read when the sidecar starts. Each hooked line is cleaned
natively before it is sent (`text_hook/clean.rs`): markup engines leave in their text is taken
out, keeping the text it marks up (HTML-like tags, `<rt>` readings, `{漢字/かんじ}`, Ren'Py's
`{w}`, Tyrano's `[r]`, `｜漢字《かんじ》`); with `stripCodes`, script codes are taken out (ASCII
runs of letters, digits and `_ $ | -` with a `$`, a `_` beside a letter or digit, or letters and
digits mixed over 5 characters or more: such as `chr00chr01`, `$fx_shake_fa`, `VOK_`),
and a line that was nothing else is dropped; repeated characters are undone (`auto`: only when
every run of a character in the line, three runs at least, is a multiple of the same count); the
game's replacements apply; and a line over 300 characters (a backlog or skip sent at once) is
dropped, logged as `texthook-dropped` with verbose logging on.

**Hook automatically.** While `inputSource` is `"hook"`, the source panel looks at the open
windows every 3 s (`source_catalog`, `texthook_targets`) and hooks the first whose exe is a game
with `autoHook` on, trying each window once. With nothing hooked, any such window counts; with a
game hooked, only a window opened since the last look, so a game started later takes over (one
hook at a time: `texthook_start` stops the session before it). Clearing a Text Hooker source
pauses it until the app next starts, or until the reader chooses a game to hook from the menu.

**Sessions.** With **Auto switch sessions** on, a game is tied to a Log session
(`frontend/texthooker/host.ts` `linkHookedGame`): hooked for the first time, it takes the session
chosen for its window by name; hooked again, it switches to its own session whatever its window
is called, and the window's name no longer picks one while it is hooked. A game's name is its
session's name, so renaming either renames both. Deleting a game in Settings removes its record
and calls `texthook_forget(all)`; its session goes too only when asked.

**Typewriter text.** A game that types text out sets it again every frame, and the hooker joins
those calls into one sentence ("「", "「旅", "「旅人", …). A sentence made only of prefixes of its
last part that never get shorter (line breaks ignored) is reduced to that last part, before it
is shown, matched or sent to the Log.

**Downloads.** `src-tauri/texthook-manifest.json` (written by `scripts/texthook-package.mjs`)
pins each engine file by size and SHA-256 with its sources in order: the upstream release
zip's entry (read by HTTP range: the zip's size, its tail and directory, the entry), then the
mirror's copy (`https://downloads.kimochiapp.com/texthook/<engine>/<version>/<file>`). Files
land in `<app local data>/texthook/.staging-…` and the directory is renamed to
`<engine>-<version>/` once every file is verified. LunaHook is tried first; if it cannot be
downloaded, started or attached, Textractor is.

### On the game: the card

While `inputSource` is `"hook"` the overlay draws nothing OCR read. The hooked line is shown in a
card on the overlay (`ui/hook-card.js`, `ui/hook-card.css`): one element of its own, not drawn by
the OCR renderer, always visible while **Show overlay** is on and the game is in front (or Read
along holds it), its text looked up like any text on the overlay. It is published with the
overlay's hit regions, so presses on it never reach the game. It looks the same however it is
placed: a bar along its top moves it, its corner resizes it, −/+ beside the corner change the
text's size, and ⋯ opens a menu with the background's opacity and **Text Hooker settings…** (the
game's page in Settings → Text Hooker, through `textHookerSettingsGame`). Any of these by the reader turns Auto align off and keeps the card where it is.

- `overlay_drag({ active: boolean }) -> ()`: the overlay is dragging the card. While it is, the
  pointer poll sends the overlay every move (`pointer`) rather than every other one, and the
  overlay's hit region is its whole display.
- Gaming Mode: with the Text Hooker as the source the radial menu has no Scan or Auto OCR, and
  starts on Read along, which steps through the card's text (`extraUnits`) or, as the full-screen
  dictionary, shows the hooked line across the top (`sections`). The card stays up while it does.
  Its items are Read along, **Text Hooker**, Recent text, Kimochi and **App settings** (Settings →
  Text Hooker, at the hooked game's page). Text Hooker opens `ui/controller-card.js`: first the
  hooked text as the sidebar's select shows it (`hookSummary`, live from `texthook-status`: the
  phases with a spinner, the line in use and how it was chosen), whose A opens the threads
  (`threadChoices`: Choose automatically, then each thread; A calls `texthook_select`, B goes back);
  then Show card, Move and resize (left stick
  moves the text box's top-left, right stick drags its bottom-right, the D-pad nudges 4 pt; A or B
  keeps it as a move does, turning Auto align off, if it moved), Auto align, Text size (the −/+ step),
  Background (the opacities) and Look (`overlayStyle.appearance`: app, light, dark, blend). Every
  change is saved as it is made; A does nothing on a stepped row (left/right step it), and no press
  counts in the panel's first 300 ms (the press that chose Card). The card
  stays up while the panel is open or it is being placed (`holdsCard`); before any line has come,
  as an example (`HOOK_EXAMPLE`, marked "Example", `data-example`) in the reader's settings,
  replaced live by the first line. In Gaming Mode the card is
  drawn bare (`data-bare`: no bar, −/+, ⋯ or corner), since nothing can point at them.
- `textHookerShowCard` (default true; Settings → Text Hooker → Card, and the panel above): off,
  the card is not drawn except while Read along or the panel holds it, and Auto align's background
  OCR does not run. Lines still reach the Log.
- The controller's Recent text lists the Log's newest lines (`log_recent`), whatever their source,
  falling back to `scannedTextHistory` when the Log has no open session.

Per game, `textHookerGames[<exe path, lowercased>]` (`ui/overlay.js`):

- `autoAlign` (the default's when unset; the older `placeWithOcr`, or `ocr: "none"` for off, are
  read first): **Auto align**, in Settings → Text Hooker and under Show overlay in the sidebar
  (both set the game's own value; one equal to the default is not stored, so the game follows
  the default, and no setting shows as changed while it equals the default). On, Auto OCR runs in the background
  with the scan engine (`ocrMode`, shown in the sidebar again), whatever the Auto OCR switch says,
  and each reading is matched against the newest line (`ui/hook-match.ts` `hookAnnotations`:
  groups, runs of stacked groups and runs of lines within a group, scored by LCS recall and
  precision after folding width and dropping punctuation; recall ≥ 0.6, precision ≥ 0.55). A new
  line does not wait for the loop to see the screen settle: the overlay reads at once
  (`SceneScanner.refresh`) and again at 0.3, 0.7, 1.2 and 2 s while no reading has found it whole,
  the later reads looking again at text already read (`Scene.lookAgain`: it may have been read
  while fading in), and logs `hook-line-chase` `{placed, reads, ms}` (with OCR's blocks when it
  never was). Turning it back on (Settings, or the game menu's Text Hooker panel) forgets `text` and
  `leading` (a size set by hand) but keeps `ocrBox` and `surface`, so the card goes straight back to
  where it last found the game's text; the overlay then forgets which line it placed and reads at
  once (`realignHookCard`, logged `hook-card-realign`), so the line is measured again and the card
  follows if the text has moved.
- `text`, `leading`: the text's size (a fraction of the window's height) and line pitch (in ems).
  Auto align sets them from the first whole reading (recall ≥ 0.9, precision ≥ 0.8: the size from a
  line's ink width over its characters, the hooked line's when OCR read exactly it on one line) and
  then keeps them; only whole readings of two different lines, both more than 30% off and within
  15% of each other, replace the size. Each reading counts once, however often it is applied. The card's −/+ set `text` a tenth at a time. Resizing the card
  never changes it.
- `ocrBox`: where Auto align puts the text, `{x, y, width, height}` of its ink, fractions of the
  game window. The first whole reading of a new line puts it there; after that, where it starts
  moves only when two whole readings in a row put the text more than a line away, and its width and
  height only grow, to the furthest the text has reached. Once a reading has placed the line, the
  card wraps it onto no more lines than the game does (its ink's height), shrinking the text for
  that line, by up to a fifth, if it must. Until then the card is on the last line's box, and while the overlay is looking
  for the new line it holds it on one line, faded out where it runs past the box, rather than
  wrapping it into a box made for another line; if no reading finds it, it wraps as it is.
- `box`: where the reader left the card's text box, same units. Kept apart from `ocrBox`, so turning
  Auto align off puts the card back. With neither, the card is centred along the bottom.
- `surface`: what the game's text sits on (`{ink, top, bottom}`, surface.rs), from the last whole
  reading. With the overlay look set to Blend the card takes those colours, but only while it is
  over the game window; otherwise, and before a reading, it is the app's light or dark. The card
  fades between colours (500 ms).
- `opacity`: the card's background opacity (1, 0.85, 0.7, 0.55 or 0.4); the text stays opaque.
- `namesApart`, `nameBox`: the game shows its speakers' names apart from what they say (a
  nameplate over the text box), and where the last one was (same units as `ocrBox`). A hooked
  line a short name leads, then one quote and nothing else (`アキ「……」`, `【アキ】「……」`;
  `hook-match.ts` `splitSpeaker`), is placed by its quote alone when OCR finds the name on a line
  of its own above the quote, before it on its row, or near `nameBox`: the card shows the quote,
  and the name is drawn where the game shows it as OCR text is (hovered and looked up the same),
  carrying the hooked name. That sets `namesApart`, after which such a line's card shows the quote
  from the start, and the quote alone wherever it is found whole even if OCR missed the name. A
  name the game shows inline, and narration that only looks like a speech (`そして「……」`), stay
  whole: their quote alone is not a whole reading. The Log keeps the line as hooked.

Lines reach the Log and the card after a game's typewriter effect is undone (`text_hook/pick.rs`
`typewriter_lines`): a burst of frames, each a prefix of the next, short at first and growing a
little at a time, is the sentence it ends on, and a burst holding two such runs (a line finished
with a click, the next typed out) is two lines. Of the ways to read a burst, the one taken leaves the
least text in sentences, so a row of one character ("ーーー", "……") is not mistaken for frames. A
line whose typing pauses longer than the hooker waits arrives in two bursts: the second carries
on the first (`typewriter_lines_after`, within 5 s), and its line is sent with `replaces`, the id
of the line it finishes, which the Log replaces rather than adding to. With verbose logging on,
each burst of the chosen thread is logged as `texthook-burst` (`{text, lines, carriesOn}`).

### Sidecar protocol (`kimochi-hookd`)

`kimochi-hookd-x64.exe luna --dir <LunaHook dir> [--flush-ms N]` or
`… textractor --dir <Textractor dir>` reads one JSON command per line on stdin and writes one
JSON event per line on stdout; closing stdin detaches every process and exits.
`kimochi-hookd-{x64,x86}.exe inject --pid N --dll <path>` injects one DLL
(`CreateRemoteThread(LoadLibraryW)`); the x64 sidecar runs the x86 build for 32-bit games.
`kimochi-hookd-x64.exe processes` writes one `process` event per running process
(`pid`, `parent`, `name`, `path` or null, `bits` 32/64 or null) and exits; on Linux the app runs
it in a Wine game's prefix to learn the game's id there.

| Command | Fields |
| --- | --- |
| `attach` | `pid`, `bits` (32/64, from the process; the other bitness is tried if the first never connects), `pcHooks`: `"auto"` (default: the generic Windows API hooks only when no engine is detected) / `"on"` / `"off"` |
| `detach` | `pid` |
| `insert` | `pid`, `code` (an H-code) |
| `pchooks` | `pid` |
| `quit` | |

| Event | Fields |
| --- | --- |
| `ready` | `engine`, `version` |
| `connected` / `disconnected` | `pid` |
| `attached` | `pid`, `bits`, `reused?` |
| `attach_error` | `pid`, `text` |
| `thread` / `thread_removed` | `key` (`pid:addr:ctx:ctx2`, hex), `pid`, `addr`, `ctx`, `ctx2`, `hookcode`, `name` |
| `text` | `key`, `pid`, `text` (one sentence) |
| `hook` | `pid`, `addr`, `hookcode` (a hook was inserted) |
| `info` | `level` (`console`, `warning`, `engine`, `emulator`), `text` |
| `error` | `text` |

## App updates

Kimochi updates itself from the project's GitHub Releases through `tauri-plugin-updater`
(`src-tauri/src/updater.rs`). The endpoint, `plugins.updater.endpoints` in `tauri.conf.json`, is
the *latest* release's `latest.json`, which GitHub resolves to the newest published,
non-prerelease release: pre-releases and the draft a `v*` tag creates are
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

## Command line

The `kimochi` command (`src-tauri/src/cli/`; the user's guide is
`site-docs/src/content/docs/reference/cli.mdx`). It is the app's own executable: `main` calls
`cli::run_if_invoked()` before anything else, and a first argument that is a bare word (or
`-h`, `--help`, `-V`, `--version`) runs the client and exits instead of the app. The app is only
ever launched with no arguments, a `kimochi://` URL or an internal `--flag`, none of them a bare
word (`cli::is_cli_args`); a typo is an unknown command, never a launch. Because it returns before
`platform::instance::take_over` and the single-instance plugin, a command never quits the running
app (macOS) or exits for it (elsewhere). macOS's take-over sweep reads each `kimochi` process's
arguments (`KERN_PROCARGS2`) and leaves command-line processes alone, so starting the app does not
kill a `kimochi watch`.

| Command | Signature |
| --- | --- |
| `cli_status` | `() -> CliStatus` |
| `cli_install` | `() -> CliStatus` — macOS may show the system's administrator prompt; `invalid: cancelled` when it is dismissed |
| `cli_uninstall` | `() -> CliStatus` — removes only a link or shim that is Kimochi's |

`CliStatus` is `{installed, builtIn, stale, path, target, onPath, note}`: `path` is where the
command lives, `target` what it runs, `builtIn` the Linux `.deb`'s own `/usr/bin/kimochi`,
`stale` a Kimochi command that runs another copy (a moved app), `note` a sentence for the page.
macOS links `/usr/local/bin/kimochi` (privileged through `osascript … with administrator
privileges` when the folder isn't writable); Linux links `~/.local/bin/kimochi` to `$APPIMAGE` or
the executable; Windows copies the console launcher (`cli-launcher/`, staged into the bundle's
`cli/kimochi-cli.exe` by `scripts/prepare-cli-launcher.mjs`) to
`%LOCALAPPDATA%\dev.kimochi.app\bin\kimochi.exe`, writes the app's executable path beside it as
`kimochi.target`, and adds that folder to the user's PATH (PowerShell, keeping `%VARIABLES%`
unexpanded, then a `WM_SETTINGCHANGE`). A release build on Windows is a GUI program, which a shell
neither waits for nor hands its standard handles (so no redirect or pipe would reach it); the
launcher is a console program, runs the app's executable with its own handles and exit code, and
`cli/console.rs` attaches the app's executable to the launcher's console (Ctrl+C reaches both). The
installed launcher counts as out of date when it differs from the bundled one or names another
executable.

**The wire.** At startup the app binds `127.0.0.1:0` and writes `cli-endpoint.json`
(`cli-endpoint-dev.json` for a development build) to its data folder, 0600:
`{port, token, pid, version, flavor, protocol}`; it removes the file at exit when it is still its
own. Each connection carries one request line `{token, method, params}` and gets one reply line,
`{ok: true, result}` or `{ok: false, error}` with the usual error prefixes (`timeout:` too).
A wrong token is refused. It is not HTTP, so no web page can drive it. The client tries its own
flavor's file, then the other's, and treats an endpoint that does not answer `ping` as not running;
a command that needs the app then starts it (`open` on the bundle on macOS, the AppImage or the
executable detached elsewhere) and waits for `ping`.

| Method | Params | Result |
| --- | --- | --- |
| `ping` | — | `{version, pid}` |
| `status` | — | `{running, pid, version, source, cropEnabled, ocrEngine, input, dictionary, autoOcr, scanning, overlay, textOverlay, status, lastScan, session, profileDir}` |
| `settings.get` | `{key?}` | the value (defaults merged), or every setting |
| `settings.set` | `{key, value}` | the stored value; through `apply_setting`, as `settings_set` |
| `action` / `actions` | `{name}` / — | `actions::dispatch`; `ACTIONS` |
| `toggle` | `{flag: autoOcr\|overlay\|textOverlay, to: on\|off\|toggle}` | `{<flag>: bool}`, after the overlay has written the new state back (`view_flags`) |
| `scan` | `{wait?, timeout?}` | dispatches `triggerScan`; with `wait`, the next published scan's `{text, engine, id}` |
| `ocr.engines` / `ocr.set` | — / `{engine}` | `{selected, engines}` from `platform_capabilities`; an engine held back only by its model may be chosen (its download starts) |
| `source.list` / `source.set` / `source.clear` / `source.choose` | — / `{query}` / — / — | `sources::catalog`; `select_keeping_crop` on the source matched by id, title or app; `sources::clear`; `choose_source` |
| `open` | `{view: main\|log\|notebook\|anki\|settings\|sources\|mini\|expand\|dictionary, page?}` | `{opened}`; `log`, `notebook` and `anki` emit `main:show-view` `{view}`, which leaves Settings |
| `quit` | — | replies, then quits as `app_quit` |
| `log.recent` | `{limit?}` | `log_lines::recent` |
| `log.add` | `{text}` | `{added}`: the Log's `host.ingest` with source `cli`; `added` is false when the Log's filters dropped it (its line count and last text are unchanged) |
| `session.list` / `session.switch` / `session.new` / `session.rename` | — / `{query}` / `{name?}` / `{name, query?}` | the manifest; the Log's `sessions` module |
| `watch` | `{events?}` | a first reply, then one JSON line per event until the client closes: `scan`, `line`, `source`, `state`, `session`, `action` |

**The Log owns its files**, so session changes and `log.add` go through its request channel:
native emits `reader:request` `{id, module, method, args}` and waits for the `reader:response` with
that `id` (frontend/texthooker/host.ts), after a `host.snapshot` has answered (the Log window may
still be loading on a cold start). Reads (`session list`, `log`) come from the files, which the Log
writes a moment after each change, and work while the app is closed (`account::profile_dir_offline`
finds the profile in `accounts.json`). A line with source `cli` is taken whatever the Log's input is
(`acceptsInput`). `watch` follows `state` for scans, sources and switches, `reader:snapshot` for
lines and sessions (only lines newer than the last one it saw, never history), and `hotkey` for
actions.

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

## Native Wayland capture: sources by window identity (Linux only)

Where the compositor has its own capture API, `platform_backend()` returns capture-core's
`NativeCapture` (`capture-core/src/linux_native/`) instead of the ScreenCast portal:
`capabilities.session.captureBackend` is `native-mutter` (GNOME, through Kimochi's Shell extension
and `org.gnome.Mutter.ScreenCast`), `native-kwin` (KDE Plasma 6, `zkde_screencast_unstable_v1` and
`org_kde_plasma_window_management`) or `native-ext` (Hyprland, Sway ≥1.12, COSMIC:
`ext-image-copy-capture` with `ext-foreign-toplevel-list`, plus Hyprland's or Sway's IPC for
geometry). Then `capture.pickerRequired` is false, `sources.catalog`, `thumbnails`, `icons`,
`followWindowBounds`, `foregroundTracking`, `activateWindow` and `nativeWindows` are true, and
`capture.isolatedWindows` says a window's stream holds that window alone.

Source ids are `wayland:window:{handle}:{pid}` and `wayland:display:{connector}` (the handle is the
compositor's own window id: Mutter's, KWin's uuid, or the ext identifier). `source_catalog`,
`source_thumbnail`, `source_icon`, `source_window_state` and `activate_source` answer for them as
on X11; `linux_window_geometry`'s link dialog and **Relink window overlay…** exist only for portal
sources. A minimised window, or one on another workspace, captures as `unavailable` (`gone: hidden:`);
a closed one as `stale_source`. `KIMOCHI_WAYLAND_CAPTURE=portal|mutter|kwin|ext` forces a choice.
On GNOME, `gnome_overlay` `track` takes `{operation: "bind", sourceId}` for a native window (the
Shell's overlay then follows it by id) and the extension's `Windows` method lists and activates
windows; startup updates an older extension in place (`gnome::refresh_for_native`). On Plasma ≤6.7
an AppImage or dev build writes a hidden `dev.kimochi.KWinCapture.desktop` naming its executable
(`native::authorize_kwin`); the .deb ships `kimochi-screencast.desktop`.

## Optional Wayland window geometry: Hyprland and KDE Plasma (Linux only)

`linux_window_geometry({operation, sourceId, windowAddress?}) -> Value` operates on
the current portal window share, through `platform/linux/tracking.rs`: Hyprland's IPC socket
(`hyprland.rs`) or, on KDE Plasma, a KWin script bridge (`kwin.rs`). `status` reports
availability/link state (`{available, linked, bounds, visible}`); `candidates` lists windows
matching the real captured frame size (`{address, title, app}`; on KDE `address` is KWin's
window id); `link` explicitly associates the selected candidate for this app/share lifetime.
`pointer` returns optional read-only compositor `{x,y}` coordinates (overlay-local) without
capturing a frame or claiming knowledge of buttons/modifiers. The layer overlay uses these to
recover missed leave events and clear stale hover/reading holds where Shift is not gated (with
the gate, the native pointer feed below replaces that poll). Unique matches are automatic;
ambiguous matches use the source panel's **Relink window overlay…** dialog. Capture permission
still comes from the portal. Missing/unsupported geometry retains the source-image crop fallback
and does not place annotations at an invented origin. See `platform/linux/DEPS.md` for limits.

- **Hyprland:** native layer-shell and one unrotated output at (0,0). Native Wayland and XWayland
  clients (Proton/Wine games) match; an XWayland buffer is either the window's logical size or, with
  `xwayland:force_zero_scaling`, the output's scale. Kimochi's own windows never make a size
  ambiguous (a tiled Log and game often split the screen equally).
- **KDE Plasma (KWin 6; 5.27 best-effort):** Kimochi serves `dev.kimochi.KWinBridge` at
  `/dev/kimochi/KWinBridge` on its own session-bus connection and loads a KWin script
  (`org.kde.kwin.Scripting`, plugin `kimochi-bridge`) that pushes window snapshots on change
  (`Push(s json)`) and long-polls commands (`Next() -> s`, answered by `Reply(i seq, s json)`:
  `snapshot`, `pointer`, `activate`). Only KWin's own bus name may call it. KWin's window
  streams are the whole frame (title bar included) at the output's scale, so the frame is
  matched; native Wayland and XWayland windows, fractional scales and several outputs are
  supported: Kimochi's layer surfaces move to the linked window's output
  (`gtk_layer_set_monitor`) and bounds/pointer are relative to it. A linked window stream holds
  only that window, so captures of it no longer hide the overlay (no flicker).
  `activate_source` on a linked `portal:window:` source asks the script to restore, switch
  desktop to and activate it. `KIMOCHI_KWIN_WINDOW_TRACKING=0` disables the bridge.

### Wayland Shift gate

A keyboard-NONE layer overlay sees no Shift, so the native pointer poll (`spawn_cursor_poll`) gets
one from `platform/linux/shift.rs` and the pointer from `tracking::pointer()`; with both,
`platform::cursor()` answers on Wayland as on X11 and the overlay's words are Shift-gated
(`View::live_regions`, `state::ShiftGate`) exactly as on macOS/Windows.
`capabilities().overlay.shiftGate` says so and `overlay.shiftSource` names the source (`x11`,
`xwayland`, `portal`); without one both are off and the words take the mouse.

- **KDE Plasma:** KWin hands XWayland the modifier keys whichever window has the keyboard while
  `[Xwayland] XwaylandEavesdrops` (Legacy X11 App Support) is not `None` (Plasma 6 default:
  `Combinations`), so a private X11 connection reads them from `QueryPointer`'s mask. The poll
  relays Shift's edges as `linux-dictionary-modifier` for the overlay's DOM-event path. When the
  setting is `None`, `overlay.lookupOnHover` is true instead and the overlay's text looks up on
  hover (`host/linux-scan-input.js` `hover`).
- **Hyprland:** the two `dictionaryShift*` portal bindings, once one has fired. Hyprland fires
  only bindings its config names, so Kimochi binds them itself while it runs (below); until a press
  arrives, `overlay.lookupOnHover` is true and the overlay's text looks up on hover, as on KDE.

**Hyprland binds** (`platform/linux/hyprland_binds.rs`). Hyprland's GlobalShortcuts portal
registers `dev.kimochi.app.*` but ignores `preferred_trigger`. After `BindShortcuts`, Kimochi adds a
runtime-only bind per shortcut over the IPC socket, dispatching `global` to the name Hyprland listed
(`j/globalshortcuts`, `<app id>:<id>`): `keyword bindd …` on a `hyprland.conf` session, `eval
hl.bind(…)` on a Lua one (which refuses `keyword`). The Shift pair is non-consuming, transparent
and ignores mods. Each bind's description starts `Kimochi: `, so one left by a crash is taken back.
A combination the config already binds is left alone and reported in
`globalShortcutReport.failed` (`hyprland: true`, shown as `globalShortcutRemediation`) unless the
bind dispatches to that shortcut (legacy binds say so; a Lua bind is opaque, so a description
naming Kimochi counts, and a shortcut that then fires drops its failure). The binds are re-added on
the event socket's `configreloaded` and removed by `shortcuts::stop` (re-apply and quit). Nothing
is written to the config.

The compositor is asked for positions (≤ ~80/s) only while Shift is held or the gate is still open
(`platform::pointer_demand`); otherwise the poll reads the modifiers alone. Buttons are known only
over an X11 window; over Wayland ones the overlay takes them from its own surface's DOM events.
`KIMOCHI_WAYLAND_SHIFT=0` turns the gate off. The gate follows `overlayLookupKey` where every
modifier is readable (X11, XWayland; `platform::lookup_keys_readable`); with Hyprland's portal it is
always Shift, and Settings offers the Lookup key row on Wayland only for `shiftSource: "xwayland"`.
On KDE `sources.activateWindow` is true while the KWin bridge is up (`tracking::can_activate`).

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

`status` also reports `installed` (the extension's files are in place) and `current` (they are
this build's metadata, loader and implementation), and, when installed, `enabled` (GNOME's
`enabled-extensions` lists it; off once the reader turns it off in the Extensions app). The welcome guide's GNOME step calls
`install`, as does the source panel's notice while the overlay is unavailable for want of the
extension; there is no Settings control. At launch, before the capture backend is chosen, native
updates an installed extension that isn't `current` or isn't running this build's revision
(`gnome::keep_current`). It never installs one that isn't there, and leaves one alone that the
reader turned off in GNOME's Extensions app (`install` would turn it back on). A live `install`
or `update` emits `platform-capabilities`.

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
game being played, else the screen. Afterwards the source follows the game Gamescope brings to the
front (switching through Steam): when the selected source is another game's window, the game now in
front is selected with its own saved crop (`gaming_sources::follow`); the screen and other sources
stay.

Event `gamescope-shown` (a bool): whether Gamescope is showing Kimochi rather than a game or Steam,
emitted on every change and again every 5 s. The main window pauses its CSS animations while it
is false (`[data-behind-game]`): mapped behind the game, WebKit would otherwise keep painting them.

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

### Clean game voices

On Windows, sentence audio injects the matching x86/x64 voice DLL through the existing hookd
helper into the explicitly selected Text Hooker game processes. The DLL injected is a copy keyed
by its content under `%LOCALAPPDATA%/kimochi-voicehook/bin/<hash>/` (a game keeps an injected
file locked until it exits, which would stop Kimochi from being updated). Captures are
discovered under `%LOCALAPPDATA%/kimochi-voicehook/<pid>-<time>`; DirectSound buffers made before
injection (Kimochi attaches to running games) are asked for their size, so streaming rings are
not taken for loops. The build stages both DLLs with the helpers. Unsupported engines, failed
injection, missing/invalid clips and ambiguous timing all use the existing system-audio
listener. Linux and macOS retain that listener. Web-game launch adapters are outside this
integration.

Unity (Mono) games, attached while running: the DLL takes each `AudioSource` internal call from
Mono's table and repoints the compiled wrapper that calls it, and names each clip by its
AudioSource's GameObject when that is an asset path (`Sound/Voice/ch01_003.ogg`), so the voice
folder groups and names the voice. Their text is read by the DLL as well: for a Unity Mono game
(`UnityPlayer.dll` and `<name>_Data/Managed`), or once LunaHook reports a `…:JIT:UNITY` hook it
could not insert, Kimochi creates the event `Local\voicehook_text_<pid>`, injects the DLL (even
with sentence audio off) and starts the hooker only once the DLL watches
`TMPro.TMP_Text.set_text` (a breakpoint on its first instruction, so no memory near the JIT code
is needed; up to 10 s). The DLL writes `{"ev":"text","obj","text","t"}` events; each `TMP_Text`
object is a thread with hookcode `UNITY:TMP_Text.set_text`, its lines sent with the DLL's time,
whole (never joined as rows). The thread choice skips objects that have said one thing only
(labels) and hands the choice from a hooker thread over to a Unity object showing the same text.

The `hooked` diagnostics object is `{captures, clipsSeen, matched, lagMs, leadMs, typingMs,
rejected, groups, error}`; groups carry `{group, voice, clips, medianDur, named, reasons}`.
`hookError` describes helper failures separately. A hooked line is shown as `how: "hooked"` in
the Log and Diagnostics, kept as MP3, and used for sentence audio on cards. Hooked clips have no
character alignment, so they do not invent word-audio boundaries. Typewriter text updates
retain the same clip. `sentence_audio_debug` runs off the main thread.

Matching uses names/channels, looping, duration, mono format and repeated alignment with text
anchors; groups are judged only on clips played within 20 s of a Log line. Unnamed streams need
at least three clips and a clear score advantage over groups large enough to judge. A voice may
start `leadMs` before its line arrives (700 ms at first, learned within 0.4–1.5 s) or `lagMs`
after (1.5 s, learned up to 4 s), each clip measured from its nearest line. Engines that hand a
row over once it is typed (KiriKiri, NScripter) start its voice earlier the longer it is: a typing
delay (`typingMs`, 0–200 ms a character) is learned when it explains clearly more voice starts
than none, and moves hook lines' anchors back. Until five voices have settled the timing, a late
start (or a narration row's claim on a voice a quote row arriving soon after may own) waits.
Lines opening a quote (「 or 『, after a name at most) are preferred, and a row carrying on a quote
opened by an earlier row shares that quote's clip. A match waits while a sound of the voice's
stream that started in the line's window is still playing. Simultaneous ambiguous candidates
fall back. With speech detection available (Silero, not the speech model), a candidate of 1.5 s
or more with essentially no speech (effects in the voice's format) is set aside (`rejected`).
Lines stay matchable as long as clips are kept, so a slow pass catches up.

Once the game's voices are established (a stream named as voice, three matches, or a stream
remembered from an earlier session while its capture runs), a line given no clip is kept silent
rather than given system audio placed by timing alone; a match by the line's words still
counts, on every path (the listening pass and cards). Each game's voice stream and typing delay
are remembered by executable in `%LOCALAPPDATA%/kimochi-voicehook/games.json` (`{exe: {group,
typingMs}}`). Unfinished streams wait at most 15 seconds before fallback; a card waits up to 30 s
while the game's own voice for its line is still expected. Speech recognition is skipped while
all recent lines are hooked or waiting for their hooked clip. Disabling `voiceHook` immediately
stops using captures; an already-loaded DLL stays until game exit, with at most 256 saved clips
and a 128 MiB clip budget per capture. The reader prunes clips older than ten minutes, and
captures untouched for an hour that belong to no hooked process are removed.
