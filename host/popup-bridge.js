/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/* global chrome:readonly */
/**
 * A host-side handle on the popups the original factory builds.
 *
 * Yomitan gives the page no way to find its popup. `Popup._setUpContainer` puts the
 * frame inside a shadow root opened with `mode: 'closed'` whenever
 * `general.usePopupShadowDom` is set — it is, by default — and hangs it off an
 * unmarked `div` styled `all: initial`. Neither is selectable, and the factory keeps
 * its instances private.
 *
 * Two parts of this app need those instances, and neither can be served by guessing
 * at the DOM:
 *
 *  - the **overlay** publishes explicit interactive rectangles to Rust and is
 *    click-through everywhere else, so a popup with no rectangle is a popup whose
 *    clicks go to the application behind it *and* count as a click away from the
 *    dictionary;
 *  - **every window** needs to say, in the app's own diagnostics, whether a lookup
 *    produced a popup or failed — these windows are capture-protected, so a
 *    screenshot cannot answer that.
 *
 * So the factory is asked rather than inspected: `isVisibleSync()`, `getFrameRect()`
 * and `child` are all public API on `Popup`. Nothing in `yomitan/` is modified; this
 * wraps the prototypes the same way the rest of the host wraps `chrome.*`.
 */

const OBSERVED = Symbol.for('kimochi.popupBridge.observed')
const PREWARMED = Symbol.for('kimochi.popupBridge.prewarmed')
const STYLED = Symbol.for('kimochi.popupBridge.styled')
const APPEARANCE = Symbol.for('kimochi.popupBridge.appearance')

/**
 * Give a page with no ground of its own Kimochi's appearance as its Yomitan "site" theme.
 *
 * Yomitan's default theme is `site`: it reads the scanned page's background colour
 * (`ThemeController#computeSiteTheme`) and themes the popup to match. The overlay is a transparent
 * window over the game, which reads as white, so every overlay lookup came up light whatever
 * Kimochi was set to. Native applies Kimochi's Appearance to the whole app (`apply_appearance` in
 * main.rs), so `prefers-color-scheme` here is that setting; the site theme becomes it too, and
 * follows it when it changes (Yomitan re-resolves on the media query's change). Only this realm's
 * `ThemeController` is affected; nothing in Yomitan is modified.
 */
