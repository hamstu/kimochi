# Kimochi Next — native command & event reference

Public API of the Rust backend in `src-tauri/`. This is the integration contract for
all workstreams: the coordinator's source picker, the React panels, and the overlay /
OCR frontend.

## Status of this document

Everything listed here is **implemented** in `src-tauri/` and passes static checks:
`cargo clippy --all-targets -- -D warnings` clean, and 52 unit tests green.

**Nothing here has been verified by running the application.** Static checks and
runtime behaviour are different claims, and only the first is made. In particular the
capture path, the tray, the gamepad reader, the `keytrigger` sidecar and the Yomitan
settings window have never been exercised against a live window server. See
[RESULTS.md](RESULTS.md) for what has actually been run.

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
`hotkeys.<name>.{accelerator,enabled,gamepadButton}`, `scannedTextFontSize` (14),
`scannedTextHistory[]`, `audioSettings.voiceId`,
`autoScanSettings.{enabled,triggerKeys,scanDelay,gamepadButton}`,
`autoOCRSettings.{pollInterval,imageHashThreshold,localOCRSimilarityThreshold,localOCRGateEnabled,adaptivePollingEnabled,adaptivePollMin,adaptivePollMax}`,
`texthookerSettings.{copyToClipboard,sendToWebSocket,webSocketUrl}`,
`gamepadSettings.{enabled,preferredGamepadIndex}` (enabled defaults true),
`lastSelectedSource.{sourceId,type,name,appName}`,
`yomitanSettings.{popupType,customApiUrl}`, `serverSettings.{mode}` (`'cloud'`),
`textOverlayGrouping.{enabled,proximityThreshold,filterSmallText,filterSmallTextThreshold}`
(`false, 100, true, 0.75`), `overlayOpacity` (80), `liveOverlayEnabled` (false),
`ocrMode` (`'cloud' | 'local' | 'websocket'`, default `'cloud'`), `endpoint` (unset by
default — see below).

**The OCR endpoint follows `serverSettings.mode` unless genuinely overridden.** A custom
`endpoint` wins; otherwise the URL is derived as `<base>/detect-text` from the mode
(`https://kimochi-server.hamish.workers.dev` or `http://localhost:3000`, from
`src/shared/constants.ts`). An `endpoint` that merely *equals* one of those two built-in
defaults does **not** count as custom — otherwise an inherited cloud default, or one the
POC's preferences round-tripped, would permanently pin the app to cloud and make the
Local toggle silently do nothing. `preferences()` reports the resolved endpoint, so the
value shown is the value a scan will use.

`serverSettings` is an object, not a flat `serverMode` scalar, because `background.ts`
and `AudioPlayer.tsx` read it through `useSetting<ServerSettings>('serverSettings', …)`.
`textOverlayGrouping` and `overlayOpacity` never appear in `src/main/settings.ts`
because `electron-store` is permissive and they are written only through `useSetting`;
their defaults come from the call sites (`OverlayApp.tsx:46-51`), the only authority
for them.

**Map keys are literal.** `cropRegions` and `cropScanEnabled` are keyed by application
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
`pin`, `unpin`, `inspect`. `show_inactive` presents without stealing focus, which is
what passive updates must use so the source application keeps keyboard focus.

`PanelInfo` is `{label, native, bounds, scale, pinned, focused, resizable, visible}`,
where `native` reports `{level, opaque, ignores_mouse}`.

| Label | Page | Notes |
| --- | --- | --- |
| `controller` | `app/panel.html` | Fixed width, sizes to content, pinned by default |
| `log` | `app/panel.html` | Pinned by default |
| `settings`, `capture`, `debug`, `stream` | `app/panel.html` | Label-parameterised React shell |
| `source-picker` | `app/source-picker.html` | The only source UX |
| `welcome` | `app/welcome.html` | Onboarding |
| `tray-popover` | `app/tray-popover.html` | Fixed size, dismisses on blur |
| `yomitan` | `settings.html` | Yomitan's own distributed page, system window frame |
| `fixture` | `ui/fixture.html` | Diagnostic Japanese test source |
| `fixture-chunks` | `ui/fixture-chunks.html` | Split-word source for cloud OCR lookahead checks (macOS menu: Panels → Split-Word Fixture) |
| `overlay` | `ui/overlay.html` | Transparent, click-through, hosts the Yomitan backend |

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

**Events:** `state` (the full snapshot, emitted whenever anything a panel renders
changes — panels should subscribe rather than poll); `panel:state` `{label, visible, pinned, bounds}` on every show/hide/place/
pin path including the tray popover's blur dismissal; `panel:closed` `{label}`;
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

## Capture and OCR

