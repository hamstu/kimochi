/**
 * The small picture beside an engine's name: the project's own logo where it has one, a neutral
 * tile otherwise. Used by the engine choosers in Settings (OCR & Overlay, Dictionary) and by
 * onboarding's dictionary step, so both places show the same pictures.
 *
 * Every picture is the same 22 px rounded square. Logos that are already a full tile (Yomitan,
 * 10ten, Kimochi) fill it; bare marks (Google Lens, Hachidori's bird, the Windows logo) sit inside
 * the neutral tile at the same size as the glyphs, so no logo looks bigger than another.
 *
 * Logos are the files in frontend/assets/engine-icons/ (sources and licences in the README there
 * and in NOTICE). Apple Live Text has no logo of its own here, so it gets a lucide glyph in the
 * neutral tile; MeikiOCR and Manga OCR publish none, so they get a monogram in the same tile.
 * PaddleOCR's only marks are wordmarks, unreadable at this size, so it gets a paddle drawn here in
 * lucide's style.
 * The pictures are decorative: the engine's name always sits beside them.
 */
import type { ReactNode } from 'react'
import { Cloud, Monitor, ScanText } from 'lucide-react'
import { OCR_MODES, type OcrMode } from '../bridge/settings'
import { DICTIONARY_ENGINES, type DictionaryEngine } from '../bridge/dictionaryEngine'
import yomitan from '../assets/engine-icons/yomitan.svg'
import yomitanApi from '../assets/engine-icons/yomitan-api.svg'
import hachidori from '../assets/engine-icons/hachidori.png'
import tenten from '../assets/engine-icons/tenten.svg'
import googleLens from '../assets/engine-icons/google-lens.svg'
import kimochiCloud from '../assets/engine-icons/kimochi-cloud.svg'
import windows from '../assets/engine-icons/windows.svg'
import './engine-icon.css'

/** `tile`: a bare mark drawn inside the neutral tile rather than filling the square itself. */
type Picture = { src: string; tile?: boolean } | { glyph: ReactNode } | { monogram: string; lang?: string }

/** A paddle, for PaddleOCR: lucide's grid and stroke, so it sits in the tile like `ScanText`. */
function Paddle(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.5 11.5 5 19" />
      <path d="m3 17 4 4" />
      <rect x="9.6" y="4.6" width="13.4" height="5.6" rx="2.8" transform="rotate(-45 16.3 7.4)" />
    </svg>
  )
}

const OCR_PICTURES: Record<OcrMode, Picture> = {
  googlelens: { src: googleLens, tile: true },
  cloud: { src: kimochiCloud },
  meikiocr: { monogram: 'M' },
  mangaocr: { monogram: '漫', lang: 'ja' },
  ppocr: { glyph: <Paddle /> },
  livetext: { glyph: <ScanText /> },
  oneocr: { src: windows, tile: true }
}

const DICTIONARY_PICTURES: Record<DictionaryEngine, Picture> = {
  yomitan: { src: yomitan },
  'custom-api': { src: yomitanApi },
  hachidori: { src: hachidori, tile: true },
  tenten: { src: tenten }
}

function EngineIcon({ picture, className }: { picture: Picture; className?: string }): ReactNode {
  const classes = ['engine-icon', className].filter(Boolean).join(' ')
  if ('src' in picture && !picture.tile) {
    return <img className={classes} src={picture.src} alt="" aria-hidden draggable={false} />
  }
  if ('src' in picture) {
    return (
      <span className={`${classes} engine-icon-tile`} aria-hidden>
        <img src={picture.src} alt="" draggable={false} />
      </span>
    )
  }
  return (
    <span className={`${classes} engine-icon-tile`} aria-hidden lang={'lang' in picture ? picture.lang : undefined}>
      {'glyph' in picture ? picture.glyph : picture.monogram}
    </span>
  )
}

/** Where the engine runs, as an icon: this computer, or a service across the network. */
export function OcrRunsIcon({ mode }: { mode: OcrMode }): ReactNode {
  const local = OCR_MODES[mode].runs === 'local'
  return (
    <span className="engine-runs" title={local ? 'Runs on this computer' : 'Runs online'}>
      {local ? <Monitor aria-label="On this computer" /> : <Cloud aria-label="Online" />}
    </span>
  )
}

/** Where a dictionary engine runs: this computer, or a server across the network. */
export function DictionaryRunsIcon({ engine }: { engine: DictionaryEngine }): ReactNode {
  const local = DICTIONARY_ENGINES[engine].runs === 'local'
  return (
    <span className="engine-runs" title={local ? 'Runs on this computer' : 'Uses a server'}>
      {local ? <Monitor aria-label="On this computer" /> : <Cloud aria-label="Uses a server" />}
    </span>
  )
}

export function OcrEngineIcon({ mode, className }: { mode: OcrMode; className?: string }): ReactNode {
  return <EngineIcon picture={OCR_PICTURES[mode]} className={className} />
}

export function DictionaryEngineIcon({
  engine,
  className
}: {
  engine: DictionaryEngine
  className?: string
}): ReactNode {
  return <EngineIcon picture={DICTIONARY_PICTURES[engine]} className={className} />
}