export async function siteThemeFromAppearance() {
  const { ThemeController } = await import('/js/app/theme-controller.js')
  if (ThemeController.prototype[APPEARANCE]) return
  ThemeController.prototype[APPEARANCE] = true
  ThemeController.prototype.computeSiteTheme = () =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * The popup frame in Kimochi's own pop-up style: the built-in dictionary pop-up's radius, hairline
 * ring and two-layer shadow (frontend/texthooker/popover.css), instead of Yomitan's grey 1em border
 * and wide glow. The ring is a 1px border here because an inset shadow would sit under the frame's
 * content; its colours are the kit's slate ring over the pop-up's ground, light and dark.
 * `data-theme` is the popup's own resolved theme, so the ring matches the page inside it.
 */
export const POPUP_FRAME_CSS = `
iframe.yomitan-popup,
iframe.yomitan-popup[data-theme] {
  border: 1px solid #e0e1e6;
  border-radius: 8px;
  box-shadow: 0 1px 2px rgb(15 17 26 / 0.08), 0 6px 14px -4px rgb(15 17 26 / 0.22);
}
iframe.yomitan-popup[data-theme=dark] {
  border-color: #363a3f;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 6px 14px -4px rgb(0 0 0 / 0.55);
}
`

/**
 * The theme a lookup asked the popup's content to take: Yomitan's frontend measures the scanned
 * page's ground (`TextScanner` → `pageTheme`) and the `Display` inside the popup resolves its
 * `site` theme against it. Null when the lookup carries none.
 */
export function pageThemeOf(displayDetails) {
  const theme = displayDetails?.state?.pageTheme
  return theme === 'dark' || theme === 'light' ? theme : null
}

/** Resolve `popup`'s frame theme with `theme` as its site theme (see {@link stylePopupFrames}). */
export function followTheme(popup, theme) {
  const controller = popup?._themeController
  if (!controller || typeof controller.updateTheme !== 'function') return false
  controller.siteTheme = theme
  controller.updateTheme()
  return true
}

/**
 * Restyle every popup frame this realm builds, and keep each frame's theme on its content's.
 *
 * Style: {@link POPUP_FRAME_CSS} goes right after Yomitan's own outer stylesheet — in the same
 * place, which may be the popup's closed shadow root, held on the instance as `_shadow`. The
 * reader's own "custom popup outer CSS" is applied after both, so it still wins.
 *
 * Theme: Yomitan resolves the frame's `data-theme` / `data-outer-theme` from the document the
 * frame sits in, but the content's from the page that was scanned ({@link pageThemeOf}). For a
 * popup inside its own window those are one page. For the popup host (ui/popup-host.js) they are
 * not: its page is transparent, which Yomitan reads as light, so a lookup in the dark Log window
 * got dark content in a white, light-ringed frame. Each `showContent` therefore gives the frame's
 * theme controller the content's page theme as its site theme — the value the `Display` inside
 * resolves with — so frame and content agree whatever `popupTheme` / `popupOuterTheme` a profile
 * holds, defaults included. A lookup without a page theme takes `fallbackTheme()` (the popup host:
 * Kimochi's appearance), handed to the content too. `ThemeController#siteTheme` is Yomitan's own
 * override; nothing in Yomitan is modified.
 *
 * Idempotent per `Popup` class; a later call may still supply the fallback.
 *
 * @param {Function} Popup Yomitan's `Popup` class (js/app/popup.js)
 * @param {{fallbackTheme?: () => ('dark' | 'light' | null)}} [options]
 */
export function stylePopupFrames(Popup, { fallbackTheme } = {}) {
  const existing = Popup.prototype[STYLED]
  if (existing) {
    if (fallbackTheme) existing.fallbackTheme = fallbackTheme
    return
  }
  const styled = { fallbackTheme: fallbackTheme ?? null }
  Popup.prototype[STYLED] = styled

  const inject = Popup.prototype._injectPopupOuterStylesheet
  if (typeof inject === 'function') {
    Popup.prototype._injectPopupOuterStylesheet = async function (...args) {
      const result = await inject.apply(this, args)
      const parent = this._shadow ?? document.head
      if (parent && !parent.querySelector?.('style[data-kimochi-popup-frame]')) {
        const style = document.createElement('style')
        style.dataset.kimochiPopupFrame = ''
        style.textContent = POPUP_FRAME_CSS
        parent.append(style)
      }
      return result
    }
  }

  const showContent = Popup.prototype.showContent
  if (typeof showContent === 'function') {
    Popup.prototype.showContent = function (details, displayDetails, ...rest) {
      if (displayDetails) {
        const theme = pageThemeOf(displayDetails) ?? styled.fallbackTheme?.() ?? null
        if (theme) {
          if (displayDetails.state?.pageTheme !== theme) {
            displayDetails = { ...displayDetails, state: { ...displayDetails.state, pageTheme: theme } }
          }
          followTheme(this, theme)
        }
      }
      return showContent.call(this, details, displayDetails, ...rest)
    }
  }
}

/**
 * Render this window's popup in another window instead of inside itself.
 *
 * Yomitan already has this shape: `PopupFactory.getOrCreatePopup` returns a
 * `PopupProxy` whenever the requested frame is not the caller's own, and the proxy
 * drives the real `Popup` over the `popupFactory*` cross-frame API. It exists for
 * iframes, where the popup belongs in the page's root frame; the only thing that
 * changes for a native window is what "offset" means.
 *
 * `FrameOffsetForwarder.getOffset` normally answers "where is my frame inside the
 * root frame's page", and `PopupProxy` adds it to the source rectangles so the popup
 * is positioned against the right coordinates. Answer it with this *window's* origin
 * on the desktop and the same arithmetic produces desktop points — which is the only
 * space two native windows share, and the space the popup host positions in.
 *
 * If the remote popup cannot be reached, the local one is used. A dictionary that
 * renders in a cramped window is worth having; one that renders nowhere is not.
 *
 * @param {{
 *   log: (value: object) => void,
 *   onChange?: () => void,
 *   window?: string,
 *   remote?: {frameId: number, offset: () => Promise<[number, number]>}
 * }} options
 * @returns {Promise<{popups: Set<object>}>} the live set, which the caller may read
 *   at any time. Instances are never removed: the factory keeps them for reuse, and a
 *   hidden popup answers `isVisibleSync() === false` rather than disappearing.
 */
export async function observePopups({ log, onChange, window: label, remote } = {}) {
  const [{ PopupFactory }, { Popup }] = await Promise.all([
    import(chrome.runtime.getURL('js/app/popup-factory.js')),
    import(chrome.runtime.getURL('js/app/popup.js'))
  ])

  const popups = new Set()
  const note = (value) => log?.({ window: label, ...value })
  stylePopupFrames(Popup)

  // One realm, one set of wrappers, however many callers ask.
  if (PopupFactory.prototype[OBSERVED]) {
    for (const popup of PopupFactory.prototype[OBSERVED].popups) popups.add(popup)
    PopupFactory.prototype[OBSERVED].listeners.add({ popups, note, onChange })
    return { popups }
  }
  const shared = { popups: new Set(), listeners: new Set([{ popups, note, onChange }]) }
  PopupFactory.prototype[OBSERVED] = shared

  const fanOut = (fn) => {
    for (const listener of shared.listeners) fn(listener)
  }

  if (remote) await useRemotePopup(remote, note)

  const create = PopupFactory.prototype.getOrCreatePopup
  PopupFactory.prototype.getOrCreatePopup = async function (...args) {
    const popup = await create.apply(this, args)
    // Only a popup whose frame is in this realm. `PopupProxy` and `PopupWindow`
    // answer `valid: false` from `getFrameRect()` by contract, because their pixels
    // belong to another window.
    if (popup instanceof Popup && !shared.popups.has(popup)) {
      shared.popups.add(popup)
      fanOut((l) => {
        l.popups.add(popup)
        l.note({ check: 'popup-created', depth: popup.depth })
      })
    }
    return popup
  }

  const { withExtent } = await import(new URL('/ui/popup-geometry.js', location.href).href)

  const show = Popup.prototype.showContent
  Popup.prototype.showContent = function (details, ...rest) {
    // A range beginning at a line boundary carries a zero-width rectangle at the end
    // of the *previous* line, and Yomitan would rather open the popup there than
    // below the word. See `withExtent`.
    if (Array.isArray(details?.sourceRects)) {
      const real = withExtent(details.sourceRects)
      if (real.length !== details.sourceRects.length) details = { ...details, sourceRects: real }
    }
    const anchor = boundingRect(details?.sourceRects)
    const result = show.call(this, details, ...rest)
    // A rectangle that arrives late is a window in which the first click is thrown
    // away, so the change is announced before it is awaited as well as after.
    fanOut((l) => l.onChange?.())
    Promise.resolve(result).then(
      () => {
        fanOut((l) => {
          l.onChange?.()
          // Geometry only: never a headword, never a definition. The anchor is the
          // rectangle Yomitan positioned against — the difference between it and the
          // word the reader pointed at is the whole of an "the popup is in the wrong
          // place" report, and these windows are capture-protected, so a screenshot
          // cannot show it.
          l.note({ check: 'popup-shown', depth: this.depth, rect: this.getFrameRect(), anchor })
        })
      },
      (error) => fanOut((l) => l.note({ check: 'popup-failed', error: describe(error) }))
    )
    return result
  }

  prewarmPopups(Popup, (value) => fanOut((l) => l.note(value)))

  const hide = Popup.prototype.hide
  Popup.prototype.hide = function (...args) {
    const result = hide.apply(this, args)
    fanOut((l) => l.onChange?.())
    return result
  }

  return { popups }
}

function describe(error) {
  return String(error?.message ?? error)
}

/** The bounding box of the rectangles a popup was positioned against. */
function boundingRect(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return null
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    count: rects.length
  }
}

