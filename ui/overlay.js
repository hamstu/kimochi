import './install-pointer-dedupe.js'
import { createDictionarySetup } from './setup-dictionaries.js'
import { followYomitanProfiles } from './yomitan-profiles.js'
import { followHachidoriLanguage } from './hachidori-languages.js'
import { aDictionaryFor } from './sample-words.js'
import {
  apiTokenize,
  dismissApiLookup,
  installApiLookup,
  lookupKeyProperty,
  lookupTerm,
  popupAnkiConfig
} from './api-lookup.js'
import { createAnki } from './game-dictionary-anki.js'
import { audioUrl } from './game-dictionary.js'
import { createController } from './controller.js'
import { radialItemForHotkey, RADIAL_MENU_SETTING } from './radial-items.js'
import { padButtons, startRegionPad } from './region-pad.js'
import { buttonName, pageMenuKey } from './controller-input.js'
import { activePadLayout, setPadLayout } from './pad-layout.js'
import { createPopupFocus, YOMITAN_FOCUS } from './popup-focus.js'
import { ReadingHold } from './reading-hold.js'
import { installPointerDiagnostics, pointerTrace, pointerTracing } from './pointer-diagnostics.js'
import { PopupLeave, gapBetween, inRect, lineAround } from './popup-leave.js'
import { boundingRect } from './popup-geometry.js'
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The overlay window: Yomitan host, text renderer and scan orchestrator.
 *
 * This is the only window that is always open, so it carries two jobs Electron
 * split between a hidden background window and the overlay renderer: hosting the
 * original Yomitan extension — backend, scanner, popup, importer and IndexedDB,
 * as the single owner of the dictionary database — and running the scan pipeline
 * that draws recognised text, detects change and publishes results.
 *
 * Native owns capture, the cloud endpoint, settings, window placement, global
 * shortcuts, the gamepad and action dispatch. This file must never repeat an
 * action native has already performed, so the `hotkey` handler below deliberately
 * ignores every action whose effect Rust applied before emitting it.
 *
 * Startup order matters: the scan pipeline is wired up first and the Yomitan host
 * is brought up behind it, without blocking. A dictionary or backend failure then
 * costs lookups and says so, instead of leaving the user with no OCR at all.
 */

import { displayAfterLayout, mapAnnotations, sourceDisplay, toOverlayLocal } from './geometry.js'
import { hoverLookupApplies, scanPointerInit, withHoverKey } from './scan-input.js'
import { effectiveLookupKey, isLookupButton, lookupButtonsBit } from './lookup-key.js'
import { groupTextAnnotations, visibleAnnotations } from './annotations.js'
import { japaneseFilterOf } from './japanese-text.js'
import { isJapanese, languageOf } from './languages.js'
import { hasLanguageScript } from './script-text.js'
import { JAPANESE_WORDS } from './word-nav.js'
import { AutoScanner } from './autoscan.js'
import { resolveWatcher, observerModeOf } from './watcher.js'
import { SceneScanner } from './scene-scanner.js'
import { ScanTrace } from './scan-trace.js'
import { scanWasPublished, markScanPublished } from './scan-publication.js'
import { annotationsInLines } from './current-lines.js'
import { TextOverlayRenderer, measureFor } from './render.js'
import { applyTextStyle, textStyle } from './language-style.js'
import { sampleFor } from './language-samples.js'
import { HoverOverlay, HoverPreview, marksUnderPointer } from './hover.js'
import { recognize } from './ocr.js'
import { annotationGroups, fullWidth, hookAnnotations, readSpan, splitSpeaker } from './hook-match.js'
import { createHookCard, HOOK_CARD_OPACITIES } from './hook-card.js'
import { glyphGeometry, OWN_PITCH_GLYPHS } from './hook-glyphs.js'
import { createOverlayHints, HINTS_DISMISSED } from './overlay-hints.js'
import { hookSettings, withLegacyShowCard } from './hook-games.js'
import { normalizeOcrResult, scanGroups } from './ocr-result.js'
import { logSections } from './log-sections.js'
import { publishOcrResult, listHistory } from './output.js'
import { speak } from './tts.js'
import { ForegroundTracker, shouldShowScannedText } from './foreground.js'
import {
  isNativeWaylandSourceId,
  isWaylandScreenSourceId,
  isWaylandWindowSourceId,
  parseSourceId
} from './source-id.js'
import { portalWindowBounds, portalCropArea } from './portal-window-geometry.js'
import {
  cropFromOutput,
  cropToOutput,
  outputArea,
  outputAt,
  sameRect as sameOutput,
  screenOutputs,
  startOutput
} from './wayland-screen-crop.js'
import {
  DICTIONARY_ENGINE_KEY,
  NO_ENGINE,
  NO_ENGINE_MESSAGE,
  dictionaryEngineOf,
  effectiveDictionaryEngine,
  fullscreenDictionary,
  fullscreenDictionarySource,
  hostEngineOf,
  isOverlayTextVisible,
  nextOverlayToggle,
  overlayTextChange,
  clickThroughLocked,
  hookCardLocksAutoAlign,
  overlayStyleOf,
  radialBaseVars,
  radialMenuColorOf,
  resolveHookCardAppearance,
  resolveHostEngine,
  resolveOverlayCardAppearance,
  usableInputSource
} from './settings.js'
import { clearOfGame, exceptRects, popupHitRects } from './regions.js'
import { Generation, PipelineLock } from './pipeline.js'
import * as scanActivity from './scan-activity.js'
import { openAppLane } from './app-lane.js'
import { createSoundPlayer, outcomeSound, soundKind, soundKindOn } from './sounds.js'
import * as native from './native.js'

let waylandDisabled = false
let waylandLayer = false
/**
 * Whether native can read Shift, so the words and the hook card let clicks through without it
 * (`View::live_regions`). On Wayland only where the compositor reports the pointer and something
 * reports Shift (`overlay.shiftGate`: KDE Plasma, Hyprland); elsewhere they take the mouse.
 */
let shiftGated = true
/** KDE Plasma with nothing relaying Shift: the overlay's text looks up on hover instead. */
let lookupOnHover = false
/** Wayland: a button went down on this surface and has not come up. A layer surface keeps the
 * pointer through a press, so its DOM events are the button's state; the compositor feed has no
 * buttons over a Wayland window. */
let surfaceButtonDown = false
/** Whether the last move the native feed handed the engine carried Shift. */
let lastScanShift = false
/**
 * Whether clicks on the overlay's text (`words`) or the hook card (`card`) go to the game unless
 * Shift is held (`overlayClickThrough`, on unless turned off). Off, they take the mouse as before;
 * drawn Transparent, they always let clicks through (`clickThroughLocked`).
 */
function clickThrough(surface = 'words') {
  return (
    native.getSetting('overlayClickThrough') !== false || clickThroughLocked(native.getSetting('overlayStyle'), surface)
  )
}
/**
 * Whether resting the pointer on a word looks it up with no key held (`overlayHoverLookup`, off
 * unless turned on). Native says when the pointer rests (the feed's `hover`); the words still let
 * clicks through to the game, and a pop-up no longer takes the next click (`catching`).
 */
function hoverLookup() {
  return hoverLookupApplies(
    { gamescope: nativeGamescope, wayland: waylandSession, lookupOnHover },
    native.getSetting('overlayHoverLookup')
  )
}
/**
 * Look up on hover with 10ten: 10ten hovers by itself, as in a browser (host/ext/app.js
 * `bareHover`), so every plain pointer move looks up and the pop-up glides from word to word.
 * The overlay then adds no key to the moves it hands it (a held Shift would ask 10ten for kanji).
 */
function tentenBareHover() {
  return extensionHosted && window.__kimochiExtensionHost?.descriptor?.id === 'tenten' && hoverLookup()
}
/** Tell the extension host whether 10ten hovers by itself; it does nothing when unchanged. */
function syncTentenBareHover() {
  window.__kimochiExtensionHost?.bareHover?.(tentenBareHover())
}
/** Linux on Wayland (`caps.session.backend`): hover lookup does not apply there (`hoverLookupApplies`). */
let waylandSession = false
/** Whether the whole overlay is taking the next click (`hitRects`, `onFreeClick`). */
let catching = false
/** Whether Shift's gate is open (`state::ShiftGate`), from the native pointer feed. */
let gateOpen = false
/** The rest of a press the free click took: swallowed up to its click. */
let swallowClick = false
/**
 * GNOME: a free click was taken for the pop-up still showing. One click away is all a pop-up
 * gets: if it does not go, the next click is the game's rather than the overlay's again, and a
 * pop-up that failed to report closing cannot leave the overlay taking every click on the screen.
 */
let freeClickTaken = false

const hub = window.__extensionHost
const log = (value) => {
  if (hub?.log) hub.log(value)
  else void native.report(value)
}

/** Say what just happened on the Log's activity ticker; see scan-activity.ts for the words. */
const activity = (post) => native.postActivity(post)

const scanTrace = new ScanTrace((records) => native.writeScanTrace(records))
const trace = (kind, data) => {
  try {
    scanTrace.record(kind, data)
  } catch {
    /* diagnostic only */
  }
}
trace('session', { instrumentation: 'first-pass-v1' })

const wordsContainer = document.querySelector('#words')
const hoverContainer = document.querySelector('#hover')
const pagesSection = document.querySelector('.pages')
const foreground = new ForegroundTracker()

const state = {
  revision: -1,
  dismiss: -1,
  dictionaryOpen: false,
  scanning: false,
  origin: null,
  info: null,
  annotations: [],
  /** What OCR last read, before the Text Hooker kept only the hooked line (setOcrAnnotations). */
  rawAnnotations: [],
  geometry: true,
  scannedApp: null,
  source: null,
  /** The selection as the shared view describes it (`{sourceId, type, ...}`). */
  viewSource: null,
  /** The native scan id already rendered and already published. */
  appliedScanId: null,
  // Session view flags live on the shared native view, so the controller and the
  // overlay can never disagree about what is switched on.
  flags: {
    autoOcrEnabled: false,
    textOverlayVisible: true,
    overlayVisible: true,
    debugOverlayVisible: false
  },
  /** Live bounds of the captured source, tracked natively between scans. */
  sourceBounds: null,
  /**
   * The rest of what native tracks about a window source (`source-bounds`): `fullscreen` (it
   * fills its display: a full-screen app, or a borderless window), `onScreen`, and `settling`
   * (a full-screen app's Space sliding in or out; its text is hidden until it is at rest).
   */
  sourceWindow: null,
  /**
   * Whether the captured window is still in front and still there, from native.
   * Null until the first answer arrives; unknown shows text rather than hiding it.
   */
  sourceFocus: null,
  crop: null,
  /** The chosen source's Anki crop (what goes on cards as the screenshot), or null for all of it. */
  ankiCrop: null,
  hover: { selectRegion: false, source: false, isWindow: false, underPointer: false },
  /** While true the overlay claims the whole display so a drag can be seen. */
  regionSelecting: false,
  /** From opening a source's region editor until its new crop is saved and taken in. */
  regionCommitting: false,
  /**
   * The text on screen came from a Quick Shot: a display region, not the chosen source. It stays
   * where it was captured instead of following the source window around.
   */
  detached: false,
  // The dictionary backend, whichever engine it is. Named for Yomitan, the first engine, and kept
  // so: `ready` gates the pointer feed for every engine, and `error` is what lookups report.
  yomitan: { ready: false, error: null }
}

/**
 * A setting, as this window reads it. `textOverlayGrouping` comes with the Japanese filter folded
 * in: that is the Log's setting (`superTexthooker.japaneseFilter`, on unless turned off), and
 * the overlay applies the same rule to what it draws (`visibleAnnotations`). Folding it in here
 * means every reader of the grouping (drawing, click targets, GNOME's surface, what a scan
 * publishes) filters the same way. The language being read comes with it (`language`): the filter
 * keeps that language's scripts, and it decides whether small text is furigana and how words join.
 */
const setting = (key) =>
  key === 'textOverlayGrouping'
    ? {
        ...(native.getSetting(key) ?? {}),
        ...japaneseFilterOf(native.getSetting('superTexthooker'), languageNow())
      }
    : native.getSetting(key)

/** The language being read: a code from languages.ts (`language`, Japanese unless chosen). */
const languageNow = () => languageOf(native.getSetting('language')).code

/**
 * How Read along finds the words of the language being read (word-nav.js): Japanese as it always
 * has, any other language by its scripts and its own word segmenter.
 */
const languageWords = () => {
  const language = languageOf(native.getSetting('language'))
  return isJapanese(language.code)
    ? JAPANESE_WORDS
    : { code: language.code, spaces: language.spaces, test: (text) => hasLanguageScript(text, language.code) }
}

// ---------------------------------------------------------------------------
// Text Hooker on the overlay (src-tauri/src/text_hook, ui/hook-match.ts)
// ---------------------------------------------------------------------------
//
// With the Text Hooker as the Log's input, the hooked line is the text and OCR only says where it
// is. Nothing OCR read is drawn: the line is shown in the card (hook-card.js), always visible while
// the game is in front, and looked up like any text on the overlay. Per game (`textHookerGames`,
// keyed by the game's exe path, as the thread it reads is in text_hook):
//
// - `autoAlign` (on unless turned off): Auto OCR runs in the background with the scan engine and
//   each reading is matched against the line (`hookAnnotations`); a new line is looked for at once
//   (`chaseHookLine`) rather than when the loop next reads. The first match sets the text's size
//   (`text`, `leading`), which then stays: a game's text size does not change from line to line,
//   and a card whose text grew and shrank with every reading was the worst of it (readings of two
//   other lines must agree to change it). The match also says where the text starts (`ocrBox` x,
//   y): the first whole reading of a new line puts the card there; after that it moves only when
//   readings put it clearly somewhere else (more than a line away). And how big the text is,
//   which only ever grows the box (`ocrBox` width, height), so a short line after a long one in
//   the same place keeps the long one's box rather than the card shrinking and growing under the
//   reader. The card wraps the line onto no more lines than the game does (hook-card.js `fit`).
// - Off, the reader places the card (`box`): moved by the bar along its top, resized by its corner;
//   the text keeps its size either way.
//
// Boxes are fractions of the game window, of the text itself (the card's padding is outside it),
// so the card follows the window; `text` is the text's size as a fraction of the window's height.

/** Where the card goes before anything placed it: centred along the bottom of the game window. */
const HOOK_DEFAULT = { x: 0.2, bottom: 0.94, width: 0.6, lines: 2 }
/** The text's size before OCR measured it (Settings → Text Hooker) is held within these points. */
const HOOK_TEXT_POINTS = [14, 40]
/** A reading that puts the text more than this many lines' height away has moved it. */
const HOOK_MOVE_LINES = 1
/** How much a reading's size must differ from the kept one, twice running, to replace it. */
const HOOK_RESIZE = 0.3
/**
 * Auto align fits the card's letter-spacing to the width OCR found for a row of at least this
 * many characters, and to no more than this share of the text's size either way (`hookCardView`).
 */
const HOOK_FIT_CHARS = 6
const HOOK_FIT_SPACING = 0.3
/**
 * Once this many lines have fitted it, the game's spacing is known, and a reading whose fit is
 * further than this share of the text's size from it is not trusted (it missed part of the line).
 */
const HOOK_FIT_KNOWN = 3
const HOOK_FIT_AGREE = 0.1
/**
 * A reading that puts a line's start within this share of the text's size of where the game's
 * lines start leaves it there (no twitch), and counts towards that place, its readings averaged
 * over at most this many.
 */
const HOOK_PIN_SNAP = 0.15
const HOOK_PIN_SNAP_BRACKETED = 0.5
const HOOK_PIN_READINGS = 8
/** How far (in frame pixels) a reading must move a line's glyphs to move the card's (`hookGlyphsFrom`). */
const HOOK_GLYPH_STILL = 0.75
/** Whether a stretch of text starts or ends with a bracket (its ink is where its font puts it). */
const bracketed = (first, last) => /[「『（【〈《“‘]/u.test(first ?? '') || /[」』）】〉》”’]/u.test(last ?? '')
const hook = {
  /** The newest hooked line. */
  line: null,
  /** The session's game and window (`texthook-status`), while hooked. */
  exe: null,
  sourceId: null,
  /** Auto align moved the card: it glides there. */
  glide: false,
  /** When the newest line arrived (`performance.now()`), to log how soon it was aligned. */
  lineAt: 0,
  /** What the card shows of the line: all of it, or what its speaker says (`splitSpeaker`). */
  shown: null,
  /** The speaker's name as OCR text where the game shows it, drawn as OCR is (`hookAligned`). */
  names: [],
  /** The line `names` was found for, kept through readings of it that miss the name. */
  namesLine: null,
  /** The line being looked for (`chaseHookLine`): until it is found the card holds it on one line. */
  chasing: null,
  /** The line a whole reading last placed the card on: a new one is placed at once. */
  placed: null,
  /**
   * Where the game wraps the line, as a whole reading found it (`{line, shown, rows}`): the hooked
   * text cut at OCR's line breaks. A game that wraps its text itself sends one unbroken line; the
   * card, aligned on the game's text, breaks it where the game does instead of where its own font
   * happens to run out of room.
   */
  wrap: null,
  /** Where a whole reading last found the line's ink (`{line, box}`): the card is centred on it. */
  /**
   * Where the game's lines start (`{x, y}`, fractions of the window: the mean of the readings that
   * agreed, `n` of them), the box they were found in (`at`) and the game: a line is shown there
   * (`show`, held for the line it was shown for, `shownLine`) and a reading of it that agrees
   * counts once (`measuredLine`).
   */
  textAt: null,
  /** The letter-spacing the game's lines have had, as a share of the text's size (`em`), averaged. */
  spacing: null,
  /**
   * Where the game draws each glyph of the line (`hookGlyphsFrom`: `{line, rows, pitch, starts,
   * middles, marks}`, fractions of the frame), from a reading that boxed its characters.
   */
  glyphs: null,
  /** The game's glyph pitch (`{exe, pitch, n, base, line}`), the running mean of its long lines'. */
  glyphPitch: null,
  /**
   * Where the game's lines start as their glyphs place them (`{exe, x, y, n, show, base, line}`):
   * the running mean (`x`, `y`) of each line's newest reading, shown (`show`) as it was when the
   * line came (`hookCardView`).
   */
  glyphAt: null,
  found: null,
  /** The last reading that did not find the line whole (`hook-line-chase` logs its blocks). */
  missed: null,
  /** The last reading aligned with, so the same one is not counted twice. */
  reading: null,
  /**
   * A size that differed from the kept one (`HOOK_RESIZE`) and the line it was read on, waiting
   * for a reading of another line to agree.
   */
  resize: null,
  /** A whole reading somewhere new (`HOOK_MOVE_LINES` away), waiting for a second to agree. */
  moveTo: null,
  /** Why the card is hidden (`hookCardHidden`), as last logged. */
  hidden: undefined,
  /** The card (hook-card.js), made once the overlay's document is ready. */
  card: null,
  /** The session as native last reported it (`texthook-status`), for the game menu's panel. */
  status: null
}
/**
 * What the card shows while the game menu's Text Hooker panel is open and no line has come yet,
 * so its place, size and look can be set: marked as an example (hook-card.css), in the reader's
 * own settings. Natsume Sōseki's opening line, long out of copyright; in another language its
 * sample sentence (language-samples.ts), or, with none, a plain note of what goes there.
 */
const HOOK_EXAMPLE = '吾輩は猫である。名前はまだ無い。'
const hookExample = () => {
  const language = languageNow()
  if (isJapanese(language)) return HOOK_EXAMPLE
  return sampleFor(language)?.sentence ?? 'The game’s text appears here.'
}
/** The Log's input, as this system can use it (a Text Hooker input synced from Windows is OCR here). */
const inputNow = () =>
  usableInputSource(setting('superTexthooker')?.inputSource ?? 'ocr', window.__KIMOCHI_PLATFORM__?.os)
const hookMode = () => inputNow() === 'hook'
/**
 * The browser extension is the source (src-tauri/src/browser_bridge.rs): its pictures are read
 * here (`onBrowserScan`) but drawn by the extension over the page, never by this window.
 */
const browserMode = () => inputNow() === 'browser'
const hookKey = () => hook.exe?.toLowerCase() ?? null
const hookGame = () => (hookKey() && setting('textHookerGames')?.[hookKey()]) || {}
/**
 * The game's settings, with the defaults (Settings → Text Hooker) where it has none (hook-games.ts).
 * A card drawn Transparent is always auto-aligned (`hookCardLocksAutoAlign`).
 */
const hookDefaults = () => withLegacyShowCard(setting('textHookerDefaults'), setting('textHookerShowCard'))
const hookSet = () => {
  const set = hookSettings(hookDefaults(), hookGame())
  return hookCardLocksAutoAlign(setting('overlayStyle')) ? { ...set, autoAlign: true } : set
}
const hookAutoAlign = () => hookSet().autoAlign
/** The card over the game at all (Settings → Text Hooker → Card, per game; the game menu's Card). */
const hookCardOn = () => hookSet().showCard !== 'never'
/**
 * Only while the lookup key is held (Settings → Text Hooker → Show the card): native's gate
 * (`gateOpen`) follows `overlayLookupKey`, and a controller's lookup button. Where the key cannot
 * be read (`shiftGated` false) or in Gaming Mode, there is no key to wait for, so the card stays up.
 */
const hookCardOnKey = () =>
  hookSet().showCard === 'hold' && shiftGated && !(window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope)
/**
 * The lookup key down (the native pointer feed's gate), or a pop-up opened from the card still up:
 * what a card shown only with the key waits for (`hookCardOnKey`).
 */
let hookKeyHeld = false
/** A dictionary pop-up is showing: a card shown with the key stays while one opened from it is up. */
const hookPopupOpen = () => Boolean(extensionPopupRect) || [...livePopups].some((popup) => popup.isVisibleSync?.())
/** Auto align reads the screen with OCR: only while there is a card to align. */
const hookOcrOn = () => hookMode() && Boolean(hook.sourceId) && hookAutoAlign() && hookCardOn()
/** The OCR engine in use (Auto align uses the scan engine too). */
const ocrModeNow = () => native.getSetting('ocrMode')
async function saveHookGame(change, forget = []) {
  const key = hookKey()
  if (!key) return
  const games = setting('textHookerGames') ?? {}
  const game = { ...(games[key] ?? {}), ...change }
  for (const name of forget) delete game[name]
  await native.setSetting('textHookerGames', { ...games, [key]: game })
}

// The card itself; it tells the overlay when it is dragged (the pointer then comes at full rate,
// and the whole display is the overlay's until it is let go) and where it was left.
hook.card = createHookCard(document.body, {
  onMoved: (box) => onHookCardMoved(box),
  onDrag: (active) => {
    void native.optional('overlay_drag', { active })
    void publishRegions()
  },
  onTextSize: (step, box) => onHookCardTextSize(step, box),
  onOpacity: (opacity) => void saveHookGame({ opacity }),
  onSettings: async () => {
    await native.setSetting('textHookerSettingsGame', hookKey())
    await native.setSetting('settingsActiveTab', 'texthooker')
    await native.panel('log', 'show')
    await window.__TAURI__.event.emit('main:show-settings')
  }
})

// What Shift does, along the bottom while there is text, until the reader closes it.
const hints = createOverlayHints(document.body, {
  onDismiss: () => {
    void native.setSetting(HINTS_DISMISSED, true)
    void publishRegions()
  }
})

/**
 * Gaming Mode's hint names the buttons that open the game menu (the radial), as the main
 * window's Gaming Mode notice does; there is no Shift there.
 */
async function syncGamingHints() {
  if (!(window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope)) return hints.gaming(null)
  const binding = (await native.hotkeysLoad?.())?.openControllerMenu
  const buttons =
    binding?.enabled === false
      ? []
      : (binding?.gamepadButtons ?? (Number.isInteger(binding?.gamepadButton) ? [binding.gamepadButton] : []))
  hints.gaming(buttons.map(buttonName).filter(Boolean))
  syncHints()
}

/**
 * Whether the overlay's words and the Text Hooker's card are drawn at all. Words show their
 * highlight unless its opacity is Off, and their hover card unless it is Transparent (Settings →
 * Overlay appearance); with both gone they are there to point at, unseen. The Text Hooker's card
 * is unseen when Transparent (Text Hooker → Card style).
 */
const wordsSeen = () => {
  const style = overlayStyleOf(setting('overlayStyle'))
  return style.appearance !== 'transparent' || style.opacity > 0
}
const hookCardSeen = () => overlayStyleOf(setting('overlayStyle')).hookAppearance !== 'transparent'

/**
 * Show the hint bar while there is text to point at and nothing else is using the overlay. Text
 * drawn transparent does not count: nothing but the dictionary pop-up shows over the game then.
 */
function syncHints(readWordRects = null) {
  const shown =
    shiftGated &&
    native.getSetting(HINTS_DISMISSED) !== true &&
    !state.regionSelecting &&
    !state.dictionaryOpen &&
    (controller?.mode ?? 'idle') === 'idle' &&
    Boolean(state.origin) &&
    ((wordsSeen() && (readWordRects?.() ?? renderer.hitRects(state.origin)).length > 0) ||
      (hookCardSeen() && (hook.card?.rects().length ?? 0) > 0))
  hints.sync(
    shown,
    clickThrough(wordsSeen() ? 'words' : 'card'),
    effectiveLookupKey(native.getSetting('overlayLookupKey'), lookupButtonSupport),
    hoverLookup()
  )
  if (shown) hints.place(hintArea())
}

/**
 * Where the hint bar goes: under the scan area (the crop, else the source window), or at the
 * bottom of it where there is no room below, so a game in a window on a big screen shows it where
 * the reader is looking. Null for a full-screen or display source: the overlay's own bottom.
 */
function hintArea() {
  const bounds = state.detached ? null : (state.sourceBounds ?? state.info?.source_bounds ?? null)
  if (!bounds || !state.origin || state.sourceWindow?.fullscreen) return null
  let area = { x: bounds.x - state.origin.x, y: bounds.y - state.origin.y, width: bounds.width, height: bounds.height }
  const crop = state.crop
  if (crop && crop.reference_width > 0 && crop.reference_height > 0) {
    const sx = bounds.width / crop.reference_width
    const sy = bounds.height / crop.reference_height
    area = { x: area.x + crop.x * sx, y: area.y + crop.y * sy, width: crop.width * sx, height: crop.height * sy }
  }
  if (area.width >= innerWidth * 0.9 && area.height >= innerHeight * 0.9) return null
  return area
}

/** Which OCR engines this machine has (`platform_capabilities`), for choosing Auto OCR's watcher. */
let ocrEngines = {}
/** Whether a mouse button can be the lookup key here (`keys.lookupButtons`, ui/lookup-key.ts). */
let lookupButtonSupport = 'unsupported'

/** The engine that watches the screen for Auto OCR (`ui/watcher.ts`). */
const autoWatcher = () =>
  resolveWatcher(ocrModeNow(), ocrEngines, setting('autoOCRSettings')?.watcher ?? 'auto', languageNow())
/**
 * Auto OCR's settings with the signal the watcher gives: text, or image comparison.
 *
 * When the reader is its own watcher (a local engine reading for itself), the recognition a
 * settled line asks for is the watcher's own reading of that frame (`observed_by` in native),
 * which costs nothing. The minimum time between requests exists to spare an online engine; here
 * it only made dialogue that advances faster than once every 1.2 s lose every other line.
 */
const autoSettings = () => {
  const watcher = autoWatcher()
  const settings = { ...setting('autoOCRSettings'), observerMode: observerModeOf(watcher) }
  if (watcher.kind === 'text' && watcher.because === 'selected') settings.minRequestSpacingMs = 0
  return settings
}
/** `capture_frame`'s observer arguments for the current watcher. */
const observerArgs = () => {
  const watcher = autoWatcher()
  return [observerModeOf(watcher), watcher.kind === 'text' ? watcher.engine : null]
}

/**
 * The dictionary engine whose host this document installed, as the injected scripts resolved it
 * at document start (DICTIONARY_ENGINES.md §2): the `localStorage` mirror, else native's prelude.
 * Read before this window rewrites the mirror. The Yomitan API engine installs no host ('none').
 */
const readEngineMirror = () => {
  try {
    return localStorage.getItem(DICTIONARY_ENGINE_KEY)
  } catch {
    return null
  }
}
const hostedEngine = resolveHostEngine(readEngineMirror(), window.__kimochiDictionaryEngine)
/** Hachidori or 10ten, run by the generic extension host (`window.__kimochiExtensionHost`). */
const extensionHosted = hostedEngine === 'hachidori' || hostedEngine === 'tenten'
const extensionHost = () => window.__kimochiExtensionHost ?? null

/**
 * The engine the windows should run: native's effective engine (the selected one when it is
 * downloaded, else none; `dictionary_engine_effective`). An older backend without the command gets
 * the setting's host engine, as before engines were downloaded.
 */
async function effectiveEngine() {
  try {
    const answer = await native.invoke('dictionary_engine_effective')
    if (typeof answer?.effective === 'string') return answer.effective
  } catch {
    // Fall through to the setting.
  }
  return hostEngineOf(
    effectiveDictionaryEngine(dictionaryEngineOf(setting('yomitanSettings')?.popupType), languageNow())
  )
}

/**
 * Keep the document-start mirror in step with the effective engine, so every window (re)loaded
 * from now on installs the right host (or none). Settings writes it on a switch too, and native
 * writes it when a download makes an engine usable or a removal takes one away; this covers a
 * store edited elsewhere and the first launch after an update, before any mirror existed.
 */
async function mirrorDictionaryEngine({ repair = false } = {}) {
  const engine = await effectiveEngine()
  try {
    if (localStorage.getItem(DICTIONARY_ENGINE_KEY) !== engine) localStorage.setItem(DICTIONARY_ENGINE_KEY, engine)
  } catch (error) {
    log({ check: 'dictionary-engine-mirror-failed', engine, error: String(error?.message ?? error) })
  }
  if (engine !== hostedEngine) {
    // This document runs another engine's host than the windows should: Settings is about to
    // reload it, or the mirror was missing (or stale: after an edit to the store from elsewhere,
    // or an engine whose files are gone) when it loaded. Said once, so it is visible; and when
    // nobody is about to reload, the windows are reloaded from here, once per overlay load per
    // engine, now that the mirror is right.
    log({ check: 'dictionary-engine-mismatch', hosted: hostedEngine, effective: engine, repair })
    // Only the startup check repairs. A change that arrives while this document is running is
    // Settings switching the engine, and Settings calls `dictionary_engine_apply` itself; a
    // second call from here reloaded every window twice, the second time mid-handshake.
    if (!repair) return
    let repaired = false
    try {
      repaired = sessionStorage.getItem('kimochi.dictionaryEngineRepaired') === engine
      if (!repaired) sessionStorage.setItem('kimochi.dictionaryEngineRepaired', engine)
    } catch {
      // No sessionStorage: reload once anyway rather than run the wrong host for the session.
    }
    if (!repaired) {
      // `repair`: reload into the effective engine even when the setting names one that is not
      // downloaded (native refuses that for a switch).
      void native
        .invoke('dictionary_engine_apply', { repair: true })
        .catch((error) => log({ check: 'dictionary-engine-repair-failed', error: String(error?.message ?? error) }))
    }
  }
}

/** Scan sounds; the settings are read at each one, so turning them off in Settings is immediate. */
const playSound = createSoundPlayer({
  volume: () => setting('soundEffectsVolume'),
  enabled: (name) =>
    soundKindOn(
      {
        soundEffects: setting('soundEffects'),
        soundEffectsScans: setting('soundEffectsScans'),
        soundEffectsClicks: setting('soundEffectsClicks'),
        sentenceAudio: setting('sentenceAudio')
      },
      soundKind(name)
    )
})

/**
 * Post how a scan ended, with the sound it calls for (see sounds.ts). Progress posts go through
 * `activity` alone; only outcomes make a sound. `auto` marks the automatic loop's, whose errors
 * are rate-limited because it can fail on every tick.
 */
function reportOutcome(post, { auto = false } = {}) {
  activity(post)
  playSound(outcomeSound(post, { auto }), { auto })
}

/**
 * Quick Shot is the Log reading OCR with no chosen source. The flag alone is not enough: the
 * sidebar shows Quick Shot only while the input is OCR, so the scan shortcut follows the same
 * rule rather than drawing a region under a Clipboard or WebSocket source.
 */