| Command | Signature |
| --- | --- |
| `enumerate` | `() -> [Source]` |
| `permission` | `() -> bool` — **requests** Screen Recording access |
| `permission_status` | `() -> "granted" \| "not_granted"` — read-only, never prompts |
| `capture_frame` | `({request}) -> {id, info, url}` |
| `ocr_frame` | `({id}) -> {id, info, ocr}` — pure |
| `scan_state` | `({scanning?, status?, scan?, publish?}) -> {revision, published}` |
| `scan` | `({request, ocr}) -> {id, info, ocr}` |
| `clear` | `() -> ()` |
| `snapshot` | `() -> ViewState` |
| `regions` | `({rects}) -> ()` |
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
browser Tesseract, WebSocket / OwOCR and any other local backend; that orchestration
lives in the overlay webview, not in Rust.

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

`scan` (the command) retains its POC signature, remains the Rust-side `/detect-text`
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

`watch_source` emits `source-bounds` `{sourceId, bounds, onScreen}` when the tracked
window moves, resizes or changes on-screen state. It polls `CGWindowListCopyWindowInfo`
for one window id rather than re-running a full `SCShareableContent` enumeration per
tick, which would be far too expensive at this cadence, and needs no Screen Recording
permission because it reads geometry, not pixels.

A second watch emits `source-focus` `{focused, present, held}` when the answer to
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
the focus. Any other application takes precedence immediately. With no frontmost
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

### `snapshot()` and the `state` event

Carries the POC fields (`revision`, `scan`, `status`, `logs`, `interactive`, `regions`,
`origin`, `dictionary`, `dismiss`) plus, so panels can stop polling expensive sources:
`source` (the frontend-shaped descriptor), `crop`, `cropEnabled`, `isScanning`,
`autoOcrEnabled`, `overlayVisible`, `textOverlayVisible`, `debugOverlayVisible`,
`frontmostApp`, `sourceFocus`, `accessibility`, and `action` `{name, seq}`.

`regions` is keyed by the window label that published each set: the overlay owns the
words it drew and the dictionary popup owns the popup, and a press has to be
attributable to one of them or clicking the dictionary would count as clicking away
from it.

## Actions, hotkeys and input

All input paths converge on one dispatcher, so a keyboard shortcut, a gamepad button, a
keyboard auto-scan trigger, the tray and a panel can never fire two different code paths
for the same action.

| Command | Signature |
| --- | --- |
| `hotkeys_load` | `() -> HotkeysSettings` — defaults merged with overrides |
| `hotkeys_save` | `({hotkeys}) -> {registered, failed}` |
| `hotkeys_reapply` | `() -> {registered, failed}` |
| `trigger_action` | `({name}) -> ()` |
| `tray_action` | `({action}) -> ()` |

All names live in one list, `actions::ACTIONS`, which the command-contract test reads
and compares against the names the frontend actually calls, so a button cannot ship
against an action that does not exist.

**Commands** — `triggerScan`, `toggleOverlay`, `setCropArea`, `playAudio`,
`selectAndScan`. Bindable to a shortcut or a gamepad button. Rust performs the native
part Electron performed: restoring the overlay for `triggerScan`, `setCropArea`,
`playAudio` and `selectAndScan`, toggling it for `toggleOverlay`, and focusing it for
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

Accelerators use Electron's exact syntax and defaults from `src/shared/defaults.ts`.
Verified against the parser rather than assumed: `global-hotkey` accepts
`COMMANDORCONTROL` (mapping to Super on macOS) and digit names such as `8` → `Digit8`,
so `CommandOrControl+Shift+8` registers unchanged. Per-key registration failures are
reported in `failed` instead of disabling the whole set silently.

**Keyboard-triggered auto-scan** reuses the Electron tree's `keytrigger` sidecar
(`bin/keytrigger-darwin-{arm64,amd64}`, bundled as a resource, with a repo fallback for a
dev run). Its line-delimited JSON gives key events and frontmost-window changes. A key
in `autoScanSettings.triggerKeys` fires `triggerScan` after `autoScanSettings.scanDelay`,
matching Electron. Key events require macOS Accessibility; that state is reported as
`snapshot().accessibility` and through `system_state()` so the UI can say so honestly.
Nothing probes or prompts on its own — `open_accessibility_preferences()` exists for an
explicit user action.

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

`ext_relay` emits `ext-relay` `{from: <sender label>, payload}` to `target`, or to every
window when `target` is null. Deliberately generic: no Yomitan knowledge lives in Rust.
It exists so the Log panel and the Yomitan settings window can reach the single Yomitan
backend in the overlay without standing up a second one.

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

**Single backend, single database.** `host/shim.js` is injected into `overlay` only.
The `yomitan` window gets `/spike/panel-shim.js` instead, resolved through Tauri's asset
resolver at window creation so this crate does not compile against a file another
workstream owns. No window sets a data store identifier, so every webview shares one
`WKWebsiteDataStore` and `tauri://localhost` resolves to the same IndexedDB everywhere.
**That is a static reading of the code, not a runtime observation** — the launch smoke
test is to open the Yomitan window and confirm its installed dictionary count matches
what the overlay reports.

## System, tray and lifecycle

