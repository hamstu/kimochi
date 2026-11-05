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
    title: 'Lightning fast OCR',
    body: "Fast, with plenty of options. Pick the OCR engine that suits what you're reading: quick on-device models like MeikiOCR and PaddleOCR, Manga OCR for manga, the ones built into Windows and macOS, or Google Lens online.",
    Visual: EnginesVisual,
    docs: '/reading/ocr-engines/'
  },
  {
    id: 'overlay',
    title: 'Cross Platform Overlay',
    body: "When the overlay is on, you'll be able to hover directly over the words in your game, app, YouTube video, manga, or anything else on your screen.",
    Visual: OverlayVisual,
    docs: '/reading/overlay/'
  },
  {
    id: 'text-hooker',
    title: 'Text Hooker',
    body: "Kimochi can read a game's text directly from the game. It fetches a text hooker the first time (LunaHook, or Textractor as a fallback), picks out the dialogue by matching it to what's on screen, and shows each line in a card over the game, ready to look up. It hooks Windows games on Windows, and on Linux and Steam Deck through Proton or Wine.",
    Visual: TextHookerVisual,
    docs: '/reading/text-hooker/',
    tag: 'windows'
  },
  {
    id: 'log',
    title: 'Log',
    body: 'Skipped a line too fast? Scroll back. Pick up tomorrow where you left off. Kimochi always remembers. No need for external texthooker pages. 👌',
    Visual: LogVisual,
    docs: '/log/the-log/'
  },
  {
    id: 'dictionaries',
    title: 'Dictionary extensions',
    body: 'Pick the dictionary you like: Kimochi supports an embedded copy of Yomitan, Hachidori, 10ten, or you can point at your own Yomitan and existing dictionaries through the Yomitan API. ✨',
    Visual: DictionariesVisual,
    docs: '/lookups/dictionaries/'
  },
  {
    id: 'dictionary',
    title: 'Look up and save',
    body: "Whether it's in the overlay or in the log, you'll be able to easily look up definitions with your favorite dictionary tool.",
    Visual: DictionaryVisual,
    docs: '/lookups/looking-up/'
  },
  {
    id: 'sessions',
    title: 'Sessions',
    body: 'Keep a separate log for every game, visual novel or manga, each with its own lines and reading stats. Kimochi can switch sessions for you by window name, and you can rename, reorder or clear them any time.',
    Visual: SessionsVisual,
    docs: '/log/sessions/'
  },
  {
    id: 'notebook',
    title: 'Notebook',
    body: 'I built this one for myself, especially! Select some text from the log to add characters, places or terms to a shared notebook. Link images and notes, too. Kimochi then highlights it as clickable in your log for easy remembering.',
    Visual: NotebookVisual,
    docs: '/log/notebook/'
  },
  {
    id: 'texthookers',
    title: 'Any source',
    body: 'Hooking a visual novel with your own setup? Point Kimochi at your texthooker over WebSocket, or just copy lines to the clipboard. They land in the same Log, with the same lookups, Notebook and stats.',
    Visual: InputsVisual,
    docs: '/reading/texthookers/'
  },
  {
    id: 'controller',
    title: 'Gaming Mode',
    body: "Kimochi runs right beside your game in Gaming Mode. Open its menu over the game with an easy shortcut, scan, then step through the words with the D-pad for quick look-ups. Hit B and you're back in the game.",
    Visual: ControllerVisual,
    docs: '/controller/gaming-mode/',
    tag: 'deck'
  },
  {
    id: 'mini-mode',
    title: 'Mini mode',
    body: 'Shrink Kimochi down to just its controls: your source, Auto OCR, the overlay, your OCR model and dictionary, in a slim window that sits beside your game, video or manga. Expand it again whenever you want the Log.',
    Visual: MiniModeVisual,
    docs: '/reading/mini-mode/'
  },
  {
    id: 'cloud-sync',
    title: 'Sync across computers',
    body: "With Kimochi Cloud, your sessions, Notebook and preferences stay in step between your computers, in the background, even after time offline. Changed something in two places at once? The other version is kept for you to restore, and you can export everything any time.",
    Visual: SyncVisual,
    tag: 'cloud',
    link: { to: '/#cloud', label: 'See Kimochi Cloud plans' }
  }
]
