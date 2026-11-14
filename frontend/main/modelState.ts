/**
 * The sidebar's OCR model, while the selected local engine's model is not ready: a fill inside the
 * select while it downloads (one bar over every file, `overallReceived` of `overallTotal`) or
 * verifies, or a short notice under it, with a way to Settings → OCR (where the download
 * is managed), when it is paused, failed or missing. Nothing once it is ready, and nothing for
 * engines without a model to download.
 */
import { badgeKind, badgeLabel, isModelEngine, percent } from '@ui/model-download'
import { useModelStatus } from '../bridge/models'
import type { FieldProgress } from './fieldProgress'

export interface ModelState {
  busy: FieldProgress | null
  /** Needs the reader: a few words for the notice, and the whole story for its tooltip. */
  notice: { text: string; title: string } | null
}

export function useOcrModelState(engine: string): ModelState {
  const status = useModelStatus(isModelEngine(engine) ? engine : null)
  const kind = badgeKind(status)
  if (!status || !kind) return { busy: null, notice: null }
  const title = badgeLabel(status)
  if (kind === 'progress') {
    if (status.state === 'verifying')
      return { busy: { value: 100, exact: false, short: 'Verifying…', title }, notice: null }
    const value = percent(status.overallReceived, status.overallTotal)
    return { busy: { value, exact: true, short: `${value}%`, title }, notice: null }
  }
  const text =
    status.state === 'paused'
      ? 'Model download paused.'
      : status.state === 'failed'
        ? 'Model download failed.'
        : 'Model not downloaded yet.'
  return { busy: null, notice: { text, title } }
}