const isQuickShot = () => Boolean(setting('quickShotEnabled')) && inputNow() === 'ocr'

// ---------------------------------------------------------------------------
// 1. Rendering
// ---------------------------------------------------------------------------

const hover = new HoverOverlay(hoverContainer)
// A picture of the hovered window inside its outline, so it can be recognised
// even when other windows cover it. Silent on failure, like the outline itself:
// `busy:` (a scan is capturing) and a closed window both just mean no picture.
let hoverCopyFailed = false
// The picture is kept as an object url: the `capture:` hover slot holds only the newest
// capture (the region editor's refresh replaces it too), so its url cannot be shown again later.
const hoverPreview = new HoverPreview({
  capture: async ({ reusable, show }) => {
    const sourceId = await native.selectedSource()
    if (!sourceId) return null
    const recent = reusable(sourceId)
    if (recent) return { key: sourceId, url: recent, reused: true }
    // The last picture now; the fresh one replaces it when it lands.
    show(sourceId)
    const preview = await native.sourceHoverPreview(sourceId)
    if (!preview?.url) return null
    try {
      const response = await fetch(preview.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { key: sourceId, url: URL.createObjectURL(await response.blob()) }
    } catch (error) {
      // Without a copy the picture still shows now; it just cannot be shown again later.
      if (!hoverCopyFailed) {
        hoverCopyFailed = true
        log({ check: 'hover-preview-copy-failed', error: String(error?.message ?? error) })
      }
      return { key: sourceId, url: preview.url }
    }
  },
  onChange: () => drawHover(),
  // Revoked late: an image fading out may still be drawing it.
  release: (url) => {
    if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
})

const renderer = new TextOverlayRenderer(wordsContainer, {
  // Keep cloud requests from disrupting lookup, while local observations still
  // notice when the game removes the words underneath the pointer. Touching the text with the
  // mouse also takes word mode back from the controller.
  onActivity: () => {
    holdAutoScan()
    controller?.mouseActivity()
  },
  onLookupStart: () => {
    holdAutoScan()
    controller?.mouseUsed()
    lookupStartedAt = performance.now()
    beatGamePause()
  }
})

/**
 * Controller mode: the radial menu and word-by-word dictionary navigation. It holds the scan's
 * text on screen while it steps through it, even once native has moved focus off the game,
 * which would otherwise hide the text as belonging to an app that is no longer in front.
 */
let nativeGamescope = false
/**
 * Whether scanned text is drawn at all. Always in Gaming Mode, which has no Show overlay switch:
 * over a game the overlay is the only way to read with Kimochi, and what Gamescope draws in front
 * decides when it shows (`gamescopeFront`).
 */
const overlayTextOn = () =>
  (window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope) ||
  isOverlayTextVisible(setting('liveOverlayEnabled'), state.flags.textOverlayVisible)
let gamescopeMenuCenter = null
let controller = null
controller = createController({
  host: document.querySelector('#controller'),
  words: wordsContainer,
  native,
  status: () => {
    const origin = state.origin
    const bounds = state.sourceBounds ?? state.info?.source_bounds ?? null
    const area =
      origin && bounds
        ? { x: bounds.x - origin.x, y: bounds.y - origin.y, width: bounds.width, height: bounds.height }
        : null
    return {
      gamescope: window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope,
      hasText: (state.annotations.length > 0 && Boolean(state.geometry)) || (hookMode() && Boolean(hook.line)),
      hooked: hookMode(),
      autoOcr: Boolean(state.flags.autoOcrEnabled),
      autoAvailable: !isQuickShot(),
      textVisible: overlayTextOn(),
      origin,
      area,
      scanId: state.appliedScanId,
      center: nativeGamescope
        ? gamescopeMenuCenter
        : area
          ? { x: area.x + area.width / 2, y: area.y + area.height / 2 }
          : null
    }
  },
  get panelInputHandoff() {
    return window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope
  },
  run: async (id) => {
    if (id === 'auto') return void onAction('toggleAutoOcr')
    if (id === 'controls' || id === 'ocr-settings') {
      // With the Text Hooker as the source, its settings (open at the hooked game's page).
      if (id === 'ocr-settings' && hookMode()) {
        await native.setSetting('textHookerSettingsGame', hookKey())
        await native.setSetting('settingsActiveTab', 'texthooker')
      } else if (id === 'ocr-settings') await native.setSetting('settingsActiveTab', 'ocr')
      await native.panel('log', 'show')
      if (id === 'ocr-settings') await window.__TAURI__.event.emit('main:show-settings')
    }
  },
  // The Log's own newest lines (OCR, Text Hooker, clipboard, WebSocket alike); the overlay's scan
  // history only if the Log has no session yet.
  history: async () => {
    const lines = await native.invoke('log_recent', { limit: 50 }).catch(() => [])
    return lines.length ? lines : native.invoke('settings_get', { key: 'scannedTextHistory' })
  },
  // With automatic OCR on, Scan catches the loop up at once instead of a separate scan;
  // either way it resolves once the text on screen is current.
  scan: async () => {
    if (scanner === sceneScanner && scanner.isRunning) return sceneScanner.refresh()
    await onAction('triggerScan')
    return false
  },
  popupControl: (control) => controlPopup(control),
  // Whose popup buttons the controller can focus and press: Yomitan's and Hachidori's.
  popupFocusable: () =>
    extensionHosted
      ? Boolean(extensionHost()?.popupFocusable?.())
      : (setting('yomitanSettings')?.popupType ?? 'builtin') !== 'custom-api',
  redraw: () => draw(),
  // The Text Hooker's card, for the game menu's Card panel (ui/controller-card.js).
  card: {
    opacities: HOOK_CARD_OPACITIES,
    state: () => {
      const bounds = state.sourceBounds ?? state.info?.source_bounds
      const game = hookGame()
      const set = hookSet()
      const fontPx = bounds?.height
        ? game.text
          ? Math.max(8, game.text * bounds.height)
          : Math.min(HOOK_TEXT_POINTS[1], Math.max(HOOK_TEXT_POINTS[0], set.textSize * bounds.height))
        : null
      return {
        shown: hookCardOn(),
        autoAlign: set.autoAlign,
        opacity: set.opacity,
        fontPx,
        look: overlayStyleOf(setting('overlayStyle')).hookAppearance,
        box: hook.card?.box() ?? null
      }
    },
    hook: () => hook.status,
    // A thread by hand (remembered for the game), or `null` to choose automatically again.
    selectThread: (key) => native.invoke('texthook_select', { key }).catch(() => {}),
    // For this game: on is the default's way of showing it (or Always, where the default is
    // Never); a choice equal to the default is left to follow it.
    setShown: (on) => {
      const fallback = hookSettings(hookDefaults(), null).showCard
      const value = on ? (fallback === 'never' ? 'always' : fallback) : 'never'
      return value === fallback ? saveHookGame({}, ['showCard']) : saveHookGame({ showCard: value })
    },
    // Back on, as in Settings: straight back to where it last found the game's text, the size
    // measured again (a size set by hand goes), and the screen read at once (`realignHookCard`).
    setAutoAlign: (on) =>
      on
        ? saveHookGame({ autoAlign: true }, ['text', 'leading'])
        : hookCardLocksAutoAlign(setting('overlayStyle'))
          ? undefined
          : saveHookGame({ autoAlign: false }),
    textSize: (step) => {
      const box = hook.card?.box()
      return box ? onHookCardTextSize(step, box) : undefined
    },
    setOpacity: (opacity) => saveHookGame({ opacity }),
    // The card's own look (Settings → Text Hooker → Card style), apart from the overlay's cards.
    setLook: (hookAppearance) =>
      native.setSetting('overlayStyle', { ...overlayStyleOf(setting('overlayStyle')), hookAppearance }),
    steer: (box) => hook.card?.steer(box) ?? null,
    release: (commit) => {
      hook.card?.release(commit)
      syncHookCard()
    }
  },
  dictionary: () => extensionApi,
  // Hachidori's own split of a scan into words (null for the other engines).
  segment: (text) => (extensionHosted ? (extensionHost()?.segment?.(text) ?? null) : null),
  popupType: () => setting('yomitanSettings')?.popupType ?? 'builtin',
  buttons: () => setting('controllerButtons'),
  menuItems: () => setting(RADIAL_MENU_SETTING),
  appearance: () => setting('appearance'),
  ringColor: () => radialMenuColorOf(setting('radialMenuColor'), setting('overlayStyle')),
  ringBase: () => radialBaseVars(setting('radialMenuBase')),
  // Gaming Mode reads the Deck's own controller. Paused Steam lets it fall back to its keyboard
  // and mouse "lizard" mode, whose arrow keys would move the outline a second time.
  padOnly: () => window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope,
  // Yomitan's frontend module is only imported for Yomitan: it loads Yomitan's own frontend.
  lookupRange: async (range) =>
    extensionHosted
      ? ((await extensionHost()?.lookupRange(range)) ?? false)
      : (await import('/spike/frontend-mode.js')).lookupRange(range),
  // Read along's direct lookup (ui/controller.js `lookupWord`): `{shown, length}`, or null when
  // the engine has none here and `lookupRange` stands in.
  lookupText: async (request) => {
    if (extensionHosted) return (await extensionHost()?.lookupText?.(request)) ?? null
    const frontendMode = await import('/spike/frontend-mode.js')
    return typeof frontendMode.lookupText === 'function' ? frontendMode.lookupText(request) : null
  },
  lookupTerm,
  apiParse: (text) => apiTokenize(text),
  // What the engine's lookup matched, as it marks it on the page (`matchedRange`: Hachidori's and
  // 10ten's highlight, Yomitan's selection), for Read along's outline when the lookup didn't say.
  matchedRange: () => matchedRange(),
  charRects: (element) =>
    renderer.mode === 'words' && element !== hook.card?.element ? renderer.charRects(element) : null,
  // Read along over the Text Hooker's card.
  extraUnits: () => hookCardUnits(),
  // The language being read, whose words Read along steps through (word-nav.js).
  languageWords,
  quietText: (quiet) => renderer.setQuiet(quiet),
  nearText: (x, y) => {
    const reach = 32
    for (const element of [...wordsContainer.children, ...(hook.card?.rects().length ? [hook.card.element] : [])]) {
      const rect = element.getBoundingClientRect()
      if (x >= rect.left - reach && x <= rect.right + reach && y >= rect.top - reach && y <= rect.bottom + reach)
        return true
    }
    return false
  },
  dismiss: () => {
    dismissPopup()
    void native.optional('hide_popover')
  },
  // Read along's full-screen dictionary with an engine's own pop-up: placed over the space under
  // its text instead of beside the word.
  placePopup: (rect) => placeEnginePopup(rect),
  popupShowing: () => enginePopupShowing(),
  // The drawn scan as the Log has it, a section per group (`publishOcrResult` logs these same
  // groups), for the full-screen dictionary; null without boxes to group.
  sections: () =>
    hookMode()
      ? hook.line
        ? [hook.line]
        : null
      : state.geometry && state.annotations.length
        ? logSections(scanGroups(state.annotations, setting('textOverlayGrouping') ?? {}))
        : null,
  log: (record) => log(record),
  modeChanged: (mode) => holdForController(mode !== 'idle'),
  // Read along as the full-screen dictionary (Settings → Overlay → Game Mode): with the Yomitan API, its
  // entries are drawn from `lookup`; with any other engine, its pop-up fills the view's lower half.
  fullDictionary: {
    enabled: () => fullscreenDictionary(setting('gameModeSettings')),
    source: () => fullscreenDictionarySource(setting('yomitanSettings')?.popupType ?? 'builtin'),
    lookup: (term, { media = false, maxEntries } = {}) =>
      native
        .invoke('yomitan_ankifields', {
          // Empty means the helper's default address, as for the API pop-up (api-lookup.js).
          baseUrl: setting('yomitanSettings')?.customApiUrl?.trim() || 'http://127.0.0.1:19633',
          text: term,
          includeMedia: media,
          maxEntries: maxEntries ?? null
        })
        .then((answer) => ({
          entries: Array.isArray(answer?.fields) ? answer.fields : [],
          audioMedia: answer?.audioMedia ?? [],
          dictionaryMedia: answer?.dictionaryMedia ?? []
        })),
    anki: () => {
      const config = popupAnkiConfig(setting('superTexthooker'))
      return config ? createAnki(native.invoke, config) : null
    },
    play: (item) => {
      const audio = new Audio(audioUrl(item))
      audio.volume = setting('superTexthooker')?.audioVolume ?? 0.9
      void audio
        .play()
        .catch((error) => log({ check: 'game-dictionary-audio-failed', error: String(error?.message ?? error) }))
    }
  }
})
/** The scan the controller last saw drawn, so it can follow a new one in word mode. */
let controllerScanId = null
// The separate Gamescope watchdog resumes Steam if this webview stops servicing
// controller mode. No ordinary Linux desktop or other platform sends this lease.
setInterval(() => {
  if (window.__KIMOCHI_PLATFORM__?.os !== 'linux' || !nativeGamescope || controller.mode === 'idle') return
  void native
    .controllerNav(true)
    .then((result) => {
      if (result?.gamescopeInput === false) {
        log({ check: 'gamescope-input-lease-failed', error: result.error })
        return controller.close()
      }
    })
    .catch((error) => {
      log({ check: 'gamescope-input-lease-failed', error: String(error) })
      void controller.close()
    })
}, 500)

/**
 * Whether macOS is throttling this page: Game Mode, while a full-screen game is in front, lets
 * every other app's display updates (and so WebKit's rendering) run about ten times a second.
 * Nothing an app can set exempts it, and macOS publishes no Game Mode state, so it is measured:
 * the animation frames this page gets in half a second, checked every few seconds while the
 * chosen window is a full-screen app in front. The main window shows a notice while it holds.
 */
let overlayThrottled = false
function animationFrameRate(ms) {
  return new Promise((resolve) => {
    let count = 0
    const start = performance.now()
    const tick = (now) => {
      count++
      if (now - start < ms) requestAnimationFrame(tick)
      else resolve((count * 1000) / (now - start))
    }
    requestAnimationFrame(tick)
    // A page that gets no frames at all is throttled too.
    setTimeout(() => resolve((count * 1000) / ms), ms * 3)
  })
}
async function checkThrottled() {
  if (window.__KIMOCHI_PLATFORM__?.os !== 'macos') return
  let next = overlayThrottled
  if (!state.sourceWindow?.fullscreen) next = false
  else if (state.sourceFocus?.focused) {
    const rate = await animationFrameRate(500)
    // Throttled pages get about 10; anything near the display's rate is not.
    if (rate <= 20) next = true
    else if (rate >= 40) next = false
  }
  if (next === overlayThrottled) return
  overlayThrottled = next
  log({ check: 'overlay-throttled', throttled: next })
  void native.setViewFlags({ overlayThrottled: next }).catch(() => undefined)
}
setInterval(() => void checkThrottled(), 4000)

/**
 * Automatic OCR stands still while the controller menu is open or the reader is stepping
 * through words: nothing is captured, nothing new is drawn under the cursor, and a recognition
 * already out is set aside rather than applied. Leaving controller mode picks it straight back
 * up, with a fresh look at the screen.
 */
let controllerHold = false
let readingHold = false
/** Game pause (`beatGamePause`): when the last lookup started, and whether a hold was sent. */
let lookupStartedAt = -Infinity
const LOOKUP_GRACE_MS = 1200
/** When the pop-up host last said its pop-up is up (`overlay-reading-popup-alive`). */
let remotePopupAliveAt = -Infinity
const REMOTE_POPUP_ALIVE_MS = 3000
let gamePauseHeld = false
let layerPointerExit = null
let hyprlandPointer = false
let layerPointerPolling = false
let remoteReadingPopup = false
/** Where that pop-up is, in desktop points: on GNOME, the holes in a click away (`hitRects`). */
let remoteReadingRects = []
let apiReadingPopup = false
const reading = new ReadingHold()
function syncScanHold() {
  if (controllerHold || readingHold) scanner.pause()
  else if (scanner.isPaused) scanner.resume()
}
/** Whether a dictionary pop-up for the overlay's text is up, in any of its hosts. */
function readingPopupShown() {
  return (
    remoteReadingPopup ||
    apiReadingPopup ||
    Boolean(extensionPopupRect) ||
    [...livePopups].some((popup) => popup.isVisibleSync?.())
  )
}
function syncReadingHold(readWordRects = null) {
  if (layerPointerExit) {
    window.__linuxLayerPointerInside = !layerPointerExit.outside()
    if (layerPointerExit.outside()) renderer.clearPointer()
  }
  const popup = readingPopupShown()
  const enabled = overlayTextOn() && !state.regionSelecting
  if (!enabled) reading.reset()
  const next = enabled && reading.update(renderer.mouse, readWordRects?.() ?? renderer.hitRects({ x: 0, y: 0 }), popup)
  if (next === readingHold) return
  readingHold = next
  syncScanHold()
  log({ check: 'auto-scan-reading-hold', hold: next })
  beatGamePause()
}
/** The Yomitan API's pop-up for a word opened or closed (`installApiLookup`). */
function apiPopupVisible(visible) {
  apiReadingPopup = visible
  syncReadingHold()
}
/**
 * "Pause the game while reading" (Settings → Overlay): what the overlay is busy with, beaten to
 * native every 500 ms. The beat is the proof the overlay is alive: if this page stops, the holds
 * lapse and the game runs again. A lookup holds from its start until its pop-up is gone (a lookup
 * that finds nothing holds for a moment only).
 */
function gamePauseReasons() {
  const reasons = []
  const now = performance.now()
  // The pop-up host's pop-up counts only while that window keeps saying so: a host that crashed or
  // reloaded after "visible" must not hold the game paused.
  const remoteAlive = remoteReadingPopup && now - remotePopupAliveAt < REMOTE_POPUP_ALIVE_MS
  const localPopup =
    apiReadingPopup || Boolean(extensionPopupRect) || [...livePopups].some((popup) => popup.isVisibleSync?.())
  if (remoteAlive || localPopup || now - lookupStartedAt < LOOKUP_GRACE_MS) reasons.push('lookup')
  if (controller && controller.mode !== 'idle') reasons.push('navigation')
  if (state.regionSelecting) reasons.push('regionEditor')
  return reasons
}
function beatGamePause() {
  if (!setting('pauseGameWhileReading')) {
    if (gamePauseHeld) void native.gamePauseBeat([])
    gamePauseHeld = false
    return
  }
  const reasons = gamePauseReasons()
  if (reasons.length === 0 && !gamePauseHeld) return
  gamePauseHeld = reasons.length > 0
  void native.gamePauseBeat(reasons)
}
setInterval(beatGamePause, 500)

function holdForController(hold) {
  if (hold === controllerHold) return
  controllerHold = hold
  syncScanHold()
  beatGamePause()
  log({ check: 'auto-scan-controller-hold', hold, running: scanner.isRunning })
}

function holdAutoScan() {
  if (!scanner.isRunning) return
  scanner.pauseRecognitionFor(3000)
}

/**
 * Where the text is on the desktop, in desktop points, whether or not it is drawn.
 *
 * Native compares these with Kimochi's own window frames: while the reader is in Kimochi,
 * the text stays as long as none of its windows is on top of it. So this has to describe
 * hidden text too — reporting nothing while hidden would make the text "uncovered" and
 * bring it straight back under the window that hid it.
 */
function textBoxes() {
  if (waylandDisabled || waylandLayer) return []
  if (!state.info || !state.origin || !state.annotations.length) return []
  if (!overlayTextOn()) return []
  const bounds = state.detached
    ? (state.info.source_bounds ?? null)
    : (state.sourceBounds ?? state.info.source_bounds ?? null)
  try {
    const shown = visibleAnnotations(state.annotations, setting('textOverlayGrouping'))
    return mapAnnotations(state.info, shown, state.origin, bounds ?? undefined).map((box) => ({
      x: state.origin.x + box.x,
      y: state.origin.y + box.y,
      width: box.width,
      height: box.height
    }))
  } catch {
    return []
  }
}

let lastTextBoxes = null
function publishTextBoxes() {
  const rects = textBoxes()
  const signature = JSON.stringify(rects.map((r) => [r.x, r.y, r.width, r.height].map(Math.round)))
  if (signature === lastTextBoxes) return
  lastTextBoxes = signature
  void native.setTextBoxes(rects).catch((error) => {
    lastTextBoxes = null
    log({ check: 'overlay-text-boxes-error', error: String(error?.message ?? error) })
  })
}

let gnomeOverlay = null
let gnomeControllerWords = false
let lastVisibilityTrace = null
function draw() {
  publishTextBoxes()
  if (waylandDisabled) {
    if (!gnomeOverlay?.shared) renderer.clear()
    void gnomeOverlay?.update()
    return
  }
  // Layer-shell provides an output-local surface, not another window's position.
  // Do not draw a portal window frame at a fabricated desktop location.
  const portalWindow = waylandLayer && isWaylandWindowSourceId(state.info?.source_id)
  const linkedBounds = portalWindow ? portalWindowBounds(state.info, state.sourceBounds) : null
  if (portalWindow && (!linkedBounds || state.sourceWindow?.onScreen === false)) {
    renderer.clear()
    return
  }
  // A full-screen app's Space is sliding: its text would crawl behind the picture.
  const settling = Boolean(state.sourceWindow?.settling) && !state.detached
  // The Text Hooker's line is in its own window, which follows the game's focus and place too.
  syncHookCard()
  // Gaming Mode: native says whether Gamescope is drawing the source (the game, for a game's text)
  // in front; over Kimochi, Steam's menus or another game the text goes. Reading holds it.
  const gamescopeFront =
    !(window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope) || state.sourceFocus?.focused !== false
  const visible =
    !settling &&
    !browserMode() &&
    (controller.holdsText ||
      (overlayTextOn() &&
        ((waylandLayer && gamescopeFront) ||
          shouldShowScannedText(state.source, state.sourceFocus, foreground.current, state.scannedApp))))

  const reason = !overlayTextOn()
    ? 'disabled'
    : settling
      ? 'source-settling'
      : !visible
        ? 'source-inactive'
        : !state.geometry
          ? 'no-geometry'
          : state.annotations.length
            ? 'visible'
            : 'no-text'
  const visibility = { reason, annotations: state.annotations.length, frameId: state.appliedScanId }
  const signature = JSON.stringify(visibility)
  if (signature !== lastVisibilityTrace) {
    lastVisibilityTrace = signature
    trace('overlay-visibility', visibility)
  }

  if (!visible || !state.geometry) {
    // Clearing takes the click targets with it: `hitRects` reads the rendered
    // elements, so text that is not on screen cannot still be catching the mouse.
    renderer.clear()
    return
  }
  let readerBounds = null
  if (waylandLayer && state.info) {
    const scale = Math.min(innerWidth / state.info.full_width, innerHeight / state.info.full_height)
    // A screen with a place on the desktop: its bounds relative to the overlay's output, which
    // native moved to the output its crop is on (src-tauri/src/platform/linux/screens.rs). Only a
    // screen with none (a virtual one) is fitted to the overlay's output.
    const screenBounds = isWaylandScreenSourceId(state.info.source_id) ? (state.info.source_bounds ?? null) : null
    readerBounds = linkedBounds ??
      screenBounds ?? {
        x: (innerWidth - state.info.full_width * scale) / 2,
        y: (innerHeight - state.info.full_height * scale) / 2,
        width: state.info.full_width * scale,
        height: state.info.full_height * scale
      }
  }
  const renderChange = renderer.render({
    annotations: state.annotations,
    info: state.info,
    origin: state.origin,
    // Where the source is now, not where it was when the frame was captured, so
    // text follows a window that has since moved or been resized.
    bounds:
      readerBounds ??
      (state.detached
        ? (state.info?.source_bounds ?? null)
        : (state.sourceBounds ?? state.info?.source_bounds ?? null)),
    grouping: setting('textOverlayGrouping'),
    opacity: setting('overlayOpacity'),
    scanning: state.scanning
  })
  if (renderChange && (renderChange.created || renderChange.removed)) trace('overlay-dom-change', renderChange)
  if (state.appliedScanId !== controllerScanId) {
    controllerScanId = state.appliedScanId
    controller.scanChanged()
  }
}

/**
 * What OCR read becomes what is drawn. Outside the Text Hooker, as it is. While hooked, only the
 * speaker's name where the game shows it apart (`hookAligned`): the line is in its card, and a
 * reading otherwise only says where the card goes. OCR's raw
 * reading is kept so a line that arrives after the screen was read is placed without reading it
 * again.
 */
function setOcrAnnotations(annotations) {
  state.rawAnnotations = annotations
  if (!hookMode()) {
    state.annotations = annotations
    return
  }
  // With Auto align turned off, a reading still in flight when it was places nothing.
  state.annotations = hookOcrOn() ? hookAligned(annotations) : []
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN
}

/**
 * The size and line pitch of the matched text, in capture pixels: a line's width over its
 * characters (full-width CJK text is a whole em per character, as the card's is), the median over
 * the lines; a line's height when no line is long enough to measure. `known`, the hooked line,
 * stands for what OCR read when the reading is it on one line: OCR drops brackets and dots now
 * and then, and a line counted a character short measures large.
 */
function measuredText(block, box, known = null) {
  const lines = block?.lineTexts ?? []
  const polygons = block?.linePolygons ?? []
  const widths = []
  const tops = []
  // Proportional text (any script but CJK) is as wide as its letters are in the card's font, not a
  // whole em each: measured in it (render.js `measureFor`), spaces and all, less the little its
  // ink stops short of its ends.
  const style = textStyle(languageNow())
  const measure = style.fullWidth ? null : measureFor('default', style.code)
  polygons.forEach((p, i) => {
    const xs = p.map(([x]) => x)
    const ys = p.map(([, y]) => y)
    tops.push(Math.min(...ys))
    if (measure) {
      const line = ((polygons.length === 1 && known) || lines[i] || '').trim()
      const ems = measure(line) - 0.1
      if (line.length >= 3 && ems > 0.5) widths.push((Math.max(...xs) - Math.min(...xs)) / ems)
      return
    }
    const chars = [...((polygons.length === 1 && known) || lines[i] || '').replace(/\s/g, '')]
    // The ink of a closing mark (。、」) is a sliver at one side of its em, as is an opening one's
    // (「『) at the other, and every line's ink stops a little short of its first and last ems:
    // counted in whole ems, it would read small.
    const line = chars.join('')
    const short = (/[。、，．」』）】〉》！？]$/.test(line) ? 0.6 : 0.05) + (/^[「『（【〈《]/.test(line) ? 0.55 : 0.05)
    if (chars.length >= 3) widths.push((Math.max(...xs) - Math.min(...xs)) / (chars.length - short))
  })
  const count = Math.max(1, polygons.length || lines.length)
  const lineHeight = (box[3] - box[1]) / count
  const size = widths.length ? median(widths) : lineHeight * 0.92
  const pitch = tops.length >= 2 ? (Math.max(...tops) - Math.min(...tops)) / (tops.length - 1) : null
  return { size: Math.min(size, lineHeight * 1.3), pitch }
}

/**
 * A reading matched the line: Auto align's place for the card (`ocrBox`) and the text's size
 * (`text`, `leading`), kept for the game. See the section's comment for why each moves as it does.
 * Returns what OCR read that is still drawn: the speaker's name, where the game shows it apart.
 */
function hookAligned(annotations) {
  if (!hook.line || !annotations?.length || !state.info) return (hook.names = [])
  // One reading reaches here more than once (as it is applied, and again as the scene redraws):
  // it counts once, or "two readings agree" would be one reading twice.
  const reading = `${hook.line}\u0000${JSON.stringify(annotations.map((a) => [a.description, a.boundingPoly]))}`
  if (reading === hook.reading) return hook.names
  hook.reading = reading
  const info = state.info
  const [cx, cy] = info.crop_pixels ?? [0, 0]
  const fw = info.full_width
  const fh = info.full_height
  const game = hookGame()
  const nameAt = game.nameBox
    ? [
        game.nameBox.x * fw - cx,
        game.nameBox.y * fh - cy,
        (game.nameBox.x + game.nameBox.width) * fw - cx,
        (game.nameBox.y + game.nameBox.height) * fh - cy
      ]
    : null
  const placed = hookAnnotations(annotations, hook.line, {
    nameAt,
    apart: Boolean(game.namesApart),
    speakers: hookSet().speakerNames,
    spaces: languageOf(languageNow()).spaces
  })
  const whole = placed.recall >= 0.9 && placed.precision >= 0.8
  // A name is only ever returned where it is the speaker's; the card shows what they say even when
  // their quote could not be placed (「……」 OCR did not read). A name found for this line stays
  // through readings that miss it: OCR reads a lone character only now and then.
  if (placed.names.length || hook.namesLine !== hook.line) {
    hook.names = placed.names
    hook.namesLine = placed.names.length ? hook.line : null
  }
  if ((whole || placed.shown !== hook.line) && placed.shown !== hook.shown) {
    hook.shown = placed.shown
    queueMicrotask(syncHookCard)
  }
  // What the last reading that did not find the line whole held, for the chase to log.
  if (!whole) hook.missed = { line: hook.line, recall: placed.recall, precision: placed.precision, annotations }
  if (!placed.box) return hook.names
  const change = {}
  // A name shown apart from the quote: the game shows names so, and where (a nameplate keeps its
  // place), so the next speaker's line is shown without the name at once and their name found.
  if (whole && placed.nameBox) {
    const nameBox = {
      x: (placed.nameBox[0] + cx) / fw,
      y: (placed.nameBox[1] + cy) / fh,
      width: (placed.nameBox[2] - placed.nameBox[0]) / fw,
      height: (placed.nameBox[3] - placed.nameBox[1]) / fh
    }
    if (!game.namesApart) change.namesApart = true
    if (!game.nameBox || ['x', 'y', 'width', 'height'].some((k) => Math.abs(game.nameBox[k] - nameBox[k]) > 0.01))
      change.nameBox = nameBox
  }
  // The hooked line counts for OCR's text only where OCR read it and nothing else.
  const exact = placed.recall >= 0.95 && placed.precision >= 0.95
  const measured = measuredText(placed.annotations[0], placed.box, exact ? placed.shown : null)
  const size = measured.size / fh
  // Only a reading that found (nearly) the whole line, and little else (`whole`), may say what
  // size the text is or where it starts: part of a line (one row of two, say) is somewhere else.
  // The size is kept; it is only replaced when readings of two different lines both disagree
  // with it, and with each other by little: one odd reading (a line with ruby, or one OCR ran
  // into its neighbour) says nothing about the game's text.
  if (!whole) {
    // Nothing to learn about the size.
  } else if (!game.text) {
    change.text = size
    if (measured.pitch) change.leading = Math.min(2.2, Math.max(1.1, measured.pitch / measured.size))
  } else if (Math.abs(size - game.text) / game.text > HOOK_RESIZE) {
    if (
      hook.resize &&
      hook.resize.line !== hook.line &&
      Math.abs(size - hook.resize.size) / hook.resize.size < HOOK_RESIZE / 2
    ) {
      change.text = (size + hook.resize.size) / 2
      hook.resize = null
    } else if (!hook.resize || hook.resize.line !== hook.line) hook.resize = { size, line: hook.line }
  } else hook.resize = null
  const text = change.text ?? game.text
  const found = {
    x: (placed.box[0] + cx) / fw,
    y: (placed.box[1] + cy) / fh,
    width: (placed.box[2] - placed.box[0]) / fw,
    height: (placed.box[3] - placed.box[1]) / fh
  }
  const saved = game.ocrBox
  const line = (text ?? size) * fh * HOOK_MOVE_LINES
  const near = (a, b) => Math.abs(a.x - b.x) * fw < line && Math.abs(a.y - b.y) * fh < line
  const stays = saved?.height !== undefined && near(found, saved)
  // The first whole reading of a new line puts the card on it at once: the line is new text, so
  // wherever OCR found it is where it is (a game that writes each line below the last one).
  const fresh = whole && hook.placed !== hook.line
  if (whole) hook.placed = hook.line
  // Where this line's own ink is: the card's ink is centred on it (`hookCardView`). Not the kept
  // box, which only grows (a short line after a long one keeps the long one's width) and keeps its
  // place against one-off readings; OCR's boxes stand a few pixels off the ink, more on one engine
  // than another, but about as far on each side, so centred the card lands on the game's text.
  // (Another reading of the line a pixel or two off is the same place: the card does not twitch.)
  const same = (a, b) =>
    Math.abs(a.x - b.x) * fw < 2 &&
    Math.abs(a.y - b.y) * fh < 2 &&
    Math.abs(a.width - b.width) * fw < 2 &&
    Math.abs(a.height - b.height) * fh < 2
  // `exact`: OCR read the whole line and nothing else, so its width is the line's (one read while
  // the game was still typing it out is short): only such a reading fits the card's spacing.
  if (whole && !(hook.found?.line === hook.line && same(hook.found.box, found) && hook.found.exact === exact)) {
    // What OCR read of it too: a 「 or a ？ it dropped is left out of its box.
    hook.found = { line: hook.line, box: found, exact, read: placed.annotations[0]?.lineTexts?.join('') ?? null }
    queueMicrotask(syncHookCard)
  }
  // The game's own line breaks: only from a reading of the whole line that cut it into rows
  // holding exactly the line's text (hook-match.ts `splitAcrossLines`).
  const rows = placed.annotations[0]?.lineTexts
  const bare = (value) => String(value).replace(/\s/g, '')
  if (whole && Array.isArray(rows) && rows.length > 1 && bare(rows.join('')) === bare(placed.shown)) {
    const wrap = { line: hook.line, shown: placed.shown, rows }
    if (JSON.stringify(wrap) !== JSON.stringify(hook.wrap)) {
      hook.wrap = wrap
      queueMicrotask(syncHookCard)
    }
  }
  if (whole) hookGlyphsFrom(placed, annotations, { cx, cy, fw, fh })
  let box = null
  if (fresh && !stays) {
    box = found
    hook.moveTo = null
    hook.glide = true
  } else if (stays) {
    // Its box only grows, to the furthest the text has reached. Where it starts stays put through
    // readings of a line, and moves to where each new line starts (a line opening with 「 starts
    // its ink half a glyph in): where the next line's card waits until a reading places it.
    const x = fresh ? found.x : saved.x
    const y = fresh ? found.y : saved.y
    if (placed.precision >= 0.8)
      box = {
        x,
        y,
        width: Math.min(Math.max(saved.x + saved.width, found.x + found.width) - x, 1 - x),
        height: Math.max(saved.y + saved.height, found.y + found.height) - y
      }
    hook.moveTo = null
  } else if (whole && (!saved?.height || (hook.moveTo && near(found, hook.moveTo)))) {
    // A first place, or a new one two whole readings in a row agree on (a game that moved its
    // text box): the box starts again from this reading.
    box = found
    hook.moveTo = null
    hook.glide = true
  } else if (whole) hook.moveTo = found
  if (box && (!saved || ['x', 'y', 'width', 'height'].some((k) => Math.abs((saved[k] ?? -1) - box[k]) > 0.002)))
    change.ocrBox = box
  const surface = placed.annotations[0]?.surface
  if (whole && surface && JSON.stringify(surface) !== JSON.stringify(game.surface)) change.surface = surface
  // A line placed where the card already is changes nothing kept: the card still shows it placed.
  if (fresh) queueMicrotask(syncHookCard)
  if (!Object.keys(change).length) return hook.names
  log({
    check: 'hook-card-aligned',
    box,
    // Where this reading found the text, before `stays` kept the box where it was.
    found,
    ...(placed.names.length ? { name: placed.names[0].description } : {}),
    stays,
    whole,
    fresh,
    text,
    size,
    recall: placed.recall,
    precision: placed.precision,
    // What OCR read, when it measured the text other than the size kept.
    ...(text && Math.abs(size - text) / text > 0.1 ? { read: placed.annotations[0]?.lineTexts } : {}),
    ...(fresh && hook.lineAt ? { afterLineMs: Math.round(performance.now() - hook.lineAt) } : {})
  })
  void saveHookGame(change)
  return hook.names
}

/**
 * Where the game draws each glyph of the line, from a whole reading whose engine boxed each
 * character (hook-glyphs.ts): kept in `hook.glyphs` as shares of the frame, for `hookCardView`.
 * The newest reading of the line wins: a game may draw each character sliding into place as it
 * fades in (Senren＊Banka: from 8 px to the right), so the first reading of the whole line can
 * catch its last glyphs on their way, and later ones see them where they stay. One that puts
 * every glyph within a pixel of where the last did changes nothing, so the card does not twitch.
 */
function hookGlyphsFrom(placed, annotations, { cx, cy, fw, fh }) {
  const block = placed.annotations[0]
  const polygons = block?.linePolygons ?? []
  const rows = block?.lineTexts?.length ? block.lineTexts : polygons.length === 1 ? [placed.shown] : null
  if (!rows || rows.length !== polygons.length) {
    log({ check: 'hook-glyphs-miss', why: 'rows', rows: rows?.length ?? null, polygons: polygons.length })
    return
  }
  const boxOf = (points) => {
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
  const pieces = []
  for (const a of annotations ?? []) {
    if (a.granularity === 'fragment' && a.description) {
      const xs = a.boundingPoly.vertices.map((v) => v.x ?? 0)
      const ys = a.boundingPoly.vertices.map((v) => v.y ?? 0)
      pieces.push({ text: a.description, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
    }
    for (const line of a.lineSegments ?? [])
      for (const seg of line) if (seg?.text && seg.bbox) pieces.push({ text: seg.text, box: seg.bbox })
  }
  // The pitch the game's long lines have had: a game sets its dialogue in one size.
  const known = hook.glyphPitch?.exe === hookKey() ? hook.glyphPitch.pitch * fw : null
  const geometry = glyphGeometry(rows, polygons.map(boxOf), pieces, known, ocrModeNow())
  if (!geometry) {
    log({
      check: 'hook-glyphs-miss',
      why: 'fit',
      rows: rows.length,
      pieces: pieces.length,
      kinds: [...new Set((annotations ?? []).map((a) => a.granularity))]
    })
    return
  }
  const next = {
    line: hook.line,
    rows,
    pitch: geometry.pitch / fw,
    starts: geometry.rows.map((r) => (r.start === null ? null : (r.start + cx) / fw)),
    middles: geometry.rows.map((r) => (r.middle === null ? null : (r.middle + cy) / fh)),
    marks: geometry.rows.map((r) => r.marks.map((m) => ({ c: m.c, y: (m.y + cy) / fh })))
  }
  const before = hook.glyphs
  if (
    before?.line === next.line &&
    before.rows.join('\n') === next.rows.join('\n') &&
    Math.abs(before.pitch - next.pitch) * fw * Math.max(...rows.map((row) => [...row].length)) < HOOK_GLYPH_STILL &&
    next.starts.every(
      (x, i) =>
        (x === null) === (before.starts[i] === null) &&
        (x === null || Math.abs(x - before.starts[i]) * fw < HOOK_GLYPH_STILL)
    ) &&
    next.middles.every(
      (y, i) => y === null || before.middles[i] === null || Math.abs(y - before.middles[i]) * fh < HOOK_GLYPH_STILL
    )
  )
    return
  hook.glyphs = next
  const used = geometry.rows.reduce((n, r) => n + r.used, 0)
  if (used >= OWN_PITCH_GLYPHS) {
    // The running mean of the game's long lines' pitch, for its short ones: each line counts
    // once, by its newest reading (its first may have caught glyphs still sliding into place).
    const pitch = geometry.pitch / fw
    const kept = hook.glyphPitch?.exe === hookKey() ? hook.glyphPitch : null
    if (!kept) hook.glyphPitch = { exe: hookKey(), line: hook.line, n: 1, pitch, base: pitch }
    else {
      if (kept.line !== hook.line)
        Object.assign(kept, { line: hook.line, base: kept.pitch, n: Math.min(kept.n + 1, HOOK_PIN_READINGS) })
      kept.pitch = kept.base + (pitch - kept.base) / kept.n
    }
  }
  log({
    check: 'hook-glyphs',
    rows: rows.length,
    glyphs: used,
    pitch: Math.round(geometry.pitch * 10) / 10,
    error: Math.round(geometry.error * 10) / 10
  })
  queueMicrotask(syncHookCard)
}

/**
 * What the card shows now (hook-card.js `show`), in overlay coordinates: the line, its text box
 * (Auto align's, the reader's, or centred along the bottom before either) and its size; null
 * while it is not to be seen (the overlay is off, or the game is not in front).
 */
/** Why the card is not shown, or null when it is (logged as it changes: `hook-card-shown`). */
function hookCardHidden(bounds) {
  if (!hookMode()) return 'not-hooking'
  if (!hook.line && !controller?.holdsCard) return 'no-line'
  if (!hook.sourceId) return 'no-game'
  if (!state.origin) return 'no-display'
  if (!bounds?.width || !bounds?.height) return 'no-window'
  if (!overlayTextOn()) return 'overlay-off'
  if (state.sourceWindow?.settling && !state.detached) return 'window-settling'
  // Off, the card still comes up to be read along (or set up from the game menu).
  const held = Boolean(hook.card?.dragging()) || Boolean(controller?.holdsText) || Boolean(controller?.holdsCard)
  if (!hookCardOn() && !held) return 'card-off'
  if (hookCardOnKey() && !hookKeyHeld && !held && !hookPopupOpen()) return 'key-up'
  const focus = state.sourceFocus
  if (focus && !(focus.focused && focus.present) && !held) return focus.present ? 'game-behind' : 'game-gone'
  return null
}

function hookCardView() {
  const bounds = state.sourceBounds ?? state.info?.source_bounds
  const hidden = hookCardHidden(bounds)
  if (hidden !== hook.hidden) {
    hook.hidden = hidden
    if (hookMode()) log({ check: 'hook-card-shown', shown: !hidden, why: hidden ?? undefined })
  }
  if (hidden) return null
  const game = hookGame()
  const auto = hookAutoAlign()
  const fontPx = game.text
    ? Math.max(8, game.text * bounds.height)
    : Math.min(HOOK_TEXT_POINTS[1], Math.max(HOOK_TEXT_POINTS[0], hookSet().textSize * bounds.height))
  const lineHeight = game.leading ?? 1.5
  // The card's line pitch: the game's own rows apart, where a reading measured them (`hook.glyphs`).
  let leading = lineHeight
  // How far in each row of the card starts, past the first (a quote's second row under the
  // character after 「), where a reading measured the game's.
  let indents = null
  const saved = (auto ? (game.ocrBox ?? game.box) : game.box) ?? null
  const ox = bounds.x - state.origin.x
  const oy = bounds.y - state.origin.y
  let where
  let letterSpacing = 0
  // How many lines the game shows the line on, as OCR found it: the card wraps onto no more.
  let lines
  let pending = false
  // On the game's text (Auto align, the line placed), the card breaks the line where the game
  // does; anywhere else it wraps to its own width.
  const example = !hook.line
  const shownText = example ? hookExample() : (hook.shown ?? hook.line)
  const wrap = hook.wrap
  const gameRows =
    saved && saved === game.ocrBox && hook.placed === hook.line && wrap?.line === hook.line && wrap.shown === shownText
      ? wrap.rows
      : null
  if (saved && saved === game.ocrBox) {
    // OCR's box is the game's ink (give or take a few pixels, as far on each side), so the card's
    // ink goes on it: its first row's ink centred on the box's first row, top to bottom, and its
    // rows' ink centred across the box when it shows the line in the game's rows (else its left
    // edge on the box's). Across, all the rows: the box spans the widest, which need not be the
    // first (「そうか。」 over a long second row). Centred, never flush with one edge: the card's font is not the game's, its
    // glyphs a little taller or shorter, and OCR pads its boxes by an engine's own margin. Where
    // the card's ink is in its text box is measured in its own font (hook-card.js `ink`).
    const height = (saved.height ?? 0) * bounds.height
    const rows = Math.max(1, Math.round((height - fontPx) / (fontPx * lineHeight)) + 1)
    // Only once a reading has found this line: until then the box is the last line's, and while
    // a reading is on its way the line stays on one line, fading out at the box's end, rather
    // than wrapping into a box made for another line.
    if (hook.placed === hook.line) lines = rows
    else pending = hook.chasing === hook.line
    const pitch = lineHeight * fontPx
    // This line's own ink, once a reading found it; until then the kept box (the last line's).
    const own = hook.found?.line === hook.line ? hook.found.box : null
    const at = own ?? saved
    const atHeight = at.height * bounds.height
    const atRows = Math.max(1, Math.round((atHeight - fontPx) / pitch) + 1)
    // The rows the card shows the line on, when they are the game's: the game's own line breaks,
    // or one row of a line the game shows on one.
    const cardRows = gameRows ?? (own && atRows === 1 && !pending ? [shownText] : null)
    // Without a measurement: half the leading above the em, and the glyphs a little inside it.
    const ink = hook.card?.ink?.((cardRows ?? [shownText]).join('\n'), fontPx, lineHeight) ?? {
      left: 0,
      top: ((lineHeight - 1) / 2 + 0.06) * fontPx,
      height: 0.88 * fontPx,
      right: at.width * bounds.width
    }
    // The first row's ink in OCR's box (the rows below it are a pitch apart), centred on the card's
    // first row's: right however many rows the card ends up showing (one, while `pending`).
    const firstRow = Math.max(ink.height * 0.5, atHeight - (atRows - 1) * pitch)
    // Until a reading finds this line, where the last line's text started: a game starts each
    // line where it started the last (an em before a 「, which inks half an em in), and nearer
    // than the last line's ink would put it. Kept with its box, so a move of the text box is not
    // followed by a place found for the old one.
    const kept = hook.textAt
    const keptHere =
      kept?.exe === hookKey() &&
      Math.abs(kept.at.x - saved.x) * bounds.width < pitch &&
      Math.abs(kept.at.y - saved.y) * bounds.height < pitch
    // The glyphs spaced as the game spaces them. The card lays each glyph a whole em apart at the
    // size Auto align measured, which is a few percent off now and then: nothing at a line's start,
    // a character or more by the end of a long one. So each row's ink is fitted to the width OCR
    // found for this line (its widest row: the box spans that one), as the OCR overlay fits each
    // box's text to its box. Before a reading finds the line, and for a line too short to measure,
    // the spacing the game's lines have had so far (`hook.spacing`, a share of the size).
    const learned = hook.spacing?.exe === hookKey() ? hook.spacing.em * fontPx : 0
    let spacing = learned
    // Only from a reading of exactly the line: one taken while the game was still typing it out
    // is short, and spread over the whole line it squeezes the glyphs together.
    const exactRead = Boolean(own && hook.found?.exact)
    // Where the ink OCR's box covers runs in the card's text box at spacing `s`, from its left:
    // its widest row, or, on one row, the stretch OCR read (a 「 or ？ it dropped is outside its
    // box). There, every glyph is a whole em plus the spacing (full-width text, hook-card.css).
    // Null where that cannot be told: the reading then says nothing about where the line is.
    let span = null
    if (exactRead && cardRows && ink.rows?.length) {
      const chars = cardRows.length === 1 ? [...cardRows[0]] : null
      const read = chars ? readSpan(cardRows[0], hook.found.read) : null
      if (read && (read[0] > 0 || read[1] < chars.length)) {
        const [a, b] = read
        const first = fullWidth(cardRows[0]) ? hook.card?.ink?.(chars[a], fontPx, lineHeight) : null
        const last = first ? hook.card?.ink?.(chars[b - 1], fontPx, lineHeight) : null
        if (first && last)
          span = {
            chars: b - a,
            bracketed: bracketed(chars[a], chars[b - 1]),
            at: (s) => ({ left: a * (fontPx + s) + first.left, right: (b - 1) * (fontPx + s) + last.right })
          }
      } else {
        const widest = ink.rows.reduce((x, y) => (y.right - y.left > x.right - x.left ? y : x))
        const whole = [...cardRows.join('')]
        span = {
          chars: widest.chars,
          bracketed: bracketed(whole[0], whole.at(-1)),
          at: (s) => ({
            left: ink.left,
            right: Math.max(...ink.rows.map((row) => row.right + s * (row.chars - 1)))
          })
        }
      }
    }
    let trusted = Boolean(span)
    const known = hook.spacing?.exe === hookKey() && hook.spacing.n >= HOOK_FIT_KNOWN ? hook.spacing : null
    // A bracket at either end inks wherever the game's font puts it in its em, which is seldom
    // where the card's does (half an em apart, for a 「): a line between brackets says little
    // about the spacing. It takes the spacing the game's other lines have had, once that is known.
    if (span && span.chars >= HOOK_FIT_CHARS && !(span.bracketed && known)) {
      // The width of what OCR's box covers grows by `chars − 1` spacings: the spacing that makes
      // it OCR's width.
      const width = (s) => span.at(s).right - span.at(s).left
      const fitted = (at.width * bounds.width - width(0)) / (width(1) - width(0))
      // A wild fit, or one far from the spacing the game's lines have had, is a reading that
      // missed some of the line or ran into something else, not the game's spacing.
      if (
        Math.abs(fitted) > HOOK_FIT_SPACING * fontPx ||
        (known && Math.abs(fitted / fontPx - known.em) > HOOK_FIT_AGREE)
      )
        trusted = false
      else {
        spacing = fitted
        if (hook.spacing?.line !== hook.line || hook.spacing.exe !== hookKey()) {
          const before = hook.spacing?.exe === hookKey() ? hook.spacing : null
          const n = Math.min((before?.n ?? 0) + 1, HOOK_PIN_READINGS)
          const em = fitted / fontPx
          hook.spacing = { exe: hookKey(), line: hook.line, n, em: before ? before.em + (em - before.em) / n : em }
        }
      }
    }
    // Where this line's own ink puts the text, once a reading found it: what OCR's box covers
    // centred on the box (OCR pads about as far on each side) for a reading of exactly the line;
    // by where its ink starts for one still being typed out. None from a reading it can't trust.
    let measured = null
    if (own && cardRows) {
      const y = at.y * bounds.height + firstRow / 2 - (ink.top + ink.height / 2)
      if (!exactRead) measured = { x: at.x * bounds.width - ink.left, y }
      else if (trusted) {
        const { left, right } = span.at(spacing)
        measured = { x: (at.x + at.width / 2) * bounds.width - (left + right) / 2, y }
      }
    }
    // A game draws its dialogue where it drew the last line, and OCR finds it a pixel or few off
    // from one reading to the next: moved to each reading, the card twitches. So a line starts
    // where the game's lines have started (`hook.textAt`, the readings' running mean), and a
    // reading that agrees within a sliver of a glyph only refines that for the next line. Text
    // that really moves (a game that writes each line below the last, a box that moved) is a row
    // or more away, well past the sliver, and the card goes there.
    // Half a glyph for a line between brackets, where the fonts' brackets put the measured place
    // that far off; text that really moves goes a row or more.
    const snap = Math.max(2, (span?.bracketed ? HOOK_PIN_SNAP_BRACKETED : HOOK_PIN_SNAP) * fontPx)
    let across
    let down
    if (
      measured &&
      keptHere &&
      Math.abs(measured.x - kept.x * bounds.width) < snap &&
      Math.abs(measured.y - kept.y * bounds.height) < snap
    ) {
      // Shown where this line started; the reading counts once, for the lines after it.
      if (kept.shownLine !== hook.line) Object.assign(kept, { shownLine: hook.line, show: { x: kept.x, y: kept.y } })
      if (kept.measuredLine !== hook.line && !span?.bracketed) {
        const n = Math.min(kept.n + 1, HOOK_PIN_READINGS)
        Object.assign(kept, {
          measuredLine: hook.line,
          n,
          x: kept.x + (measured.x / bounds.width - kept.x) / n,
          y: kept.y + (measured.y / bounds.height - kept.y) / n,
          at: { x: at.x, y: at.y }
        })
      }
      across = kept.show.x * bounds.width
      down = kept.show.y * bounds.height
    } else if (measured) {
      across = measured.x
      down = measured.y
      const x = across / bounds.width
      const y = down / bounds.height
      hook.textAt = {
        x,
        y,
        n: 1,
        at: { x: at.x, y: at.y },
        exe: hookKey(),
        shownLine: hook.line,
        measuredLine: hook.line,
        show: { x, y }
      }
    } else if (keptHere) {
      // Until a reading finds this line, or from one that can't say where it is: where the game's
      // lines start.
      if (kept.shownLine !== hook.line) Object.assign(kept, { shownLine: hook.line, show: { x: kept.x, y: kept.y } })
      across = kept.show.x * bounds.width
      down = kept.show.y * bounds.height
    } else {
      across = at.x * bounds.width - ink.left
      down = at.y * bounds.height + firstRow / 2 - (ink.top + ink.height / 2)
    }
    // Where the game draws every glyph of this line, from OCR's character boxes (hook-glyphs.ts):
    // the card's go there, row by row. Its glyphs are full-width, a whole em plus the spacing
    // apart, so each one's centre is half an em into its advance: the spacing is the game's pitch
    // less an em, each row starts half an em before the centre of its first character, and the
    // rows are the game's row pitch apart. This replaces everything above, which only knows where
    // the line's ink starts and ends.
    let glyphWidth = 0
    const glyphs = hook.glyphs
    if (
      glyphs?.line === hook.line &&
      cardRows &&
      cardRows.length === glyphs.rows.length &&
      cardRows.join('\n') === glyphs.rows.join('\n') &&
      glyphs.starts[0] !== null
    ) {
      // This line's own pitch (a short line's is the game's, `hookGlyphsFrom`): a game sets its
      // dialogue in one size, but the newest reading of a line knows its glyphs best.
      const glyphPitch = glyphs.pitch * bounds.width
      spacing = glyphPitch - fontPx
      // Each row's top (its line box's), from its glyphs: where each one's box centre is, less
      // where the card's font puts that glyph's ink in a line box (an engine boxes a short kana
      // lower, and the card's font draws it lower too). The rows are as far apart as the game's
      // are, which sets the card's line pitch.
      const rowTop = (marks, at) => {
        const tops = marks.flatMap((m) => {
          const ink = hook.card?.ink?.(m.c, fontPx, at)
          return ink ? [m.y * bounds.height - (ink.top + ink.height / 2)] : []
        })
        if (!tops.length) return null
        tops.sort((a, b) => a - b)
        return tops[tops.length >> 1]
      }
      const lastRow = glyphs.marks.findLastIndex((m, i) => i > 0 && m.length)
      if (lastRow > 0) {
        // Measured at the current leading; the glyphs sit centred in their line box, so the
        // distance between two rows' tops is the line pitch whatever the leading measured at.
        const firstTop = rowTop(glyphs.marks[0], leading)
        const lastTop = rowTop(glyphs.marks[lastRow], leading)
        if (firstTop !== null && lastTop !== null)
          leading = Math.min(2.5, Math.max(1, (lastTop - firstTop) / lastRow / fontPx))
      }
      const start = glyphs.starts[0] * bounds.width
      const top = rowTop(glyphs.marks[0], leading)
      const reading = { x: (start - fontPx / 2) / bounds.width, y: (top ?? down) / bounds.height }
      // A game draws each line where it drew the last, and each reading finds it a pixel or two
      // off: shown where the game's lines have started (`hook.glyphAt`, the readings' running
      // mean), each line's newest reading refining that for the lines after it. Text that really
      // moves (more than a sliver of a glyph: a box that moved) goes where this reading says.
      const kept = hook.glyphAt?.exe === hookKey() ? hook.glyphAt : null
      const sliver = Math.max(2, HOOK_PIN_SNAP * fontPx)
      if (
        kept &&
        Math.abs(reading.x - kept.x) * bounds.width < sliver &&
        Math.abs(reading.y - kept.y) * bounds.height < sliver
      ) {
        if (kept.line !== hook.line)
          Object.assign(kept, {
            line: hook.line,
            show: { x: kept.x, y: kept.y },
            base: { x: kept.x, y: kept.y },
            n: Math.min(kept.n + 1, HOOK_PIN_READINGS)
          })
        // This line's newest reading stands for it in the mean (the first may have caught its
        // glyphs still sliding into place).
        kept.x = kept.base.x + (reading.x - kept.base.x) / kept.n
        kept.y = kept.base.y + (reading.y - kept.base.y) / kept.n
      } else {
        hook.glyphAt = { exe: hookKey(), line: hook.line, n: 1, ...reading, show: reading, base: reading }
      }
      across = hook.glyphAt.show.x * bounds.width
      down = hook.glyphAt.show.y * bounds.height
      indents = glyphs.starts.map((x) => (x === null ? 0 : x * bounds.width - start))
      glyphWidth = Math.max(...cardRows.map((row, i) => indents[i] + [...row].length * glyphPitch))
      hook.spacing = { exe: hookKey(), line: hook.line, n: HOOK_PIN_READINGS, em: spacing / fontPx }
    } else if (hook.glyphAt?.exe === hookKey()) {
      // A line too short to measure glyph by glyph (はい。), or not read yet: where the game's
      // lines start, as the measured ones found it, when that is where this one is. Measured
      // from its box alone it would land a pixel or few from the lines around it.
      const kept = hook.glyphAt
      if (Math.abs(across - kept.x * bounds.width) < pitch && Math.abs(down - kept.y * bounds.height) < pitch) {
        across = kept.x * bounds.width
        down = kept.y * bounds.height
      }
    }
    letterSpacing = spacing
    where = {
      x: ox + across,
      y: oy + down,
      // To the furthest the text has reached, and a little over: the card's font is not quite
      // the game's.
      width:
        Math.max(Math.max(saved.x + saved.width, at.x + at.width) * bounds.width - across, glyphWidth) + fontPx * 0.6,
      height: rows * leading * fontPx
    }
  } else if (saved) {
    where = {
      x: ox + saved.x * bounds.width,
      y: oy + saved.y * bounds.height,
      width: saved.width * bounds.width,
      height: (saved.height ?? 0) * bounds.height || fontPx * lineHeight
    }
  } else {
    const height = fontPx * lineHeight * HOOK_DEFAULT.lines
    where = {
      x: ox + HOOK_DEFAULT.x * bounds.width,
      y: oy + HOOK_DEFAULT.bottom * bounds.height - height,
      width: HOOK_DEFAULT.width * bounds.width,
      height
    }
  }
  // The card's own look (`hookAppearance`). Blend takes the colours of what the game's text sits
  // on, so only while the card is over the game and a reading said what that is; otherwise the
  // app's own light or dark. Transparent draws nothing of the card: its text is still there to
  // look up.
  let theme = resolveHookCardAppearance(setting('overlayStyle'), setting('appearance'), systemDark.matches)
  const inside =
    where.x >= ox &&
    where.y >= oy &&
    where.x + where.width <= ox + bounds.width &&
    where.y + where.height <= oy + bounds.height
  const surface = theme === 'blend' && inside ? (game.surface ?? null) : null
  if (theme === 'blend' && !surface)
    theme = resolveOverlayCardAppearance({ appearance: 'app' }, setting('appearance'), systemDark.matches)
  if (gameRows) lines = gameRows.length
  return {
    text: gameRows && !example ? gameRows.join('\n') : shownText,
    example,
    ...where,
    lines,
    pending,
    fontPx,
    lineHeight: leading,
    indents,
    theme,
    surface,
    opacity: hookSet().opacity,
    letterSpacing,
    // Its rows are words apart in a language that spaces its words (hook-card.js `setText`).
    spaced: languageOf(languageNow()).spaces,
    // In the language being read (its font: `--kimochi-text-font`, `applyTextStyle`).
    lang: textStyle(languageNow()).lang
  }
}

/**
 * The card's text as Read along takes a box's (ui/controller.js `readUnits`): a unit per row
 * (hook-card.js `setText`), as for a block's lines, so a word the game breaks across two rows is
 * one word. Each carries the whole line as its `sentence` (and where the row starts in it,
 * `sentenceOffset`): the sentence a lookup gives Anki, and what keeps a word from running on out
 * of the card into other text (word-nav.js `runsOnInto`). None while it is not shown.
 */
function hookCardUnits() {
  const element = hook.card?.element
  const text = element && !element.hidden ? element.querySelector('.hook-card-text') : null
  if (!text) return []
  const sentence = text.textContent
  const units = []
  let sentenceOffset = 0
  // A row's text nodes, in order: a curly quote is in a span of its own (hook-card.js `setText`),
  // and a word never runs through one.
  for (const row of text.children) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const rowText = node.textContent
      if (rowText) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const { left, top, width, height } = range.getBoundingClientRect()
        const box = { x: left, y: top, width, height }
        units.push({ element, node, text: rowText, sentence, sentenceOffset, vertical: false, box })
      }
      sentenceOffset += rowText.length
    }
  }
  return units
}

/** Shows the card as it should be now, and publishes it as somewhere the pointer may go. */
function syncHookCard() {
  if (!hook.card) return
  // Gaming Mode: nothing can point at the card's bar, buttons or menu; the game menu has them.
  hook.card.bare(window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope)
  const view = hookCardView()
  const glide = hook.glide
  hook.glide = false
  hook.card.show(view && { ...view, glide })
  const signature = JSON.stringify(hook.card.rects())
  if (signature !== hook.cardRect) {
    hook.cardRect = signature
    void publishRegions()
  }
}

/** A text box on the overlay as fractions of the game window, as `box` keeps it; null without one. */
function hookBoxOf(box) {
  const bounds = state.sourceBounds ?? state.info?.source_bounds
  if (!box || !bounds?.width || !bounds?.height || !state.origin) return null
  return {
    x: (box.x - (bounds.x - state.origin.x)) / bounds.width,
    y: (box.y - (bounds.y - state.origin.y)) / bounds.height,
    width: box.width / bounds.width,
    height: box.height / bounds.height
  }
}

/**
 * The reader moved or resized the card: kept for the game. Placing it by hand is the reader
 * taking over, so Auto align turns off (turning it back on aligns again).
 */
function onHookCardMoved(box) {
  const saved = hookBoxOf(box)
  if (!saved || !hookKey()) return
  log({ check: 'hook-card-moved', box: saved })
  void saveHookGame({ box: saved, autoAlign: false })
}

/**
 * Smaller or larger text (−/+ on the card): a tenth at a time, kept for the game. The card stays
 * where it is, now the reader's, and Auto align turns off as it does for a move.
 */
function onHookCardTextSize(step, box) {
  const bounds = state.sourceBounds ?? state.info?.source_bounds
  if (!bounds?.height || !hookKey()) return
  const game = hookGame()
  const now = (game.text ?? hookSet().textSize) * bounds.height
  const next = Math.min(96, Math.max(10, Math.round(now * (step > 0 ? 1.1 : 1 / 1.1) * 10) / 10))
  const saved = hookBoxOf(box)
  log({ check: 'hook-card-text-size', from: now, to: next })
  return saveHookGame({ text: next / bounds.height, ...(saved ? { box: saved } : {}), autoAlign: false })
}

/** A new hooked line: shown at once, aligned with what OCR last read if the line is there. */
function onHookLine(payload) {
  if (!hookMode() || typeof payload?.text !== 'string') return
  // A sentence the game added to the text box it already shows (`screen`, the whole box): the
  // Log takes the sentence, the card everything the game shows, so every line on screen can be
  // pointed at, and Auto align finds the box as OCR reads it.
  const line = typeof payload.screen === 'string' && payload.screen ? payload.screen : payload.text
  hook.line = line
  hook.lineAt = performance.now()
  hook.names = []
  // A game known to show its speakers' names apart, or one that sends the name after the quote on
  // a line of its own: the card shows what they say from the start, Auto align on or off.
  const speech = hookSet().speakerNames ? splitSpeaker(line) : null
  hook.shown = (speech && (speech.after || hookGame().namesApart) && speech.body) || line
  // The chase first: the card shows the line held for it (`pending`) from the start.
  void chaseHookLine(line)
  setOcrAnnotations(state.rawAnnotations ?? [])
  syncHookCard()
  controller?.hookChanged?.()
}

/**
 * Looks for a new line at once rather than when Auto OCR next reads the screen. The loop waits
 * for text to settle before reading it, a second or more, and some games never quite settle (an
 * animated backdrop, a blinking cue): but the Text Hooker only sends a line once the game has
 * finished typing it, so it is on screen now. Reads straight away, then a little later while no
 * reading has found the whole line, and stops once one has. A first reading may have caught the
 * line still fading in, which the loop counts as read: the later looks read it again.
 */
const HOOK_CHASE_MS = [0, 300, 700, 1200, 2000]
/**
 * Auto align was turned back on: the card goes back to where Auto align last found the game's
 * text (its `ocrBox`, kept while it was off) at once, and the screen is read now, as for a new
 * line, so the line is measured again and the card follows if the text has moved.
 */
let hookAligning = null
function realignHookCard() {
  const on = hookOcrOn()
  const was = hookAligning
  hookAligning = on
  if (!on || was !== false) return
  hook.placed = null
  hook.reading = null
  hook.moveTo = null
  hook.resize = null
  hook.wrap = null
  log({ check: 'hook-card-realign', line: Boolean(hook.line) })
  syncHookCard()
  // After the scanner the same change starts (`syncAutoScanner`) is running.
  if (hook.line) setTimeout(() => void chaseHookLine(hook.line), 0)
}

async function chaseHookLine(line) {
  if (!hookOcrOn()) return
  const started = performance.now()
  const reads = []
  hook.chasing = line
  for (const wait of HOOK_CHASE_MS) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    if (hook.line !== line || hook.placed === line || !hookOcrOn()) break
    if (scanner !== sceneScanner || !scanner.isRunning) break
    const from = performance.now()
    await sceneScanner.refresh(reads.length > 0).catch(() => false)
    reads.push([Math.round(from - started), Math.round(performance.now() - from)])
  }
  if (hook.line !== line) return
  hook.chasing = null
  // Given up: the line wraps in the box it has (`pending` no longer holds it on one line).
  syncHookCard()
  const placed = hook.placed === line
  const missed = !placed && hook.missed?.line === line ? hook.missed : null
  log({
    check: 'hook-line-chase',
    placed,
    reads,
    ms: Math.round(performance.now() - started),
    // Not found: what OCR's blocks were, to see why.
    ...(missed && {
      recall: missed.recall,
      precision: missed.precision,
      blocks: annotationGroups(missed.annotations).map((g) => g.text.slice(0, 80))
    })
  })
}

function onHookStatus(status) {
  const hooked = status && status.phase !== 'idle' && status.phase !== 'failed' && status.phase !== 'ended'
  const sourceId = hooked ? (status.sourceId ?? null) : null
  if (sourceId !== hook.sourceId) {
    hook.line = null
    hook.shown = null
    hook.names = []
    hook.placed = null
    hook.missed = null
    hook.reading = null
    hook.resize = null
    hook.moveTo = null
  }
  hook.exe = status?.exe ?? null
  hook.sourceId = sourceId
  hook.status = status ?? null
  controller?.hookChanged?.()
  void followSource(followedSource())
  syncAutoScanner()
  draw()
}

/**
 * Whether hovering the source card marks the window. Not when it fills its display: the
 * picture would cover the reader's whole screen, the way it would for a display. Nor when it
 * is on another Space or desktop: it would be drawn over whatever the reader has in front.
 */
function hoverMarksWindow() {
  return (
    state.hover.isWindow &&
    !state.hover.underPointer &&
    !state.sourceWindow?.fullscreen &&
    state.sourceWindow?.onScreen !== false
  )
}
/** Bumped by every source-card hover, so a pointer reading from an earlier one is dropped. */
let hoverSourceTurn = 0

function drawHover() {
  const marked = state.hover.source && hoverMarksWindow()
  hover.update({
    visible: state.hover.selectRegion || marked,
    showWindowOutline: marked,
    showCropRegion: state.hover.selectRegion,
    windowImage: marked ? hoverPreview.url : null,
    windowImageStale: !hoverPreview.fresh,
    bounds: state.sourceBounds,
    crop: state.crop,
    origin: state.origin
  })
}

/**
 * Reflect scan progress locally and on the shared view.
 *
 * The controller lives in another window and reads `isScanning` and `status`
 * from the native view, so a scan driven from here has to publish both or the
 * controller shows nothing happening while an OCR request is in flight. A
 * failure to publish must never fail the scan, so it is reported and swallowed.
 */
function setScanning(scanning, status) {
  if (state.scanning !== scanning) {
    state.scanning = scanning
    draw()
  }
  publish({ scanning, ...(status === undefined ? {} : { status }) })
}

/** Publishing must never fail a scan, so a failure is reported and swallowed. */
function publish(update) {
  void native
    .publishScanState(update)
    .catch((error) => log({ check: 'scan-state-error', error: String(error?.message ?? error) }))
}

/**
 * Publish an accepted result to the shared view.
 *
 * Called only once the staleness guard has passed, so the shared view — and with
 * it the capture and debug panels and the controller's status — never shows a
 * result belonging to a source the user has already moved away from. Native
 * dedupes by frame id, so a cloud frame that `ocr_frame` already published is
 * not published twice; that call only clears the busy flag.
 */
function publishAccepted(frame, result) {
  if (!frame?.id) return
  state.appliedScanId = frame.id
  return native.publishScanState({
    publish: true,
    scanning: false,
    scan: {
      id: frame.id,
      info: frame.info ?? null,
      ocr: {
        groups: result.groups ?? [],
        engine: result.engine,
        schemaVersion: 1,
        fullText: result.fullText ?? '',
        textAnnotations: result.geometry ? (result.textAnnotations ?? []) : [],
        geometry: result.geometry !== false
      }
    },
    // A result without geometry has nothing to draw, and the status line is where
    // that is explained rather than letting it look like a scan that found
    // nothing.
    ...(result.geometry
      ? {}
      : {
          status: result.fullText
            ? 'Scan ready \u00b7 text only, this engine returns no positions'
            : 'Scan ready \u00b7 no text recognized'
        })
  })
}

/**
 * Frames whose results were rejected as stale.
 *
 * `ocr_frame` publishes its result to the shared view before this window judges
 * it, so a late cloud result from a source the user has left would arrive back
 * as a view update and be rendered after all. Remembering the rejected ids stops
 * that echo, alongside asking native to stop self-publishing from `ocr_frame`.
 */
const rejectedFrameIds = new Set()
function rejectFrame(id) {
  if (id === null || id === undefined) return
  rejectedFrameIds.add(id)
  // Ids increase monotonically, so only the newest few can still be echoed.
  if (rejectedFrameIds.size > 32) {
    rejectedFrameIds.delete(rejectedFrameIds.values().next().value)
  }
}

// ---------------------------------------------------------------------------
// 2. The scan pipeline
// ---------------------------------------------------------------------------

const generation = new Generation()
const pipeline = new PipelineLock()

/**
 * Snapshot everything a scan depends on, once, before any await.
 *
 * The source descriptor and crop are captured here rather than read back after
 * the endpoint answers, so a result is always attributed to the selection that
 * produced it even if the user picks a different window mid-request.
 */
async function beginJob() {
  const sourceId = await native.selectedSource()
  if (!sourceId) return null
  const prefs = await native.preferences().catch(() => null)
  return {
    generation: generation.current,
    sourceId,
    source: prefs?.source ?? null,
    request: { source_id: sourceId, crop: prefs?.crop ?? null }
  }
}

/**
 * Keep native tracking whichever source is selected.
 *
 * `watch_source` polls the window's bounds natively and emits `source-bounds`,
 * which is what lets the overlay follow a source that moves or changes display
 * between scans — Electron did this with its window-position watcher.
 */
let watchedSourceId = null
/**
 * The window the overlay follows: the one picked as the source, or with the Text Hooker as the
 * input, the hooked game's (whatever window was last picked for OCR), so its card sits over the game
 * and goes when the game is left.
 */
const followedSource = () => (hookMode() && hook.sourceId ? { sourceId: hook.sourceId } : state.viewSource)
async function followSource(source) {
  const id = source?.sourceId ?? source?.id ?? null
  if (id === watchedSourceId) return
  watchedSourceId = id
  state.sourceBounds = null
  state.sourceWindow = null
  await native.watchSource(id ?? null)
}

/** Place the overlay over the display that holds the captured source. */
async function positionFor(info) {
  // Unsupported Wayland desktops still publish capture/OCR to the reader.
  // They have neither an annotation surface nor a portable desktop catalogue.
  if (waylandDisabled) return state.origin
  if (waylandLayer) return { x: 0, y: 0, width: innerWidth, height: innerHeight }
  if (!info?.source_bounds) return state.origin
  const origin = sourceDisplay(info.source_bounds, await native.desktop())
  const moved =
    !state.origin ||
    state.origin.x !== origin.x ||
    state.origin.y !== origin.y ||
    state.origin.width !== origin.width ||
    state.origin.height !== origin.height
  if (moved) await native.placeOverlay(origin)
  return origin
}

/**
 * Apply one OCR result: reposition, redraw, publish.
 *
 * The published string is the filtered reading-order text, not the endpoint's
 * `fullText`, so history, clipboard, texthooker and TTS all agree with what the
 * overlay actually shows.
 */
async function applyResult(result, frame, job, outcome = { publish: true }) {
  // The selection moved on while this was in flight: these pixels describe a
  // source the user is no longer looking at, so they must not be rendered and
  // must not reach the history, the clipboard or the texthooker.
  if (!job || generation.isStale(job)) {
    const staleId = result.nativeScanId ?? frame?.id ?? null
    rejectFrame(staleId)
    log({
      check: 'overlay-scan-discarded',
      reason: 'selection changed while the scan was in flight',
      frameId: staleId,
      jobGeneration: job?.generation ?? null,
      current: generation.current
    })
    publish({ scanning: false, status: 'Scan discarded: the source changed while it was running.' })
    // An automatic recognition reports once, when the loop lets go; see `autoRound`.
    if (autoRound) autoRound.outcome = scanActivity.sourceChanged()
    else activity(scanActivity.sourceChanged())
    return ''
  }

  const info = frame?.info ?? null
  state.info = info
  state.detached = !!job.detached
  state.geometry = result.geometry !== false
  setOcrAnnotations(state.geometry ? (result.textAnnotations ?? []) : [])
  state.source = job.source
  const kind = state.source?.kind ?? state.source?.type
  state.scannedApp = kind === 'window' ? (state.source.app ?? state.source.appName ?? null) : foreground.current
  // Whichever native scan produced this is now accounted for, so the poll loop
  // does not treat its revision as new work and publish the same text twice.
  state.appliedScanId = result.nativeScanId ?? frame?.id ?? null

  // The native published owner must exist before AutoScanner releases its pin.
  await publishAccepted(frame, result)

  if (state.geometry && info) state.origin = await positionFor(info)
  draw()

  const grouping = setting('textOverlayGrouping')
  // Redrawing and publishing are separate. The accurate recogniser returning the
  // same sentence again — because the reader has not moved on, and the box has
  // only shifted a little — must still move the word boxes, and must not put a
  // second copy in the history, the clipboard and the texthooker.
  const published =
    outcome.publish === false
      ? ''
      : await publishOcrResult(outcome.publishResult ?? result, {
          detached: !!job.detached,
          grouping,
          // A scan of text that is already in the history does not add it again.
          merge: true,
          frame: frame?.id ?? null,
          onPublication: outcome.onPublication
        })

  // A reloaded overlay must redraw this native scan without replaying its outputs. Saved whatever
  // `publish` said: `publish: false` means the outputs were handled elsewhere (auto-OCR text mode
  // publishes passages itself, image-mode refreshes hold them back), and a replay must not add
  // them either.
  markScanPublished(state.appliedScanId)

  log({
    check: 'overlay-scan-applied',
    mode: ocrModeNow(),
    geometry: state.geometry,
    words: state.geometry ? visibleAnnotations(state.annotations, grouping).length : 0,
    published: published.length,
    refreshedOnly: outcome.publish === false
  })
  return published
}

/**
 * A manual scan: capture, recognise, apply. Skipped while the loop holds the lock.
 *
 * `explicit` is a ready-made job (a Quick Shot's display region) to run instead of the chosen
 * source's.
 */
/** How long a scan the reader asked for waits for a capture already running. */
const SCAN_WAIT_MS = 10000

/**
 * The frame for a scan the reader asked for. Automatic scanning may be in the middle of a
 * capture (a slow watcher on a large full-screen frame holds it for seconds): the scan waits for
 * it rather than giving up, so Scan and Force rescan always scan.
 */
async function captureForScan(request) {
  const until = Date.now() + SCAN_WAIT_MS
  for (;;) {
    try {
      return await native.captureFrame(request, scanner.isRunning, ...observerArgs())
    } catch (error) {
      if (!String(error?.message ?? error).startsWith('busy:') || Date.now() > until) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function performScan(explicit = null) {
  trace('manual-scan', { generation: generation.current })
  const ran = await pipeline.run(async () => {
    setScanning(true, 'Capturing\u2026')
    // While a game is hooked the scan only places the card; it says so once it is done.
    if (!hookMode()) activity(scanActivity.scanStarted())
    // Only here: every caller of performScan is the reader asking (shortcut, button, gamepad,
    // Quick Shot, a committed region), and the automatic loop never comes through this path.
    playSound('scan-start')
    // Which stage a failure belongs to decides how it is told: a capture error is about the
    // source, a recognition error about the engine.
    let stage = 'capture'
    try {
      const job = explicit ?? (await beginJob())
      if (!job) {
        log({ check: 'overlay-scan-skipped', reason: 'no source selected' })
        setScanning(false, 'Choose a source before scanning.')
        reportOutcome(scanActivity.noSource())
        return
      }
      const frame = await captureForScan(job.request)
      stage = 'recognise'
      if (!hookMode()) activity(scanActivity.recognising(ocrModeNow()))
      const result = await recognize(frame, { ocrMode: ocrModeNow() })
      if (!result) {
        setScanning(false, 'No result from the OCR engine.')
        reportOutcome(scanActivity.nothingRecognised())
        return
      }
      stage = 'publish'
      let publication = null
      const published = await applyResult(result, frame, job, {
        publish: true,
        onPublication: (report) => {
          publication = report
        }
      })
      // Every applied result reaches the publisher, which reports; one that did not was
      // discarded as stale, and applyResult has already said so.
      // While a game is hooked the reading only places the card: say so, rather than "Nothing
      // recognised" or nothing at all, to a reader who pressed Scan wanting OCR.
      if (hookMode()) reportOutcome(scanActivity.hookedScan())
      else if (publication || !generation.isStale(job)) reportOutcome(scanActivity.scanOutcome(publication))
      // Keep the auto loop from immediately republishing what we just showed —
      // but only if the result was actually accepted.
      // Tell the loop what has just been spent and shown, so it does not
      // immediately make the same request again — and so its minimum spacing
      // starts from this scan, not from its own last one.
      if (published !== '' || !generation.isStale(job))
        scanner.noteExternalScan(result.fullText, observationFrom(frame)?.lines, result)
    } catch (error) {
      // Capture permission, a stale source and an unreachable endpoint all land
      // here, and the user's only view of them is the controller's status line.
      const message = String(error?.message ?? error)
      log({ check: 'overlay-scan-error', error: message })
      state.scanning = false
      draw()
      publish({ scanning: false, status: message })
      reportOutcome(scanActivity.scanFailed(error, stage, ocrModeNow()))
      return
    } finally {
      if (state.scanning) setScanning(false)
    }
  })
  if (ran === null) {
    log({ check: 'overlay-scan-skipped', reason: 'a scan is already running' })
    activity(scanActivity.scanBusy())
  }
  return ran !== null
}

/**
 * The automatic loop.
 *
 * Every dependency is injected, which is what lets `scripts/autoscan.test.mjs`
 * exercise the whole policy with a fake clock and no app. What this file supplies
 * is the real versions: one native call that captures, hashes and locally reads a
 * frame; the configured accurate recogniser; the shared pipeline lock; and the
 * same `applyResult` the manual path uses, so a result reaches the overlay by one
 * route whichever path produced it.
 */
/**
 * The job the most recent automatic capture belongs to.
 *
 * Only used as a fallback. A recognition outlives the tick that started it, so by
 * the time a result lands this may already describe a later capture — which is
 * why each frame carries its own job below, and why the result is attributed to
 * that one rather than to whatever the loop is looking at now.
 */
let autoJob = null
/** The source window was out of view at the last automatic capture (`isSourceOutOfView`). */
let autoSourceHidden = false
const scanDeps = {
  generation: () => generation.current,
  // Held by the *other* path. The loop's own request takes this lock too, so it
  // cannot overlap a manual scan and a manual scan cannot overlap it.
  isBusy: () => pipeline.isHeld,
  tryAcquire: () => pipeline.acquire(),
  releaseLock: () => pipeline.release(),
  captureFrame: async (options) => {
    const selectionStarted = performance.now()
    autoJob = await beginJob()
    const selectionMs = performance.now() - selectionStarted
    if (!autoJob) throw new Error('No source selected')
    const started = performance.now()
    trace('capture-start', { generation: autoJob.generation })
    let captured
    try {
      captured = await native.captureFrame(autoJob.request, true, ...observerArgs(), options?.readIfStill ?? null)
    } catch (error) {
      trace('capture-failed', { durationMs: performance.now() - started })
      throw error
    }
    autoSourceHidden = false
    try {
      scanTrace.observation({
        frameId: captured.id,
        generation: autoJob.generation,
        fingerprint: captured.contentFingerprint ?? null,
        observation: observationFrom(captured),
        captureMs: captured.info?.total_ms,
        resolveMs: captured.info?.resolve_ms,
        acquisitionMs: captured.info?.acquisition_ms,
        pixelsMs: captured.info?.pixels_ms,
        observerMs: captured.observation?.duration_ms,
        roundTripMs: performance.now() - started,
        selectionMs,
        width: captured.info?.width,
        height: captured.info?.height
      })
    } catch {
      /* diagnostic only */
    }
    // The job travels with the frame. `applyResult` needs the source and the
    // generation *this* capture was made under, and a slow request can easily
    // outlive several later captures.
    const frame = { ...captured, job: autoJob }
    return {
      frame,
      generation: autoJob.generation,
      hash: captured?.hash ?? null,
      contentFingerprint: captured?.contentFingerprint ?? null,
      observation: observationFrom(captured),
      observerError: captured?.observerError ?? null,
      observerUnsupported: !!captured?.observerUnsupported,
      observerBusy: !!captured?.observerBusy,
      observerSkipped: !!captured?.observerSkipped
    }
  },
  recognize: async (frame) => {
    const started = performance.now()
    trace('second-pass-start', { frameId: frame.id, mode: ocrModeNow() })
    try {
      const result = await recognize(frame, { ocrMode: ocrModeNow() })
      try {
        scanTrace.result(frame.id, result?.fullText ?? '', performance.now() - started)
      } catch {
        /* diagnostic only */
      }
      return result
    } catch (error) {
      trace('second-pass-failed', { frameId: frame.id, durationMs: performance.now() - started })
      throw error
    }
  },
  retainFrame: (frame) => native.retainFrame(frame?.id, true),
  releaseFrame: (frame) => native.retainFrame(frame?.id, false),
  onDiagnostic: (event, frame, counters, context) => {
    // Free-form messages/details may carry service content. Keep only structured
    // decision fields; the existing operational error log remains separate.
    const safe = Object.fromEntries(
      Object.entries(event).filter(([key]) => !['message', 'detail', 'layout'].includes(key))
    )
    trace('decision', { event: safe, frameId: frame?.id ?? null, counters, ...context })
  },
  onScanStart: () => {
    setScanning(true, 'Auto scan\u2026')
    beginAutoRound()
  },
  onScanEnd: () => {
    setScanning(false)
    settleAutoRound()
  },
  onEvent: onAutoScanEvent
}

/**
 * What the recognition the automatic loop has out will be reported as.
 *
 * The loop starts one whenever the screen settles on new text, and its outcome arrives in
 * pieces: lines published through `applyResult` or the scene, a skip or an error event from
 * the loop. They are gathered here and said once, when the loop lets go of the pipeline, so
 * the ticker shows one "Screen settled, scanning…" and one outcome per recognition rather than
 * a line for every step.
 */
let autoRound = null

function beginAutoRound() {
  autoRound = { lines: 0, duplicate: false, outcome: null }
  activity(scanActivity.autoScanStarted())
}

/** Lines the automatic path published; outside a recognition they are news on their own. */
function noteAutoPublication(report) {
  if (!autoRound) {
    if (report.lines > 0) reportOutcome(scanActivity.scanOutcome(report, { auto: true }), { auto: true })
    return
  }
  autoRound.lines += report.lines
  autoRound.duplicate ||= report.duplicate
}

function settleAutoRound() {
  const round = autoRound
  autoRound = null
  if (!round) return
  // Lines that reached the Log are the outcome, whatever else was said on the way.
  reportOutcome(round.lines > 0 || !round.outcome ? scanActivity.scanOutcome(round, { auto: true }) : round.outcome, {
    auto: true
  })
}

/**
 * Image mode: the whole-crop hash decides, so the original single-candidate loop drives it.
 * Text mode — the default — runs on the scene memory instead; see scene-scanner.ts.
 */
const imageScanner = new AutoScanner({
  ...scanDeps,
  onResult: async (result, frame, outcome) => {
    const started = performance.now()
    trace('apply-start', { frameId: frame?.id, publish: outcome.publish })
    try {
      const applied = await applyResult(result, frame, frame?.job ?? autoJob, {
        ...outcome,
        onPublication: noteAutoPublication
      })
      trace('apply-end', {
        frameId: frame?.id,
        durationMs: performance.now() - started,
        publishedChars: applied.length,
        geometry: result.geometry !== false
      })
      return applied
    } catch (error) {
      trace('apply-failed', { frameId: frame?.id, durationMs: performance.now() - started })
      throw error
    }
  }
})

const sceneScanner = new SceneScanner({ ...scanDeps, onScene: applyScene, language: languageNow })

/** Whichever loop the observer mode calls for; `syncAutoScanner` keeps it current. */
let scanner = sceneScanner

/**
 * Draw what the scene memory holds, and publish what it says is new.
 *
 * An update with a frame comes from a recognition and goes through `applyResult` like any
 * scan, so the reader, the controller and the published scan state all see it. One without
 * is the drawing catching up with the screen — a line went, or came back with a reading the
 * memory already had — and only redraws.
 */
async function applyScene(update) {
  const grouping = setting('textOverlayGrouping')
  if (update.frame) {
    const started = performance.now()
    trace('apply-start', { frameId: update.frame.id, publish: update.publish.length })
    await applyResult(update.result, update.frame, update.frame.job ?? autoJob, { publish: false })
    trace('apply-end', {
      frameId: update.frame.id,
      durationMs: performance.now() - started,
      geometry: update.result.geometry !== false
    })
  } else {
    if (update.generation !== generation.current) return
    setOcrAnnotations(update.result.geometry ? update.result.textAnnotations : [])
    if (state.rawAnnotations.length) state.geometry = true
    draw()
    void publishRegions()
  }
  let published = 0
  for (const passage of hookMode() ? [] : update.publish) {
    published += (await publishPassage(passage, grouping, update.frame?.id ?? null)).length
  }
  log({
    check: 'auto-scan-scene',
    reason: update.reason,
    annotations: Math.max(0, state.annotations.length - 1),
    passages: update.publish.length,
    corrections: update.publish.filter((passage) => passage.replaces).length,
    published
  })
}

/**
 * Publish one passage from automatic OCR. Merged into the history rather than appended: a
 * passage that is the same sentence as one just written, or a piece of it, adds nothing, and
 * one that completes an earlier fragment replaces it.
 */
async function publishPassage(passage, grouping, frame) {
  return publishOcrResult(passage.result, {
    detached: state.detached,
    grouping,
    merge: true,
    frame,
    onPublication: noteAutoPublication
  })
}

/**
 * Turn the native observation into the shape the policy compares.
 *
 * Line boxes arrive in the frame's own pixels with a top-left origin — see
 * `TextLine` in capture-core — which is the same space the box tolerance is
 * expressed in, so nothing is converted here.
 */
function observationFrom(frame) {
  const observation = frame?.observation
  if (!observation || typeof observation.text !== 'string') return null
  return {
    text: observation.text,
    durationMs: observation.duration_ms,
    lines: (observation.lines ?? []).map((line) => ({
      text: line.text ?? '',
      box: { x: line.x ?? 0, y: line.y ?? 0, width: line.width ?? 0, height: line.height ?? 0 },
      ...(Array.isArray(line.ink) ? { ink: line.ink } : {})
    }))
  }
}

/**
 * Report what the loop is doing, without ever reporting what it read.
 *
 * Every event carries counts, reasons, lengths and coarse geometry and no
 * recognised text, so the diagnostics stay safe to read and to send. `status` is
 * the one the user has to see: automatic scanning turning itself off, whether
 * because this platform has no observer or because it has failed too often, is
 * not something to leave in a log file.
 */
function onAutoScanEvent(event) {
  switch (event.type) {
    case 'visual-invalidated':
      // Local observation controls visual freshness; never wait for the cloud
      // to tell us that text which disappeared is no longer on screen.
      setOcrAnnotations(
        event.keepBoxes ? annotationsInLines(state.rawAnnotations ?? state.annotations, event.keepBoxes) : []
      )
      draw()
      void publishRegions()
      log({
        check: 'auto-scan-visual-cleared',
        reason: event.reason,
        retained: state.annotations.length
      })
      return
    case 'status':
      if (event.state === 'running') {
        const settings = autoSettings()
        trace('auto-start', {
          mode: ocrModeNow(),
          observerMode: settings.observerMode,
          watcher: autoWatcher(),
          settings: Object.fromEntries(
            Object.entries(settings).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean')
          )
        })
      }
      if (event.state === 'idle') {
        trace('auto-stop')
        void scanTrace.flush()
      }
      log({ check: 'auto-scan-status', state: event.state, message: event.message })
      // Null for the states that are not news; posting nothing is a no-op.
      activity(scanActivity.autoScanStatus(event.state, event.message))
      if (event.state === 'unavailable' || event.state === 'suspended') {
        state.scanning = false
        draw()
        publish({ scanning: false, status: event.message })
      }
      return
    case 'error':
      log({
        check: 'auto-scan-error',
        stage: event.stage,
        error: event.message,
        backoffMs: event.backoffMs
      })
      // A capture or endpoint failure belongs on the controller, not only in the
      // log; an observer that has simply not answered yet does not, because it
      // retries on its own and the status line would flicker.
      if (event.stage !== 'observer') publish({ scanning: false, status: event.message })
      if (event.stage === 'capture') {
        // A manual scan holding the capture is the loop's normal rhythm, not news.
        if (!/^busy:/.test(event.message))
          reportOutcome(scanActivity.scanFailed(event.message, 'capture', ocrModeNow()), {
            auto: true
          })
      } else if ((event.stage === 'recognize' || event.stage === 'publish') && autoRound) {
        autoRound.outcome = scanActivity.scanFailed(
          event.message,
          event.stage === 'recognize' ? 'recognise' : 'publish',
          ocrModeNow()
        )
      }
      return
    case 'skip':
      if (event.reason === 'hidden') {
        // The game is minimised (an exclusive-fullscreen one is, whenever Kimochi has focus):
        // say so once, and keep Auto OCR on to pick it up when it comes back.
        if (!autoSourceHidden) {
          autoSourceHidden = true
          publish({ scanning: false, status: `Auto OCR is waiting for the window: ${event.detail}` })
          activity(scanActivity.autoScanSkipped(event.reason))
        }
        return log({ check: 'auto-scan-skip', reason: event.reason, detail: event.detail ?? null })
      }
      // Only the skips that end a recognition the ticker has already announced.
      if (autoRound && !autoRound.outcome) autoRound.outcome = scanActivity.autoScanSkipped(event.reason)
      return log({ check: 'auto-scan-skip', reason: event.reason, detail: event.detail ?? null })
    case 'request':
      return log({
        check: 'auto-scan-request',
        reason: event.reason,
        queued: event.queued,
        replaced: event.replaced
      })
    case 'result':
      return log({
        check: 'auto-scan-result',
        published: event.published,
        reason: event.reason,
        chars: event.chars
      })
    default:
      return undefined
  }
}

/** Counters, for the debug panel and for answering "is it still scanning?". */
export function autoScanStats() {
  return { state: scanner.state, reason: scanner.stateReason, ...scanner.stats() }
}

/** The watcher the running loop was started with: another one reads lines differently. */
let runningWatcher = null

function syncAutoScanner() {
  const settings = autoSettings()
  const watcher = JSON.stringify(autoWatcher())
  const wantedScanner = settings?.observerMode === 'image' ? imageScanner : sceneScanner
  if (scanner.isRunning && runningWatcher !== null && runningWatcher !== watcher) {
    log({ check: 'auto-scan-watcher-changed', from: runningWatcher, to: watcher })
    scanner.stop()
  }
  if (wantedScanner !== scanner) {
    if (scanner.isRunning) scanner.stop()
    scanner.resume()
    scanner = wantedScanner
    if (controllerHold || readingHold) scanner.pause()
  }
  scanner.updateSettings(settings)
  // Quick Shot has no source to watch, so there is nothing for the loop to scan. Nor while a
  // region is being edited: the old region is about to be replaced, and the loop's frame checks
  // run on this page, where they would stutter the drag. Nor until an edited region has been
  // saved and taken in: a round started against the old crop would only be discarded.
  const wanted =
    (hookMode() ? hookOcrOn() : state.flags.autoOcrEnabled) &&
    !isQuickShot() &&
    // The extension watches its page itself; there is no screen to watch.
    !browserMode() &&
    !state.regionSelecting &&
    !state.regionCommitting
  if (wanted && !scanner.isRunning) {
    scanner.reset()
    scanner.start()
    runningWatcher = watcher
  } else if (!wanted && scanner.isRunning) {
    scanner.stop()
  }
}

/**
 * Say once, at startup, whether automatic scanning can work here at all.
 *
 * Better than finding out one failed tick at a time, and much better than the
 * alternative it replaces: a platform with no local observer used to mean every
 * captured frame went to the remote recogniser.
 */
async function reportObserver() {
  const status = await native.observerStatus().catch(() => null)
  if (!status) return
  log({
    check: 'auto-scan-observer',
    // What will watch (`ui/watcher.ts`); `engine` is the native default until the first capture.
    watcher: autoWatcher(),
    engine: status.engine,
    supported: status.supported,
    privateApi: status.private_api ?? status.privateApi ?? false,
    minimumOs: status.minimum_os ?? status.minimumOs ?? '',
    detail: status.detail
  })
}

// ---------------------------------------------------------------------------
// 3. Actions
// ---------------------------------------------------------------------------

/**
 * Actions native dispatches to every window.
 *
 * `actions::dispatch` in Rust applies everything it owns before emitting: it
 * toggles and shows or hides the overlay window itself, and the source picker
 * owns crop editing and select-and-scan. Only the two actions whose work belongs
 * in this window are handled here — handling any other would apply it twice.
 */
async function onAction(name) {
  switch (name) {
    case 'triggerScan':
      if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && gnomeOverlay && controllerHold) {
        await window.__TAURI__.event.emit('gnome-controller-toggle')
        for (let attempt = 0; attempt < 20 && controllerHold; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 25))
        if (controllerHold) throw new Error('Close controller navigation before scanning')
      }
      if (isQuickShot()) return quickShot()
      // The page reads its picture again and sends it (`onBrowserScan`).
      if (browserMode()) return native.invoke('browser_rescan')
      // With Auto OCR on, the button and the shortcut are Force rescan: start over from nothing.
      if (scanner.isRunning) forceRescan()
      return performScan()
    case 'openControllerMenu':
      // Gaming Mode's hint is how to open this menu: whoever has opened it has learned it.
      if (
        window.__KIMOCHI_PLATFORM__?.os === 'linux' &&
        nativeGamescope &&
        native.getSetting(HINTS_DISMISSED) !== true
      ) {
        void native.setSetting(HINTS_DISMISSED, true)
        syncHints()
      }
      return openController()
    case 'playAudio':
      return playLatest()
    // The controller reads these back from the shared view, so this window owns
    // the flip. Native must pass these names through without touching the flag,
    // or the switch would toggle twice and appear dead.
    // Both edit the current source's region over the source itself; see editSourceRegion.
    case 'selectAndScan':
    case 'setCropArea':
      return editSourceRegion()
    // The second region: what goes on Anki cards. Same editors, green, and saving it scans nothing.
    case 'setAnkiCropArea':
      return editSourceRegion('anki')
    case 'toggleAutoOcr':
      return native.setViewFlags({ autoOcrEnabled: !state.flags.autoOcrEnabled })
    case 'toggleTextOverlay':
      return toggleOverlayText()
    case 'toggleDebugOverlay':
      return native.setViewFlags({ debugOverlayVisible: !state.flags.debugOverlayVisible })
    // Cosmetic, and deliberately silent about failure: a hover must never put an
    // error on screen.
    case 'hoverSelectRegionOn':
    case 'hoverSelectRegionOff':
      state.hover.selectRegion = name.endsWith('On')
      return drawHover()
    // The window was brought to the front: its markings dissipate instead of waiting for the
    // pointer to leave the card.
    case 'hoverSourceDismiss':
      hoverSourceTurn++
      state.hover.source = false
      hoverPreview.stop()
      hover.dissipate()
      return drawHover()
    case 'hoverSourceOn':
    case 'hoverSourceOff': {
      const hovering = name.endsWith('On')
      const turn = ++hoverSourceTurn
      state.hover.source = hovering
      state.hover.underPointer = false
      if (hovering) {
        // Where the pointer is decides whether there is anything to mark: see marksUnderPointer.
        const at = await native.pointerLocation().catch(() => null)
        if (turn !== hoverSourceTurn) return undefined
        state.hover.underPointer = marksUnderPointer(state.sourceBounds, at)
      }
      if (state.hover.source && hoverMarksWindow()) hoverPreview.start()
      else hoverPreview.stop()
      return drawHover()
    }
    default: {
      // A controller menu item's own shortcut (ui/radial-items.js): run it without the menu.
      const item = radialItemForHotkey(name)
      if (item) return openController(item.id)
      // Everything else native has already applied before emitting.
      return undefined
    }
  }
}

/** GNOME controller host requests it has taken (`gnome-controller-item-taken`). */
const gnomeItemsDone = new Set()
if (window.__KIMOCHI_PLATFORM__?.os === 'linux')
  void native.listen('gnome-controller-item-taken', ({ payload }) => {
    if (payload?.request) gnomeItemsDone.add(payload.request)
  })

/**
 * Open the controller menu (or close what the controller has open), or with `item` run that
 * menu item directly. Gamescope's overlay and GNOME's controller host need readying first.
 */
async function openController(item) {
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope && controller.mode === 'idle') {
    // A never-mapped Gamescope overlay has a zero-sized WebKit viewport.
    // Native bounds are logical pixels and available immediately after mapping.
    await native.panel('overlay', 'show')
    const panel = await native.panel('overlay', 'inspect')
    if (panel.bounds?.width > 0 && panel.bounds?.height > 0) {
      gamescopeMenuCenter = { x: panel.bounds.width / 2, y: panel.bounds.height / 2 }
    }
  }
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && gnomeOverlay) {
    if (controllerHold) return window.__TAURI__.event.emit('gnome-controller-toggle')
    await native.panel('controller-host', 'show_inactive')
    // The lazy WebKit host acknowledges opening through the shared hold flag; an item that opens
    // no mode of its own (Auto OCR) never holds, so the host acknowledges the request instead and
    // runs each request once, however often it is sent.
    const request = item ? crypto.randomUUID() : undefined
    for (let attempt = 0; attempt < 20 && !controllerHold && !gnomeItemsDone.has(request); attempt++) {
      await window.__TAURI__.event.emit('gnome-controller-open', item ? { item, request } : undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    gnomeItemsDone.delete(request)
    return
  }
  return item ? controller.runItem(item) : controller.toggle()
}

/** When a controller was last reported connected (the native `gamepad` state), for the editor. */
let gamepadSeenAt = 0
void native.listen('gamepad', ({ payload }) => {
  if (payload?.activeGamepadIndex != null) gamepadSeenAt = Date.now()
  // Hints name the buttons the way the pad in hand prints them (✕ ○ on a PlayStation pad).
  setPadLayout(activePadLayout(payload))
})
/** A controller is connected now: the region editor offers its controls. */
const gamepadConnected = () => Date.now() - gamepadSeenAt < 10000

/** How often the pointer is read while the region editor is up. */
const POINTER_POLL_MS = 30

/**
 * Feed the editor the pointer's position for as long as it is on screen, and, when `onDisplay` is
 * given, carry the overlay to whichever display the cursor moves to while the editor is idle (no
 * box, no drag) or still showing the box it opened with. A box the reader has drawn or touched
 * keeps the overlay where it is. `onDisplay` returns the box to open with on the new display.
 */
async function followPointer(selector, onDisplay) {
  const windows = window.__KIMOCHI_PLATFORM__?.os === 'windows'
  let tracedAt = -Infinity
  while (selector.active) {
    // Mid-drag the editor has the pointer itself. On Windows the webview's mouse moves can stop
    // while the hook holds the button (a pen in range or a touch takes its input), so the native
    // pointer is offered too; the editor uses it only once its own pointer has gone quiet.
    if (selector.dragging) {
      if (windows && state.origin) {
        const at = await native.pointerLocation().catch(() => null)
        if (at && selector.dragging) {
          const local = { x: at.x - state.origin.x, y: at.y - state.origin.y }
          const used = selector.dragAt?.(local) ?? false
          if (pointerTracing() && (used || performance.now() - tracedAt > 200)) {
            tracedAt = performance.now()
            pointerTrace('overlay', { type: 'native-pointer', local, used })
          }
        }
      }
      await new Promise((done) => setTimeout(done, POINTER_POLL_MS))
      continue
    }
    let at = null
    try {
      at = await native.pointerLocation()
    } catch {
      at = null
    }
    if (!selector.active) return
    const display = at?.display
    const movable = selector.idle || selector.pristine
    if (onDisplay && display?.bounds && movable && !sameRect(display.bounds, state.origin)) {
      try {
        await native.placeOverlay(display.bounds)
        state.origin = display.bounds
        draw()
        log({ check: 'region-display-moved', display: display.id })
        if (!selector.active) return
        // The box on the display left behind means nothing here; start with this one's own.
        selector.reset(onDisplay(display) ?? null)
      } catch (error) {
        log({ check: 'region-display-move-failed', error: String(error?.message ?? error) })
      }
      if (!selector.active) return
      selector.pointerAt({ x: at.x - state.origin.x, y: at.y - state.origin.y }, { snap: true })
    } else if (at && state.origin) {
      const local = { x: at.x - state.origin.x, y: at.y - state.origin.y }
      const inside = local.x >= 0 && local.y >= 0 && local.x < state.origin.width && local.y < state.origin.height
      selector.pointerAt(inside ? local : null)
    }
    await new Promise((done) => setTimeout(done, POINTER_POLL_MS))
  }
}

/**
 * Run the region editor over the display the overlay covers and return what was confirmed.
 *
 * The editor itself is `ui/region-select.js`, shared by "Select region" and Quick Shot; it
 * reports a rectangle in this window's CSS points. What has to be right lives here: the overlay is
 * click-through by default, so it claims the whole display for the duration (`regionSelecting`
 * feeds `hitRects`). It never takes the keyboard — it cannot, and activating the app to get it
 * would bring every Kimochi window in front of the game — so Escape and Return arrive as global
 * shortcuts held for the editor's lifetime and are replayed to it as key presses.
 *
 * For the same reason it sees no hover events, so the pointer is polled natively to keep the
 * editor's cursor bubble beside the cursor. With `onDisplay` (Quick Shot), the overlay also follows
 * the cursor onto another display while nothing is drawn yet, and `onDisplay` is told where it went.
 *
 * `follow`, given, runs instead of that poll for as long as the editor is open (the Linux layer
 * overlay's own, `followLayerOutputs`).
 *
 * `area`, `initial`, `picture` and `alternateLabel` pass through to the editor (see
 * ui/region-select.js); `onStart` gets the running editor, for a caller that keeps its picture
 * fresh. The rectangle comes back with the editor's `action`: `alternate` when the
 * `alternateLabel` button committed it, else `primary`.
 *
 * @param {string} confirmLabel
 * @param {{onDisplay?: (display: object) => object|null|void, area?: object, initial?: object,
 *   picture?: object, alternateLabel?: string, onStart?: (selector: object) => void}} [options]
 * @returns {Promise<{x:number,y:number,width:number,height:number,action:string}|null>}
 */
async function editRegion(
  confirmLabel,
  { onDisplay, follow, area, initial, picture, alternateLabel, onStart, accent, title } = {}
) {
  let RegionSelect
  try {
    ;({ RegionSelect } = await import('./region-select.js'))
  } catch (error) {
    log({
      check: 'region-editor-unavailable',
      error: String(error?.message ?? error),
      note: 'ui/region-select.js is missing from the build; the region drag cannot be shown.'
    })
    return null
  }

  state.regionSelecting = true
  syncAutoScanner()
  const stopKeys = await native.listen('region-key', ({ payload }) => {
    if (payload?.key)
      document.dispatchEvent(
        new KeyboardEvent(payload.type === 'keyup' ? 'keyup' : 'keydown', {
          key: payload.key,
          bubbles: true
        })
      )
  })
  try {
    await native.regionKeys(true)
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandLayer) await publishRegions()
    const appearance = setting('appearance')
    const theme =
      appearance === 'light' || appearance === 'dark'
        ? appearance
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
    // Under Gamescope there is no mouse: the editor takes a finger and the controller, sized for
    // both. Elsewhere it offers the controller while one is connected.
    const gamescope = window.__KIMOCHI_PLATFORM__?.os === 'linux' && nativeGamescope
    const buttons = padButtons(setting('controllerButtons'))
    const usePad = gamescope || gamepadConnected()
    const selector = new RegionSelect({
      container: document.body,
      confirmLabel,
      alternateLabel,
      theme,
      area,
      initial,
      picture,
      accent,
      title,
      touch: gamescope || matchMedia('(pointer: coarse)').matches,
      pad: usePad ? { confirm: buttonName(buttons.confirm) ?? 'A', cancel: buttonName(buttons.back) ?? 'B' } : null,
      onTrace: (record) => pointerTrace('region-editor', record)
    })
    const running = selector.start()
    onStart?.(selector)
    // `follow` replaces the pointer poll for an editor that moves itself (a Wayland screen).
    void (follow ? follow(selector) : followPointer(selector, onDisplay))
    const stopPad = usePad
      ? await startRegionPad(selector, { native, gamescope, buttons, log }).catch((error) => {
          log({ check: 'region-pad-failed', error: String(error?.message ?? error) })
          return null
        })
      : null
    const result = await running.catch(() => null)
    await stopPad?.()
    selector.destroy()
    const rect = result?.local
    return rect && rect.width >= 1 && rect.height >= 1 ? { ...rect, action: result.action ?? 'primary' } : null
  } finally {
    // Whatever happened, the overlay must stop swallowing clicks, and the game gets its
    // Escape and Return back.
    state.regionSelecting = false
    syncAutoScanner()
    stopKeys()
    await native.regionKeys(false)
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandLayer) await publishRegions()
  }
}

