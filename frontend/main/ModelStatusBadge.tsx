/**
 * Beside the sidebar's "OCR model" label: the selected local engine's model download. A spinner
 * and percentage while it downloads or verifies; a warning when it is paused, failed or missing
 * (click it for Settings → OCR, where the download is managed); nothing once it is ready, and
 * nothing for engines without a model to download.
 */
import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Spinner, Tooltip } from '@kit'
import { badgeKind, badgeLabel, isModelEngine, percent } from '@ui/model-download'
import { useModelStatus } from '../bridge/models'
import './model-status-badge.css'

export function ModelStatusBadge({
  engine,
  onOpenSettings
}: {
  /** The selected `ocrMode`. */
  engine: string
  onOpenSettings: () => void
}): ReactNode {
  const status = useModelStatus(isModelEngine(engine) ? engine : null)
  const kind = badgeKind(status)
  if (!status || !kind) return null
  const label = badgeLabel(status)
  if (kind === 'progress') {
    return (
      <Tooltip content={label}>
        <span className="sb-model-badge">
          <Spinner label={label} />
          {status.state === 'downloading' && (
            <span className="k-num">{percent(status.overallReceived, status.overallTotal)}%</span>
          )}
        </span>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="sb-model-badge sb-model-badge-warning"
        aria-label={label}
        onClick={onOpenSettings}
      >
        <TriangleAlert />
      </button>
    </Tooltip>
  )
}
