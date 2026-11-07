/**
 * DEV-ONLY: the UI studio's presets and flows (the Presets tab).
 *
 * A PRESET is a whole starting state in one click: the surface, its URL parameters, its JSON state
 * and where in it to be (a view, a settings page), instead of setting each control by hand. Applying
 * one replaces that surface's state (the appearance, platform and size in the top bar are kept
 * unless the preset names them).
 *
 * A FLOW starts from a preset and then plays a series of steps inside the running page, as if
 * they were happening: a download starting, failing, being retried. Each step acts through the
 * page's control (`window.__kimochiPreview`, frontend/dev/preview-control.ts), so nothing reloads
 * between steps. A step waits `after` ms when played (not when stepped through by hand), runs, and
 * then, with `until`, waits for the page to get there (a download to finish) before the next.
 *
 * Add a preset or a flow by adding it to the lists below.
 */
import type { PreviewControl } from '../preview-control'
import type { Values } from './params'
import type { StudioContext } from './types'

export interface PresetState {
  surface: string
  /** The surface's URL parameters (the State tab's controls, and any other the page reads). */
  values?: Values
  /** JSON state, by key, as text (the State tab's JSON editors). */
  json?: Record<string, string>
  /** Where in the surface to be, e.g. `{ view: 'settings', tab: 'ocr' }`. */
  context?: StudioContext
  /** The top bar's appearance, platform and size; kept as they are when absent. */
  globals?: Values
  /** The window's size on the desk (centred); its usual size when absent. */
  size?: { width: number; height: number }
}

export interface Preset {
  id: string
  label: string
  detail: string
  state: PresetState
}

export interface FlowStep {
  label: string
  /** When played: how long to wait before this step, in ms (default 1500). */
  after?: number
  run?: (page: PreviewControl) => void
  /** Wait, after running, until this holds (checked every 250 ms). */
  until?: (page: PreviewControl) => boolean
  /** How long `until` may take before the flow stops, in ms (default 30 s). */
  timeout?: number
}

export interface Flow {
  id: string
  label: string
  detail: string
  /** The state the flow starts from: the page is reloaded into it. */
  start: PresetState
  steps: readonly FlowStep[]
}

export interface PresetGroup<T> {
  title: string
  items: readonly T[]
}

// ---------------------------------------------------------------- presets

/** Tall enough that the sidebar's OCR model and Dictionary are in view without scrolling. */
const TALL = { width: 900, height: 760 }

export const PRESETS: readonly PresetGroup<Preset>[] = [
  {
    title: 'Main window',
    items: [
      {
        id: 'reset',
        label: 'Reset',
        detail: 'The app as it opens, set up: the Log, a window chosen, Google Lens and Yomitan downloaded.',
        state: { surface: 'main', values: { ext: 'ready' } }
      },
      {
        id: 'first-run',
        label: 'First run',
        detail: 'No source chosen yet, an empty Log and Notebook.',
        state: { surface: 'main', values: { nosource: '1', empty: '1', ext: 'ready' } }
      },
      {
        id: 'all-downloading',
        label: 'Everything setting up',
        detail: 'MeikiOCR downloading; Hachidori downloading, then starting and fetching its dictionaries.',
        state: { surface: 'main', values: { ocr: 'meikiocr', model: 'downloading', popup: 'hachidori', ext: 'downloading', readiness: 'setup' }, size: TALL }
      }
    ]
  },
  {
    title: 'Needs attention',
    items: [
      {
        id: 'ocr-absent',
        label: 'OCR model not downloaded',
        detail: 'Manga OCR chosen, its model never downloaded.',
        state: { surface: 'main', values: { ocr: 'mangaocr', ext: 'ready' }, size: TALL }
      },
      {
        id: 'ocr-failed',
        label: 'OCR model download failed',
        detail: 'MeikiOCR chosen, its download stopped partway.',
        state: { surface: 'main', values: { ocr: 'meikiocr', model: 'failed', ext: 'ready' }, size: TALL }
      },
      {
        id: 'dict-absent',
        label: 'Dictionary not downloaded',
        detail: 'Hachidori chosen, not downloaded.',
        state: { surface: 'main', values: { popup: 'hachidori', ext: 'absent' }, size: TALL }
      },
      {
        id: 'dict-failed',
        label: 'Dictionary setup failed',
        detail: 'Hachidori downloaded, but it could not start.',
        state: { surface: 'main', values: { popup: 'hachidori', ext: 'ready', readiness: 'failed' }, size: TALL }
      },
      {
        id: 'dict-setup',
        label: 'Dictionary needs setting up',
        detail: 'Hachidori running with no dictionary installed.',
        state: { surface: 'main', values: { popup: 'hachidori', ext: 'ready', readiness: 'setup-needed' }, size: TALL }
      }
    ]
  }
]

// ---------------------------------------------------------------- flows

/** Reading with Google Lens and Yomitan; MeikiOCR installed, the other local engines not. */
const LENS: PresetState = { surface: 'main', values: { ext: 'ready' }, size: TALL }
/** Yomitan in use; Hachidori chosen but not downloaded yet. */
const HACHIDORI_ABSENT: PresetState = { surface: 'main', values: { popup: 'hachidori', ext: 'absent' }, size: TALL }
/** How long the preview's dictionary-engine download takes, verifying included. */
const EXT_DOWNLOAD_MS = 6200

