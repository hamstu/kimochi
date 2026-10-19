import type { ComponentType } from 'react'
import { AutoScanVisual } from './visuals/AutoScanVisual'
import { ControllerVisual } from './visuals/ControllerVisual'
import { DictionaryVisual } from './visuals/DictionaryVisual'
import { EnginesVisual } from './visuals/EnginesVisual'
import { LogVisual } from './visuals/LogVisual'
import { NotebookVisual } from './visuals/NotebookVisual'
import { OverlayVisual } from './visuals/OverlayVisual'
import { StatsVisual } from './visuals/StatsVisual'

export interface Feature {
  /** Stable key (also usable as an anchor). */
  id: string
  /** Short label above the title, e.g. the window or concept name. */
  kicker: string
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
    kicker: 'Overlay',
    title: 'Text, right where it was',
    body: 'The words go back on top of the game, right where they were. Hover one to look it up.',
    Visual: OverlayVisual
  },
  {
    id: 'auto-ocr',
    kicker: 'Auto OCR',
    title: 'Waits for the line to finish',
    body: 'Hit Scan, or let it watch. It waits for the text to finish typing out, then reads it.',
    Visual: AutoScanVisual
  },
  {
    id: 'log',
    kicker: 'Log',
    title: 'Every line, saved',
    body: 'Skipped a line too fast? Scroll back. Pick up tomorrow where you left off.',
    Visual: LogVisual
  },
  {
    id: 'dictionary',
    kicker: 'Dictionary',
    title: 'Look it up, hear it, keep it',
    body: 'Yomitan is built in. Hear a line read out, ask what it means, or send it to Anki in one click.',
    Visual: DictionaryVisual
  },
  {
    id: 'notebook',
    kicker: 'Notebook',
    title: 'Who’s who',
    body: 'Jot down characters, places and terms. Kimochi spots them in new lines, so you stop forgetting names.',
    Visual: NotebookVisual
  },
  {
    id: 'engines',
    kicker: 'OCR engines',
    title: 'Pick your OCR',
    body: 'Live Text on a Mac, OneOCR on Windows, or local models on your GPU. Texthookers work too.',
    Visual: EnginesVisual
  },
  {
    id: 'controller',
    kicker: 'Steam Deck',
    title: 'Couch friendly',
    body: 'Works in Gaming Mode. Click both sticks, scan, pick a word with the D-pad, then B and you’re back.',
    Visual: ControllerVisual
  },
  {
    id: 'stats',
    kicker: 'Sessions and stats',
    title: 'Watch it add up',
    body: 'Time read, lines, characters. It’s nice seeing the number go up.',
    Visual: StatsVisual
  }
]