/** Points in the overlay to capture pixels of a display or source with `bounds` at `scale`. */
function cropFor(rect, origin, bounds, scale) {
  return {
    x: Math.max(0, Math.round((rect.x + origin.x - bounds.x) * scale)),
    y: Math.max(0, Math.round((rect.y + origin.y - bounds.y) * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
    reference_width: Math.round(bounds.width * scale),
    reference_height: Math.round(bounds.height * scale)
  }
}

/** How often the window's picture is refreshed while its region is being edited. */
const REGION_PICTURE_MS = 1500

/**
 * A display's source id, as native minted it. The constructed form is only for a
 * backend that predates `source_id` on `DisplayInfo`, which was always macOS.
 */
const displaySourceId = (display) => display?.source_id ?? `macos:display:${display.id}`
const scaleOf = (display) => display?.scale_factor ?? display?.scaleFactor ?? 1

/** A saved crop (capture pixels of `bounds`) as a rectangle in overlay points over `origin`. */
function cropToLocal(crop, origin, bounds) {
  if (!crop?.reference_width || !crop?.reference_height) return null
  const sx = bounds.width / crop.reference_width
  const sy = bounds.height / crop.reference_height
  return {
    x: Math.round(bounds.x - origin.x + crop.x * sx),
    y: Math.round(bounds.y - origin.y + crop.y * sy),
    width: Math.round(crop.width * sx),
    height: Math.round(crop.height * sy)
  }
}

/** The display holding most of `bounds` (its centre), from `native.displays()`. */
function displayHolding(bounds, displays) {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  return (
    displays.find(
      (d) =>
        cx >= d.bounds.x && cy >= d.bounds.y && cx < d.bounds.x + d.bounds.width && cy < d.bounds.y + d.bounds.height
    ) ?? displays[0]
  )
}

async function placeOverlayOn(bounds) {
  if (sameRect(state.origin, bounds)) return
  await native.placeOverlay(bounds)
  state.origin = bounds
  // Text from an earlier scan was positioned for the display the overlay left.
  draw()
}

/**
 * Edit the current source's region over the source itself — the one region editor, shared with
 * Quick Shot — then save it. Save and Scan (the default) also scans it, unless Auto OCR is already
 * reading; Save only clears the old text.
 *
 * `target` picks which of the source's two regions: `ocr`, the area read (blue), or `anki`, the
 * area that goes on Anki cards as the screenshot (green). Both use the same editor for the
 * platform; saving the Anki one changes nothing else — not the selection, not the OCR crop, not
 * the text on screen — and scans nothing.
 *
 * A screen is edited in place and is not a fixed choice: the editor follows the cursor to any
 * display, and the display the region is drawn on becomes the source. A window is shown as its
 * latest screenshot, kept fresh, over a dimmed screen — the real window may be covered — and the
 * region is limited to it.
 */
async function editSourceRegion(target = 'ocr') {
  if (state.regionSelecting) return
  const region = REGIONS[target] ?? REGIONS.ocr
  const sourceId = await native.selectedSource()
  if (!sourceId) {
    log({ check: 'region-edit-skipped', reason: 'no source selected', region: region.name })
    return
  }
  // Only the OCR crop changes what is read: the Anki one has nothing to hold back.
  if (region === REGIONS.ocr) state.regionCommitting = true
  try {
    // The view's own description of the selection says what it is; the id is read
    // (never pattern-matched on a platform name) only when the view has not caught up.
    const described = state.viewSource?.sourceId === sourceId ? state.viewSource : null
    const kind = described?.kind ?? described?.type ?? parseSourceId(sourceId)?.kind
    await bringSourceForward(sourceId, kind)
    const desktopCrop =
      window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandDisabled && (await gnomeCropAvailable(sourceId))
    const saved = desktopCrop
      ? await editGnomeRegion(sourceId, { region })
      : window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandDisabled
        ? await editLinuxSourceImage(sourceId, region)
        : window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandLayer
          ? await editPortalRegion(sourceId, kind, { region })
          : kind === 'window'
            ? await editWindowRegion(sourceId, region)
            : await editScreenRegion(sourceId, region)
    if (!saved) {
      log({ check: 'region-edit-cancelled', region: region.name })
      return
    }
    // Saved, and nothing read changed: the shared view brings `ankiCrop` back to every window.
    if (region !== REGIONS.ocr) return
    // Committing changes the selection, so anything in flight belongs to the old one.
    generation.bump()
    // Consume the committed crop before anything scans. The native state event otherwise
    // arrives during the next OCR, bumps the generation again and discards that very result
    // ("Scan discarded: the source changed while it was running", after every crop edit).
    await processView(await native.snapshot())
    for (let attempt = 0; handling || pendingView; attempt++) {
      if (attempt >= 100) throw new Error('Committed crop did not synchronize with the reader.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // Text read from the old region no longer matches what is on screen, even when the
    // region came back unchanged.
    clearSelectionText()
    // Auto OCR reads the new region by itself once this lets go of it (`finally`). Otherwise Save and
    // Scan (the editor's default, and every editor without the choice) scans; Save leaves the
    // next scan to the user.
    if (!state.flags.autoOcrEnabled && saved !== 'save') await performScan()
  } catch (error) {
    log({ check: 'region-edit-error', error: String(error?.message ?? error) })
    publish({ status: `Editing the region failed: ${error?.message ?? error}` })
  } finally {
    // Auto OCR starts afresh here, on the new region.
    state.regionCommitting = false
    syncAutoScanner()
  }
}

/**
 * The region editor is drawn over the game, so on a Linux desktop the game comes to the front
 * first: opened from Kimochi's own window, which stays in front of the game otherwise, the editor
 * framed Kimochi instead of the game. Where the window can be brought forward at all
 * (`sources.activateWindow`: X11, KWin's bridge, GNOME's Shell integration); Gaming Mode has its own
 * editor. A failure leaves the editor where it was before.
 */
async function bringSourceForward(sourceId, kind) {
  if (kind !== 'window' || window.__KIMOCHI_PLATFORM__?.os !== 'linux' || nativeGamescope) return
  const caps = await native.capabilities().catch(() => null)
  if (!caps?.sources?.activateWindow) return
  try {
    await native.activateSource(sourceId)
    // The compositor restacks and the source's bounds follow a moment later (a minimized window
    // comes back where it was).
    await new Promise((resolve) => setTimeout(resolve, 150))
    log({ check: 'region-edit-activated', sourceId })
  } catch (error) {
    log({ check: 'region-edit-activate-failed', error: String(error?.message ?? error) })
  }
}

/** A portal screen maps to the sole GNOME monitor; never infer a window origin. */
async function gnomeCropAvailable(sourceId = null) {
  if (!waylandDisabled || window.__KIMOCHI_PLATFORM__?.os !== 'linux') return false
  let status = await native.invoke('gnome_overlay', { operation: 'status', payload: null })
  if (
    isNativeWaylandSourceId(sourceId) &&
    sourceId.includes(':window:') &&
    status.available &&
    status.nativeWindows &&
    status.tracked?.sourceId !== sourceId
  ) {
    // A native window is bound by its Mutter id: nothing to match.
    await native
      .invoke('gnome_overlay', { operation: 'track', payload: { operation: 'bind', sourceId } })
      .catch(() => null)
    status = await native.invoke('gnome_overlay', { operation: 'status', payload: null })
  } else if (
    sourceId?.startsWith('portal:window:') &&
    status.available &&
    status.windowTracking &&
    status.tracked?.sourceId !== sourceId
  ) {
    const frame = await native.sourceHoverPreview(sourceId)
    if (frame?.width && frame?.height) {
      await native.invoke('gnome_overlay', {
        operation: 'track',
        payload: {
          operation: 'match',
          sourceId,
          width: frame.width,
          height: frame.height,
          name: state.viewSource?.name
        }
      })
      status = await native.invoke('gnome_overlay', { operation: 'status', payload: null })
    }
  }
  return (
    status.available &&
    status.cropEditor &&
    status.monitors?.length === 1 &&
    (!isWaylandWindowSourceId(sourceId) || status.tracked?.sourceId === sourceId)
  )
}

async function editGnomeRegion(sourceId, { quick = false, region = REGIONS.ocr, onStart } = {}) {
  if (!isWaylandWindowSourceId(sourceId) && !isWaylandScreenSourceId(sourceId))
    throw new Error('Desktop crop requires a shared screen or linked window.')
  state.regionSelecting = true
  syncAutoScanner()
  let restoreLog = false
  let selected = false
  try {
    if (quick) {
      restoreLog = Boolean((await native.panel('log', 'inspect')).visible)
      if (restoreLog) await native.panel('log', 'hide')
    }
    await gnomeOverlay?.pause()
    const frame = await native.sourceHoverPreview(sourceId)
    if (!frame?.width || !frame?.height) throw new Error('No shared screen frame available. Choose a screen first.')
    const { selectGnomeCrop } = await import('./gnome-crop.js')
    const crop = await selectGnomeCrop(native, {
      sourceId,
      frame,
      initial: regionInitialCrop(region, frame),
      quick,
      onStart,
      theme:
        setting('appearance') === 'light'
          ? 'light'
          : setting('appearance') === 'dark'
            ? 'dark'
            : matchMedia('(prefers-color-scheme: light)').matches
              ? 'light'
              : 'dark',
      ...(quick ? {} : { accent: region.accent, title: region.title })
    })
    if (!crop) return false
    if ((await native.selectedSource()) !== sourceId)
      throw new Error('The shared screen changed while editing. Open the editor again.')
    if (quick) {
      selected = true
      return crop
    }
    await region.commit(sourceId, crop)
    log({ check: 'region-saved', region: region.name, sourceId, crop, editor: 'gnome-shell' })
    return true
  } finally {
    state.regionSelecting = false
    syncAutoScanner()
    void gnomeOverlay?.update()
    if (restoreLog && !selected) await native.panel('log', 'show').catch(() => {})
  }
}

/** A source-image editor in the main window when a native desktop layer is unavailable. */
async function editLinuxSourceImage(sourceId, region = REGIONS.ocr) {
  state.regionSelecting = true
  syncAutoScanner()
  const requestId = crypto.randomUUID()
  let stop = () => {}
  let timer
  try {
    // Shell targets sit above application windows; release them before editor input.
    await gnomeOverlay?.pause().catch(() => {})
    const frame = await native.invoke('source_preview', { sourceId })
    let finish
    const result = new Promise((resolve, reject) => {
      finish = resolve
      timer = setTimeout(() => reject(new Error('Crop editor timed out. Open it again to continue.')), 600000)
    })
    stop = await native.listen('linux:source-crop-result', ({ payload }) => {
      if (payload?.requestId === requestId) finish(Boolean(payload.saved))
    })
    // Register the reply listener before the main window can submit the editor.
    await native.panel('log', 'show')
    // `kind` says which region: the dialog saves an `anki` one with commit_anki_crop.
    await window.__TAURI__.event.emit('linux:edit-source-crop', {
      requestId,
      sourceId,
      frame,
      crop: regionInitialCrop(region, frame),
      kind: region.name
    })
    const saved = await result
    if (saved) log({ check: 'region-saved', region: region.name, sourceId, editor: 'linux-source-image' })
    return saved
  } finally {
    clearTimeout(timer)
    stop()
    try {
      await window.__TAURI__.event.emit('linux:close-source-crop', { requestId })
    } finally {
      state.regionSelecting = false
      syncAutoScanner()
      void gnomeOverlay?.update()
    }
  }
}

/** Portal captures have pixel dimensions, but no desktop display catalogue or window origin. */
async function editPortalRegion(sourceId, kind, { quick = false, region = REGIONS.ocr, onStart } = {}) {
  let pictureUrl = null
  const frame = await native.sourceHoverPreview(sourceId)
  if (!frame?.width || !frame?.height) {
    throw new Error('No portal frame available. Choose a source in the system picker first.')
  }
  let screenPicture = false
  if (kind !== 'window') {
    // A screen is edited where it is, on whichever of its outputs the pointer is over.
    const layout = await native.invoke('layer_outputs', { operation: 'list' }).catch(() => null)
    const outputs = layout?.outputs ?? []
    const screen = frame.sourceBounds
    if (screen && screenOutputs(screen, outputs).length) {
      return editLayerScreen(sourceId, frame, screen, layout, { quick, region, onStart })
    }
    // With the outputs known, a screen on none of them (a virtual screen) is shown as its picture.
    // Without them (Gamescope's one output in Gaming Mode), the screen is the overlay's own.
    screenPicture = outputs.length > 0
    if (screenPicture)
      log({ check: 'region-edit-screen-picture', sourceId, bounds: screen ?? null, outputs: outputs.length })
  }
  // A hidden layer has not received its output-sized configure yet (initially 1×1).
  // Map it for the editor before reading its viewport, and unwind even if setup fails.
  state.regionSelecting = true
  state.origin = { x: 0, y: 0, width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) }
  try {
    await native.regionKeys(true)
    await publishRegions()
    for (let attempt = 0; innerWidth <= 1 || innerHeight <= 1; attempt++) {
      if (attempt >= 100) throw new Error('Wayland crop surface did not receive its screen size.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const origin = { x: 0, y: 0, width: innerWidth, height: innerHeight }
    state.origin = origin
    // A compositor-linked window can be edited over the game itself. Anonymous
    // streams retain their screenshot editor rather than inventing an origin.
    const linked = kind === 'window' && frame.desktopVisible ? frame.desktopBounds : null
    // Anything not over its own place on screen is shown as its latest picture, fitted.
    const pictured = !linked && (kind === 'window' || screenPicture)
    const fit = pictured ? Math.min(origin.width / frame.width, origin.height / frame.height) : null
    const bounds =
      linked ??
      (fit === null
        ? origin
        : {
            x: (origin.width - frame.width * fit) / 2,
            y: (origin.height - frame.height * fit) / 2,
            width: frame.width * fit,
            height: frame.height * fit
          })
    const area = linked ? portalCropArea(bounds, origin) : bounds
    if (!area) throw new Error('The shared window is outside this display. Bring it into view and try again.')
    if (pictured) {
      // WebKitGTK's image loader can reject capture:// from an HTTP dev page,
      // while the native fetch bridge can read it. Decode the same PNG as a blob.
      const response = await fetch(frame.url)
      if (!response.ok) throw new Error('Could not load the shared window preview.')
      pictureUrl = URL.createObjectURL(await response.blob())
    }
    const saved = quick ? null : region.saved()
    const rect = await editRegion(quick ? 'Scan' : region.confirmLabel, {
      alternateLabel: quick ? undefined : region.alternateLabel,
      accent: quick ? undefined : region.accent,
      title: quick ? undefined : region.title,
      area,
      initial: saved ? cropToLocal(saved, origin, bounds) : !quick && region.whole ? area : null,
      picture: pictured ? bounds : undefined,
      onStart: (selector) => {
        if (pictureUrl) void selector.setPicture(pictureUrl)
        onStart?.(selector)
      }
    })
    if (!rect) return false
    if ((await native.selectedSource()) !== sourceId)
      throw new Error('The shared source changed while editing. Open the editor again.')
    if (linked) {
      const current = await native.sourceHoverPreview(sourceId)
      if (
        !current?.desktopVisible ||
        !sameRect(current.desktopBounds, bounds) ||
        current.width !== frame.width ||
        current.height !== frame.height
      ) {
        throw new Error('The shared window moved or resized while editing. Open the editor again.')
      }
    }
    const sx = frame.width / bounds.width
    const sy = frame.height / bounds.height
    const crop = {
      x: Math.max(0, Math.round((rect.x - bounds.x) * sx)),
      y: Math.max(0, Math.round((rect.y - bounds.y) * sy)),
      width: Math.round(rect.width * sx),
      height: Math.round(rect.height * sy),
      reference_width: frame.width,
      reference_height: frame.height
    }
    if (crop.width <= 0 || crop.height <= 0) return false
    if (quick) return crop
    await region.commit(sourceId, crop)
    log({
      check: 'region-saved',
      region: region.name,
      kind,
      sourceId,
      crop,
      editor: 'wayland-layer',
      placement: linked ? 'linked-window' : pictured ? 'source-image' : 'screen',
      action: rect.action
    })
    return savedAction(rect)
  } finally {
    if (pictureUrl) URL.revokeObjectURL(pictureUrl)
    state.regionSelecting = false
    syncAutoScanner()
    await native.regionKeys(false)
    await publishRegions()
  }
}

/** How often the Linux layer editor asks where the pointer is, to follow it between outputs. */
const LAYER_FOLLOW_MS = 100

/**
 * Put the layer overlay on `output` (global logical geometry) and wait for its surface to take that
 * output's size: the editor's limits are in its points. Returns whether it moved.
 */
async function moveLayerOverlay(output) {
  const moved = Boolean(await native.invoke('layer_outputs', { operation: 'move', rect: output }))
  const fits = () =>
    innerWidth > 1 &&
    innerHeight > 1 &&
    (!moved || (Math.abs(innerWidth - output.width) < 2 && Math.abs(innerHeight - output.height) < 2))
  for (let attempt = 0; !fits(); attempt++) {
    if (attempt >= 75) {
      // A zoomed or scaled webview can differ from the output's logical size; edit anyway.
      log({ check: 'layer-output-size', output, viewport: { width: innerWidth, height: innerHeight } })
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  state.origin = { x: 0, y: 0, width: innerWidth, height: innerHeight }
  // Text from an earlier scan was placed for the output the overlay left.
  draw()
  return moved
}

/**
 * The layer editor's pointer poll (`editRegion`'s `follow`): it moves the overlay to whichever of
 * the screen's outputs the pointer goes to while nothing is drawn yet, and keeps the editor's
 * cursor bubble beside the pointer. `onOutput(output)` gives that output's `{area, initial}`.
 */
async function followLayerOutputs(selector, screen, start, onOutput) {
  let output = start
  while (selector.active) {
    if (!selector.dragging) {
      const layout = await native.invoke('layer_outputs', { operation: 'list' }).catch(() => null)
      if (!selector.active) return
      const pointer = layout?.pointer ?? null
      const next = pointer ? outputAt(screenOutputs(screen, layout.outputs), pointer) : null
      let snap = false
      if (next && !sameOutput(next, output) && (selector.idle || selector.pristine)) {
        try {
          await moveLayerOverlay(next)
          if (!selector.active) return
          output = next
          const { area, initial } = onOutput(next)
          selector.reset(initial, { area })
          snap = true
          log({ check: 'region-output-moved', output: next })
        } catch (error) {
          log({ check: 'region-output-move-failed', error: String(error?.message ?? error) })
        }
      }
      if (pointer && !selector.dragging) {
        const local = { x: pointer.x - output.x, y: pointer.y - output.y }
        const inside = local.x >= 0 && local.y >= 0 && local.x < output.width && local.y < output.height
        selector.pointerAt(inside ? local : null, { snap })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LAYER_FOLLOW_MS))
  }
}

/**
 * A shared screen on the Linux layer overlay, edited over the screen itself (see
 * ui/wayland-screen-crop.js): on the output under the pointer, or the one the saved region is on,
 * following the pointer to the screen's other outputs — a secondary monitor, or any part of a
 * whole-workspace share. Returns like `editPortalRegion`.
 */
async function editLayerScreen(sourceId, frame, screen, layout, { quick = false, region = REGIONS.ocr, onStart } = {}) {
  const saved = quick ? null : region.saved()
  let output = startOutput(screen, layout.outputs, { pointer: layout.pointer, saved, current: layout.current })
  const initialFor = (o) =>
    saved ? cropToOutput(saved, screen, o) : !quick && region.whole ? outputArea(screen, o) : null
  state.regionSelecting = true
  try {
    // Map the surface for the editor before moving and measuring it (a hidden one is 1x1).
    await native.regionKeys(true)
    await publishRegions()
    await moveLayerOverlay(output)
    const rect = await editRegion(quick ? 'Scan' : region.confirmLabel, {
      alternateLabel: quick ? undefined : region.alternateLabel,
      accent: quick ? undefined : region.accent,
      title: quick ? undefined : region.title,
      area: outputArea(screen, output),
      initial: initialFor(output),
      follow: (selector) =>
        followLayerOutputs(selector, screen, output, (next) => {
          output = next
          return { area: outputArea(screen, next), initial: initialFor(next) }
        }),
      onStart
    })
    if (!rect) return false
    if ((await native.selectedSource()) !== sourceId)
      throw new Error('The shared source changed while editing. Open the editor again.')
    const crop = cropFromOutput(rect, screen, output, frame)
    if (!crop) return false
    if (quick) return crop
    await region.commit(sourceId, crop)
    log({
      check: 'region-saved',
      region: region.name,
      kind: 'display',
      sourceId,
      crop,
      editor: 'wayland-layer',
      placement: 'screen',
      output,
      outputs: screenOutputs(screen, layout.outputs).length,
      action: rect.action
    })
    return savedAction(rect)
  } finally {
    state.regionSelecting = false
    syncAutoScanner()
    await native.regionKeys(false)
    await publishRegions()
  }
}

/** The region editor's default button, and what an editor returns for each of its two buttons. */
const SAVE_AND_SCAN = 'Save and Scan'
/** `scan` for Save and Scan (Return), `save` for Save. */
const savedAction = (rect) => (rect.action === 'alternate' ? 'save' : 'scan')

/**
 * A source's two regions and how an editor shows and saves each. The OCR crop is the area read
 * (blue; Save and Scan, or Save). The Anki crop is the area that goes on Anki cards as the
 * screenshot (green; Save only). With no Anki crop saved the cards get the whole source, so its
 * editor opens on the whole source (`whole`) rather than on an empty screen.
 */
const REGIONS = {
  ocr: {
    name: 'ocr',
    title: 'OCR crop area',
    accent: 'blue',
    confirmLabel: SAVE_AND_SCAN,
    alternateLabel: 'Save',
    whole: false,
    saved: () => state.crop,
    commit: (sourceId, crop) => native.commitSource(sourceId, crop)
  },
  anki: {
    name: 'anki',
    title: 'Anki crop area',
    accent: 'green',
    confirmLabel: 'Save',
    alternateLabel: undefined,
    whole: true,
    saved: () => state.ankiCrop,
    commit: (sourceId, crop) => native.commitAnkiCrop(sourceId, crop)
  }
}

/** A region's saved crop for an editor that takes source pixels, or the whole `frame` (`whole`). */
function regionInitialCrop(region, frame) {
  const saved = region.saved()
  if (saved) return saved
  if (!region.whole || !frame?.width || !frame?.height) return null
  return {
    x: 0,
    y: 0,
    width: frame.width,
    height: frame.height,
    reference_width: frame.width,
    reference_height: frame.height
  }
}

async function editScreenRegion(sourceId, region = REGIONS.ocr) {
  const displays = await native.displays()
  const current = displays.find((d) => displaySourceId(d) === sourceId) ?? null
  // Only the OCR crop may move the source to another display; the Anki crop stays on the chosen one.
  const follows = region === REGIONS.ocr
  const start = follows ? ((await native.pointerDisplay()) ?? current ?? displays[0]) : current
  if (!start?.bounds) return false
  await placeOverlayOn(start.bounds)

  // The saved region shows on its own display only.
  const initialFor = (display) => {
    if (!display || displaySourceId(display) !== sourceId) return null
    const saved = region.saved()
    if (saved) return cropToLocal(saved, display.bounds, display.bounds)
    return region.whole ? { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height } : null
  }
  let target = start
  const rect = await editRegion(region.confirmLabel, {
    alternateLabel: region.alternateLabel,
    accent: region.accent,
    title: region.title,
    initial: initialFor(start),
    onDisplay: follows
      ? (next) => {
          target = next
          return initialFor(next)
        }
      : undefined
  })
  if (!rect) return false
  const crop = cropFor(rect, target.bounds, target.bounds, scaleOf(target))
  if (crop.width <= 0 || crop.height <= 0) return false
  const chosen = displaySourceId(target)
  await region.commit(chosen, crop)
  log({
    check: 'region-saved',
    region: region.name,
    kind: 'display',
    sourceId: chosen,
    switched: chosen !== sourceId,
    crop,
    action: rect.action
  })
  return savedAction(rect)
}

async function editWindowRegion(sourceId, region = REGIONS.ocr) {
  const bounds = state.sourceBounds ?? state.info?.source_bounds ?? null
  if (!bounds) {
    log({ check: 'region-edit-skipped', reason: 'window bounds unknown' })
    publish({ status: 'Could not find the window to edit its region. Try again in a moment.' })
    return false
  }
  const display = displayHolding(bounds, await native.displays())
  if (!display?.bounds) return false
  const origin = display.bounds
  await placeOverlayOn(origin)

  const picture = {
    x: bounds.x - origin.x,
    y: bounds.y - origin.y,
    width: bounds.width,
    height: bounds.height
  }
  // The part of the window on this display.
  const left = Math.max(0, picture.x)
  const top = Math.max(0, picture.y)
  const area = {
    x: left,
    y: top,
    width: Math.min(origin.width, picture.x + picture.width) - left,
    height: Math.min(origin.height, picture.y + picture.height) - top
  }
  if (area.width <= 0 || area.height <= 0) return false

  // The capture's own size, once known, is the crop's reference; until then, points × scale.
  let frame = null
  const refresh = async (selector) => {
    while (selector.active) {
      // A new picture is a full-size capture and decode: never while the box is being dragged.
      if (selector.dragging) {
        await new Promise((done) => setTimeout(done, 200))
        continue
      }
      try {
        const preview = await native.sourceHoverPreview(sourceId)
        if (!selector.active) return
        if (preview?.url && !selector.dragging) {
          frame = preview
          void selector.setPicture(preview.url)
        }
      } catch {
        // Busy behind a scan, or the window is briefly unavailable: keep the last picture.
      }
      await new Promise((done) => setTimeout(done, REGION_PICTURE_MS))
    }
  }

  const saved = region.saved()
  const rect = await editRegion(region.confirmLabel, {
    alternateLabel: region.alternateLabel,
    accent: region.accent,
    title: region.title,
    area,
    picture,
    initial: saved ? cropToLocal(saved, origin, bounds) : region.whole ? area : null,
    onStart: (selector) => void refresh(selector)
  })
  if (!rect) return false
  const scale = frame?.width ? frame.width / bounds.width : scaleOf(display)
  const crop = cropFor(rect, origin, bounds, scale)
  if (frame?.width && frame?.height) {
    crop.reference_width = frame.width
    crop.reference_height = frame.height
  }
  if (crop.width <= 0 || crop.height <= 0) return false
  await region.commit(sourceId, crop)
  log({ check: 'region-saved', region: region.name, kind: 'window', sourceId, crop, action: rect.action })
  return savedAction(rect)
}

/**
 * The Quick Shot being taken, from its shortcut press until its editor closes; null otherwise.
 * Its trigger pressed again goes to `press` (the editor's `shortcutPressed`) instead of starting
 * another, whatever the trigger: a key, a gamepad or mouse button all arrive as `triggerScan`.
 */
let quickShotRun = null
/** When the last Quick Shot editor closed. */
let quickShotClosedAt = -Infinity
/**
 * A trigger this soon after an editor closed opens nothing: one press delivered twice (a gamepad
 * button that is both the editor's Cancel and the Quick Shot binding) must not close the editor
 * and then open a new one.
 */
const QUICK_SHOT_REOPEN_MS = 300

/**
 * Quick Shot: draw a region on the display under the pointer, scan it, show the Log.
 *
 * Nothing is chosen or saved: the region is captured from that display directly as a one-off job,
 * so the reader's chosen source and its crop are untouched, and the text is published detached
 * from them (no source name on the history entry, so no session switch).
 *
 * Pressed again while its editor is up, it cancels with no box drawn and scans the box once there
 * is one (see `shortcutPressOutcome` in ui/region-select.js).
 */
async function quickShot() {
  if (quickShotRun) {
    const outcome = quickShotRun.press()
    log({ check: 'quick-shot-pressed-again', outcome })
    return
  }
  if (state.regionSelecting) return
  if (performance.now() - quickShotClosedAt < QUICK_SHOT_REOPEN_MS) return
  // Until the editor is up there is nothing to cancel or confirm.
  const run = { press: () => 'ignore' }
  quickShotRun = run
  const pressGoesTo = (editor) => {
    run.press = () => editor.shortcutPressed()
  }
  const closed = () => {
    if (quickShotRun !== run) return
    quickShotRun = null
    quickShotClosedAt = performance.now()
  }
  try {
    const quickCaps = window.__KIMOCHI_PLATFORM__?.os === 'linux' ? await native.capabilities() : null
    // Wayland has no global pointer or display list for an app: Quick Shot crops a screen source.
    if (quickCaps && (quickCaps.capture.pickerRequired || quickCaps.sources.nativeWindows)) {
      const { runWaylandQuickShot } = await import('./linux-quick-shot.js')
      await runWaylandQuickShot({
        available: waylandLayer || (await gnomeCropAvailable()),
        catalog: () => native.invoke('enumerate'),
        pick: () => native.invoke('capture_pick_source', { fresh: true }),
        edit: (id) =>
          (waylandLayer
            ? editPortalRegion(id, 'display', { quick: true, onStart: pressGoesTo })
            : editGnomeRegion(id, { quick: true, onStart: pressGoesTo })
          ).finally(closed),
        scan: async (sourceId, crop) => {
          await processView(await native.snapshot())
          for (let attempt = 0; handling || pendingView; attempt++) {
            if (attempt >= 100) throw new Error('Screen share did not synchronize with the reader.')
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          log({ check: 'quick-shot', display: sourceId, crop, editor: waylandLayer ? 'wayland-layer' : 'gnome-shell' })
          try {
            return await performScan({
              generation: generation.current,
              sourceId,
              source: { sourceId, kind: 'display', name: 'Quick Shot' },
              request: { source_id: sourceId, crop },
              detached: true
            })
          } finally {
            await native.panel('log', 'show').catch(() => undefined)
          }
        },
        status: (status) => publish({ scanning: false, status }),
        log
      })
      return
    }
    const display = await native.pointerDisplay()
    if (!display?.bounds) {
      log({ check: 'quick-shot-skipped', reason: 'no display under the pointer' })
      return
    }
    const bounds = display.bounds
    if (!sameRect(state.origin, bounds)) {
      await native.placeOverlay(bounds)
      state.origin = bounds
      // Text from an earlier scan was positioned for the display the overlay left.
      draw()
    }

    // The overlay follows the cursor across displays until a box is drawn; read on the one used.
    let target = display
    const rect = await editRegion('Scan', {
      onDisplay: (next) => {
        target = next
      },
      onStart: pressGoesTo
    }).finally(closed)
    if (!rect) {
      log({ check: 'quick-shot-cancelled' })
      return
    }
    const crop = cropFor(rect, target.bounds, target.bounds, target.scale_factor ?? 1)
    const sourceId = displaySourceId(target)
    log({ check: 'quick-shot', display: target.id, crop })

    // The Log comes forward first, so the result is seen arriving.
    void native.panel('log', 'show').catch(() => undefined)
    await performScan({
      generation: generation.current,
      sourceId,
      source: { sourceId, kind: 'display', name: 'Quick Shot' },
      request: { source_id: sourceId, crop },
      detached: true
    })
  } catch (error) {
    log({ check: 'quick-shot-error', error: String(error?.message ?? error) })
    publish({ scanning: false, status: `Quick Shot failed: ${error?.message ?? error}` })
    reportOutcome({ text: `Quick Shot failed: ${error?.message ?? error}`, tone: 'error' })
  } finally {
    closed()
  }
}

/**
 * One control for "is the OCR overlay on".
 *
 * Both gates have to move together or the control is decorative: the persisted
 * `liveOverlayEnabled` defaults to off, so flipping only the session flag would
 * leave a switch that reads as on while nothing is drawn, and would send the
 * user hunting for a second switch in Settings. Turning off touches only the
 * session flag, leaving the persisted preference the Settings panel shows.
 */
async function toggleOverlayText() {
  const next = nextOverlayToggle({
    liveOverlayEnabled: setting('liveOverlayEnabled'),
    textOverlayVisible: state.flags.textOverlayVisible
  })
  if (next.liveOverlayEnabled !== setting('liveOverlayEnabled')) {
    await native.setSetting('liveOverlayEnabled', next.liveOverlayEnabled)
  }
  await native.setViewFlags({ textOverlayVisible: next.textOverlayVisible })
  // The view flag round-trips through the shared state event, but the local draw
  // must not wait for it: the user pressed a switch and expects the text now.
  state.flags = { ...state.flags, textOverlayVisible: next.textOverlayVisible }
  draw()
}

/**
 * Turn the overlay's text on or off, through the same switch the main window shows. On needs
 * both gates, as the toggle does; off only lowers the session flag, so the persisted setting
 * keeps the reader's choice.
 */
async function setOverlayText(visible) {
  if (visible && !setting('liveOverlayEnabled')) await native.setSetting('liveOverlayEnabled', true)
  if (state.flags.textOverlayVisible !== visible) await native.setViewFlags({ textOverlayVisible: visible })
  state.flags = { ...state.flags, textOverlayVisible: visible }
  draw()
}

async function playLatest() {
  const latest = listHistory()[0]?.text ?? ''
  if (!latest) return
  // Read aloud has Japanese voices only, so it is off for other languages.
  if (!isJapanese(languageNow())) return
  // Text to speech runs on Kimochi cloud, which needs a signed-in Kimochi account.
  if (!(await native.capabilities()).cloudAccess) return
  try {
    await speak(latest, { audioSettings: setting('audioSettings') })
  } catch (error) {
    log({ check: 'tts-error', error: String(error?.message ?? error) })
  }
}

// ---------------------------------------------------------------------------
// 4. Yomitan host, brought up without blocking the pipeline
// ---------------------------------------------------------------------------

const relayTargets = new Set()
/** The fast lane to the other windows (ui/app-lane.js), for built-in Yomitan's requests. */
const appLane = openAppLane(window, 'overlay')
let forwardingBackendBroadcasts = false
function forwardBackendBroadcasts() {
  if (forwardingBackendBroadcasts) return
  forwardingBackendBroadcasts = true
  chrome.runtime.onMessage.addListener((message) => {
    for (const target of relayTargets) void native.relay(target, { kind: 'broadcast', message })
  })
}
let extensionApi = null
let dictionarySetup = null
let openInIframe = null

/** Relayed windows share this window's extension storage rather than forking it. */
function relayStorage({ area, action, keys, values }) {
  const store = chrome.storage[area === 'session' ? 'session' : 'local']
  switch (action) {
    case 'get':
      return store.get(keys ?? null)
    case 'set':
      return store.set(values)
    case 'remove':
      return store.remove(keys)
    case 'clear':
      return store.clear()
    case 'getBytesInUse':
      return store.getBytesInUse()
    default:
      throw Error(`Unsupported storage action: ${action}`)
  }
}

/**
 * Answer extension messages for windows that have no backend of their own.
 *
 * The log panel and the Yomitan settings window run the original frontend but
 * must not stand up a second backend: two owners of one IndexedDB dictionary
 * database is a corruption risk. Only JSON crosses, which suffices because
 * Yomitan's dictionary API is entirely `sendMessage`-based.
 */
/**
 * Settles when the dictionary backend is up (or has failed to start). Windows come up in an
 * order nobody controls, so a relayed request that arrives while the backend is still starting
 * waits for it here instead of being rejected, which used to surface in the Log as "Dictionary
 * backend is not ready" on launch.
 */
let settleBackend
let gnomeBackendReady = false
const backendSettled = new Promise((resolve) => (settleBackend = resolve))
/** Bounded like the startup itself: the backend signals readiness within 30s or fails. */
const BACKEND_WAIT_MS = 35000

async function whenBackendReady() {
  if (state.yomitan.ready || gnomeBackendReady) return
  if (!state.yomitan.error) {
    await Promise.race([backendSettled, new Promise((resolve) => setTimeout(resolve, BACKEND_WAIT_MS))])
  }
  if (!state.yomitan.ready && !gnomeBackendReady) throw Error(state.yomitan.error ?? 'Dictionary backend is not ready')
}

async function handleRelay(from, payload, overLane = false) {
  // Hachidori and 10ten: the extension host's hub listens to `ext-relay` itself and answers its
  // own relays. Answering here too would double-answer `hello` with a Yomitan backend's status.
  if (extensionHosted) return
  if (!payload || typeof payload !== 'object') return
  if (payload.kind === 'hello') {
    relayTargets.add(from)
    await native.relay(from, { kind: 'ready', backend: state.yomitan.ready })
    return
  }
  if (payload.kind === 'open') {
    void openDictionaryPage(payload.url)
    return
  }
  if (payload.kind !== 'request') return
  relayTargets.add(from)
  // Answered the way it came (ui/app-lane.js): a request from the lane goes back on it.
  const answer = (message) => (overLane && appLane.send(from, message) ? undefined : native.relay(from, message))
  try {
    await whenBackendReady()
    const result = dictionarySetup?.handles(payload.message?.action)
      ? await dictionarySetup.handle(payload.message.params)
      : payload.message?.action === '__storage'
        ? await relayStorage(payload.message.params)
        : await hub.message(
            { id: `relay:${from}`, win: window, events: { onMessage: { listeners: new Set() } } },
            [...hub.contexts.values()].filter((c) => c.background),
            payload.message
          )
    await answer({ kind: 'response', id: payload.id, result })
  } catch (error) {
    await answer({
      kind: 'response',
      id: payload.id,
      error: String(error?.message ?? error)
    })
  }
}

/**
 * Prefer a real native settings window, as Electron has, and fall back to the
 * in-overlay iframe when that window does not exist. Either way the single
 * backend in this realm serves it.
 *
 * A web page (a link in Yomitan's settings, info page or popup; host/page-actions.js) opens in
 * the system browser instead: the settings window is not a browser.
 */
async function openDictionaryPage(url) {
  let web = null
  try {
    const parsed = new URL(String(url), location.href)
    if (/^https?:$/.test(parsed.protocol) && parsed.origin !== location.origin) web = parsed.href
  } catch {
    // Not a URL: handled as a page below, which refuses it.
  }
  if (web) {
    await native.invoke('plugin:shell|open', { path: web }).catch((error) =>
      native.report({
        check: 'dictionary-link-failed',
        url: web.slice(0, 300),
        error: String(error?.message ?? error)
      })
    )
    return
  }
  try {
    await native.panel('dictionary', 'show')
    await native.relay('dictionary', { kind: 'navigate', url })
    return
  } catch {
    // No native window for the extension pages; present them here instead.
  }
  void native.setDictionaryOpen(true)
  openInIframe?.(url)
}

async function startYomitan() {
  void native.report({
    check: 'dictionary-readiness',
    engine: 'yomitan',
    phase: 'starting',
    settingsReady: false,
    message: 'Starting Yomitan…'
  })
  if (!hub) throw Error('Extension host shim did not install')

  await import('/spike/network-bundle.js')
  hub.manifest = await fetch('/manifest.json').then((r) => r.json())
  hub.local = await native.invoke('storage_load')
  if (!hub.local.options) {
    const { OptionsUtil } = await import('/js/data/options-util.js')
    const util = new OptionsUtil()
    await util.prepare()
    const options = util.getDefault()
    options.profiles[0].options.general.showGuide = false
    await util.save(options)
  }

  const api = async (action, params) => {
    const response = await chrome.runtime.sendMessage({ action, params })
    if (response?.error) throw Error(JSON.stringify(response.error))
    return response?.result
  }

  const ready = new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.action !== 'applicationBackendReady') return
      chrome.runtime.onMessage.removeListener(listener)
      resolve()
    }
    chrome.runtime.onMessage.addListener(listener)
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener)
      reject(
        Error(
          'Dictionary backend did not signal readiness within two minutes. Open dictionary settings or choose the engine again to retry.'
        )
      )
    }, 120000)
  })
  const backend = document.createElement('iframe')
  backend.id = 'backend'
  backend.src = '/spike/background.html'
  document.body.append(backend)
  await ready
  // Before the frontend exists, so no popup can be built without being seen.
  await capturePopups()
  // The overlay has no ground of its own: Yomitan's popups take Kimochi's appearance instead.
  await (await import('/spike/popup-bridge.js')).siteThemeFromAppearance()
  await installApiLookup({ onVisibilityChange: apiPopupVisible })
  await import('/js/app/content-script-wrapper.js')

  extensionApi = api
  dictionarySetup = createDictionarySetup({
    api,
    fetchArchive: (url) => hub.fetchRemote(url),
    countEntries: async (title) => {
      const { DictionaryWorker } = await import('/js/dictionary/dictionary-worker.js')
      const result = await new DictionaryWorker().getDictionaryCounts([title], false)
      return result.counts[0]?.terms ?? 0
    },
    importArchive: async (archive, progress) => {
      const { DictionaryWorker } = await import('/js/dictionary/dictionary-worker.js')
      return new DictionaryWorker().importDictionary(archive, { prefixWildcardsSupported: false }, progress)
    }
  })
  window.pocApi = api
  openInIframe = hub.open.bind(hub)
  hub.open = (url) => {
    void openDictionaryPage(url)
    return { id: 1, windowId: 1, url }
  }

  // Backend broadcasts (readiness, database updates) must reach relayed windows
  // too, or their frontends never finish starting up.
  forwardBackendBroadcasts()

  // Extension storage changes are broadcast the same way. Relayed windows read
  // and write through this one store, so without this a profile or option
  // changed in the settings window would be invisible to code watching for it
  // in the log window.
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const target of relayTargets) {
      void native.relay(target, { kind: 'storage-changed', changes, area })
    }
  })

  state.yomitan.ready = true
  settleBackend()
  let lastReadiness = ''
  const refreshReadiness = async () => {
    try {
      const dictionaries = await api('getDictionaryInfo')
      const options = await api('optionsGetFull')
      const profile = options.profiles[options.profileCurrent]
      const enabled = profile?.options?.dictionaries ?? []
      const phase = dictionaries.some((dictionary) =>
        enabled.some((entry) => entry.name === dictionary.title && entry.enabled)
      )
        ? 'ready'
        : 'setup-needed'
      if (phase === lastReadiness) return
      lastReadiness = phase
      void native.report({
        check: 'dictionary-readiness',
        engine: 'yomitan',
        phase,
        settingsReady: true,
        message:
          phase === 'ready'
            ? 'Yomitan is ready.'
            : `Open Yomitan settings to import and enable ${aDictionaryFor(languageOf(native.getSetting('language')).name)}.`
      })
    } catch {
      /* The backend startup error is reported separately. */
    }
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'applicationDatabaseUpdated' || message.action === 'applicationOptionsUpdated')
      void refreshReadiness()
  })
  await refreshReadiness()
  // Each account looks words up through its own Yomitan profile (ui/yomitan-profiles.ts).
  followYomitanProfiles({
    api,
    native,
    onOptionsUpdated: (callback) =>
      chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'applicationOptionsUpdated') callback()
      })
  })
  log({
    check: 'yomitan-ready',
    dictionaries: (await api('getDictionaryInfo')).map((d) => d.title)
  })
}