const modelReady = (p: PreviewControl): boolean => p.model.state('mangaocr') === 'ready'
const dictReady = (p: PreviewControl): boolean => p.readiness.phase('hachidori') === 'ready'

export const FLOWS: readonly PresetGroup<Flow>[] = [
  {
    title: 'OCR model',
    items: [
      {
        id: 'ocr-download',
        label: 'Download a new OCR model',
        detail: 'Switch from Google Lens to Manga OCR, whose model downloads across its five files.',
        start: LENS,
        steps: [
          { label: 'Reading with Google Lens', after: 0 },
          {
            label: 'Choose Manga OCR: its model downloads',
            run: (p) => p.setSetting('ocrMode', 'mangaocr'),
            until: modelReady
          },
          { label: 'Ready to read', after: 600 }
        ]
      },
      {
        id: 'ocr-download-fails',
        label: 'OCR model download fails, then a retry',
        detail: 'The download stops partway; retried from Settings, it finishes.',
        start: LENS,
        steps: [
          { label: 'Reading with Google Lens', after: 0 },
          {
            label: 'Choose Manga OCR: the download fails at 55%',
            run: (p) => {
              p.model.start('mangaocr', { failAt: 0.55 })
              p.setSetting('ocrMode', 'mangaocr')
            },
            until: (p) => p.model.state('mangaocr') === 'failed'
          },
          {
            label: 'Retry: it carries on from there',
            after: 2500,
            run: (p) => p.model.start('mangaocr', { fresh: false }),
            until: modelReady
          }
        ]
      },
      {
        id: 'ocr-download-paused',
        label: 'OCR model download paused, then resumed',
        detail: 'Paused partway (from Settings), then resumed to the end.',
        start: LENS,
        steps: [
          { label: 'Reading with Google Lens', after: 0 },
          { label: 'Choose Manga OCR: its model downloads', run: (p) => p.setSetting('ocrMode', 'mangaocr') },
          { label: 'Pause the download', after: 3000, run: (p) => p.model.pause('mangaocr') },
          { label: 'Resume it', after: 2500, run: (p) => p.model.start('mangaocr', { fresh: false }), until: modelReady }
        ]
      }
    ]
  },
  {
    title: 'Dictionary',
    items: [
      {
        id: 'dict-download',
        label: 'Download and set up a new dictionary',
        detail: 'Hachidori downloads, starts, fetches its dictionary data and installs it: one bar.',
        start: HACHIDORI_ABSENT,
        steps: [
          { label: 'Hachidori is not downloaded yet', after: 0 },
          {
            label: 'Download it: then it starts, fetches its data and installs',
            run: (p) => {
              p.readiness.play('hachidori', { delay: EXT_DOWNLOAD_MS })
              p.extension.start('hachidori')
            },
            until: dictReady
          },
          { label: 'Ready to look words up', after: 600 }
        ]
      },
      {
        id: 'dict-download-fails',
        label: 'Dictionary download fails, then a retry',
        detail: 'The engine download stops partway; retried, it finishes and sets up.',
        start: HACHIDORI_ABSENT,
        steps: [
          { label: 'Hachidori is not downloaded yet', after: 0 },
          {
            label: 'Download it: it fails at 60%',
            run: (p) => p.extension.start('hachidori', { failAt: 0.6 }),
            until: (p) => p.extension.state('hachidori') === 'failed'
          },
          {
            label: 'Retry: it finishes, then sets up',
            after: 2500,
            run: (p) => {
              p.readiness.play('hachidori', { delay: 3200 })
              p.extension.start('hachidori', { fresh: false })
            },
            until: dictReady
          }
        ]
      },
      {
        id: 'dict-data-fails',
        label: 'Dictionary data download fails',
        detail: 'Hachidori is downloaded and starts, but fetching its dictionary data fails partway.',
        start: { surface: 'main', values: { popup: 'hachidori', ext: 'ready' }, size: TALL },
        steps: [
          { label: 'Hachidori is downloaded', after: 0 },
          {
            label: 'It starts and fetches its data: that fails at 45%',
            run: (p) => p.readiness.play('hachidori', { failAt: 0.45 }),
            until: (p) => p.readiness.phase('hachidori') === 'failed'
          }
        ]
      },
      {
        id: 'dict-needs-setup',
        label: 'Dictionary sets up with nothing installed',
        detail: 'Hachidori starts but has no dictionary to use, and asks to be set up.',
        start: { surface: 'main', values: { popup: 'hachidori', ext: 'ready' }, size: TALL },
        steps: [
          { label: 'Hachidori is downloaded', after: 0 },
          {
            label: 'It starts, then needs a dictionary',
            run: (p) => p.readiness.play('hachidori', { end: 'setup-needed' }),
            until: (p) => p.readiness.phase('hachidori') === 'setup-needed'
          }
        ]
      }
    ]
  }
]
