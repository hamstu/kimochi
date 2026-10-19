import type { ComponentType } from 'react'
import { AutoScanVisual } from './visuals/AutoScanVisual'
import { ControllerVisual } from './visuals/ControllerVisual'
import { DictionariesVisual } from './visuals/DictionariesVisual'
import { DictionaryVisual } from './visuals/DictionaryVisual'
import { EnginesVisual } from './visuals/EnginesVisual'
import { LogVisual } from './visuals/LogVisual'
import { NotebookVisual } from './visuals/NotebookVisual'
import { OverlayVisual } from './visuals/OverlayVisual'

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
    title: 'Overlay',
    body: 'The words go back on top of the game, right where they were. Hover one to look it up.',
    Visual: OverlayVisual
  },
  {
    id: 'auto-ocr',
    title: 'Auto OCR',
    body: 'Hit Scan, or let it watch. It waits for the text to finish typing out, then reads it.',
    Visual: AutoScanVisual
  },
  {
    id: 'log',
    title: 'Log',
    body: 'Skipped a line too fast? Scroll back. Pick up tomorrow where you left off.',
    Visual: LogVisual
  },
  {
    id: 'dictionary',
    title: 'Look up and save',
    body: 'Hear a line read out, ask what it means, or send a word to Anki in one click.',
    Visual: DictionaryVisual
  },
  {
    id: 'dictionaries',
    title: 'Dictionaries',
    body: 'Pick the dictionary you like: the built-in Yomitan with your own dictionaries, Hachidori, 10ten, or the Yomitan you already use, through its API.',
    Visual: DictionariesVisual
  },
  {
    id: 'notebook',
    title: 'Notebook',
    body: 'Jot down characters, places and terms. Kimochi spots them in new lines, so you stop forgetting names.',
    Visual: NotebookVisual
  },
  {
    id: 'engines',
    title: 'OCR engines',
    body: 'Live Text on a Mac, OneOCR on Windows, or local models on your GPU. Texthookers work too.',
    Visual: EnginesVisual
  },
  {
    id: 'controller',
    title: 'Steam Deck',
    body: 'Works in Gaming Mode. Click both sticks, scan, pick a word with the D-pad, then B and you’re back.',
    Visual: ControllerVisual
  }
]
