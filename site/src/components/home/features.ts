import type { ComponentType } from 'react'
import { ControllerVisual } from './visuals/ControllerVisual'
import { DictionariesVisual } from './visuals/DictionariesVisual'
import { DictionaryVisual } from './visuals/DictionaryVisual'
import { EnginesVisual } from './visuals/EnginesVisual'
import { LogVisual } from './visuals/LogVisual'
import { MiniModeVisual } from './visuals/MiniModeVisual'
import { NotebookVisual } from './visuals/NotebookVisual'
import { OverlayVisual } from './visuals/OverlayVisual'
import { SessionsVisual } from './visuals/SessionsVisual'

export interface Feature {
  /** Stable key (also usable as an anchor). */
  id: string
  /** The feature's name, shown as the card's title. */
  title: string
  body: string
  /** A self-contained drawing in src/components/home/visuals/, rendered in a <VisualFrame>. */
  Visual: ComponentType
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
    Visual: OverlayVisual
  },
  {
    id: 'mini-mode',
    title: 'Mini mode',
    body: 'Shrink Kimochi down to just its controls: your source, Auto OCR, the overlay, your OCR model and dictionary, in a slim window that sits beside your game. Expand it again whenever you want the Log.',
    Visual: MiniModeVisual
  },
  {
    id: 'log',
    title: 'Log',
    body: 'Skipped a line too fast? Scroll back. Pick up tomorrow where you left off. Kimochi always remembers. No need for external texthooker pages. 👌',
    Visual: LogVisual
  },
  {
    id: 'sessions',
    title: 'Sessions',
    body: 'Keep a separate log for every game, visual novel or manga, each with its own lines and reading stats. Kimochi can switch sessions for you by window name, and you can rename, reorder or clear them any time.',
    Visual: SessionsVisual
  },
  {
    id: 'dictionary',
    title: 'Look up and save',
    body: "Whether it's in the overlay or in the log, you'll be able to easily look up definitions with your favorite dictionary tool.",
    Visual: DictionaryVisual
  },
  {
    id: 'dictionaries',
    title: 'Dictionaries',
    body: 'Pick the dictionary you like: Kimochi supports an embedded copy of Yomitan, Hachidori, 10ten, or you can point at your own Yomitan and existing dictionaries through the Yomitan API. ✨',
    Visual: DictionariesVisual
  },
  {
    id: 'notebook',
    title: 'Notebook',
    body: 'I built this one for myself, especially! Select some text from the log to add characters, places or terms to a shared notebook. Link images and notes, too. Kimochi then highlights it as clickable in your log for easy remembering.',
    Visual: NotebookVisual
  },
  {
    id: 'engines',
    title: 'OCR engines',
    body: "Kimochi gives you complete control over choosing the OCR engine and provides several options depending on what you're doing (e.g., if you prefer Cloud vs. Local).",
    Visual: EnginesVisual
  },
  {
    id: 'controller',
    title: 'Gaming Mode',
    body: "In Gaming Mode you can activate Kimochi's shortcut (Click both sticks) to scan. Then pick a word with the D-pad for quick look-ups. Hit B and you’re back in the game.",
    Visual: ControllerVisual
  }
]
