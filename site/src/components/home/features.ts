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
    title: 'The text, right where it was',
    body: 'Kimochi draws the recognised lines back over the game, in place. Point at a word to look it up; your eyes never leave the scene.',
    Visual: OverlayVisual
  },
  {
    id: 'auto-ocr',
    kicker: 'Scan and Auto OCR',
    title: 'Reads when the text settles',
    body: 'Press Scan when you want a line, or let Auto OCR watch the window. It waits for the text to stop typing out, then reads it once.',
    Visual: AutoScanVisual
  },
  {
    id: 'log',
    kicker: 'Log',
    title: 'Every line, kept',
    body: 'A running transcript of the session. Scroll back to a line you rushed past, select any word, copy it out, or pick up tomorrow where you stopped.',
    Visual: LogVisual
  },
  {
    id: 'dictionary',
    kicker: 'Dictionary',
    title: 'Look up, listen, save to Anki',
    body: 'Lookups use Yomitan and your own dictionaries, bundled and verified. Hear a word or a whole line spoken, ask for an explanation, and send a card to Anki in one click.',
    Visual: DictionaryVisual
  },
  {
    id: 'notebook',
    kicker: 'Notebook',
    title: 'Who is who, and where',
    body: 'Each session keeps a notebook of characters, places and terms. Entries are recognised in new lines, so names and readings stop being a mystery.',
    Visual: NotebookVisual
  },
  {
    id: 'engines',
    kicker: 'OCR engines',
    title: 'The right reader for the game',
    body: 'Apple Live Text on a Mac, OneOCR on Windows 11, or MeikiOCR and manga-ocr running locally on your GPU. Texthookers work too, over the clipboard or a WebSocket.',
    Visual: EnginesVisual
  },
  {
    id: 'controller',
    kicker: 'Steam Deck',
    title: 'Made for the couch too',
    body: 'In Gaming Mode, both sticks open a radial menu. Scan, step through words with the D-pad, press A for the reading and B to get back to the game.',
    Visual: ControllerVisual
  },
  {
    id: 'stats',
    kicker: 'Sessions and stats',
    title: 'See the reading add up',
    body: 'Sessions track reading time, lines and characters read, so a long route turns into a number you can watch grow.',
    Visual: StatsVisual
  }
]