/**
 * The extension popup's rectangle in this document's CSS pixels, while it is shown. It lives in
 * the light DOM (a shadow host), so `hitRects` adds it like a frame; see `observePopup`.
 */
let extensionPopupRect = null

/**
 * Bring up Hachidori or 10ten through the generic extension host (host/ext, injected by native
 * before this script runs). `start({host: true})` makes this window the hub: it creates the
 * extension's background (and offscreen) frames and answers every relayed window. Scope null:
 * everything this window draws is scannable. Resolves when the engine is ready, throws otherwise,
 * so the caller's unavailable path is the same as Yomitan's.
 */
async function startExtensionEngine() {
  const host = extensionHost()
  if (!host) {
    log({
      check: 'ext-host-missing',
      engine: hostedEngine,
      note: 'Native did not inject dist/spike/ext-host.js into the overlay, or it refused to install.'
    })
    throw Error(`The ${hostedEngine} extension host did not load`)
  }
  const applyReadiness = (status) => {
    if (status.engine !== hostedEngine) return
    // 10ten looks words up while its full dictionary is still downloading (readiness.js
    // `lookups`); the setup screens still wait for the phase.
    state.yomitan.ready = typeof status.lookups === 'boolean' ? status.lookups : status.phase === 'ready'
    state.yomitan.error = status.phase === 'failed' ? status.message : null
    settleBackend()
  }
  await native.listen('dictionary-readiness', ({ payload }) => applyReadiness(payload))
  // Before start, so a popup opened by the very first lookup is already a region.
  host.observePopup(({ visible, rect }) => {
    extensionPopupRect = visible && rect ? rect : null
    void publishRegions()
  })
  const result = await host.start({ host: true, scope: null })
  if (!result?.ready) throw Error(result?.error ?? `${hostedEngine} did not start`)
  applyReadiness(await native.invoke('dictionary_runtime_status', { engine: hostedEngine }))
  log({ check: 'ext-engine-host-ready', engine: hostedEngine })
  // Hachidori looks words up in the language being learned, through its profile for it
  // (ui/hachidori-languages.ts), as Yomitan does through its profiles.
  if (hostedEngine === 'hachidori' && host.extension) followHachidoriLanguage({ port: host.extension, native })
}

