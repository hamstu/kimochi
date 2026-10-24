/**
 * DEV-ONLY: the overlay stage, `/dev/stage.html`. The real overlay modules from ui/ (the text
 * renderer, the controller with its radial menu, read-along outline, hint bar, controls sheet and
 * recent text, the source hover markings, the region editor) drawn over a pretend game, with no
 * Tauri runtime: a fake `native` and the hooks overlay.js would pass, and the reader pop-up preview
 * (reader-popup.html) as the dictionary pop-up. The UI studio shows it frameless; it works opened
 * on its own too, for checking the overlay in a browser.
 *
 * URL parameters (all optional):
 *   ?scene=overlay-words (default) | overlay-hover | region-select | controller-menu |
 *          controller-words | controller-controls | controller-history
 *   ?game=dialogue (default) | manga     a visual novel's dialogue box, or vertical speech bubbles
 *   ?windowed=1      the game is a window on a desktop (a Mac game), not the whole screen
 *   ?furigana=0      no readings over the kanji (default: drawn, and reported as OCR reports them)
 *   ?filter=0        keep furigana and small text (the overlay's small-text filter off)
 *   ?grouping=1      Group text into regions (the grouped overlay)
 *   ?opacity=<0-100> the grouped overlay's background opacity (default 80)
 *   ?typeface=manga  set the text in Manga OCR's typeface
 *   ?hover=<x>,<y>   overlay-words: rest the pointer there (page points) so the proximity glow shows
 *   ?lookup=1        overlay-words: look up the first word on load (the pop-up open)
 *   ?theme=light|dark  the pop-up's, the region editor's and the controller's appearance (default:
 *                    the browser's)
 *   ?popup=yomitan (default) | hachidori | tenten | custom-api   the dictionary in use: Yomitan and
 *                    Hachidori pop-ups have buttons the controller can move into, the others not
 *   ?input=pad (default) | keys   controller scenes: opened with a controller or the keyboard
 *   ?auto=1          Auto OCR on: the menu says On and starts on Read along
 *   ?notext=1        controller-menu: nothing scanned yet (Read along is "Scan first")
 *   ?quickshot=1     controller-menu: Quick Shot (Auto OCR is unavailable)
 *   ?unit=character  controller-words: step by character, not by word
 *   ?cursor=free     controller-words: the left stick's free cursor out
 *   ?layer=popup     controller-words: in the pop-up's buttons
 *   ?driver=mouse    controller-words: the mouse took over (outline and hints faded)
 *   ?step=<n>        controller-words: step on n words from the first
 *   ?read=1          controller-history: open the chosen entry's words
 *   ?crop=1          overlay-hover: the saved crop's outline too (default: the window outline only)
 *   ?initial=1       region-select: open with a box drawn, ready to adjust
 *   ?picture=1       region-select: dim the screen and show the window's picture
 *   ?label=<text>    region-select: the confirm button's label (default Save); ?alternate=<text> adds
 *                    the outlined second button
 *
 * Studio JSON (`studioJson`): `script` (StageScript: the game's lines, bubbles and dictionary) and
 * `history` (the recent-text entries).
 *
 * For agents: `window.__stage` = { scene, send(input), controller, renderer, log, popup }.
 * `send` takes a button (`a`, `b`, `x`, `y`, `lb`, `rb`, `view`, `up`, `down`, `left`, `right`,
 * `ls`, `rs`), `menu` (the menu button), `stick:<x>,<y>` / `rstick:<y>` (a stick held there,
 * `stick:0,0` to let go), or `key:<Key>` (`key:ArrowRight`, `key:Enter`, `key:Escape`, `key:Space`).
 */
import overlayHtml from '@ui/overlay.html?raw'
import '@ui/controller.css'
import '@ui/controller-variants.css'
// The app bundles Figtree for the overlay as fonts/figtree.css (prepare.mjs); here, from the package.
import '@fontsource-variable/figtree/wght.css'
import '@fontsource/zen-kaku-gothic-antique/500.css'
import '@fontsource/zen-kaku-gothic-antique/700.css'
import './stage.css'
import { TextOverlayRenderer } from '@ui/render.js'
import { createController } from '@ui/controller.js'
import { BUTTON } from '@ui/controller-input.js'
import { HoverOverlay } from '@ui/hover.js'
import { RegionSelect } from '@ui/region-select.js'
import { SETTINGS_DEFAULTS } from '@ui/settings'
import { studioJson } from '../studio/bridge'
import { drawGame, gamePicture, type Game, type GameKind } from './game'
import { DEFAULT_HISTORY, DEFAULT_SCRIPT, lookupWord, type StageScript } from './script'

