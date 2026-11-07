/**
 * DEV-ONLY: what a preview page lets the UI studio around it do while it runs
 * (`window.__kimochiPreview`, installed by `setupPreview`): move its simulated downloads and
 * dictionary setup along, and change settings, the way native would, without a reload. The
 * studio's flows (frontend/dev/studio/presets.ts) are made of these.
 */
import type { ModelEngine, ModelState } from '@ui/model-download'
import type { ExtensionEngine } from '@ui/extension-download'

export interface DownloadControl<Engine> {
  state(engine: Engine): ModelState
  /** Put the download in a state at once (partway for paused and failed). */
  set(engine: Engine, state: ModelState): void
  /** Pause where it is, as the Pause button does. */
  pause(engine: Engine): void
  /** Download from nothing (or from where it is, with `fresh: false`), failing at `failAt` (0–1). */
  start(engine: Engine, options?: { failAt?: number; fresh?: boolean }): void
}

export interface PreviewControl {
  model: DownloadControl<ModelEngine>
  extension: DownloadControl<ExtensionEngine>
  readiness: {
    /** The dictionary engine's phase now: starting, downloading, installing, setup-needed, ready, failed. */
    phase(engine: string): string
    /** Starting, data downloading, installing, then `end`; or failing partway through the data at `failAt` (0–1). */
    play(engine: string, options?: { end?: 'ready' | 'failed' | 'setup-needed'; failAt?: number; delay?: number }): void
    set(engine: string, phase: 'ready' | 'failed' | 'setup-needed'): void
  }
  /** Save a setting as the app would (every window hears it). */
  setSetting(key: string, value: unknown): void
  setting(key: string): unknown
}

export function installPreviewControl(control: PreviewControl): void {
  ;(window as unknown as { __kimochiPreview: PreviewControl }).__kimochiPreview = control
}

/** The control of a page in a frame, once it has installed it. */
export function previewControlOf(frame: Window | null | undefined): PreviewControl | null {
  try {
    return (frame as unknown as { __kimochiPreview?: PreviewControl } | null)?.__kimochiPreview ?? null
  } catch {
    return null
  }
}