| Command | Signature |
| --- | --- |
| `system_state` | `() -> {frontmostApp, accessibility, displays}` |
| `app_quit` | `() -> ()` |
| `open_screen_capture_preferences` | `() -> ()` |
| `open_accessibility_preferences` | `() -> ()` |

Emits `system-suspend` and `system-resume` from
`NSWorkspaceWillSleepNotification` / `NSWorkspaceDidWakeNotification` — the macOS
equivalent of Electron's `powerMonitor`, which Tauri does not wrap. Consumers should
tear down and re-establish capture state across a sleep exactly as Electron does.

Emits `frontmost-app` `{appName, windowTitle?, appPath?}` from the `keytrigger` sidecar
and from `NSWorkspaceDidActivateApplicationNotification`. **The name is raw and
unfiltered on purpose.** Kimochi's own windows are not filtered out, because a consumer
needs to distinguish "Kimochi is frontmost" (where the previous foreign app should stay
the effective focus) from "no signal yet" (where text must be shown, never hidden).

The tray uses the Electron build's macOS template icon, a left-click popover positioned
under the icon, and a right-click menu of Show Controls / Settings / Quit. Emits
`tray:action` `{action}`.

## OCR model downloads

The local engines' models are not bundled; only the ONNX Runtime libraries are. They are
downloaded on demand into `<app local data>/models/<engine>/` (`app_local_data_dir`: the app
data directory on macOS and Linux, `%LOCALAPPDATA%` rather than the roaming profile on
Windows) from the pinned list in `src-tauri/ocr-models.json` (repository, revision, URL,
SHA-256 and size per file). Implementation: `src-tauri/src/model_store.rs`.

`engine` is `"meikiocr"` or `"mangaocr"`. Every command answers with the engine's
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
`paused`. Setting `ocrMode` to a local engine whose models are `absent` (Settings, the
sidebar, or at launch) starts the download; a `paused` or `failed` one waits for Resume or
Retry. On Windows and Linux the automatic-scan observer reads frames with MeikiOCR whatever
engine is selected, so it starts the MeikiOCR download too and answers `busy` until it is
ready.

**Resolution order** for an engine's models: the downloaded store when complete and
verified, then `<resources>/<engine>/models` (a build that still bundles them), then
`src-tauri/resources/<engine>/models` (development). Bundled and development copies make the
status `ready` with that `source`; they cannot be deleted from the app.

**Gating.** While an engine's models are not usable, `platform_capabilities` reports it
`available: false` with a human `reason` — `Model not downloaded`, `Downloading model… 32%`,
`Verifying model…`, `Model download paused`, `Model download failed: <message>` — and adds
`model: <state>` so pickers keep the engine selectable (choosing it downloads). Every scan
path refuses with the same reason: `ocr_frame` and `scan` fail with
`"<Engine> is not ready: <reason>"`, and the observer as above. Switching to an engine whose
models are ready scans at once.

## Capabilities

`capabilities/core.json` grants `core:event:default` plus a few read-only window
queries (`is-visible`, `is-focused`, `is-minimized`, `scale-factor`) to our own window
labels. Without `core:event:default` a React panel's `event.listen` would build fine and
fail silently at runtime.

`capabilities/network.json` scopes `http:default` to `overlay`, `log`, `settings` and
`yomitan` — the last because dictionary downloads from the Yomitan settings window go
through the same plugin —
allowing only the configured OCR/TTS server (cloud and `localhost:3000`), the local
Yomitan API (`19633`) and AnkiConnect (`8765`), plus the dictionary hosts Yomitan itself
downloads from. It is deliberately not a general internet grant. WebSocket OCR
(`ws://localhost:7331`) needs nothing here: WebSocket bypasses the HTTP plugin.

## Platform gaps

Real limitations, recorded rather than papered over.

- **macOS only.** Capture, overlay geometry, icons, cursors, power, window tracking and
  the `keytrigger` sidecar are all macOS 14+ implementations. No cross-platform capture
  behaviour is claimed or implemented; Windows and Linux need separate backends.
- **Panels on a captured display.** Own-process exclusion covers Kimochi's windows in
  display captures; it has not been observed at runtime.
- **Inactive-window hover** is handled for panel button affordances through the native
  pointer hit test. It does not make arbitrary webview hover work in background windows.
- **Transparent windows** use Tauri's macOS private API feature, which is unsuitable for
  a Mac App Store claim.

## Optional GNOME Shell overlay (Linux only)

`gnome_overlay({operation, payload}) -> Value`: status/install/present/clear/definition.
Only the native Linux GNOME Wayland backend supports this bridge. The bundled extension
creates compositor-owned annotation actors; ordinary Tauri annotation windows stay hidden.
Screen annotations only, initially one monitor and GNOME46; portal window tracking stays deferred.
Installation preserves differing existing extension files and tells the user to save work
and log out/in when GNOME cannot discover the newly installed extension. No automatic logout.
`gnome-overlay-lookup` forwards native word click or Shift hover to the existing Yomitan backend.
The extension displays plain dictionary text; full Yomitan popup controls are not implemented.