const params = new URLSearchParams(location.search)
const flag = (name: string): boolean => params.get(name) === '1'
const scene = params.get('scene') ?? 'overlay-words'
const script: StageScript = { ...DEFAULT_SCRIPT, ...(studioJson<Partial<StageScript>>('script') ?? {}) }
const history = studioJson<unknown[]>('history') ?? DEFAULT_HISTORY
const popupType = params.get('popup') ?? 'yomitan'
const input = params.get('input') === 'keys' ? 'keys' : 'pad'
const theme =
  params.get('theme') === 'light' || params.get('theme') === 'dark'
    ? (params.get('theme') as 'light' | 'dark')
    : matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'

// The reader pop-up inside reads the studio's state from its parent, which is this page.
try {
  ;(window as unknown as { __kimochiStudio?: unknown }).__kimochiStudio = (
    window.parent as unknown as { __kimochiStudio?: unknown }
  ).__kimochiStudio
} catch {
  // Not in the studio.
}

// The overlay window's own styles, as the app loads them (overlay.html's <style> blocks).
for (const [, css] of overlayHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
}

const gameHost = document.querySelector<HTMLElement>('#game')!
const words = document.querySelector<HTMLElement>('#words')!
const hoverHost = document.querySelector<HTMLElement>('#hover')!
const controllerHost = document.querySelector<HTMLElement>('#controller')!

const log: unknown[] = []
function toast(message: string): void {
  const node = document.createElement('div')
  node.className = 'stage-toast'
  node.textContent = message
  document.body.append(node)
  setTimeout(() => (node.style.opacity = '0'), 1400)
  setTimeout(() => node.remove(), 1800)
}

// --------------------------------------------------------------- the game and its text

let game: Game = { area: { x: 0, y: 0, width: innerWidth, height: innerHeight }, annotations: [] }
let textVisible = true
const renderer = new TextOverlayRenderer(words, {
  onLookupStart: () => undefined,
  onActivity: () => undefined
})

function grouping(): Record<string, unknown> {
  return {
    ...SETTINGS_DEFAULTS.textOverlayGrouping,
    enabled: flag('grouping'),
    filterSmallText: params.get('filter') !== '0'
  }
}

function draw(): void {
  if (!textVisible) return renderer.clear()
  const { area } = game
  const typeface = params.get('typeface') === 'manga' ? { typeface: 'manga' } : {}
  // The renderer's JSDoc types predate `bounds`; this is the view overlay.js passes.
  renderer.render({
    annotations: game.annotations.map((a) => ({ ...a, ...typeface })),
    info: {
      full_width: area.width,
      full_height: area.height,
      crop_pixels: [0, 0, area.width, area.height],
      source_bounds: area
    },
    origin: { x: 0, y: 0, width: innerWidth, height: innerHeight },
    bounds: area,
    grouping: grouping(),
    opacity: Number(params.get('opacity') ?? SETTINGS_DEFAULTS.overlayOpacity),
    scanning: false
  } as unknown as Parameters<TextOverlayRenderer['render']>[0])
}

async function layOut(): Promise<void> {
  await document.fonts.ready
  game = drawGame(gameHost, {
    kind: (params.get('game') === 'manga' ? 'manga' : 'dialogue') as GameKind,
    script,
    furigana: params.get('furigana') !== '0',
    windowed: flag('windowed')
  })
  draw()
}

// --------------------------------------------------------------- the dictionary pop-up

const popup = document.createElement('iframe')
popup.className = 'stage-popup'
popup.title = 'Dictionary pop-up'
popup.hidden = true
let popupReady: Promise<void> | null = null
let shown: string | null = null

