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
const popupSources = new Map()
let desktopLookup = false
let gnomeBridge = false
let appearance = 'system'
const themeMedia = matchMedia('(prefers-color-scheme: dark)')
const resolvedTheme = () => appearance === 'light' || appearance === 'dark' ? appearance : themeMedia.matches ? 'dark' : 'light'
let anchors = []
let displays = []
let windowRect = null

async function refreshDisplays() {
  try {
    displays = await invoke('displays')
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
      const status = await invoke('gnome_overlay', { operation: 'status', payload: null })
      gnomeBridge = Boolean(status.available && status.desktopPopup)
      if (gnomeBridge) {
        if (status.sharedOverlay) window.__kimochiFrameBands.overlay = 0
        displays = status.monitors.map((m, id) => ({ id, bounds: m, work_area: m.workArea, scale_factor: 1 }))
      }
    }
  } catch (error) {
    report({ check: 'popup-host-displays-failed', error: String(error?.message ?? error) })
  }
}
await refreshDisplays()
// Kimochi's appearance, for a lookup that does not say which theme its page has (desktop OCR on
// GNOME). Every other lookup brings its page's theme, and the popup frame follows that.
try {
  appearance = (await invoke('settings_all')).appearance ?? 'system'
  await window.__TAURI__?.event?.listen('settings:changed', ({ payload }) => {
    if (payload.key === 'appearance') appearance = payload.value
  })
} catch (error) {
  report({ check: 'popup-host-appearance-failed', error: String(error?.message ?? error) })
}

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

