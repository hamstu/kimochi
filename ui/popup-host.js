/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The dictionary popup's own native window.
 *
 * ## What this is, and what it is not
 *
 * The popup rendered here is the original extension's: the original `Popup` builds
 * its iframe, the original `Display` runs inside it, `FrameEndpoint` and the
 * CrossFrameAPI ports connect them, and the original `PopupFactory` hands the whole
 * thing out to other windows over Yomitan's own `PopupProxy`. Nothing about the
 * dictionary UI is reimplemented. What is adapted is *where the iframe lives*: in a
 * small borderless always-on-top window instead of inside whichever panel owns the
 * scanned text, so a 720-point-wide log window stops being the popup's world.
 *
 * ## How the geometry works
 *
 * `Popup._getPosition` takes a viewport and returns a rectangle inside it, applying
 * Yomitan's own above/below preference, configured offsets and edge clamp. Give it
 * the work area of the display the scanned text is on, in desktop points, and it
 * answers in desktop points. So:
 *
 *  - the client adds its window's desktop origin to the source rectangles it sends,
 *    so what arrives here is already desktop points (see host/popup-bridge.js);
 *  - `_getViewport` is replaced with the anchor's display work area;
 *  - after `_show`, the rectangle Yomitan chose is taken off the frame and given to
 *    the window instead, and the frame is moved to the window's own origin.
 *
 * Two `Popup` internals are used by name — `_getViewport` and `_frame` — because
 * there is no public seam for either. They are the only ones, they are both read in
 * one place, and a Yomitan update that renames them will fail loudly at startup
 * rather than quietly misplace a popup: see `assertSeams` below.
 *
 * ## Nested lookups
 *
 * A lookup inside the popup makes a second `Popup` in this same document, and one
 * window cannot be in two places. The window therefore becomes the bounding box of
 * the whole visible chain and each frame is offset within it, which leaves every
 * popup exactly where Yomitan put it on the desktop.
 */

import {
  anchorViewport,
  asEdges,
  boundsOf,
  chainWindow,
  fitsIn,
  insetIn,
  withExtent
} from './popup-geometry.js'

const LABEL = 'popup-host'
const core = window.__TAURI__?.core
const invoke = (command, args) => core.invoke(command, args)
const report = (value) => void invoke('report', { value: { window: LABEL, ...value } }).catch(() => {})

const host = window.__kimochiPanelYomitan
if (!host) {
  throw new Error('The popup host needs the extension host shim injected by native.')
}

// The extension host fetches the manifest as it starts, and `Application.main` reads
// it on its first line. Starting before it is ready fails there rather than here.
await host.hub.ready

const [{ Application }, { PopupFactory }, { Popup }] = await Promise.all([
  import('/js/application.js'),
  import('/js/app/popup-factory.js'),
  import('/js/app/popup.js')
])

// Fail at startup rather than at the first lookup. If a Yomitan update renames either
// of these, the popup would still open — positioned against this small window instead
// of against the screen, or left wherever the window happened to be — and a popup in
// the wrong place is a worse failure than a window that refuses to start. `_frame` is
// assigned in the constructor, so it can only be checked on a real popup; `frameOf`
// does that.
for (const seam of ['_getViewport', '_getPosition']) {
  if (typeof Popup.prototype[seam] !== 'function') {
    throw new Error(
      `The popup host relies on Popup#${seam}, which this Yomitan build does not have.`
    )
  }
}

/** Desktop rectangle each visible popup has been placed at. */
const placed = new Map()
let anchors = []
let displays = []
let windowRect = null

async function refreshDisplays() {
  try {
    displays = await invoke('displays')
  } catch (error) {
    report({ check: 'popup-host-displays-failed', error: String(error?.message ?? error) })
  }
}
await refreshDisplays()

// The viewport Yomitan positions within: the work area of the display the scanned
// text is on, not the one this window happens to be sitting on.
let viewport = null
Popup.prototype._getViewport = function () {
  viewport = anchorViewport(anchors, displays, windowRect ?? { x: 0, y: 0, width: 1280, height: 800 })
  return viewport
}

function frameOf(popup) {
  const frame = popup._frame
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error('The popup host relies on Popup#_frame, which this Yomitan build does not have.')
  }
  return frame
}

/**
 * Record the rectangle Yomitan chose, at the moment it chooses it.
 *
 * Taken from `_getPosition`'s return value rather than read back off the frame's
 * inline style afterwards. The style is not a safe place to keep this: `relayout`
 * rewrites `left`/`top` to window-local coordinates, and the popup's own auto-resize
 * arrives from the `Display` asynchronously, so a resize landing between `_show` and
 * a read-back returns this module's own `0px` — which moved the window to the origin
 * of the primary display. `placed` is the single source of truth, and the frame's
 * style is only ever derived from it.
 *
 * Desktop points, because `_getViewport` handed `_getPosition` the work area of the
 * display the scanned text is on.
 */