function popupFrame(): Promise<void> {
  popupReady ??= new Promise((resolve) => {
    const ready = (event: MessageEvent): void => {
      if ((event.data as { type?: string })?.type !== 'kimochi-preview-popover-ready') return
      window.removeEventListener('message', ready)
      resolve()
    }
    window.addEventListener('message', ready)
    popup.src = `./reader-popup.html?popover=message&theme=${theme}`
    document.body.append(popup)
  })
  return popupReady
}

/** Show the pop-up for a lookup of `text` (and on), beside `rect` as Yomitan places it. */
async function showPopup(text: string, rect: { left: number; top: number; right: number; bottom: number }): Promise<void> {
  const { term, word } = lookupWord(script, text)
  log.push({ check: 'stage-lookup', text, term })
  const width = 380
  const height = 230
  // Beside a vertical word (left of it where there is room), else under or over it.
  const vertical = rect.bottom - rect.top > (rect.right - rect.left) * 1.5
  let left: number
  let top: number
  if (vertical) {
    left = rect.left - 8 - width >= 0 ? rect.left - 8 - width : Math.min(innerWidth - width - 8, rect.right + 8)
    top = Math.max(8, Math.min(innerHeight - height - 8, rect.top))
  } else {
    const below = rect.bottom + 8 + height <= innerHeight
    left = Math.max(8, Math.min(innerWidth - width - 8, rect.left))
    top = below ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)
  }
  Object.assign(popup.style, { left: `${left}px`, top: `${top}px` })
  await popupFrame()
  popup.hidden = false
  if (shown === term) return
  shown = term
  popup.contentWindow?.postMessage(
    {
      type: 'kimochi-preview-popover',
      theme,
      payload: {
        kind: 'loaded',
        term,
        fresh: true,
        entries: [
          {
            expression: term,
            reading: word?.reading ?? '',
            glossary: `<div style="text-align: left;"><ol><li>${word?.meaning ?? 'No entry in the stage’s dictionary (studio JSON: script.words).'}</li></ol></div>`,
            dictionary: 'JMdict (English)',
            tags: ''
          }
        ],
        audioMedia: [],
        dictionaryMedia: [],
        sentence: text,
        audioAutoplay: false,
        audioVolume: 0.9,
        ankiConfig: null,
        baseUrl: 'http://127.0.0.1:19633'
      }
    },
    location.origin
  )
}

function hidePopup(): void {
  popup.hidden = true
  delete popup.dataset.focused
}

// A lookup as Yomitan's scanner reads it: a Shift-mousedown on the overlay's text (render.js).
words.addEventListener('mousedown', (event) => {
  if (!event.shiftKey) return
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY)
  const node = caret?.startContainer
  if (!caret || !node?.textContent) return
  const range = document.createRange()
  range.setStart(node, caret.startOffset)
  range.setEnd(node, node.textContent.length)
  const rect = (event.target as HTMLElement).closest('.ocr-word, .ocr-group')?.getBoundingClientRect() ?? range.getBoundingClientRect()
  void showPopup(range.toString(), rect)
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hidePopup()
})

// --------------------------------------------------------------- the controller

type Listener = (event: { payload: unknown }) => void
const listeners = new Map<string, Listener>()
const native = {
  listen: async (name: string, handler: Listener) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  },
  controllerNav: async () => ({}),
  hotkeysLoad: async () => ({ openControllerMenu: { gamepadButtons: [BUTTON.ls, BUTTON.rs] } })
}
let autoOcr = flag('auto')

