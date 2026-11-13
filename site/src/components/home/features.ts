import type { ComponentType } from 'react'
import { ControllerVisual } from './visuals/ControllerVisual'
import { DictionariesVisual } from './visuals/DictionariesVisual'
import { DictionaryVisual } from './visuals/DictionaryVisual'
import { EnginesVisual } from './visuals/EnginesVisual'
import { InputsVisual } from './visuals/InputsVisual'
import { LogVisual } from './visuals/LogVisual'
import { MiniModeVisual } from './visuals/MiniModeVisual'
import { NotebookVisual } from './visuals/NotebookVisual'
import { OverlayVisual } from './visuals/OverlayVisual'
import { SessionsVisual } from './visuals/SessionsVisual'
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
   * ("Windows games") and `deck` are quiet grey chips for a feature made for that platform.
   */
  tag?: 'cloud' | 'windows' | 'deck'
  /** A link on this site instead of the docs link, e.g. to the plans. */
  link?: { to: string; label: string }
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
    id: 'text-hooker',
    title: 'Text hooking',
    body: "Pick a game's window, turn on Text hooking, and Kimochi reads its text directly from the game, with each line in a card over the game. It hooks Windows games on Windows, and on Linux and Steam Deck through Proton or Wine.",
    Visual: TextHookerVisual,
    docs: '/reading/text-hooker/',
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
    id: 'dictionaries',
    title: 'Dictionary extensions',
    body: 'Use a built-in copy of Yomitan, or point Kimochi at your own Yomitan and its dictionaries through the Yomitan API. For Japanese, Hachidori and 10ten are built in too.',
    Visual: DictionariesVisual,
    docs: '/lookups/dictionaries/'
  },
  {
    id: 'dictionary',
    title: 'Look up and save',
    body: 'Look up words from the overlay or the Log with your favorite dictionary.',
    Visual: DictionaryVisual,
    docs: '/lookups/looking-up/'
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
    body: "Kimochi runs beside your game in Gaming Mode. Press R4 to open its menu over the game, scan, then step through the words with the D-pad. Hit B and you're back in the game.",
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