/**
 * Point this window's default popup at a frame in another window.
 *
 * Only the *default* popup is redirected. A popup asked for by id, a popup with a
 * parent, and a window popup are all left alone: each is already addressed to a
 * particular place, and redirecting them would break the chain rather than move it.
 */
async function useRemotePopup(remote, note) {
  const { PopupFactory } = await import(chrome.runtime.getURL('js/app/popup-factory.js'))
  const { FrameOffsetForwarder } = await import(
    chrome.runtime.getURL('js/comm/frame-offset-forwarder.js')
  )

  // Desktop points, not page coordinates. `PopupProxy` adds this to every source
  // rectangle it forwards, and refreshes it about once a second, so a window the
  // reader drags is followed without asking on every hover.
  FrameOffsetForwarder.prototype.getOffset = async function () {
    try {
      return await remote.offset()
    } catch (error) {
      note({ check: 'popup-offset-failed', error: describe(error) })
      return null
    }
  }

  const create = PopupFactory.prototype.getOrCreatePopup
  PopupFactory.prototype.getOrCreatePopup = async function (details, ...rest) {
    const isDefault =
      details &&
      details.frameId === this._application.frameId &&
      details.id === void 0 &&
      !details.popupWindow &&
      !details.parentPopupId
    if (isDefault) {
      try {
        return await create.call(this, { ...details, frameId: remote.frameId }, ...rest)
      } catch (error) {
        // A popup in this window is worse than one in its own window, and far better
        // than none. Say so once, out loud, rather than looking like it worked.
        note({ check: 'popup-remote-unavailable', error: describe(error) })
      }
    }
    return create.call(this, details, ...rest)
  }
}