type ControllerContext = Parameters<typeof createController>[0]
const controller = createController({
  host: controllerHost,
  appearance: () => theme,
  words,
  native,
  status: () => {
    const { area } = game
    return {
      gamescope: false,
      hasText: !flag('notext') && game.annotations.length > 0,
      autoOcr,
      autoAvailable: !flag('quickshot'),
      textVisible,
      origin: { x: 0, y: 0 },
      area,
      scanId: 1,
      center: { x: area.x + area.width / 2, y: area.y + area.height / 2 }
    }
  },
  panelInputHandoff: false,
  run: async (id: string) => {
    if (id === 'auto') {
      autoOcr = !autoOcr
      return toast(`Auto OCR ${autoOcr ? 'on' : 'off'}`)
    }
    toast(id === 'controls' ? 'Opens Kimochi (the main window)' : 'Opens Settings → OCR & Overlay')
  },
  history: async () => history,
  scan: async () => {
    toast('Scanned (the stage’s text)')
    return true
  },
  popupControl: (control: { focus?: string; step?: number; scroll?: number }) => {
    if (control.focus === 'enter') {
      if (popup.hidden) return false
      popup.dataset.focused = ''
      return true
    }
    if (control.focus === 'exit') {
      delete popup.dataset.focused
      return true
    }
    if (control.focus === 'press') toast('Pressed the pop-up’s chosen button')
    if (control.focus === 'audio') toast('Plays the word’s audio')
    return !popup.hidden
  },
  popupFocusable: () => popupType === 'yomitan' || popupType === 'hachidori',
  redraw: () => draw(),
  dictionary: () => null,
  popupType: () => (popupType === 'yomitan' ? 'builtin' : popupType),
  buttons: () => SETTINGS_DEFAULTS.controllerButtons,
  lookupRange: async (range: Range) => {
    // Placed by where the lookup starts: the range runs on past the word, into the boxes after.
    await showPopup(range.toString(), range.getClientRects()[0] ?? range.getBoundingClientRect())
    return true
  },
  lookupTerm: async (text: string, x: number, y: number) => {
    await showPopup(text, { left: x, right: x, top: y - 12, bottom: y + 12 })
  },
  apiParse: async () => null,
  matchedRange: () => null,
  charRects: (element: HTMLElement) => (renderer.mode === 'words' ? renderer.charRects(element) : null),
  quietText: (quiet: boolean) => renderer.setQuiet(quiet),
  setText: (visible: boolean) => {
    textVisible = visible
    draw()
  },
  nearText: (x: number, y: number) =>
    [...words.children].some((element) => {
      const r = element.getBoundingClientRect()
      return x >= r.left - 32 && x <= r.right + 32 && y >= r.top - 32 && y <= r.bottom + 32
    }),
  dismiss: () => hidePopup(),
  log: (record: unknown) => void log.push(record),
  modeChanged: () => undefined
} as unknown as ControllerContext)
window.addEventListener('mousemove', (event) => {
  renderer.setPointer(event.clientX, event.clientY)
  controller.pointer(event.clientX, event.clientY)
})
words.addEventListener('mousemove', () => controller.mouseActivity())
words.addEventListener('click', () => controller.mouseUsed())

const BUTTONS: Record<string, number> = {
  a: BUTTON.south,
  b: BUTTON.east,
  x: BUTTON.west,
  y: BUTTON.north,
  lb: BUTTON.lb,
  rb: BUTTON.rb,
  lt: BUTTON.lt,
  rt: BUTTON.rt,
  view: BUTTON.view,
  start: BUTTON.start,
  ls: BUTTON.ls,
  rs: BUTTON.rs,
  up: BUTTON.up,
  down: BUTTON.down,
  left: BUTTON.left,
  right: BUTTON.right
}
let stick = { x: 0, y: 0 }
let rstick = { x: 0, y: 0 }

