/**
 * The self-update's progress bar: the same track, fill and motion as the model downloads
 * (`model-download.css`), so an update looks like every other download in the app. Shown only
 * while bytes arrive or the swap is under way; the caller decides (`showsBar`).
 */
import type { ReactNode } from 'react'
import { barPercent, downloadProgress, isIndeterminate, type UpdateStatus } from '@ui/update'
import '../panels/settings/model-download.css'

/**
 * The model bar's visual states, which the update's map onto: anything without a measurable
 * progress (the swap, a download of unknown size) gets the full bar with the sweeping highlight.
 */
function barState(status: UpdateStatus): string {
  if (isIndeterminate(status)) return 'verifying'
  switch (status.state) {
    case 'ready':
      return 'ready'
    case 'failed':
      return 'failed'
    default:
      return 'downloading'
  }
}

export function UpdateBar({ status, label }: { status: UpdateStatus; label: string }): ReactNode {
  const value = barPercent(status)
  const indeterminate = isIndeterminate(status)
  return (
    <span className="model-progress" data-state={barState(status)} data-bar="shown">
      <span
        className="model-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuetext={status.state === 'downloading' ? downloadProgress(status) : undefined}
      >
        <span
          className="model-progress-fill"
          style={{ transform: `scaleX(${(indeterminate ? 100 : value) / 100})` }}
        />
      </span>
    </span>
  )
}