/**
 * Import the authored three-entry fixture archive.
 *
 * Diagnostics only, never called during normal startup: a reader's dictionary
 * list belongs to them, and an app that silently installs a synthetic dictionary
 * on first run is doing something they did not ask for. `ui/checks.js` and manual
 * verification call this explicitly.
 */
async function importFixtureDictionary() {
  if (!extensionApi) throw Error('Dictionary backend is not ready')
  const title = 'Tauri Spike Fixture v2'
  const existing = await extensionApi('getDictionaryInfo')
  if (existing.some((d) => d.title === title)) return { alreadyInstalled: true, title }

  const { DictionaryWorker } = await import('/js/dictionary/dictionary-worker.js')
  const imported = await new DictionaryWorker().importDictionary(
    await fetch('/spike/fixture.zip').then((r) => r.arrayBuffer()),
    { prefixWildcardsSupported: false },
    null
  )
  if (imported.errors.length) throw Error(JSON.stringify(imported.errors))

  const options = await extensionApi('optionsGetFull')
  const profile = options.profiles[options.profileCurrent].options
  if (!profile.dictionaries.some((d) => d.name === title)) {
    profile.dictionaries.push({
      name: title,
      alias: '',
      partsOfSpeechFilter: true,
      useDeinflections: true,
      enabled: true,
      allowSecondarySearches: false,
      definitionsCollapsible: 'not-collapsible'
    })
    await extensionApi('setAllSettings', { value: options, source: 'kimochi-fixture' })
    await extensionApi('triggerDatabaseUpdated', { type: 'dictionary', cause: 'import' })
  }
  log({ check: 'fixture-dictionary-imported', summary: imported.result })
  return imported.result
}