/** One input, as native would report it (see the `__stage` notes above). */
async function send(command: string): Promise<void> {
  const nav = (payload: Record<string, unknown>): void =>
    listeners.get('controller-nav')?.({ payload: { pressed: [], released: [], held: [], stick, rstick, ...payload } })
  if (command === 'menu') return void (await controller.toggle(input))
  if (command.startsWith('key:')) {
    const key = command.slice(4)
    listeners.get('controller-key')?.({ payload: { type: 'keydown', key } })
    return
  }
  if (command.startsWith('stick:')) {
    const [x, y] = command.slice(6).split(',').map(Number)
    stick = { x, y }
    return nav({})
  }
  if (command.startsWith('rstick:')) {
    rstick = { x: 0, y: Number(command.slice(7)) }
    return nav({})
  }
  const button = BUTTONS[command]
  if (button === undefined) throw new Error(`stage: unknown input ${command}`)
  nav({ pressed: [button], held: [button] })
  nav({ released: [button] })
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Open read-along on the stage's text, the way the menu's Read along does. */
async function readAlong(): Promise<void> {
  const wasAuto = autoOcr
  autoOcr = true // the menu starts on Read along, so A opens it
  await controller.toggle(input)
  autoOcr = wasAuto
  await send(input === 'keys' ? 'key:Enter' : 'a')
  await pause(250)
}

// --------------------------------------------------------------- scenes

async function play(): Promise<void> {
  switch (scene) {
    case 'overlay-words': {
      const at = params.get('hover')?.split(',').map(Number)
      if (at?.length === 2) renderer.setPointer(at[0], at[1])
      if (flag('lookup')) {
        const first = words.querySelector<HTMLElement>('.ocr-word, .ocr-group')
        const text = first?.textContent ?? ''
        if (first) await showPopup(text, first.getBoundingClientRect())
      }
      return
    }
    case 'overlay-hover': {
      const { area } = game
      new HoverOverlay(hoverHost).update({
        visible: true,
        showWindowOutline: true,
        showCropRegion: flag('crop'),
        windowImage: null,
        bounds: area,
        crop: { x: area.width * 0.05, y: area.height * 0.62, width: area.width * 0.9, height: area.height * 0.34, reference_width: area.width, reference_height: area.height },
        origin: { x: 0, y: 0 }
      })
      return
    }
    case 'region-select': {
      const { area } = game
      const initial = flag('initial')
        ? {
            x: Math.round(area.x + area.width * 0.05),
            y: Math.round(area.y + area.height * 0.62),
            width: Math.round(area.width * 0.9),
            height: Math.round(area.height * 0.34)
          }
        : null
      const picture = flag('picture') ? area : null
      // Started again after each commit or cancel, so the editor stays on screen.
      for (;;) {
        const selector = new RegionSelect({
          container: document.body,
          confirmLabel: params.get('label') ?? 'Save',
          alternateLabel: params.get('alternate'),
          theme,
          area: flag('windowed') ? area : null,
          initial,
          picture
        } as unknown as ConstructorParameters<typeof RegionSelect>[0])
        const running = selector.start()
        if (picture) void selector.setPicture(gamePicture(params.get('game') === 'manga' ? 'manga' : 'dialogue'))
        const result = (await running.catch(() => null)) as { local: { width: number; height: number } } | null
        log.push({ check: 'stage-region', result })
        selector.destroy()
        if (result) toast(`Region ${Math.round(result.local.width)} × ${Math.round(result.local.height)}`)
        await pause(400)
      }
    }
    case 'controller-menu':
      await pause(100)
      return void (await controller.toggle(input))
    case 'controller-words':
    case 'controller-controls': {
      await readAlong()
      const steps = Number(params.get('step') ?? 0)
      // Along the text: down a column of vertical text, right along a line.
      const along = params.get('game') === 'manga' ? 'down' : 'right'
      for (let i = 0; i < steps; i++) await send(input === 'keys' ? `key:Arrow${along === 'down' ? 'Down' : 'Right'}` : along)
      if (params.get('unit') === 'character') await send(input === 'keys' ? 'key:Space' : 'y')
      if (params.get('cursor') === 'free') {
        await send('stick:0.7,0.2')
        await pause(220)
        await send('stick:0,0')
      }
      if (params.get('layer') === 'popup') {
        await pause(150)
        await send('a')
      }
      if (params.get('driver') === 'mouse') {
        const r = words.firstElementChild?.getBoundingClientRect()
        if (r) {
          controller.pointer(r.left - 200, r.top - 200)
          controller.pointer(r.left + 10, r.top + 10)
        }
      }
      if (scene === 'controller-controls') {
        // Put away so the sheet can be read; in the app the pop-up is its own window, and may
        // still be up over it.
        hidePopup()
        await send('view')
      }
      return
    }
    case 'controller-history':
      await controller.recentText()
      if (flag('read')) {
        await pause(100)
        await send('a')
      }
      return
    default:
      toast(`Unknown scene: ${scene}`)
  }
}

Object.assign(window, { __stage: { scene, send, controller, renderer, log, popup, game: () => game } })

await layOut()
let resizing: ReturnType<typeof setTimeout> | null = null
// A new size is a new scan: the text is laid out again, and a scene that the controller or the
// region editor is part way through starts over from the top.
addEventListener('resize', () => {
  if (resizing) clearTimeout(resizing)
  resizing = setTimeout(() => (scene === 'overlay-words' ? void layOut() : location.reload()), 200)
})
await play()
