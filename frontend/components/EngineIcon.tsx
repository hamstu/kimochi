/**
 * The small picture beside an engine's name: the project's own logo where it has one, a neutral
 * tile otherwise. Used by the engine choosers in Settings (OCR, Dictionary) and by
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
import { Cloud, Monitor } from 'lucide-react'
import { ocrModeInfo, type OcrMode } from '../bridge/settings'
import { DICTIONARY_ENGINES, type DictionaryEngine } from '../bridge/dictionaryEngine'
import yomitan from '../assets/engine-icons/yomitan.svg'
import yomitanApi from '../assets/engine-icons/yomitan-api.svg'
import hachidori from '../assets/engine-icons/hachidori.png'
import tenten from '../assets/engine-icons/tenten.svg'
import { OCR_PICTURES, type Picture } from './enginePictures'
import './engine-icon.css'

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
  const local = ocrModeInfo(mode).runs === 'local'
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