/**
 * Build the popup's frame before the first lookup instead of during it.
 *
 * `Popup._inject` is lazy: the frame is created, navigated to the extension's
 * `popup.html` and handshaken, and the whole `Display` inside it started, on the
 * first `showContent`. That work lands on the first word the reader hovers, which is
 * exactly when it is most noticeable — and it is the difference between a dictionary
 * that feels instant and one that stutters once per session.
 *
 * `setOptionsContext` is the earliest honest trigger: injection needs the options
 * context, and the frontend assigns it as soon as it has chosen a popup, long before
 * anything is scanned. `_inject` memoises, so the first real lookup finds it done.
 *
 * **Only the outermost popup.** Injecting one starts a whole `Display` inside it,
 * and that `Display` has a frontend of its own for nested lookups, which assigns an
 * options context to a popup one level deeper — so warming without a depth check
 * walks the entire `popupNestingMaxDepth` chain and builds ten frames nobody asked
 * for. A nested popup is warmed by the lookup that needs it, which is by then already
 * inside a popup and no longer the first thing the reader sees.
 *
 * Idempotent across callers, and failures are reported rather than thrown: a popup
 * that could not be warmed still works, just not as quickly.
 */
export function prewarmPopups(Popup, note) {
  if (Popup.prototype[PREWARMED]) return
  Popup.prototype[PREWARMED] = true
  const setOptionsContext = Popup.prototype.setOptionsContext
  Popup.prototype.setOptionsContext = async function (...args) {
    const result = await setOptionsContext.apply(this, args)
    if (this.depth === 0 && typeof this._inject === 'function') {
      void Promise.resolve(this._inject()).then(
        (injected) => note({ check: 'popup-prewarmed', depth: this.depth, injected: !!injected }),
        (error) => note({ check: 'popup-prewarm-failed', error: describe(error) })
      )
    }
    return result
  }
}

/**
 * Hand a replayed pointer sample to the Yomitan popup under it, so a word inside a popup is
 * Shift-scanned and opens Yomitan's own nested popup (up to `popupNestingMaxDepth`).
 *
 * Kimochi's windows that hold popups never have the keyboard (the game or the Log does), and
 * macOS sends mouse moves only to the window that does: a popup's own scanner never sees the
 * pointer move, nor Shift. Native reads both for every window and the page replays them; a
 * sample dispatched at the page would only reach the page's scanner (which rightly ignores
 * points over its popup), so one over a popup goes into that popup's frame instead, translated
 * into the frame's own coordinates.
 *
 * `popups` are the factory's `Popup` instances; `x`, `y` are in this document's viewport. The
 * deepest popup holding the point wins, as the topmost one on screen. Returns whether one did.
 */
export function replayIntoPopup(popups, x, y, init) {
  let best = null
  for (const popup of popups ?? []) {
    if (!popup?.isVisibleSync?.()) continue
    const frame = popup._frame
    if (!(frame instanceof HTMLIFrameElement)) continue
    const rect = frame.getBoundingClientRect()
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) continue
    if (!best || (popup.depth ?? 0) > (best.popup.depth ?? 0)) best = { popup, frame, rect }
  }
  if (!best) return false
  const { frame, rect } = best
  let win = null
  let doc = null
  try {
    win = frame.contentWindow
    doc = frame.contentDocument
  } catch {
    return false
  }
  if (!win || !doc) return false
  const style = getComputedStyle(frame)
  const clientX = x - rect.left - (Number.parseFloat(style.borderLeftWidth) || 0)
  const clientY = y - rect.top - (Number.parseFloat(style.borderTopWidth) || 0)
  const target = doc.elementFromPoint(clientX, clientY) ?? win
  target.dispatchEvent(new win.PointerEvent('pointermove', { ...init, clientX, clientY }))
  return true
}
