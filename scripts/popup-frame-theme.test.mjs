/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * The Built-in Yomitan pop-up's frame takes the theme of the content inside it.
 *
 * Yomitan themes a pop-up twice: the `Display` inside the frame resolves its `site` theme from
 * the page that was scanned (`pageTheme`, measured by the frontend), while the frame element
 * (`data-theme`, which Kimochi's frame ring and shadow key on, and Yomitan's own frame
 * background) resolves it from the document the frame sits in. The Log window's pop-up lives in
 * the popup host (ui/popup-host.js), a transparent page that always reads as light, so a lookup
 * in the dark Log came up dark inside a white, light-ringed frame — on every fresh profile,
 * because `site` is Yomitan's default for both theme settings. `stylePopupFrames`
 * (host/popup-bridge.js) hands each frame its content's page theme.
 *
 * This drives Yomitan's real `ThemeController` over a transparent document, and checks that the
 * `Popup` seams the fix relies on are still in the pinned Yomitan.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { POPUP_FRAME_CSS, followTheme, pageThemeOf, stylePopupFrames } from '../host/popup-bridge.js'

const yomitan = new URL('../extensions/yomitan/', import.meta.url)

// A transparent page, as ui/popup-host.html is: Yomitan's site detection reads it as light.
globalThis.document = { documentElement: {}, body: {} }
globalThis.window = { getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)' }) }

const { ThemeController } = await import(new URL('js/app/theme-controller.js', yomitan).href)

/** The parts of Yomitan's `Popup` the theme passes through (js/app/popup.js). */
function popupClass() {
  return class Popup {
    constructor({ popupTheme = 'site', popupOuterTheme = 'site' } = {}) {
      this._frame = { dataset: {} }
      this._themeController = new ThemeController(this._frame)
      this._themeController.theme = popupTheme
      this._themeController.outerTheme = popupOuterTheme
      this.shown = []
    }

    // As `showContent` → `_setOptionsContext` → `updateTheme`, then the display gets its content.
    async showContent(details, displayDetails) {
      this._themeController.updateTheme()
      this.shown.push(displayDetails)
    }
  }
}

const lookup = (pageTheme) => ({ historyMode: 'clear', state: { focusEntry: 0, url: 'x', ...(pageTheme ? { pageTheme } : {}) } })

test('without Kimochi, a dark lookup in the popup host gets a light frame (the bug)', async () => {
  const Popup = popupClass()
  const popup = new Popup()
  await popup.showContent({}, lookup('dark'))
  assert.equal(popup._frame.dataset.theme, 'light')
})

test('the frame takes the scanned page theme, both ways, on Yomitan defaults', async () => {
  const Popup = popupClass()
  stylePopupFrames(Popup)
  const popup = new Popup()
  await popup.showContent({}, lookup('dark'))
  assert.equal(popup._frame.dataset.theme, 'dark')
  assert.equal(popup._frame.dataset.outerTheme, 'dark')
  // The app switched to light: the next lookup follows it.
  await popup.showContent({}, lookup('light'))
  assert.equal(popup._frame.dataset.theme, 'light')
  assert.equal(popup._frame.dataset.outerTheme, 'light')
})

test('a profile that chose a theme keeps it: the frame resolves as the content does', async () => {
  const Popup = popupClass()
  stylePopupFrames(Popup)
  const light = new Popup({ popupTheme: 'light', popupOuterTheme: 'dark' })
  await light.showContent({}, lookup('dark'))
  assert.equal(light._frame.dataset.theme, 'light')
  const dark = new Popup({ popupTheme: 'dark', popupOuterTheme: 'light' })
  await dark.showContent({}, lookup('light'))
  assert.equal(dark._frame.dataset.theme, 'dark')
})

test('a lookup without a page theme takes the fallback, and so does its content', async () => {
  const Popup = popupClass()
  stylePopupFrames(Popup)
  // A later call (the popup host's) supplies the fallback to an already-styled class.
  let appearance = 'dark'
  stylePopupFrames(Popup, { fallbackTheme: () => appearance })
  const popup = new Popup()
  await popup.showContent({}, lookup(null))
  assert.equal(popup._frame.dataset.theme, 'dark')
  assert.equal(popup.shown[0].state.pageTheme, 'dark')
  appearance = 'light'
  await popup.showContent({}, lookup(null))
  assert.equal(popup._frame.dataset.theme, 'light')
  // A repositioning call carries no display details and changes nothing.
  await popup.showContent({}, null)
  assert.equal(popup._frame.dataset.theme, 'light')
  assert.equal(popup.shown.at(-1), null)
})

test('pageThemeOf and followTheme accept only what Yomitan produces', () => {
  assert.equal(pageThemeOf(lookup('dark')), 'dark')
  assert.equal(pageThemeOf(lookup('sepia')), null)
  assert.equal(pageThemeOf(null), null)
  assert.equal(followTheme({}, 'dark'), false)
})

test("Kimochi's frame style keys on the frame's resolved theme, in both themes", () => {
  assert.match(POPUP_FRAME_CSS, /iframe\.yomitan-popup\[data-theme\]\s*\{[^}]*border:[^}]*box-shadow:/)
  assert.match(POPUP_FRAME_CSS, /iframe\.yomitan-popup\[data-theme=dark\]\s*\{[^}]*border-color:[^}]*box-shadow:/)
})

test('the pinned Yomitan still has the seams the frame theme relies on', async () => {
  const popup = await readFile(new URL('js/app/popup.js', yomitan), 'utf8')
  assert.match(popup, /this\._themeController = new ThemeController\(this\._frame\);/)
  assert.match(popup, /async showContent\(details, displayDetails\) \{/)
  assert.match(popup, /async _injectPopupOuterStylesheet\(\) \{/)
  const display = await readFile(new URL('js/display/display.js', yomitan), 'utf8')
  // The content resolves `site` from the lookup's page theme — the value the frame is given.
  assert.match(display, /this\._themeController\.siteTheme = pageTheme \?\? null;/)
  const frontend = await readFile(new URL('js/app/frontend.js', yomitan), 'utf8')
  assert.match(frontend, /const detailsState = \{[^}]*pageTheme,/)
  const outer = await readFile(new URL('css/popup-outer.css', yomitan), 'utf8')
  // Yomitan's frame is white unless `data-theme=dark`: the frame theme decides its ground.
  assert.match(outer, /iframe\.yomitan-popup\[data-theme=dark\] \{\s*background-color: #1e1e1e;/)
})