const getPosition = Popup.prototype._getPosition
Popup.prototype._getPosition = function (...args) {
  const chosen = getPosition.apply(this, args)
  if (chosen.width > 0 && chosen.height > 0) {
    placed.set(this, { x: chosen.left, y: chosen.top, width: chosen.width, height: chosen.height })
  }
  return chosen
}

/**
 * Size the window to the visible chain and offset each popup inside it.
 *
 * Also publishes the window's rectangle as an interactive region. That is not about
 * this window's own clicks — it is a real window and takes them normally — but about
 * the overlay's: a press that no window claims is what native counts as a click away
 * from the dictionary, and without this, clicking the popup would close it.
 */
let pending = null
/** The popup that opened last; the chain is kept around it if one goes astray. */
let newest = null
const markNewest = (popup) => {
  newest = popup
}

/**
 * How long an empty chain has to stay empty before the window itself goes.
 *
 * Sliding along a line crosses the gaps between words, and Yomitan clears the popup on
 * every gap and opens it again on the next match. Inside a page that costs nothing;
 * here it would tear down and re-show a real window several times a second, and hiding
 * a window that has the keyboard hands the keyboard to somebody else on the way out.
 *
 * This is about the window, not about what the reader sees: the *content* still goes
 * the instant Yomitan hides it, because how long a popup outlives the text it belongs
 * to is `hideDelay` in their own scanning settings, and that is theirs to set.
 */
const HIDE_GRACE_MS = 220

/**
 * Transparent margin around the popups, for their drop shadow (the frame style in
 * host/popup-bridge.js). The window is that much larger on every side and the frames sit that
 * far in; the margin is not published as a region, so clicks on it pass through. Matches the
 * built-in pop-up's `--popup-pad` / `SHADOW_PAD`.
 */
const SHADOW_PAD = 16
let hideTimer = null

function cancelHide() {
  if (hideTimer === null) return
  clearTimeout(hideTimer)
  hideTimer = null
}

/**
 * Let go of the window, but not yet.
 *
 * The rectangles go at once even though the window stays: an empty window that
 * still takes the mouse is a hole in the desktop for as long as it lasts, and
 * dropping its claim is also what tells native to make it click-through again.
 */
function scheduleHide() {
  void invoke('regions', { rects: [] }).catch(() => {})
  if (hideTimer !== null) return
  hideTimer = setTimeout(() => {
    hideTimer = null
    if ([...placed].some(([popup]) => popup.isVisibleSync())) return
    windowRect = null
    void invoke('popup_window', { rect: null, visible: false }).catch((error) => {
      report({ check: 'popup-host-place-failed', error: String(error?.message ?? error) })
    })
  }, HIDE_GRACE_MS)
}

async function relayout() {
  const visible = [...placed].filter(([popup]) => popup.isVisibleSync())
  if (visible.length === 0) {
    scheduleHide()
    return
  }
  cancelHide()
  // One popup badly placed would otherwise drag the window's bounding box across the
  // desktop, and a transparent always-on-top window the size of two monitors takes
  // every click on both of them. A chain that cannot fit on one screen is a bug
  // somewhere else; the window stays around the popup that opened last, and says so.
  const whole = chainWindow(visible.map(([, rect]) => rect))
  const screen = whole ? anchorViewport([asEdges(whole)], displays, whole) : null
  let container = whole
  if (whole && screen && !fitsIn(whole, screen)) {
    const latest = visible.find(([popup]) => popup === newest) ?? visible[visible.length - 1]
    container = latest ? latest[1] : whole
    report({ check: 'popup-host-chain-implausible', chain: whole, used: container })
  }
  windowRect = container
  for (const [popup, rect] of visible) {
    if (container !== whole && popup !== newest) continue
    const { left, top } = insetIn(container, rect)
    const frame = frameOf(popup)
    frame.style.left = `${left + SHADOW_PAD}px`
    frame.style.top = `${top + SHADOW_PAD}px`
  }
  const padded = {
    x: container.x - SHADOW_PAD,
    y: container.y - SHADOW_PAD,
    width: container.width + SHADOW_PAD * 2,
    height: container.height + SHADOW_PAD * 2
  }
  try {
    await invoke('popup_window', { rect: padded, visible: true })
    await invoke('regions', {
      // `focus: true` asks native to make this window key when the pointer arrives on
      // it, and only then. That is the whole bargain: the popup does not take the
      // keyboard when it opens, so the reader can keep moving across words, and it
      // takes it the moment they actually reach for it, so clicks, selection,
      // scrolling and its keyboard shortcuts work. Since this window is a
      // non-activating panel, that costs the reader's own application nothing: it
      // stays active, and its window order is not touched.
      rects: [{ ...container, focus: true }]
    })
  } catch (error) {
    report({ check: 'popup-host-place-failed', error: String(error?.message ?? error) })
  }
}

/** Coalesce: several popups in one chain settle within the same task. */
function scheduleRelayout() {
  pending ??= Promise.resolve().then(() => {
    pending = null
    return relayout()
  })
  return pending
}