/**
 * Close the dictionary popup. Yomitan closes its popup on a pointerdown outside the popup's own
 * frame; the extension engines are told by their host (only while one is showing, since their
 * dismissal sends commands and synthetic events).
 */
/**
 * The dictionary pop-up closes once the pointer has left the words and the pop-up
 * (ui/popup-leave.ts). On Windows without click-through: a hover there no longer takes the
 * keyboard, so the click or Escape that would otherwise close it would reach the game too. With
 * look up on hover, everywhere: there is no click away. Not while the controller reads.
 */
const popupLeave = new PopupLeave()
/**
 * Look up on hover: the pop-up goes once the pointer has been off the line, the gap and the
 * pop-up for a moment: long enough that a pointer slipping off the line on its way along it
 * doesn't close it, short enough to read as going when the pointer moves on.
 */
const hoverPopupLeave = new PopupLeave(250)
/** After dismissal, wait for movement or a return to text before allowing another hover lookup. */
let hoverPaused = false
function syncHoverPause(pointer) {
  if (!hoverPaused) return
  hoverPaused = feedHover && !renderer.hitRects(state.origin).some((r) => inRect(r, pointer.x, pointer.y))
}
/**
 * The Yomitan API's pop-ups, in desktop points (`popover:cards`): windows of their own, so neither
 * `livePopups` nor the extension's rectangle sees them.
 */
let apiPopupCards = []
void native.listen('popover:cards', ({ payload }) => {
  apiPopupCards = Array.isArray(payload) ? payload : []
  checkPopupLeave()
})
let popupLeavePointer = null
let popupLeaveTimer = null
function checkPopupLeave(pointer = popupLeavePointer) {
  popupLeavePointer = pointer
  if (controller.drivesLookups) return
  // Look up on hover, on every platform: a pop-up no longer takes the next click (`catching`), so
  // nothing else closes it. It goes once the pointer is off the word's line and off the pop-up.
  const hover = hoverLookup()
  // Otherwise, with click-through, a click away is free (`onFreeClick`), so the pop-up stays until then.
  if (!hover && (window.__KIMOCHI_PLATFORM__?.os !== 'windows' || clickThrough('words'))) return
  const open =
    Boolean(extensionPopupRect) ||
    (hover && apiPopupCards.length > 0) ||
    [...livePopups].some((popup) => popup.isVisibleSync?.())
  clearTimeout(popupLeaveTimer)
  const leave = hover ? hoverPopupLeave : popupLeave
  // Nothing to measure with no pop-up up: `update` only resets then.
  const rects = !open ? [] : hover ? hoverLeaveRects() : hitRects()
  if (leave.update(performance.now(), pointer, rects, open)) {
    log({ check: 'popup-left' })
    dismissPopup()
    if (hover) {
      window.getSelection()?.removeAllRanges()
      hoverPaused = true
    }
    return
  }
  const wait = leave.remaining(performance.now())
  if (wait !== null) popupLeaveTimer = setTimeout(() => checkPopupLeave(), wait + 20)
}

/** The CSS highlights the extension engines mark their match with (overlay-text.css). */
const MATCH_HIGHLIGHTS = ['tenten-selection', 'tenten-selection-blue', 'gsm-hoshidicts-match']

/**
 * Keep hover popups open over the match, its line, the popups and the gaps between them.
 * All rectangles are in screen points. Without a match, fall back to the full hit regions.
 */
function hoverLeaveRects() {
  const origin = state.origin
  if (!origin) return []
  const toScreen = (r) => ({ x: origin.x + r.left, y: origin.y + r.top, width: r.width, height: r.height })
  const rangeRects = (range) => [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map(toScreen)
  const ranges = []
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed)
    for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i))
  for (const name of MATCH_HIGHLIGHTS) ranges.push(...(globalThis.CSS?.highlights?.get(name) ?? []))
  const word = ranges.flatMap(rangeRects)
  const wordBox = boundingRect(word)
  if (!wordBox) return hitRects()
  // The text's direction and size, from the text itself: a single letter is taller than wide, and
  // a block of short lines too.
  const elements = ranges.map((range) => {
    const node = range.startContainer
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  })
  const style = getComputedStyle(elements[0])
  const vertical = style.writingMode.startsWith('vertical')
  const em = parseFloat(style.fontSize) || (vertical ? wordBox.width : wordBox.height)
  // The line as drawn, which may run past its box: Yomitan looks up on every glyph, so a kept area
  // ending at the box's edge closed and reopened the pop-up there.
  const drawn = []
  for (const host of new Set(elements.map((element) => element?.closest('[data-ocr-word-box], .hook-card-text')))) {
    if (!host) continue
    const all = document.createRange()
    all.selectNodeContents(host)
    drawn.push(...rangeRects(all))
  }
  const line = lineAround(wordBox, renderer.hitRects(origin), drawn, vertical, em)
  const popups = popupRects()
  if (extensionPopupRect)
    popups.push({ ...extensionPopupRect, x: origin.x + extensionPopupRect.x, y: origin.y + extensionPopupRect.y })
  popups.push(...apiPopupCards)
  const near = line ? boundingRect([wordBox, line]) : wordBox
  return [...word, ...(line ? [line] : []), ...popups, ...popups.map((popup) => gapBetween(near, popup))]
}

function dismissPopup() {
  dismissApiLookup()
  if (extensionHosted) {
    const host = extensionHost()
    if (host && (extensionPopupRect || host.isPopupVisible?.())) host.dismiss()
    return
  }
  window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true }))
}

// ---------------------------------------------------------------------------
// 4b. Where the dictionary popup actually is
// ---------------------------------------------------------------------------

/**
 * The popups the original factory has built in this window.
 *
 * They cannot be found from the DOM — see host/popup-bridge.js — and without
 * their rectangles the overlay is click-through over its own dictionary.
 */
let livePopups = new Set()

/** `replayIntoPopup` from host/popup-bridge.js, once Yomitan's popups are being observed. */
let replayPopupPointer = null
/** `trackPopupHover` from host/popup-bridge.js, and the popup frame the pointer is over. */
let trackPopupHover = null
let hoveredPopupFrame = null
/** `setPopupTarget` from host/popup-bridge.js: where Yomitan's top-level popup opens, or null. */
let setYomitanPopupTarget = null

/**
 * Open the engine's top-level pop-up over `rect` (overlay points) instead of beside the word, for
 * Read along's full-screen dictionary; null gives the engine its own placing back. Yomitan's
 * popup is a frame in this window placed at its next show; an extension engine's is a shadow host
 * in this window, restyled by its host (host/ext/content.js `place`). Both stay in this window,
 * so they are excluded from capture and published as regions as any pop-up is.
 */
function placeEnginePopup(rect) {
  if (extensionHosted) return void extensionHost()?.placePopup?.(rect)
  setYomitanPopupTarget?.(rect)
}

/** Whether the engine's pop-up is showing in this window now. */
function enginePopupShowing() {
  if (extensionHosted) return Boolean(extensionPopupRect || extensionHost()?.isPopupVisible?.())
  return Boolean(visibleYomitanPopup())
}

