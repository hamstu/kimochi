/**
 * Settings → OCR, under the engine: the selected local engine's model. Its size, where its
 * download stands (overall and per-file progress), and the actions that make sense now:
 * Download, Pause, Resume, Retry, Cancel or Delete.
 *
 * Self-contained: the download runs in Rust (`model_store.rs`) and survives this window closing;
 * this only shows its `model-download` events and sends the commands.
 */
import { useState, type ReactNode } from 'react'
import { Button, Callout, ConfirmDialog, SettingsRow, SettingsSection } from '@kit'
import {
  formatBytes,
  modelActions,
  percent,
  progressText,
  showsProgress,
  stateLabel,
  type ModelAction,
  type ModelStatus
} from '@ui/model-download'
import { modelAction, useModelStatus, type ModelEngine } from '../../bridge/models'
import { nativeError } from '../../bridge/tauri'
import './model-download.css'

const ACTION_LABELS: Record<ModelAction, string> = {
  download: 'Download',
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
  cancel: 'Cancel',
  delete: 'Delete'
}

function ProgressBar({
  label,
  value,
  detail
}: {
  label: string
  value: number
  detail: string
}): ReactNode {
  return (
    <div className="model-progress">
      <div className="model-progress-text">
        <span className="model-progress-label">{label}</span>
        <span className="model-progress-detail k-num">{detail}</span>
      </div>
      <div
        className="model-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div className="model-progress-fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

function description(status: ModelStatus): ReactNode {
  const size = formatBytes(status.overallTotal)
  switch (status.state) {
    case 'absent':
      return `Not downloaded. This engine needs its ${size} model, downloaded once and kept on this computer.`
    case 'ready':
      return status.source === 'downloaded'
        ? `Downloaded · ${size}. Stored on this computer; delete it to free the space.`
        : `${stateLabel(status)} · ${size}.`
    case 'paused':
      return `${stateLabel(status)} · ${progressText(status.overallReceived, status.overallTotal)}. Scans with this engine wait until it finishes.`
    case 'failed':
      return `${stateLabel(status)}. Retry continues from what has already arrived.`
    default:
      return `${stateLabel(status)} · ${size}. Scans with this engine start once it finishes.`
  }
}

export function ModelDownloadCard({ engine }: { engine: ModelEngine }): ReactNode {
  const status = useModelStatus(engine)
  const [pending, setPending] = useState<ModelAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // A backend without model downloads says nothing.
  if (!status || status.engine !== engine) return null

  const run = (action: ModelAction): void => {
    setPending(action)
    setError(null)
    modelAction(engine, action)
      .catch((e) => setError(nativeError(e).message))
      .finally(() => setPending(null))
  }
  const actions = modelActions(status)
  const overall = percent(status.overallReceived, status.overallTotal)
  const fileProgress =
    status.state === 'downloading' && status.file && status.totalBytes
      ? {
          value: percent(status.receivedBytes ?? 0, status.totalBytes),
          detail: progressText(status.receivedBytes ?? 0, status.totalBytes)
        }
      : null

  return (
    <SettingsSection title="Model">
      <SettingsRow label={`${status.name} model`} description={description(status)}>
        {actions.length > 0 && (
          <div className="model-actions">
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={
                  action === 'delete'
                    ? 'danger'
                    : action === 'cancel' || action === 'pause'
                      ? 'secondary'
                      : 'primary'
                }
                disabled={pending !== null}
                onClick={() => (action === 'delete' ? setConfirmDelete(true) : run(action))}
              >
                {ACTION_LABELS[action]}
              </Button>
            ))}
          </div>
        )}
      </SettingsRow>
      {showsProgress(status) && (
        <div className="model-progress-group" aria-live="polite">
          <ProgressBar
            label={status.state === 'verifying' ? 'Verifying' : 'Overall'}
            value={overall}
            detail={`${progressText(status.overallReceived, status.overallTotal)} · ${overall}%`}
          />
          {fileProgress && status.file && (
            <ProgressBar
              label={status.file}
              value={fileProgress.value}
              detail={fileProgress.detail}
            />
          )}
        </div>
      )}
      {(status.state === 'failed' && status.message) || error ? (
        <div className="settings-note">
          <Callout tone="danger">{error ?? status.message}</Callout>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete the ${status.name} model?`}
        description={`This frees ${formatBytes(status.overallTotal)}. Choosing ${status.name} again downloads it again.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          setConfirmDelete(false)
          run('delete')
        }}
      />
    </SettingsSection>
  )
}