let readingPopupVisible = false
async function relayout() {
  const visible = [...placed].filter(([popup]) => popup.isVisibleSync())
  const readingVisible = visible.some(([popup]) => popupSources.get(popup) === 'desktop')
  if (readingVisible !== readingPopupVisible) {
    readingPopupVisible = readingVisible
    void window.__TAURI__.event.emitTo('overlay','overlay-reading-popup',{visible:readingVisible}).catch(() => {})
  }
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
    if (gnomeBridge) {
      await invoke('gnome_overlay', { operation: 'own-window', payload: {
        label: LABEL, sourceKind: popupSources.get(newest) ?? 'reader',
        interactiveRects: visible.filter(([popup]) => container === whole || popup === newest).map(([, rect]) => rect)
      } })
    }
    await invoke('popup_window', { rect: padded, visible: true })
    await invoke('regions', {
      // `focus: true` asks native to make this window key when the pointer arrives on
      // it, and only then. That is the whole bargain: the popup does not take the
      // keyboard when it opens, so the reader can keep moving across words, and it
      // takes it the moment they actually reach for it, so clicks, selection,
      // scrolling and its keyboard shortcuts work. Since this window is a
      // non-activating panel, that costs the reader's own application nothing: it
      // stays active, and its window order is not touched.
      rects: gnomeBridge
        ? visible.filter(([popup]) => container === whole || popup === newest).map(([, rect]) => ({ ...rect, focus: true }))
        : [{ ...container, focus: true }]
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

/** This window's top-left on the desktop: the chain's box, less the shadow margin. */
function windowOrigin() {
  return windowRect ? { x: windowRect.x - SHADOW_PAD, y: windowRect.y - SHADOW_PAD } : null
}

/**
 * The desktop point a nested lookup's rectangles are measured from.
 *
 * A lookup inside the popup runs in the popup's own frame. `PopupFactory` moves its source
 * rectangles by the parent frame's place in this window (`_getPopupOffset`), so they arrive in
 * this window's coordinates, short only of the parent frame's border, which Yomitan leaves out
 * (`box-sizing: border-box` puts the content inside it). This window's own desktop origin is
 * what turns them into desktop points. Adding the parent's desktop rectangle instead counted
 * the parent's place twice and opened nested popups well off their word.
 */
function nestedOrigin(popup) {
  const parent = popup.parent
  const origin = parent ? windowOrigin() : null
  if (!origin) return null
  const style = getComputedStyle(frameOf(parent))
  return {
    x: origin.x + (Number.parseFloat(style.borderLeftWidth) || 0),
    y: origin.y + (Number.parseFloat(style.borderTopWidth) || 0)
  }
}

/**
 * Whether the pointer is over the popup chain, asked by the scanning window's frontend before it
 * scans (`Frontend._ignorePoint`): a point over the popup is the popup's, not the text it covers.
 * That frontend is in another window and asks in desktop points (its `FrameOffsetForwarder` adds
 * its window's origin, see host/popup-bridge.js), while the frames here are measured in this
 * window. Unconverted, the answer was always no, and Shift over the popup looked up the line
 * underneath it. Nested popups ask from inside this window, in its own coordinates.
 */
const containsPoint = Popup.prototype.containsPoint
Popup.prototype.containsPoint = function (x, y) {
  const origin = this.parent ? null : windowOrigin()
  if (!this.parent && !origin) return Promise.resolve(false)
  return origin ? containsPoint.call(this, x - origin.x, y - origin.y) : containsPoint.call(this, x, y)
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
  if (gnomeBridge && !this.parent) {
    // Reader and desktop lookups share one native host, not two independent
    // root popups. Keep nested children, but retire the previous root chain.
    for (const [popup] of placed) if (!popup.parent && popup !== this) popup.hide(false)
  }
  markNewest(this)
  if (sent.length) popupSources.set(this, this.parent ? popupSources.get(this.parent) : desktopLookup || displayDetails?.content?.contentOrigin?.tabId === 1 ? 'desktop' : 'reader')
  anchors = origin
    ? real.map((r) => ({
        left: r.left + origin.x,
        top: r.top + origin.y,
        right: r.right + origin.x,
        bottom: r.bottom + origin.y
      }))
    : real
  if (anchors !== sent) details = { ...details, sourceRects: anchors }
  if (gnomeBridge) {
    // Display.window.focus() is appropriate for an in-page iframe, but a remote
    // GTK window would take the reader's Shift hold with it. Hover stays passive;
    // the real window can still receive an explicit click and scroll normally.
    // (The frame's theme follows the content's in stylePopupFrames, below, for every OS.)
    if (displayDetails) displayDetails = { ...displayDetails, focus: false }
  }
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
const { prewarmPopups, replayIntoPopup, stylePopupFrames } = await import('/spike/popup-bridge.js')
// This page is transparent, which Yomitan would read as a light site: each frame takes its
// content's theme instead (the scanned window's), else Kimochi's appearance.
stylePopupFrames(Popup, { fallbackTheme: resolvedTheme })
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

// The pointer and modifiers over this window, from native (`spawn_cursor_poll`): this window never
// has the keyboard, so it sees neither for itself. Handed to the popup under the pointer, whose
// own scanner then opens Yomitan's nested popup for a word Shift-scanned inside it.
await window.__TAURI__?.event?.listen('popup-host:pointer', ({ payload }) => {
  const origin = windowOrigin()
  if (!origin || typeof payload?.x !== 'number') return
  replayIntoPopup(placed.keys(), payload.x - origin.x, payload.y - origin.y, {
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    cancelable: true,
    screenX: payload.x,
    screenY: payload.y,
    buttons: payload.down ? 1 : 0,
    shiftKey: !!payload.shift,
    ctrlKey: !!payload.ctrl,
    altKey: !!payload.alt,
    metaKey: !!payload.meta
  })
})

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
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
    let generation = 0
    let desktopPopup = null

if(window.__KIMOCHI_PLATFORM__?.os==='linux'&&gnomeBridge) {
  await window.__TAURI__.event.listen('gnome-controller-popup-control',async({payload})=>{
    const doc=desktopPopup?._frame?.contentDocument
    const scroll=doc?.querySelector('#content-scroll');if(!scroll)return
    if(Number.isFinite(payload.scroll))scroll.scrollBy(0,payload.scroll)
    if(payload.step===1||payload.step===-1) {
      // Use the reader's own entry action first, including its active entry and
      // sticky-header handling, just as the shared controller does.
      const options=await application.api.optionsGetFull()
      const profile=options?.profiles?.[options.profileCurrent]?.options
      const action=payload.step>0?'nextEntry':'previousEntry'
      const hotkey=profile?.inputs?.hotkeys?.find(h=>h.action===action&&h.enabled!==false&&typeof h.key==='string'&&(h.scopes??[]).includes('popup'))
      if(hotkey) {
        const win=desktopPopup._frame.contentWindow,mods=hotkey.modifiers??[]
        const key=new win.KeyboardEvent('keydown',{key:hotkey.key.replace(/^Key/,'').toLowerCase(),code:hotkey.key,
          altKey:mods.includes('alt'),ctrlKey:mods.includes('ctrl'),shiftKey:mods.includes('shift'),metaKey:mods.includes('meta'),bubbles:true,cancelable:true})
        doc.dispatchEvent(key)
        if(key.defaultPrevented)return
      }
      const entries=[...doc.querySelectorAll('.entry')]
      const top=scroll.getBoundingClientRect().top
      const current=Math.max(0,entries.findIndex(entry=>entry.getBoundingClientRect().bottom>top+8))
      entries[Math.max(0,Math.min(entries.length-1,current+payload.step))]?.scrollIntoView({block:'start'})
    }
  })
}
    // Desktop OCR has no Frontend scanner. Original Display.close() still calls
    // the content-origin API; answer that API here instead of timing out.
    application.crossFrame.registerHandlers([
      ['frontendClosePopup', () => { ++generation; desktopPopup?.hide(false) }]
    ])
    await window.__TAURI__.event.listen('gnome-popup-dismiss', () => {
      ++generation
      for (const [popup] of placed) popup.hide(false)
    })
    await window.__TAURI__.event.listen('gnome-overlay-lookup', async ({ payload }) => {
      const serial = ++generation
      try {
        const status = await invoke('gnome_overlay', { operation: 'status', payload: null })
        if (!status.available || !status.desktopPopup || status.suspended || status.serial !== payload?.serial) return
        const r = payload.rect
        if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || typeof payload.text !== 'string') return
        const optionsContext = { url: location.href, depth: 0 }
        const result = await application.api.termsFind(payload.text, {}, optionsContext)
        if (serial !== generation) return
        const current = await invoke('gnome_overlay', { operation: 'status', payload: null })
        if (current.suspended || current.serial !== payload.serial) return
        await invoke('gnome_overlay', { operation: 'highlight', payload: {
          serial: payload.serial, index: payload.index, length: result.originalTextLength ?? 0
        } })
        if (!result.dictionaryEntries.length) { desktopPopup?.hide(false); return }
        await refreshDisplays()
        desktopPopup ??= await factory.getOrCreatePopup({ frameId: application.frameId, depth: 0, childrenSupported: true })
        await desktopPopup.setOptionsContext(optionsContext)
        if (serial !== generation) return
        desktopLookup = true
        try {
        await desktopPopup.showContent({ optionsContext,
          sourceRects: [{ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height }],
          writingMode: 'horizontal-tb' }, {
          focus: false, historyMode: 'clear', params: { type: 'terms', query: payload.text.slice(0, result.originalTextLength ?? payload.text.length), wildcards: 'off' },
          state: { focusEntry: 0, optionsContext, url: location.href, pageTheme: resolvedTheme(), sentence: { text: payload.sentence ?? payload.text, offset: payload.offset ?? 0 }, documentTitle: 'Kimochi screen OCR' },
          content: { contentOrigin: { tabId: application.tabId, frameId: application.frameId }, dictionaryEntries: result.dictionaryEntries }
        })
        if (serial !== generation) desktopPopup.hide(false)
        } finally { desktopLookup = false }
      } catch (error) { report({ check: 'gnome-yomitan-popup-failed', error: String(error) }) }
    })
  }
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