async function capturePopups() {
  const {
    observePopups,
    replayIntoPopup,
    setPopupTarget,
    trackPopupHover: track
  } = await import('/spike/popup-bridge.js')
  replayPopupPointer = replayIntoPopup
  trackPopupHover = track
  setYomitanPopupTarget = setPopupTarget
  let remote = null
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
    const { installGnomePopupTransport } = await import('./gnome-popup-transport.js')
    remote = await installGnomePopupTransport(window, hub, () => {
      // The backend is already running. Let the native popup host complete its
      // API handshake before this frontend asks for a remote PopupFactory.
      gnomeBackendReady = true
      forwardBackendBroadcasts()
      settleBackend()
    })
  }
  ;({ popups: livePopups } = await observePopups({
    remote,
    log,
    window: 'overlay',
    // A popup opens and closes between two ticks of the region loop; 100 ms of
    // missing rectangle is 100 ms in which its first click is thrown away and
    // counted as a dismissal.
    onChange: () => void publishRegions()
  }))
}

/**
 * Scroll the open dictionary popup, or jump between its definitions, for the controller's right
 * stick and shoulder buttons.
 *
 * Yomitan's popup is a same-origin frame in this window, so it is scrolled directly: its
 * definitions are the per-dictionary `.definition-item`s, or whole `.entry`s when no entry
 * holds more than one. The Yomitan API pop-up is its own window and is asked by event.
 *
 * `control.focus` moves the controller's focus over the popup's buttons (ui/popup-focus.js), for
 * Yomitan and Hachidori; the return value says whether it did anything. The Yomitan API pop-up
 * and 10ten have no buttons it can reach.
 */
function controlPopup(control) {
  if ((setting('yomitanSettings')?.popupType ?? 'builtin') === 'custom-api') {
    void globalThis.__TAURI__?.event?.emit('popover:control', control)
    return false
  }
  if (extensionHosted) {
    // The extension's popup is in a closed-off shadow root; its host knows how to drive it.
    return Boolean(extensionHost()?.popupControl(control))
  }
  if (control.focus) return yomitanFocus(control.focus)
  const popup = visibleYomitanPopup()
  let doc = null
  try {
    doc = popup?._frame?.contentDocument ?? null
  } catch {
    // A cross-origin frame: nothing to scroll from here. Reported below.
  }
  const scroller = doc?.getElementById('content-scroll')
  if (control.step || !scroller) {
    // Each jump, and any scroll that finds no popup, says how far it got: a jump that does
    // nothing visible is otherwise impossible to tell apart from one that never arrived.
    const report = {
      check: 'controller-popup-control',
      step: control.step ?? null,
      popups: livePopups?.size ?? 0,
      visible: Boolean(popup),
      frame: Boolean(popup?._frame),
      document: Boolean(doc),
      scroller: Boolean(scroller),
      scrollTop: scroller?.scrollTop ?? null,
      scrollHeight: scroller?.scrollHeight ?? null,
      clientHeight: scroller?.clientHeight ?? null
    }
    if (control.step || Date.now() - lastPopupReport > 2000) {
      lastPopupReport = Date.now()
      log(report)
    }
  }
  if (!scroller) return
  if (control.scroll) {
    if (jump) cancelAnimationFrame(jump.frame)
    jump = null
    scroller.scrollTop += control.scroll
  }
  if (control.step) void stepEntry(popup._frame, scroller, control.step)
  return false
}

/** The deepest visible Yomitan popup (a definition's own lookup opens a child popup). */
function visibleYomitanPopup() {
  return [...(livePopups ?? [])].filter((candidate) => candidate.isVisibleSync?.()).pop()
}

function yomitanDocument() {
  try {
    return visibleYomitanPopup()?._frame?.contentDocument ?? null
  } catch {
    return null
  }
}

const yomitanButtons = createPopupFocus({
  root: () => yomitanDocument()?.getElementById('content-body') ?? yomitanDocument(),
  spec: YOMITAN_FOCUS,
  scroller: () => yomitanDocument()?.getElementById('content-scroll') ?? null
})

function yomitanFocus(request) {
  if (request === 'enter') return yomitanButtons.enter()
  if (request === 'exit') return (yomitanButtons.exit(), true)
  if (request === 'refocus') return yomitanButtons.refocus()
  if (request === 'press') return yomitanButtons.press()
  if (request === 'audio') return yomitanButtons.playAudio()
  if (request === 'available') return yomitanButtons.available()
  return yomitanButtons.move(request)
}

/**
 * Move to the next or previous entry with Yomitan's own entry navigation — the `nextEntry` and
 * `previousEntry` hotkeys (Alt+↓ / Alt+↑ by default) — by sending the popup the keystroke the
 * reader's options bind to it. Yomitan then scrolls, marks the current entry and handles its
 * sticky header itself, exactly as it does from the keyboard. Only when no such hotkey is
 * bound does the overlay scroll the entries itself.
 */
async function stepEntry(frame, scroller, step) {
  const before = scroller.scrollTop
  const hotkey = await entryHotkey(step > 0 ? 'nextEntry' : 'previousEntry')
  const win = frame.contentWindow
  let handled = false
  if (hotkey && win) {
    const event = new win.KeyboardEvent('keydown', {
      key: hotkey.key.replace(/^Key/, '').toLowerCase(),
      code: hotkey.key,
      altKey: hotkey.modifiers.includes('alt'),
      ctrlKey: hotkey.modifiers.includes('ctrl'),
      shiftKey: hotkey.modifiers.includes('shift'),
      metaKey: hotkey.modifiers.includes('meta'),
      bubbles: true,
      cancelable: true
    })
    win.document.dispatchEvent(event)
    // Yomitan prevents the default of a keystroke it acted on.
    handled = event.defaultPrevented
  }
  if (!handled) {
    const doc = frame.contentDocument
    jumpDefinition(scroller, doc.getElementById('content-body') ?? scroller, [...doc.querySelectorAll('.entry')], step)
  }
  setTimeout(() => {
    log({
      check: 'controller-entry-step',
      step,
      hotkey: hotkey ? `${hotkey.modifiers.join('+')}+${hotkey.key}` : null,
      handled,
      before,
      after: scroller.scrollTop
    })
  }, 400)
}

/** The reader's popup hotkey for an entry action, from the current Yomitan profile. */
async function entryHotkey(action) {
  try {
    const options = await extensionApi?.('optionsGetFull')
    const profile = options?.profiles?.[options.profileCurrent]?.options
    const hotkey = profile?.inputs?.hotkeys?.find(
      (entry) =>
        entry.action === action &&
        entry.enabled !== false &&
        typeof entry.key === 'string' &&
        (entry.scopes ?? []).includes('popup')
    )
    return hotkey ? { key: hotkey.key, modifiers: hotkey.modifiers ?? [] } : null
  } catch {
    return null
  }
}
let lastPopupReport = 0

/** A definition jump in progress: where it is headed, so a quick second press continues from there. */
let jump = null
const JUMP_MS = 220

/**
 * Scroll `scroller` so the next (`step` 1) or previous (-1) of `targets` is at its top.
 *
 * Positions are measured against `body`, the scrolled content, the way Yomitan measures its own
 * entry navigation: the popup's content is scaled, so a rectangle and `scrollTop` are not in the
 * same units, and mixing them sent every jump the wrong way. The scroll is animated here rather
 * than with `scrollTo({behavior: 'smooth'})`, which the popup frame cut short after a few
 * points.
 */
function jumpDefinition(scroller, body, targets, step) {
  if (!targets.length) return
  const bodyTop = body.getBoundingClientRect().top
  const offsets = targets.map((target) => target.getBoundingClientRect().top - bodyTop)
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  // Where the popup is, or is about to be: a press during a jump counts from its destination.
  const from = jump?.scroller === scroller ? jump.to : scroller.scrollTop
  let current = 0
  offsets.forEach((offset, index) => {
    if (offset <= from + 8) current = index
  })
  // At the bottom, the last definitions cannot reach the top; step past whichever is showing.
  if (step > 0 && from >= max - 1) return
  const next = Math.max(0, Math.min(targets.length - 1, current + step))
  const to = Math.min(max, next === 0 ? 0 : Math.max(0, offsets[next] - 6))
  animateScroll(scroller, to)
  targets[next].animate?.([{ backgroundColor: 'rgba(125, 211, 252, 0.2)' }, { backgroundColor: 'transparent' }], {
    duration: 700,
    easing: 'ease-out'
  })
}

function animateScroll(scroller, to) {
  if (jump) cancelAnimationFrame(jump.frame)
  const start = performance.now()
  const from = scroller.scrollTop
  const current = { scroller, to, frame: 0 }
  jump = current
  const tick = (now) => {
    const t = Math.min(1, (now - start) / JUMP_MS)
    scroller.scrollTop = from + (to - from) * (1 - (1 - t) ** 3)
    if (t < 1 && jump === current) current.frame = requestAnimationFrame(tick)
    else if (jump === current) jump = null
  }
  current.frame = requestAnimationFrame(tick)
}

/** Desktop rectangles for the visible popup chain; see ui/regions.ts. */
const popupRects = () => popupHitRects(livePopups, state.origin)

// ---------------------------------------------------------------------------
// 5. Hit regions and the shared view
// ---------------------------------------------------------------------------

/**
 * The rectangles where this window takes the mouse, in desktop points.
 *
 * `focus` marks the ones that are worth taking the keyboard for, and scanned
 * words are not among them: the keyboard belongs to whatever the reader is
 * reading, and a lookup no longer needs it (see `feedScanner`). What is marked
 * is this window's own interface — the dictionary page and the extension frames
 * — which a reader has deliberately opened and has to be able to type into.
 *
 * `readWordRects`, when supplied, samples words in overlay-local coordinates for this tick.
 */
function hitRects(readWordRects = null) {
  if (waylandDisabled && (!gnomeOverlay?.shared || state.regionSelecting)) return []
  if (!state.origin) return []
  // Selecting a region needs every event on the display, not just the parts of
  // it that happen to have text under them.
  if (state.regionSelecting || hook.card?.dragging()) return [{ ...state.origin, focus: false }]
  const gated = clickThrough('words')
  const wordRects = readWordRects?.() ?? null
  const rects =
    wordRects === null
      ? renderer.hitRects(state.origin).map((rect) => ({ ...rect, shift: gated }))
      : wordRects.map((rect) => ({
          ...rect,
          x: state.origin.x + rect.x,
          y: state.origin.y + rect.y,
          shift: gated
        }))
  const add = (rect, focus, shift = false) => {
    if (rect.width > 0 && rect.height > 0) {
      rects.push({
        x: state.origin.x + rect.x,
        y: state.origin.y + rect.y,
        width: rect.width,
        height: rect.height,
        focus,
        shift
      })
    }
  }
  for (const frame of document.querySelectorAll('iframe')) {
    if (frame.id === 'backend') continue
    // The extension host's background and offscreen frames are never meant to be seen.
    if (frame.checkVisibility?.() === false) continue
    if (frame.id === 'extension-page' && !state.dictionaryOpen) continue
    add(frame.getBoundingClientRect(), true)
  }
  if (state.dictionaryOpen) add(pagesSection.getBoundingClientRect(), true)
  // The popup is not in the light DOM; see popupRects().
  rects.push(...popupRects())
  // An extension engine's popup: a shadow host in this document, reported by its host.
  if (extensionPopupRect) add(extensionPopupRect, true)
  for (const rect of controller.hitRects()) add(rect, false)
  // The Text Hooker's card and its menu: its text is looked up, its controls pressed. The card,
  // like the words, is Shift-only while any of it is over the game; moved clear of the game it
  // covers nothing there, so it takes the mouse like any window (`hookCardClear`, #187). Its menu,
  // once opened, takes the mouse until it closes.
  const [card, menu] = hook.card?.rects() ?? []
  if (card) add(card, false, clickThrough('card') && !hookCardClear())
  if (menu) add(menu, false)
  // The hint bar's ×: the one part of it that takes the mouse, Shift or not.
  for (const rect of hints.rects()) add(rect, false)
  // A pop-up is open: the whole overlay takes the next click, so clicking away closes the pop-up
  // without the click reaching the game (`onFreeClick`). On GNOME, Yomitan's pop-up is a window
  // of its own (ui/popup-host.js), which this one may be stacked above: everything but it. Not with
  // hover lookup: a pop-up opens whenever the pointer rests on text, which is where it rests between
  // clicks that advance the game, so the click goes to the game and closes the pop-up on the way
  // (native's dismiss).
  const remote = remoteReadingPopup && gnomeOverlay?.shared ? remoteReadingRects : null
  const shown = popupShown() || remote !== null
  if (!shown) freeClickTaken = false
  catching =
    gated &&
    !hoverLookup() &&
    shown &&
    !(freeClickTaken && gnomeOverlay?.shared) &&
    (controller?.mode ?? 'idle') === 'idle'
  if (catching) {
    const whole = { x: state.origin.x, y: state.origin.y, width: innerWidth, height: innerHeight }
    for (const rect of exceptRects(whole, remote ?? [])) rects.push({ ...rect, focus: false, shift: false })
  }
  return rects
}

/**
 * Whether the Text Hooker's card is clear of the game window (`clearOfGame`), so it takes the mouse
 * with no lookup key held (#187). Read afresh wherever it matters (the region loop republishes
 * every 100 ms, the pointer feed asks at each sample), so it follows the card being dragged and
 * the game window moving or resizing. False while either rectangle is unknown: click-through, as
 * before.
 */
function hookCardClear() {
  const [card] = hook.card?.rects() ?? []
  const origin = state.origin
  if (!card || !origin) return false
  const game = state.sourceBounds ?? state.info?.source_bounds ?? null
  return clearOfGame({ x: origin.x + card.left, y: origin.y + card.top, width: card.width, height: card.height }, game)
}

/** Whether a point (overlay coordinates) is on a dictionary pop-up in this window. */
function overPopupAt(local) {
  if (extensionPopupRect && inRect(extensionPopupRect, local.x, local.y)) return true
  const origin = state.origin
  return Boolean(origin) && popupRects().some((rect) => inRect(rect, local.x + origin.x, local.y + origin.y))
}

/** Whether a dictionary pop-up is showing in this window. */
function popupShown() {
  return Boolean(extensionPopupRect) || popupRects().length > 0
}

/**
 * What the open pop-up's lookup matched, as the engine marks it on the page: Hachidori's and
 * 10ten's highlight (the extension host's `matchedRange`), else the selection Yomitan makes of
 * the text it matched. `{startContainer, startOffset, endContainer, endOffset}`, or null.
 */
function matchedRange() {
  if (extensionHosted) return extensionHost()?.matchedRange?.() ?? null
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  return selection.getRangeAt(0)
}

/**
 * `rects` (a range's client rects) as one rectangle per line: those that share most of a row (a
 * column, in vertical text) are one line, as Read along's outline draws a word over line breaks.
 */
function lineRects(rects, vertical) {
  const lines = []
  for (const rect of rects) {
    if (!(rect.width > 0 && rect.height > 0)) continue
    const [from, to] = vertical ? [rect.left, rect.right] : [rect.top, rect.bottom]
    const line = lines.find((other) => {
      const [a, b] = vertical ? [other.left, other.right] : [other.top, other.bottom]
      return Math.min(to, b) - Math.max(from, a) > 0.5 * Math.min(to - from, b - a)
    })
    if (!line) {
      lines.push({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      })
      continue
    }
    line.left = Math.min(line.left, rect.left)
    line.top = Math.min(line.top, rect.top)
    line.right = Math.max(line.right, rect.right)
    line.bottom = Math.max(line.bottom, rect.bottom)
  }
  return lines
    .sort((a, b) => (vertical ? b.left - a.left : a.top - b.top))
    .map((line) => ({
      left: line.left,
      top: line.top,
      width: line.right - line.left,
      height: line.bottom - line.top
    }))
}

/**
 * Text drawn Transparent shows nothing of what a lookup matched (the engines' own marks are
 * hidden with it, overlay-text.css), so the match gets Read along's outline, fainter
 * (`overlayMatchOutline`, on unless turned off): on the overlay's words with Hover card
 * appearance Transparent, and on the Text Hooker's card with its Card look Transparent. Only while
 * the pop-up is open and the controller isn't reading (its own outline shows then).
 */
let matchOutlined = false
function syncMatchOutline() {
  let rects = null
  let vertical = false
  const look = overlayStyleOf(setting('overlayStyle'))
  const hidden = {
    words: look.appearance === 'transparent',
    card: look.hookAppearance === 'transparent'
  }
  if (
    (hidden.words || hidden.card) &&
    native.getSetting('overlayMatchOutline') !== false &&
    (controller?.mode ?? 'idle') === 'idle' &&
    // The Yomitan API's pop-up is a window of its own, not in this page (`apiPopupVisible`).
    (popupShown() || apiReadingPopup)
  ) {
    const match = matchedRange()
    const node = match?.startContainer
    const start = node?.nodeType === Node.ELEMENT_NODE ? node : (node?.parentElement ?? null)
    const surface = !start
      ? null
      : hook.card?.element?.contains(start)
        ? 'card'
        : wordsContainer.contains(start)
          ? 'words'
          : null
    if (surface && hidden[surface]) {
      try {
        const range = document.createRange()
        range.setStart(match.startContainer, match.startOffset)
        range.setEnd(match.endContainer, match.endOffset)
        vertical = getComputedStyle(start).writingMode.startsWith('vertical')
        rects = lineRects([...range.getClientRects()], vertical)
      } catch {
        rects = null
      }
    }
  }
  if (!rects?.length && !matchOutlined) return
  matchOutlined = Boolean(rects?.length)
  controller?.outlineMatch(rects, vertical)
}
setInterval(syncMatchOutline, 100)

/**
 * The free click: with a pop-up open, a click anywhere on the overlay that is not on the pop-up,
 * the card's menu, the hint bar or the controller closes the pop-up and goes no further: not to
 * the game (the overlay took it, `catching`), nor to a word under it (a lookup). The game keeps
 * the keyboard throughout; the next click goes through to it. With Shift's gate open, clicks are
 * the words' and the card's as usual.
 */
function onFreeClick(event) {
  // Every press starts clean: one that ended without a click must not swallow the next.
  swallowClick = false
  if (!catching || gateOpen) return
  const target = event.target instanceof Element ? event.target : null
  // A card clear of the game takes the mouse as if the key were held: its clicks are its own.
  if (target?.closest('.hook-card') && hookCardClear()) return
  const popupHost = extensionHost()?.descriptor?.popupSelector
  if (target?.closest('.hook-card-menu, .overlay-hints, #controller, .pages, iframe')) return
  if (popupHost && target?.closest(popupHost)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  swallowClick = true
  catching = false
  freeClickTaken = true
  log({ check: 'overlay-free-click' })
  dismissPopup()
  window.getSelection()?.removeAllRanges()
  renderer.clearPointer()
  void publishRegions()
}
document.addEventListener('pointerdown', onFreeClick, true)
for (const type of ['mousedown', 'mouseup', 'pointerup', 'click']) {
  document.addEventListener(
    type,
    (event) => {
      if (!swallowClick) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (type === 'click') swallowClick = false
    },
    true
  )
}

/** Drops the text read from the selection, from the overlay and the scanner's memory. */
function clearSelectionText() {
  reading.reset()
  readingHold = false
  remoteReadingPopup = false
  apiReadingPopup = false
  syncScanHold()
  setOcrAnnotations([])
  state.info = null
  state.appliedScanId = null
  state.detached = false
  renderer.clear()
  scanner.reset()
}

/**
 * Force rescan (Scan while Auto OCR is on): drop what is drawn and everything the automatic loop
 * remembers — the scene, what it held back, its backoff after errors, an engine it gave up on —
 * so the scan that follows starts from the screen as it is. A way out when the loop is stuck.
 */
function forceRescan() {
  log({ check: 'overlay-force-rescan', scanner: scanner === sceneScanner ? 'scene' : 'image' })
  clearSelectionText()
  scanner.resume()
  draw()
}

let handling = false
let lastSelection = null

/**
 * React to the shared native view.
 *
 * Driven by the `state` event, which native emits only when a fingerprint of the
 * view changes, with one snapshot at startup to establish the baseline. An event
 * arriving while the previous one is still being applied replaces the pending
 * one rather than queueing behind it — intermediate states are not worth
 * replaying, but the latest must never be dropped, or a missed transition would
 * persist until something else happened to change the view.
 */
let pendingView = null
async function processView(view) {
  if (!view) return
  if (handling) {
    pendingView = view
    return
  }
  handling = true
  try {
    // A native click outside any interactive region dismisses the popup.
    if (state.dismiss !== view.dismiss) {
      state.dismiss = view.dismiss
      dismissPopup()
    }

    if (view.revision !== state.revision) {
      state.revision = view.revision
      const scanId = view.scan?.id ?? null
      // Our own scans rendered and published on the way through; re-applying
      // here would duplicate the history entry and rewrite the clipboard.
      const alreadyApplied = scanId !== null && scanId === state.appliedScanId
      if (!alreadyApplied) {
        dismissPopup()
        window.getSelection()?.removeAllRanges()
        if (view.scan?.ocr) {
          const ocr = normalizeOcrResult(view.scan.ocr, view.scan.ocr.engine ?? ocrModeNow(), languageNow())
          await applyResult(
            { ...ocr, nativeScanId: scanId },
            view.scan,
            {
              generation: generation.current,
              sourceId: view.source?.sourceId ?? view.source?.id ?? null,
              source: view.source ?? null,
              request: { source_id: null, crop: view.crop ?? null }
            },
            { publish: !scanWasPublished(scanId) }
          )
          scanner.noteExternalScan(ocr.fullText ?? '', null, ocr)
        } else if (!view.scan && !pipeline.isHeld && !state.scanning) {
          // An explicit clear. A scan in flight has not produced its frame yet
          // and must not wipe what is currently readable.
          setOcrAnnotations([])
          state.info = null
          state.appliedScanId = null
          renderer.clear()
        }
      }
    }

    const flags = {
      autoOcrEnabled: view.autoOcrEnabled ?? state.flags.autoOcrEnabled,
      textOverlayVisible: view.textOverlayVisible ?? state.flags.textOverlayVisible,
      overlayVisible: view.overlayVisible ?? state.flags.overlayVisible,
      debugOverlayVisible: view.debugOverlayVisible ?? state.flags.debugOverlayVisible
    }
    const autoChanged = flags.autoOcrEnabled !== state.flags.autoOcrEnabled
    state.flags = flags
    if (autoChanged) syncAutoScanner()
    syncOverlayText()
    document.body.classList.toggle('debug', flags.debugOverlayVisible)

    if (typeof view.frontmostApp === 'string') foreground.note(view.frontmostApp)
    // Also carried on the view, so a window that starts up mid-session begins with the
    // current answer instead of waiting for the next change.
    if (view.sourceFocus) state.sourceFocus = view.sourceFocus

    // Crop and source identity come from the shared view, so a commit in the
    // picker reaches the hover markings without a scan in between.
    const selection = {
      sourceId: view.source?.sourceId ?? view.source?.id ?? null,
      crop: view.crop ?? null
    }
    if (generation.bumpIfChanged(lastSelection, selection)) {
      // A different source or crop invalidates anything in flight, and the
      // text on screen belongs to the previous selection.
      if (lastSelection !== null) clearSelectionText()
      lastSelection = selection
    }
    state.crop = view.crop ?? null
    state.ankiCrop = view.ankiCrop ?? null
    state.viewSource = view.source ?? null
    const kind = view.source?.kind ?? view.source?.type
    state.hover.isWindow = kind === 'window'
    await followSource(followedSource())
    drawHover()

    if (view.dictionary !== state.dictionaryOpen) {
      state.dictionaryOpen = view.dictionary
      pagesSection.hidden = !state.dictionaryOpen
      if (state.dictionaryOpen) {
        if (!state.origin) {
          state.origin = (await native.desktop())[0]
          await native.placeOverlay(state.origin)
        }
        if (!document.querySelector('#extension-page').getAttribute('src')) {
          openInIframe?.('/settings.html')
        }
        await native.panel('overlay', 'show')
      }
    }
  } catch (error) {
    log({ check: 'overlay-error', error: String(error?.message ?? error) })
  } finally {
    handling = false
    const next = pendingView
    pendingView = null
    if (next) void processView(next)
  }
}

/**
 * React to the overlay's text being switched on or off.
 *
 * Two inputs decide whether scanned text is drawn — a persisted preference and a
 * session flag — and they arrive on two different channels: a settings change and a
 * view broadcast. Both call this, and it compares the *combined* answer against the
 * last one, so flipping one input cannot look like two transitions and start two
 * scans.
 *
 * Switching it on scans, because otherwise it switches on to nothing: the overlay
 * draws the last scan, and if there was not one, or it belonged to a source that has
 * since changed, the reader gets an empty screen and has to ask for a scan by hand.
 * Switching it off never scans. The scan itself is the ordinary one — same capture,
 * same source, same generation and busy guards — so a scan already running satisfies
 * the transition and a failure is reported on the status line like any other.
 */
let overlayTextShown = null
// ---------------------------------------------------------------------------
// The browser extension (src-tauri/src/browser_bridge.rs, browser-extension/)
// ---------------------------------------------------------------------------

/**
 * Read a picture the browser extension sent, as a scan of the selected engine, and answer with
 * the lines to lay over it. Its text reaches the Log like any scan's (`publishOcrResult`, with the
 * same filters); nothing is drawn here.
 */
async function onBrowserScan({ request, frame, reason, session }) {
  const answer = (payload) =>
    native
      .invoke('browser_scan_result', { request, result: null, error: null, ...payload })
      .catch((error) => log({ check: 'browser-scan-answer-failed', error: String(error?.message ?? error) }))
  const auto = reason === 'auto'
  publish({ scanning: true, status: 'Reading the picture from your browser\u2026' })
  if (!auto) activity(scanActivity.recognising(ocrModeNow()))
  try {
    const result = await recognize(frame, { ocrMode: ocrModeNow() })
    if (!result) throw new Error('The OCR engine returned nothing')
    const grouping = setting('textOverlayGrouping')
    let publication = null
    const published = await publishOcrResult(result, {
      detached: true,
      grouping,
      // The same picture read again (Auto OCR, Rescan) does not add its text twice.
      merge: true,
      frame: frame.id,
      // The tab's session: the Log switches to it for these lines.
      session: session ?? null,
      onPublication: (report) => {
        publication = report
      }
    })
    // The activity bubble hears how it went, as after any scan (it said "Recognising…").
    reportOutcome(scanActivity.scanOutcome(publication, { auto }), { auto })
    const lines = browserLines(result, grouping, frame.info)
    publish({
      scanning: false,
      status: lines.length
        ? `Read ${lines.length} line${lines.length === 1 ? '' : 's'} from your browser`
        : 'No text in that picture'
    })
    log({ check: 'browser-scan', reason, lines: lines.length, published: published.length, engine: ocrModeNow() })
    await answer({
      result: {
        lines,
        width: frame.info.width,
        height: frame.info.height,
        engine: ocrModeNow(),
        geometry: result.geometry !== false,
        text: published
      }
    })
  } catch (error) {
    const message = String(error?.message ?? error)
    publish({ scanning: false, status: `Couldn\u2019t read that picture: ${message}` })
    log({ check: 'browser-scan-failed', reason, error: message })
    reportOutcome(scanActivity.scanFailed(error, 'recognise', ocrModeNow()), { auto })
    await answer({ error: message })
  }
}

/**
 * The visible lines of a reading (the overlay's own filters), in fractions of the picture, for the
 * extension to draw: `{text, points: [[x, y] ×4], vertical, group, surface?}`. A block that knows
 * its lines (Manga OCR's speech bubbles) gives each line, under the block's group; with Group text
 * into regions on, lines near each other share a group as the overlay's boxes would.
 */
function browserLines(result, grouping, info) {
  if (result.geometry === false) return []
  const width = info?.width || 1
  const height = info?.height || 1
  const round = (value) => Math.round(value * 10000) / 10000
  const at = (x, y) => [round((x ?? 0) / width), round((y ?? 0) / height)]
  const visible = visibleAnnotations(result.textAnnotations ?? [], grouping)
  const groupOf = new Map()
  if (grouping?.enabled) {
    groupTextAnnotations(visible, grouping.proximityThreshold).forEach((group, index) => {
      for (const annotation of group.annotations) groupOf.set(annotation, index)
    })
  }
  const lines = []
  visible.forEach((annotation, index) => {
    const vertical = annotation.isVertical === true || annotation.orientation === 'vertical'
    const group = groupOf.get(annotation) ?? `a${index}`
    const surface = annotation.surface
    const texts = annotation.lineTexts
    if (annotation.linePolygons?.length && texts?.length === annotation.linePolygons.length) {
      annotation.linePolygons.forEach((polygon, line) => {
        if (texts[line]?.trim())
          lines.push({ text: texts[line], points: polygon.map(([x, y]) => at(x, y)), vertical, group, surface })
      })
      return
    }
    if (!annotation.description?.trim()) return
    lines.push({
      text: annotation.description,
      points: annotation.boundingPoly.vertices.map((vertex) => at(vertex.x, vertex.y)),
      vertical,
      group,
      surface
    })
  })
  return lines
}

function syncOverlayText() {
  const shown = overlayTextOn()
  const was = overlayTextShown
  overlayTextShown = shown
  draw()
  switch (overlayTextChange(was, shown, pipeline.isHeld || state.scanning)) {
    case 'scan':
      log({ check: 'overlay-enabled-scan' })
      void performScan()
      break
    case 'scan-pending':
      log({ check: 'overlay-enabled-scan-pending' })
      break
  }
}

/**
 * Publish the interactive rectangles on a timer rather than on view changes:
 * they move whenever the DOM does — a popup opening, a hover scaling a box —
 * which the native view knows nothing about.
 */
let publishing = false
let republish = false
// What was last published, and when: an unchanged set is sent again only once a second (native
// may have shown or hidden the surface meanwhile), not on every tick of the region loop.
let publishedSignature = null
let publishedAt = 0
const REPUBLISH_MS = 1000

async function publishRegions(readWordRects = null) {
  if (publishing) {
    // Coalesce: the next publish must reflect the DOM as it is when it runs, not
    // queue a stale snapshot behind the one in flight.
    republish = true
    return
  }
  publishing = true
  try {
    do {
      republish = false
      const rects = hitRects(readWordRects)
      // This sample belongs only to the synchronous part of this tick. A request coalesced
      // while setRegions is in flight must read the DOM again after that await.
      readWordRects = null
      const signature = JSON.stringify([rects, state.flags.overlayVisible, state.regionSelecting])
      if (signature === publishedSignature && performance.now() - publishedAt < REPUBLISH_MS) continue
      await native.setRegions(rects)
      publishedSignature = signature
      publishedAt = performance.now()
    } while (republish)
  } catch (error) {
    log({ check: 'overlay-regions-error', error: String(error?.message ?? error) })
  } finally {
    publishing = false
  }
}

function startRegionLoop() {
  setInterval(() => {
    void refreshLayerPointer()
    // These consumers run synchronously before publishRegions awaits native. Sample words
    // only if needed, once in local coordinates, and discard at the end of the tick. Popup,
    // hint and controller rectangles are still read after their own updates as before.
    let wordRects = null
    const readWordRects = () => (wordRects ??= renderer.hitRects({ x: 0, y: 0 }))
    syncReadingHold(readWordRects)
    syncHints(readWordRects)
    void publishRegions(readWordRects)
  }, 100)
}

async function refreshLayerPointer() {
  // With Shift readable, native's pointer feed already follows the pointer over the text.
  if (shiftGated || !hyprlandPointer || !layerPointerExit || layerPointerPolling || !state.origin) return
  // Nothing on the overlay takes the mouse, and the last sample already said so: there is
  // nothing for the pointer to be inside until something is drawn.
  if (layerPointerExit.outside() && hitRects().length === 0) return
  layerPointerPolling = true
  try {
    const point = await native.invoke('linux_window_geometry', {
      operation: 'pointer',
      sourceId: watchedSourceId ?? '',
      windowAddress: null
    })
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    const inside = hitRects().some(
      (r) => point.x >= r.x && point.y >= r.y && point.x < r.x + r.width && point.y < r.y + r.height
    )
    layerPointerExit.sample(inside)
    if (inside) renderer.setPointer(point.x - state.origin.x, point.y - state.origin.y)
    syncReadingHold()
  } catch {
    /* Optional compositor IPC: GTK surface edges remain the fallback. */
  } finally {
    layerPointerPolling = false
  }
}

// ---------------------------------------------------------------------------
// 6. Startup
// ---------------------------------------------------------------------------

native.onCapabilityGap((command) =>
  log({
    check: 'native-capability-missing',
    command,
    note: 'Feature degraded; the frontend falls back to its non-native path.'
  })
)

await native.loadSettings()
// The learner's text in the language being read's fonts, marked with its `lang` (language-style.ts).
applyTextStyle(languageNow())
await mirrorDictionaryEngine({ repair: true })

/**
 * The text's look (Settings → Overlay → Overlay appearance): the highlight colour, and whether
 * the cards are light, dark, blended or transparent (no card, the highlight alone); "Same as Kimochi" follows
 * the app's appearance and, for `system`, the OS.
 */
const systemDark = matchMedia('(prefers-color-scheme: dark)')
function applyOverlayStyle() {
  const style = setting('overlayStyle')
  renderer.setStyle({
    color: style.color,
    opacity: style.opacity,
    theme: resolveOverlayCardAppearance(style, setting('appearance'), systemDark.matches)
  })
}
applyOverlayStyle()
systemDark.addEventListener('change', applyOverlayStyle)

await native.watchSettings((key) => {
  if (key === 'language') applyTextStyle(languageNow())
  if (key === 'hotkeys' || key.startsWith('hotkeys.')) void syncGamingHints()
  // The selected engine decides the watcher too (`autoWatcher`).
  if (
    key === 'autoOCRSettings' ||
    key === 'quickShotEnabled' ||
    key === 'superTexthooker' ||
    key === 'ocrMode' ||
    key === 'language' ||
    key === 'textHookerGames' ||
    key === 'textHookerDefaults' ||
    key === 'textHookerShowCard'
  )
    syncAutoScanner()
  if (
    key === 'language' ||
    key === 'textHookerGames' ||
    key === 'textHookerDefaults' ||
    key === 'superTexthooker' ||
    key === 'textHookerShowCard'
  ) {
    // First, so the last reading is matched afresh too: the line may still be where it was read.
    realignHookCard()
    setOcrAnnotations(state.rawAnnotations ?? [])
    draw()
  }
  // Mirror only: a switch is reloaded by Settings (`dictionary_engine_apply`), not from here.
  if (key === 'yomitanSettings') void mirrorDictionaryEngine()
  if (key === 'overlayHoverLookup') checkPopupLeave()
  if (key === 'overlayStyle' || key === 'appearance') {
    applyOverlayStyle()
    // The hint bar shows only while something is drawn (the card follows in `draw`, below).
    syncHints()
  }
  syncOverlayText()
})

await native.listen('texthook-line', ({ payload }) => onHookLine(payload))
await native.listen('browser-scan', ({ payload }) => void onBrowserScan(payload))
await native.listen('texthook-status', ({ payload }) => onHookStatus(payload))
void native.optional('texthook_status').then((status) => status && onHookStatus(status))

// The raw name, ours included: "Kimochi is frontmost" and "no signal yet" are
// different states, and only the tracker may collapse them.
await native.listen('frontmost-app', ({ payload }) =>
  typeof payload === 'string'
    ? foreground.note(payload)
    : foreground.note(payload?.appName, typeof payload?.pid === 'number' ? payload.pid : null)
)
// Which pids and app names are ours, so our own windows are recognised by process
// where the platform can tell; the default names stand until it says.
await native.watchCapabilities(async (caps) => {
  // An engine downloaded or verified can change which one watches.
  ocrEngines = caps.ocrEngines ?? {}
  lookupButtonSupport = caps.keys?.lookupButtons ?? 'unsupported'
  syncAutoScanner()
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux') nativeGamescope = !!caps.session.nativeGamescope
  void syncGamingHints()
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
    const gated = caps.session?.backend !== 'wayland' || caps.overlay?.shiftGate === true
    // The first Shift press stops the pointer poll (`refreshLayerPointer`): its last sample
    // (often "outside", taken while the pointer was on the game) must not outlive it.
    if (gated && !shiftGated) layerPointerExit?.unsample()
    shiftGated = gated
    lookupOnHover = caps.overlay?.lookupOnHover === true
    waylandSession = caps.session?.backend === 'wayland'
  }
  if (
    window.__KIMOCHI_PLATFORM__?.os === 'linux' &&
    (caps.session.nativeLayerShell || caps.session.nativeGamescope) &&
    !waylandLayer
  ) {
    waylandLayer = true
    if (caps.session.backend === 'wayland' && caps.session.nativeLayerShell) {
      // Hyprland's IPC and KWin's script bridge both report the pointer over the game.
      hyprlandPointer = ['Hyprland', 'KDE'].includes(caps.session.compositor)
      const { installWaylandPointerExit } = await import('./wayland-pointer-exit.js')
      const pointerExit = installWaylandPointerExit(window, {
        leave: () => {
          renderer.clearPointer()
          syncReadingHold()
        },
        dismiss: () => {
          if (!controllerHold && !controller.drivesLookups && !state.regionSelecting) dismissPopup()
        }
      })
      layerPointerExit = pointerExit
      await native.listen('wayland-layer-pointer', ({ payload }) => {
        if (payload === true) pointerExit.enter()
        else if (payload === false) pointerExit.leave()
      })
    }
    const { installLinuxScanInput } = await import('/spike/linux-scan-input.js')
    // Where nothing can report Shift to the overlay (KDE Plasma without Legacy X11 App Support),
    // its text looks up on hover. Asked live: the Shift feed can come up after startup.
    await installLinuxScanInput(window, { passive: true, hover: () => lookupOnHover })
    window.addEventListener(
      'pointerdown',
      () => {
        surfaceButtonDown = true
      },
      true
    )
    for (const type of ['pointerup', 'pointercancel'])
      window.addEventListener(
        type,
        () => {
          surfaceButtonDown = false
        },
        true
      )
    window.addEventListener('resize', () => {
      state.origin = { x: 0, y: 0, width: innerWidth, height: innerHeight }
      draw()
    })
  }
  if (
    window.__KIMOCHI_PLATFORM__?.os === 'linux' &&
    caps.session.backend === 'wayland' &&
    !caps.session.nativeLayerShell
  ) {
    waylandDisabled = true
    if (!gnomeOverlay && caps.session.compositor === 'GNOME') {
      const { installGnomeOverlay } = await import('./gnome-overlay.js')
      gnomeOverlay = await installGnomeOverlay(
        native,
        state,
        () => !state.regionSelecting && (gnomeControllerWords || (overlayTextOn() && state.flags.overlayVisible)),
        log,
        { renderer, setting }
      )
      const { installLinuxScanInput } = await import('/spike/linux-scan-input.js')
      await installLinuxScanInput(window, { passive: true })
    }
    renderer.clear()
    log({
      check: caps.session.nativeGnomeShell ? 'overlay-native-gnome' : 'overlay-disabled',
      reason: caps.session.nativeGnomeShell
        ? 'GNOME Shell places the shared annotation WebView without keyboard focus.'
        : 'Native layer-shell overlay is unavailable on this desktop. GNOME can use the optional Shell integration.'
    })
  }

  if (caps.os === 'windows')
    void import('/spike/windows-pointer.js').then(({ installWindowsPointer }) =>
      installWindowsPointer(window, () => livePopups)
    )
  foreground.configure({ pids: caps.ownPids, names: caps.ownAppNames })
})
await native.listen('hotkey', ({ payload }) => {
  if (payload?.name && !payload.name.startsWith('hover')) log({ check: 'overlay-action', name: payload.name })
  if (payload?.name) void onAction(payload.name)
})
/**
 * Follow the captured source as it moves.
 *
 * Two different things can change and they are independent. The overlay *window*
 * only has to move when the source crosses onto another display, because it is
 * placed over a whole display rather than over the source. The rendered *text*
 * has to move whenever the source moves at all, including within one display,
 * because each box is positioned from the source's current bounds.
 *
 * Getting only the first right is what left text stranded: the window stayed put
 * — correctly — and nothing redrew.
 */