/**
 * The desktop point a nested lookup's rectangles are measured from.
 *
 * A lookup inside the popup runs in the popup's own frame, and Yomitan sends its
 * source rectangles in that frame's coordinates with no offset applied —
 * `PopupFactory` only attaches a `FrameOffsetForwarder` when there is no parent
 * popup. In a browser the parent frame and the popup it opens share one page, so the
 * result is merely a bit off; in a window of its own it is the difference between the
 * scanned word and the origin of the primary display.
 *
 * The parent's own rectangle is already known in desktop points, so the frame's
 * content box is where the child's coordinates start. The border is real: the popup
 * frame draws one, and `box-sizing: border-box` puts the content inside it.
 */
function nestedOrigin(popup) {
  const parent = popup.parent
  const rect = parent ? placed.get(parent) : null
  if (!rect) return null
  const style = getComputedStyle(frameOf(parent))
  return {
    x: rect.x + (Number.parseFloat(style.borderLeftWidth) || 0),
    y: rect.y + (Number.parseFloat(style.borderTopWidth) || 0)
  }
}

const showContent = Popup.prototype.showContent
Popup.prototype.showContent = async function (details, displayDetails) {
  const sent = Array.isArray(details?.sourceRects) ? details.sourceRects : []
  // Before anything else: a range starting at a line boundary carries a zero-width
  // rectangle at the end of the previous line, and Yomitan would open the popup there.
  const real = withExtent(sent)
  const origin = nestedOrigin(this)
  // `_getViewport` takes no arguments, so the anchor has to be in scope before
  // `_show` runs. Set per call rather than per popup: a nested lookup positions
  // against its own source rectangles.
  markNewest(this)
  anchors = origin
    ? real.map((r) => ({
        left: r.left + origin.x,
        top: r.top + origin.y,
        right: r.right + origin.x,
        bottom: r.bottom + origin.y
      }))
    : real
  if (anchors !== sent) details = { ...details, sourceRects: anchors }
  try {
    await showContent.call(this, details, displayDetails)
  } catch (error) {
    report({ check: 'popup-host-show-failed', error: String(error?.message ?? error) })
    throw error
  }
  await scheduleRelayout()
  // Geometry only: never a headword, never a definition. These windows are
  // capture-protected, so this is the only record that a popup appeared and where.
  report({
    check: 'popup-host-shown',
    depth: this.depth,
    rect: placed.get(this) ?? null,
    // The screen Yomitan was told it had to fit inside. A popup on the wrong display
    // is this being wrong, not the position arithmetic.
    viewport,
    displays: displays.map((d) => d.work_area),
    // Desktop points, as the client sent them — or, for a nested lookup, translated
    // out of the parent popup's frame. Comparing these with the rectangle above is
    // how a misplaced popup is diagnosed without a screenshot, and the individual
    // rectangles matter: Yomitan sends one per line of the match and chooses between
    // them, so which one it picked is the whole answer to "why is it over there".
    anchor: boundsOf(anchors),
    anchorCount: anchors.length,
    anchors: anchors.slice(0, 8).map((r) => ({
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom)
    })),
    nested: origin ?? null,
    // What arrived, before the extentless ones were dropped. Kept because "the popup
    // opened one line up" is only ever explained by the rectangles it chose among.
    sent: sent.length === anchors.length ? undefined : sent.length
  })
}

const hide = Popup.prototype.hide
Popup.prototype.hide = function (changeFocus) {
  const result = hide.call(this, changeFocus)
  if (!this.isVisibleSync()) placed.delete(this)
  void scheduleRelayout()
  return result
}

// The Display's own resize handle. Original code all the way down: the popup asks its
// parent frame to resize it, which is this window.
// Build the popup's frame ahead of the first lookup rather than during it.
const { prewarmPopups, stylePopupFrames } = await import('/spike/popup-bridge.js')
stylePopupFrames(Popup)
prewarmPopups(Popup, report)

const setFrameSize = Popup.prototype.setFrameSize
Popup.prototype.setFrameSize = async function (width, height) {
  const result = await setFrameSize.call(this, width, height)
  const rect = placed.get(this)
  if (rect) {
    placed.set(this, { ...rect, width, height })
    await scheduleRelayout()
  }
  return result
}

// A monitor added, removed or rearranged changes which work area a popup belongs in.
await window.__TAURI__?.event?.listen('display-layout', () => void refreshDisplays())

// The single backend lives in the overlay, which may still be starting. Ask rather
// than assume: `Application.main` fails outright against a backend that is not ready.
const reachable = await host.hub.waitForBackend(30000)
if (!reachable.ready) {
  report({ check: 'popup-host-backend-unavailable', error: reachable.error })
}

await Application.main(false, async (application) => {
  const factory = new PopupFactory(application)
  factory.prepare()
  // Only now: a client that asks earlier gets a timeout, and Yomitan caches which
  // popup a frontend uses, so one early miss would cost the whole session.
  host.hub.serving = true
  report({
    check: 'popup-host-ready',
    frameId: application.frameId,
    tabId: application.tabId,
    displays: displays.length
  })
})
