import type { ComponentType } from 'react'
import { ClickThroughVisual } from './visuals/ClickThroughVisual'
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
}

/**
 * The home page feature grid, in order. Adding a feature = one entry here plus one visual
 * component. Keep bodies to two or three sentences; the grid is two columns from md up, so an
 * even count reads best.
 */
export const features: Feature[] = [
  {
    id: 'overlay',
    title: 'Cross Platform Overlay',
    body: "When the overlay is on, you'll be able to hover directly over the words in your game, app, YouTube video, manga, or anything else on your screen.",
    Visual: OverlayVisual,
    docs: '/reading/overlay/'
  },
  {
    id: 'mini-mode',
    title: 'Mini mode',
    body: 'Shrink Kimochi down to just its controls: your source, Auto OCR, the overlay, your OCR model and dictionary, in a slim window that sits beside your game, video or manga. Expand it again whenever you want the Log.',
    Visual: MiniModeVisual,
    docs: '/reading/mini-mode/'
  },
  {
    id: 'log',
    title: 'Log',
    body: 'Skipped a line too fast? Scroll back. Pick up tomorrow where you left off. Kimochi always remembers. No need for external texthooker pages. 👌',
    Visual: LogVisual,
    docs: '/log/the-log/'
  },
  {
    id: 'sessions',
    title: 'Sessions',
    body: 'Keep a separate log for every game, visual novel or manga, each with its own lines and reading stats. Kimochi can switch sessions for you by window name, and you can rename, reorder or clear them any time.',
    Visual: SessionsVisual,
    docs: '/log/sessions/'
  },
  {
    id: 'dictionary',
    title: 'Look up and save',
    body: "Whether it's in the overlay or in the log, you'll be able to easily look up definitions with your favorite dictionary tool.",
    Visual: DictionaryVisual,
    docs: '/lookups/looking-up/'
  },
  {
    id: 'dictionaries',
    title: 'Dictionaries',
    body: 'Pick the dictionary you like: Kimochi supports an embedded copy of Yomitan, Hachidori, 10ten, or you can point at your own Yomitan and existing dictionaries through the Yomitan API. ✨',
    Visual: DictionariesVisual,
    docs: '/lookups/dictionaries/'
  },
  {
    id: 'notebook',
    title: 'Notebook',
    body: 'I built this one for myself, especially! Select some text from the log to add characters, places or terms to a shared notebook. Link images and notes, too. Kimochi then highlights it as clickable in your log for easy remembering.',
    Visual: NotebookVisual,
    docs: '/log/notebook/'
  },
  {
    id: 'engines',
    title: 'OCR engines',
    body: "Kimochi gives you complete control over choosing the OCR engine and provides several options depending on what you're doing (e.g., if you prefer Cloud vs. Local).",
    Visual: EnginesVisual,
    docs: '/reading/ocr-engines/'
  },
  {
    id: 'texthookers',
    title: 'Texthookers and clipboard',
    body: 'Already hooking text out of a visual novel? Point Kimochi at your texthooker over WebSocket, or just copy lines to the clipboard. They land in the same Log, with the same lookups, Notebook and stats.',
    Visual: InputsVisual,
    docs: '/reading/texthookers/'
  },
  {
    id: 'text-hooker',
    title: 'Text Hooker (Windows)',
    body: "On Windows, Kimochi can read a game's text straight from the game, no OCR needed. It fetches a text hooker the first time (LunaHook, or Textractor as a fallback), picks out the dialogue by matching it to what's on screen, and shows each line in a card over the game, ready to look up.",
    Visual: TextHookerVisual,
    docs: '/reading/text-hooker/'
  },
  {
    id: 'click-through',
    title: 'Clicks go through to the game',
    body: "Overlay text sitting on your game's buttons? It won't get in the way: clicks on it go straight to the game. Hold Shift when you want to look a word up or click the text. Prefer the old way? Switch it off in Settings. (On Linux with Wayland, the overlay keeps the old behaviour.)",
    Visual: ClickThroughVisual,
    docs: '/reading/overlay/#clicking-through-to-the-game'
  },
  {
    id: 'controller',
    title: 'Gaming Mode',
    body: "In Gaming Mode you can activate Kimochi's shortcut (Click both sticks) to scan. Then pick a word with the D-pad for quick look-ups. Hit B and you’re back in the game. This works great on something like a Steam Deck!",
    Visual: ControllerVisual,
    docs: '/controller/gaming-mode/'
  }
]