await native.listen('source-bounds', async ({ payload }) => {
  if (!payload?.bounds) return
  // Bounds for a source we are no longer watching are stale by definition: a
  // late event from the previous window must not drag the current one's text.
  if (payload.sourceId && watchedSourceId && payload.sourceId !== watchedSourceId) return

  const window = {
    fullscreen: Boolean(payload.fullscreen),
    onScreen: payload.onScreen !== false,
    settling: Boolean(payload.settling)
  }
  const was = state.sourceWindow
  const changed =
    !was || was.fullscreen !== window.fullscreen || was.onScreen !== window.onScreen || was.settling !== window.settling
  state.sourceWindow = window
  if (changed) {
    trace('overlay-source-window', window)
    // A window that went full screen or to another Space is no longer one to mark on hover.
    if (state.hover.source && !hoverMarksWindow()) hoverPreview.stop()
    drawHover()
  }

  const previous = state.sourceBounds
  const bounds = payload.bounds
  if (previous && !movedOrResized(previous, bounds)) {
    if (changed) draw()
    return
  }
  state.sourceBounds = bounds
  // Quick Shot text belongs to the display region it was read from, not to this window.
  if (state.detached) return
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandDisabled) {
    draw()
    return
  }

  try {
    const origin = sourceDisplay(bounds, await native.desktop())
    if (!sameRect(state.origin, origin)) {
      state.origin = origin
      await native.placeOverlay(origin)
    }
  } catch {
    // A source whose centre is off every display: leave the overlay where it is
    // and still redraw, so text tracks the part of the source that is visible.
  }
  draw()
  drawHover()

  // Recorded so a move can be checked without a screenshot: these windows are
  // capture-protected, so the rendered position is only observable as a number.
  if (state.annotations.length) {
    log({
      check: 'overlay-follow-source',
      bounds,
      origin: state.origin,
      first: renderer.firstBox()
    })
  }
})

// A display changed (resolution, scaling, a monitor added or rearranged): the overlay covers
// the display it is on as it is now, as when the source window moves, rather than keeping the
// old size until the next scan places it (#42).
await native.listen('display-layout', async () => {
  if (!state.origin || waylandDisabled || waylandLayer) return
  try {
    const source = state.sourceBounds && !state.detached ? state.sourceBounds : null
    const next = displayAfterLayout(state.origin, await native.desktop(), source)
    if (next) await placeOverlayOn(next)
    log({ check: 'overlay-display-layout', origin: state.origin })
  } catch (error) {
    log({ check: 'overlay-display-layout', error: String(error?.message ?? error) })
  }
})

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function movedOrResized(a, b) {
  return !sameRect(a, b)
}
// Gamepad input is polled natively (src-tauri/src/gamepad.rs) and dispatched
// through that same action path, so this window must not poll it as well.
const receiveExtensionRelay = ({ payload }) => {
  if (!payload?.from || payload.from === 'overlay') return
  if (typeof payload.to === 'string' && payload.to !== 'overlay') return
  void handleRelay(payload.from, payload.payload)
}
await Promise.all(['ext-relay', 'ext-relay:overlay'].map((event) => native.listen(event, receiveExtensionRelay)))
// Built-in Yomitan's requests from the other windows, over the fast lane where they are on it.
appLane.listen((payload, from) => void handleRelay(from, payload, true))

/** For a devtools inspector: what the overlay holds and why its text shows or not. */
window.__kimochiOverlayState = () => ({
  mode: controller?.mode,
  annotations: state.annotations.length,
  wordBoxes: document.querySelectorAll('[data-ocr-word-box]').length,
  sourceFocus: state.sourceFocus,
  regionSelecting: state.regionSelecting,
  textOverlayVisible: state.flags.textOverlayVisible,
  liveOverlay: setting('liveOverlayEnabled'),
  visibility: document.visibilityState,
  origin: state.origin,
  info: state.info
    ? {
        source: state.info.source_id,
        crop: state.info.crop_pixels,
        bounds: state.info.source_bounds,
        full: [state.info.full_width, state.info.full_height]
      }
    : null,
  geometry: state.geometry,
  overlayVisible: state.flags.overlayVisible,
  sourceBounds: state.sourceBounds,
  // What takes the mouse, and why: a pop-up open makes the whole overlay take the next click.
  popupShown: popupShown(),
  catching,
  gateOpen,
  regions: hitRects().map(({ x, y, width, height, shift, focus }) =>
    [x, y, width, height, shift ? 'shift' : focus ? 'focus' : ''].map((v) =>
      typeof v === 'number' ? Math.round(v) : v
    )
  )
})

// Gaming Mode: while the controller drives Kimochi, Steam is paused, and the Deck's controller
// falls back to its keyboard-and-mouse "lizard" mode (its firmware's watchdog): the D-pad sends
// arrow keys, A Return, B Escape, the right trackpad moves a mouse. Kimochi reads the controller
// itself, so none of that may reach the page: Hachidori would act on the keys and look up, or
// cancel a lookup, wherever that mouse is. The lookups' own synthetic events are not trusted, so
// they still pass.
for (const type of [
  'keydown',
  'keyup',
  'keypress',
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'wheel',
  'pointermove',
  'pointerdown',
  'pointerup'
]) {
  window.addEventListener(
    type,
    (event) => {
      if (!event.isTrusted || !nativeGamescope || !controller || controller.mode === 'idle') return
      event.stopImmediatePropagation()
      if (event.cancelable) event.preventDefault()
    },
    { capture: true, passive: false }
  )
}

// Windows: opening the controller menu brings this overlay to the front, and Windows does not
// call Kimochi's low-level keyboard hook (platform/windows/mouseguard.rs) for keys typed into
// Kimochi's own windows, so the menu's keys never became `controller-key` events and the menu
// ignored the keyboard. They arrive here instead: hand them to the controller as the hook
// would have, and keep them from the page, as the hook keeps them from the game. While a game
// is in front the hook still takes them, and this page never sees them.
// (`pageMenuKey`: never a field being typed in, nor while the region editor has the keys.)
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(
    type,
    (event) => {
      const payload = pageMenuKey(event, {
        os: window.__KIMOCHI_PLATFORM__?.os,
        mode: controller?.mode,
        regionSelecting: state.regionSelecting
      })
      if (!payload) return
      event.stopImmediatePropagation()
      event.preventDefault()
      controller.key(payload)
    },
    { capture: true }
  )
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  // 10ten is dismissed with a synthetic Escape on this window (host/ext/content.js); if it
  // declines the key the event reaches here, and answering it with another dismiss would
  // recurse. Only the reader's own key dismisses from here.
  if (!event.isTrusted) return
  dismissPopup()
  void native.setDictionaryOpen(false)
})
document.querySelector('#close').onclick = () => native.setDictionaryOpen(false)

// The captured window's focus, answered immediately rather than at the next view
// broadcast: text that belongs to a window the reader just left should go at once,
// and its click targets with it.
await native.listen('source-focus', ({ payload }) => {
  trace('source-focus', {
    focused: payload?.focused,
    present: payload?.present,
    held: payload?.held
  })
  if (!payload || typeof payload.focused !== 'boolean') return
  const was = state.sourceFocus
  state.sourceFocus = payload
  draw()
  // On change only. These windows are capture-protected, so whether the text went when
  // the reader left the captured window is otherwise unobservable.
  log({
    check: 'overlay-source-focus',
    focused: payload.focused,
    present: payload.present,
    held: payload.held ?? false,
    covered: payload.covered ?? false,
    // Which two windows were compared. Ids only, never a title: an application can
    // order an auxiliary window in front of the one being read, and that is the only
    // thing that distinguishes it from the reader genuinely leaving.
    front: payload.frontWindow ?? payload.front_window ?? null,
    source: payload.sourceWindow ?? payload.source_window ?? null,
    words: renderer.hitRects(state.origin).length
  })
  // Not at the next tick of the region loop: an invisible rectangle that still takes
  // the mouse is worse than a visible one, so the click targets go with the text.
  void publishRegions()
  if (was && !(payload.focused && payload.present)) {
    // The words are gone; a dictionary popup about one of them has nothing left to
    // point at.
    dismissPopup()
  }
})

/**
 * The last pointer event this window received on its own.
 *
 * The overlay is click-through except over the words themselves, so real events
 * arrive only while the pointer is already on one and this window has the mouse.
 * When they do, they are the better source, and the native feed steps aside
 * rather than searching the same point twice.
 */
let lastRealPointer = -Infinity
/** The modifiers that event reported: on Windows, none while the game has the keyboard. */
let lastRealModifiers = null
window.addEventListener(
  'pointermove',
  (event) => {
    if (!event.isTrusted) return
    lastRealPointer = performance.now()
    lastRealModifiers = {
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey
    }
    // The box under a real pointer is lit before the engine sees the event (`flushPointer`):
    // this listener is the window's first, registered before any content script.
    if (extensionHosted && !controller.drivesLookups) {
      renderer.setPointer(event.clientX, event.clientY)
      renderer.flushPointer()
    }
    rekeyForHover(event)
  },
  true
)
// Hachidori reads `mousemove` (its descriptor's `pointerEvents`).
window.addEventListener(
  'mousemove',
  (event) => {
    if (event.isTrusted) rekeyForHover(event)
  },
  true
)

/** Whether the native feed's last sample said the pointer rests (`hover`, `state::HoverIntent`). */
let feedHover = false
/** Whether the feed's last sample held the lookup key while it is a mouse button (#204). */
let feedLookupButton = false
/**
 * Hover lookup, where the overlay has the mouse itself (click-through off, or the words while the
 * gate is open): its real moves carry no key, and 10ten closes a key-opened pop-up on a move
 * without its key, so gliding along a line would flicker between the feed's keyed moves and these.
 * While the feed says the pointer rests, a real move goes on with the lookup key held instead,
 * as the feed's own samples do (`withHoverKey`: not over a pop-up, not with a button down).
 *
 * A mouse button as the lookup key (`feedLookupButton`) has the same trouble with every real move
 * while it is held: the move carries the button, not Shift, which native sends for it. Those go on
 * keyed too, over a pop-up as well (a nested lookup, as with Shift), with the button left out.
 */
function rekeyForHover(event) {
  if (controller.drivesLookups) return
  const key = native.getSetting('overlayLookupKey')
  const button = feedLookupButton && isLookupButton(key)
  if (!button && (!feedHover || hoverPaused || !hoverLookup() || tentenBareHover())) return
  const property = lookupKeyProperty(key)
  if (event[property] || (event.buttons & ~lookupButtonsBit(button ? key : null)) !== 0) return
  if (!button && overPopupAt({ x: event.clientX, y: event.clientY })) return
  event.stopImmediatePropagation()
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    buttons: 0,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    [property]: true
  }
  const keyed =
    event.type === 'mousemove'
      ? new MouseEvent('mousemove', init)
      : new PointerEvent('pointermove', {
          ...init,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          pointerId: event.pointerId
        })
  ;(event.target ?? window).dispatchEvent(keyed)
}

/** The element at a point, looking inside open shadow roots (an engine's pop-up) as a real event would. */
/**
 * The element an extension engine's move goes to at (x, y): the deepest one there, into the
 * engine's pop-up when the point is on it. Off the pop-up, never the pop-up's host: 10ten's host
 * (`#tenten-ja-window`, a manual popover in the top layer) can lie over the text once it has shown,
 * and 10ten ignores any move aimed at it, so the pop-up stuck on the first word looked up until it
 * closed. The element under the host takes the move then.
 */
function scanTargetAt(x, y) {
  const deep = deepElementFromPoint(document, x, y)
  const selector = window.__kimochiExtensionHost?.descriptor?.popupSelector
  if (!deep || !selector || overPopupAt({ x, y })) return deep
  const inHost = (element) => {
    for (let node = element; node; node = node.parentElement ?? node.getRootNode?.()?.host ?? null) {
      if (node.matches?.(selector)) return true
    }
    return false
  }
  if (!inHost(deep)) return deep
  if (!notedUnderPopupHost) {
    notedUnderPopupHost = true
    log({ check: 'scan-target-under-popup-host', host: selector })
  }
  return document.elementsFromPoint(x, y).find((element) => !inHost(element)) ?? deep
}
let notedUnderPopupHost = false

function deepElementFromPoint(doc, x, y) {
  let element = doc.elementFromPoint(x, y)
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === element) break
    element = inner
  }
  return element
}

let notedModifier = false
let notedFeed = false
function noteScanFeed(payload, dispatched) {
  if (dispatched && !notedFeed) {
    notedFeed = true
    log({ check: 'overlay-scan-feed-started' })
  }
  const held = !!(payload.shift || payload.ctrl || payload.alt || payload.meta)
  if (!held || notedModifier) return
  notedModifier = true
  log({
    check: 'overlay-modifier-seen',
    shift: !!payload.shift,
    ctrl: !!payload.ctrl,
    alt: !!payload.alt,
    meta: !!payload.meta
  })
}

// The pointer, including where this window cannot see it: it drives the proximity
// effect on scanned words, and the scan itself. See ui/scan-input.ts for why the
// scan arrives this way rather than from an event addressed to this window.
// With verbose logging on, the region editor's pointer events (Quick Shot, Select region) go to
// the diagnostics log. Only while it is open: otherwise this window sees the scan feed's
// synthetic moves all the time, which say nothing about the reader's devices.
installPointerDiagnostics('overlay', { label: 'overlay', active: () => state.regionSelecting })

// GNOME: where the Shell put the shared surface, sent with each of its pointer samples. The
// pointer itself comes from the cursor poll below, like everywhere else, with the Shift gate.
await native.listen('gnome-surface', ({ payload }) => gnomeOverlay?.pointer(payload))
await native.listen('pointer', ({ payload }) => {
  // Wayland: the compositor feed has no buttons over a Wayland window; a press on this surface does.
  if (waylandLayer && surfaceButtonDown && !payload?.down) payload = { ...payload, down: true }
  if (!state.origin || typeof payload?.x !== 'number') return
  const local = toOverlayLocal(payload, state.origin)
  // Words and the hook card are Shift-only: without Shift a click goes to the game (native
  // leaves them out of what takes the mouse, `View::live_regions`), so nothing lights up either.
  // Without click-through, text lights up on hover as it always has.
  gateOpen = Boolean(payload.gate ?? payload.shift)
  feedHover = payload.hover === true
  feedLookupButton = payload.shift === true && isLookupButton(native.getSetting('overlayLookupKey'))
  // A card shown only with the lookup key comes and goes with it (and stays while its pop-up is up).
  if (hookCardOnKey()) {
    const up = gateOpen || hookPopupOpen()
    if (up !== hookKeyHeld) {
      hookKeyHeld = up
      syncHookCard()
    }
  }
  // Look up on hover lights the word under the pointer as the lookup key would: the reader is
  // looking words up just by pointing. Clicks still go to the game (native's regions follow the key).
  const armed = !clickThrough('words') || gateOpen || hoverLookup()
  if (local) hints.pointer(local.x, local.y)
  // A drag of the Text Hooker's card follows the pointer and nothing else does meanwhile.
  // The card clear of the game is the reader's to click without the key (`hookCardClear`).
  const cardArmed = !clickThrough('card') || gateOpen || hookCardClear()
  if (local && hook.card?.pointer(local.x, local.y, Boolean(payload.down), cardArmed)) return
  checkPopupLeave(payload.over === false || !local ? null : { x: payload.x, y: payload.y })
  // Yomitan's popups hear the pointer enter and leave them, for "Hide popup on cursor exit" (#95).
  // Not while the controller reads: the resting mouse is not the reader's.
  if (trackPopupHover && !extensionHosted && !controller.drivesLookups) {
    const inside = payload.over !== false && local
    hoveredPopupFrame = trackPopupHover(hoveredPopupFrame, livePopups, inside ? local.x : null, inside ? local.y : null)
  }
  if (payload.over === false || !local || !armed) {
    renderer.clearPointer()
    syncReadingHold()
    if (payload.over === false || !local) return
  } else renderer.setPointer(local.x, local.y)
  syncReadingHold()
  controller.pointer(local.x, local.y)
  // While the controller is reading, the pointer must not steer Yomitan: an idle mouse resting
  // somewhere else would otherwise close the controller's popup.
  if (!state.yomitan.ready || controller.drivesLookups) return
  // Hover lookup: a resting pointer looks up as if the lookup key were held (not over a pop-up).
  syncHoverPause(payload)
  syncTentenBareHover()
  const scanned = withHoverKey(
    payload,
    hoverLookup() && !hoverPaused && !tentenBareHover(),
    native.getSetting('overlayLookupKey'),
    overPopupAt(local)
  )
  const init = scanPointerInit(scanned, local, performance.now() - lastRealPointer, lastRealModifiers)
  // Over Yomitan's own popup the sample is the popup's: its scanner opens a nested popup for the
  // word under it. The page's scanner would only ignore it.
  if (init && !extensionHosted && replayPopupPointer?.(livePopups, local.x, local.y, init)) {
    noteScanFeed(payload, true)
    return
  }
  if (init) {
    // Yomitan reads only the coordinates. The extension engines also look at the event's target,
    // so theirs is dispatched at the element under the point (it bubbles to window either way).
    if (extensionHosted) renderer.flushPointer()
    // Into the engine's pop-up, too: Hachidori opens a nested lookup from a `mousemove` listener
    // on its pop-up inside its shadow root, which an event at the shadow host never reaches (#94).
    const target = extensionHosted ? (scanTargetAt(local.x, local.y) ?? window) : window
    // Each engine listens for its own event: Yomitan and 10ten for `pointermove`, Hachidori for
    // `mousemove` on the document (extensions/hachidori/content.js). The descriptor says which.
    const types = window.__kimochiExtensionHost?.descriptor?.pointerEvents ?? ['pointermove']
    // Shift just went down with the pointer at rest: 10ten takes WebKitGTK for Safari and drops a
    // move that only adds a modifier at the point of the last one (a Safari bug it works around).
    // A plain move a pixel off first makes this one a move. Wayland only: there the last move the
    // engine saw is often the surface's own, at this very point, as the words started taking it.
    const prime =
      waylandLayer && init.shiftKey && !lastScanShift
        ? { ...init, shiftKey: false, clientX: init.clientX + 1, screenX: init.screenX + 1, kimochiPrime: true }
        : null
    for (const type of types) {
      // Composed, so a move dispatched inside a shadow root still reaches the document's listeners.
      const make = (options) =>
        type === 'mousemove'
          ? new MouseEvent(type, { ...options, composed: true })
          : new PointerEvent(type, { ...options, composed: true })
      if (prime) target.dispatchEvent(make(prime))
      target.dispatchEvent(make(init))
    }
  }
  lastScanShift = Boolean(init?.shiftKey)
  // Once each, then never again. Whether a modifier can be read at all from a window
  // that does not have the keyboard is the one thing this window cannot find out for
  // itself, and "Shift does nothing" has two completely different causes depending on
  // the answer. Names of keys only.
  noteScanFeed(payload, init !== null)
})

await native.listen('overlay-reading-popup-alive', () => {
  remotePopupAliveAt = performance.now()
})
await native.listen('overlay-reading-popup', ({ payload }) => {
  remoteReadingPopup = payload?.visible === true
  if (remoteReadingPopup) remotePopupAliveAt = performance.now()
  remoteReadingRects = remoteReadingPopup && Array.isArray(payload.rects) ? payload.rects : []
  syncReadingHold()
  void publishRegions()
})
window.addEventListener('mousemove', () => syncReadingHold())

await native.listen('gnome-popup-dismiss', () => {
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && gnomeOverlay?.shared) {
    dismissPopup()
    window.getSelection()?.removeAllRanges()
  }
})
await native.listen('state', ({ payload }) => void processView(payload))
// The reader cleared its log. Both loops forget what they published, so a line read again
// reaches the log again; native's history merge forgets it on the same signal.
await native.listen('history:merge-reset', () => {
  imageScanner.forgetPublished()
  sceneScanner.forgetPublished()
})

syncAutoScanner()
void reportObserver()
startRegionLoop()
// One baseline read, in case the first `state` event predates this listener.
void native.snapshot().then(processView)

// Scanning and rendering are live from here. The dictionary comes up behind them:
// if it fails, lookups are unavailable and say so, but OCR still works. Which engine is the one
// this document's host scripts installed (`hostedEngine`).
// No engine downloaded (a first run that skipped the choice, a removed engine, a pin bump still
// downloading): nothing to start, and lookups say how to get one.
async function startNoEngine() {
  throw Error(NO_ENGINE_MESSAGE)
}

/**
 * The Yomitan API: no host and nothing downloaded. Words are split and looked up through the
 * browser's Yomitan over its API, so the lookup hook (Shift over the text) is all
 * there is to install; the pointer replay and the controller see it as a ready dictionary.
 */
async function startApiEngine() {
  await installApiLookup({ embedded: false, onVisibilityChange: apiPopupVisible })
  state.yomitan.ready = true
  settleBackend()
  log({ check: 'dictionary-api-ready' })
}

/** The Yomitan API is the engine: it needs no host, so this document installed none. */
const apiEngine =
  hostedEngine === NO_ENGINE && dictionaryEngineOf(setting('yomitanSettings')?.popupType) === 'custom-api'

;(apiEngine
  ? startApiEngine()
  : hostedEngine === NO_ENGINE
    ? startNoEngine()
    : extensionHosted
      ? startExtensionEngine()
      : startYomitan()
).catch((error) => {
  state.yomitan.error = String(error?.message ?? error)
  if (hostedEngine === 'yomitan')
    void native.report({
      check: 'dictionary-readiness',
      engine: 'yomitan',
      phase: 'failed',
      settingsReady: false,
      message: 'Yomitan could not start. Choose another dictionary engine and switch back to retry.'
    })
  settleBackend()
  log({
    check:
      hostedEngine === NO_ENGINE
        ? 'dictionary-none'
        : extensionHosted
          ? 'dictionary-unavailable'
          : 'yomitan-unavailable',
    engine: hostedEngine,
    error: state.yomitan.error,
    note: 'Scanning and text output still work; dictionary lookup does not.'
  })
})

log({
  check: 'overlay-ready',
  ocrMode: ocrModeNow(),
  liveOverlay: setting('liveOverlayEnabled'),
  missingCommands: native.unavailableCommands()
})

// Exposed for ui/checks.js, which drives a scan and asserts against the result.
window.kimochiOverlay = {
  performScan,
  onAction,
  importFixtureDictionary,
  renderer,
  scanner,
  state
}

// GNOME hosts the unchanged controller UI in a bounded own window. The OCR
// coordinator still owns scanning, settings, and the one dictionary backend.
if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
  await native.listen('gnome-controller-command', async ({ payload: p }) => {
    if (!gnomeOverlay) return
    let result, error
    try {
      switch (p.action) {
        case 'snapshot':
          result = {
            hasText: state.annotations.length > 0,
            autoOcr: Boolean(state.flags.autoOcrEnabled),
            autoAvailable: !isQuickShot(),
            scanId: state.appliedScanId,
            settings: {
              controllerButtons: setting('controllerButtons'),
              controllerMenuItems: setting(RADIAL_MENU_SETTING),
              overlayStyle: setting('overlayStyle'),
              radialMenuColor: setting('radialMenuColor'),
              radialMenuBase: setting('radialMenuBase'),
              appearance: setting('appearance')
            }
          }
          break
        case 'scan':
          await onAction('triggerScan')
          result = true
          break
        case 'action':
          if (p.name !== 'toggleAutoOcr') throw new Error('Invalid controller action')
          await onAction(p.name)
          break
        case 'dictionary':
          if (p.apiAction !== 'parseText') throw new Error('Invalid dictionary action')
          if (!extensionApi) throw new Error('Word splitting needs Yomitan; using the segmenter')
          result = await extensionApi(p.apiAction, p.params)
          break
        case 'text':
          await setOverlayText(Boolean(p.visible))
          await gnomeOverlay.update()
          break
        case 'hold':
          gnomeControllerWords = Boolean(p.hold)
          holdForController(gnomeControllerWords)
          await gnomeOverlay.flush()
          break
        default:
          throw new Error('Unknown controller command')
      }
    } catch (e) {
      error = String(e)
    }
    await window.__TAURI__.event.emit('gnome-controller-response', { id: p.id, result, error })
  })
}
