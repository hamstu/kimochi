/**
 * The closed OCR model and Dictionary selects: the engine's picture, name and where it runs; and,
 * while its setup is under way, the same select filling up behind its text like a progress bar,
 * with the percentage (or the step, where there is no number) in place of where it runs. Nothing
 * is added under the select, so the sidebar does not move.
 */
import type { ReactNode } from 'react'
import type { FieldProgress } from './fieldProgress'

export function EngineValue({
  picture,
  name,
  runs,
  busy
}: {
  picture: ReactNode
  name: string
  runs: ReactNode
  busy: FieldProgress | null
}): ReactNode {
  return (
    <span className="sb-engine-option">
      {picture}
      <span className="sb-engine-option-name">{name}</span>
      {busy ? <span className="sb-engine-status k-num">{busy.short}</span> : runs}
    </span>
  )
}
