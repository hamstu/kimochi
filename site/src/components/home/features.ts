import type { ComponentType } from 'react'
import { ControllerVisual } from './visuals/ControllerVisual'
import { DictionariesVisual } from './visuals/DictionariesVisual'
import { DictionaryVisual } from './visuals/DictionaryVisual'
import { EnginesVisual } from './visuals/EnginesVisual'
import { InputsVisual } from './visuals/InputsVisual'
import { LogVisual } from './visuals/LogVisual'
import { MiniModeVisual } from './visuals/MiniModeVisual'
import { NotebookVisual } from './visuals/NotebookVisual'
import { OverlayLookVisual } from './visuals/OverlayLookVisual'
import { OverlayVisual } from './visuals/OverlayVisual'
import { SessionsVisual } from './visuals/SessionsVisual'
import { StatsVisual } from './visuals/StatsVisual'
import { SyncVisual } from './visuals/SyncVisual'
import { TextHookerVisual } from './visuals/TextHookerVisual'

export interface Feature {
  /** Stable key (also usable as an anchor). */
  id: string
  /** The feature's name, shown as the card's title. */
  title: string
  body: string
  /** A self-contained drawing in src/components/home/visuals/, rendered in a <VisualFrame>. */
  Visual: ComponentType
  /** The docs page that explains it (a path on docs.kimochiapp.com, see src/lib/docs.js). */
  docs?: string
  /**
   * A chip beside the title: `cloud` marks a Kimochi Cloud (paid) feature in the accent; `windows`
   * ("Windows games, also on Linux & Steam Deck") and `deck` are quiet grey chips for a feature made for that platform.
   */
  tag?: 'cloud' | 'windows' | 'deck'
  /** A link on this site instead of the docs link, e.g. to the plans. */
  link?: { to: string; label: string }
  /** A page on this site that goes further, shown after the docs link. */
  more?: { to: string; label: string }
}

/**
 * The home page feature grid, in order. Adding a feature = one entry here plus one visual
 * component. Keep bodies to two or three sentences; the grid is two columns from md up, so an
 * even count reads best.
 */
export const features: Feature[] = [
  {
    id: 'engines',
    title: 'Fast OCR',
    body: "Pick the OCR engine that suits what you're reading: quick on-device models like PaddleOCR, the ones built into Windows and macOS, or Google Lens online. Kimochi offers the ones that read your language; for Japanese there's also MeikiOCR, and Manga OCR for manga.",
    Visual: EnginesVisual,
    docs: '/reading/ocr-engines/'
  },
  {
    id: 'overlay',
    title: 'Cross Platform Overlay',
    body: 'With the overlay on, you can hover the words directly in your game, a video, manga or anything else on screen.',
    Visual: OverlayVisual,
    docs: '/reading/overlay/'
  },
  {
    id: 'overlay-look',
    title: 'Make the overlay yours',
    body: "Set the hover cards to Transparent if you'd rather see the game's own text, and fade the dictionary so the game shows through it. Auto Game Pausing can also freeze the game while you look up a word. It's experimental, so it won't work with every game!",
    Visual: OverlayLookVisual,
    docs: '/reading/overlay/'
  },
  {
    id: 'dictionary',
    title: 'Look up and save',
    body: "Point at a word in the overlay or the Log while you hold Shift, another key, or your middle, back or forward mouse button, and it opens in your favorite dictionary. Or turn on Look up on hover and skip the key. (Mouse buttons can't be used on Linux with Wayland.)",
    Visual: DictionaryVisual,
    docs: '/lookups/looking-up/'
  },
  {
    id: 'dictionaries',
    title: 'Dictionary extensions',
    body: 'Use a built-in copy of Yomitan, or point Kimochi at your own Yomitan and its dictionaries through the Yomitan API. Hachidori is built in too, for Japanese and (experimentally) about twenty other languages, and so is 10ten for Japanese.',
    Visual: DictionariesVisual,
    docs: '/lookups/dictionaries/'
  },
  {
    id: 'text-hooker',
    title: 'Text hooking',
    body: "Pick a game's window, turn on Text hooking, and Kimochi reads its text directly from the game, with each line in a card over the game. It hooks Windows games on Windows, and on Linux and Steam Deck through Proton or Wine.",
    Visual: TextHookerVisual,
    docs: '/reading/text-hooker/',
    more: { to: '/linux-steam-deck-text-hooker', label: 'Text hooking on Linux and Steam Deck' },
    tag: 'windows'
  },
  {
    id: 'log',
    title: 'Log',
    body: 'Every line Kimochi reads goes into the Log. Scroll back, or pick up tomorrow where you left off. It does the job of a texthooker page.',
    Visual: LogVisual,
    docs: '/log/the-log/'
  },
  {
    id: 'stats',
    title: 'Stats and reading history',
    body: "The Stats tab shows how much you've read: a heatmap with your streak, characters and time per day, your reading speed and the kanji you've met most. Every line is kept, and you can export it for exSTATic, or as CSV or JSON.",
    Visual: StatsVisual,
    docs: '/log/stats/'
  },
  {
    id: 'sessions',
    title: 'Sessions',
    body: 'Keep a separate log for every game, visual novel or manga, each with its own lines and reading stats. Kimochi can switch sessions by window name.',
    Visual: SessionsVisual,
    docs: '/log/sessions/'
  },
  {
    id: 'notebook',
    title: 'Notebook',
    body: 'I built this one for myself, especially! Select some text from the log to add characters, places or terms to a shared notebook. Link images and notes, too. Kimochi then highlights them in the Log, so you can click one when you forget who someone is.',
    Visual: NotebookVisual,
    docs: '/log/notebook/'
  },
  {
    id: 'texthookers',
    title: 'Any source',
    body: 'If you hook visual novels with your own setup, point Kimochi at your texthooker over WebSocket, or copy lines to the clipboard. They land in the same Log, with the same lookups, Notebook and stats.',
    Visual: InputsVisual,
    docs: '/reading/texthookers/'
  },
  {
    id: 'controller',
    title: 'Gaming Mode',
    body: "Kimochi runs beside your game in Gaming Mode. Press R4 to open its menu over the game, scan, then step through the words with the D-pad. Hit B and you're back in the game. You can choose the menu's actions, their order, buttons and colours.",
    Visual: ControllerVisual,
    docs: '/controller/gaming-mode/',
    tag: 'deck'
  },
  {
    id: 'mini-mode',
    title: 'Mini mode',
    body: 'Shrink Kimochi down to its controls, in a slim window that sits beside your game, video or manga.',
    Visual: MiniModeVisual,
    docs: '/reading/mini-mode/'
  },
  {
    id: 'cloud-sync',
    title: 'Sync across computers',
    body: 'With Kimochi Cloud, your sessions, Notebook and preferences stay in step between your computers.',
    Visual: SyncVisual,
    tag: 'cloud',
    link: { to: '/#cloud', label: 'See Kimochi Cloud plans' }
  }
]
