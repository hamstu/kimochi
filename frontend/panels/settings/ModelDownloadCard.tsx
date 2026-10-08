/**
 * Settings → OCR, under the engine: the selected local engine's model. One progress bar, one
 * status line under it ("Downloading Manga OCR · 212 MB of 539 MB", "Paused at 40%", "Ready ·
 * 539 MB"), and the actions that make sense now: Download, Pause, Resume, Retry, Cancel or
 * Delete. Download is offered here without a further dialog: the button, which names the size,
 * is the consent.
 *
 * Self-contained: the download runs in Rust (`model_store.rs`) and survives this window closing;
 * this only shows its `model-download` events and sends the commands.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Callout, ConfirmDialog, SettingsRow, SettingsSection } from '@kit'
import {
  actionLabel,
  barPercent,
  formatBytes,
  modelActions,
  showsBar,
  statusLine,
  type ModelAction,
  type ModelStatus
} from '@ui/model-download'
import { modelAction, useModelStatus, type ModelEngine } from '../../bridge/models'
import { nativeError } from '../../bridge/tauri'
import './model-download.css'

/** How long the bar stays mounted while it fades out; matches the exit transition in the CSS. */
const BAR_EXIT_MS = 400

/**
 * The line, with the bar above it only while a download is under way. Spans, since they sit
 * inside the row's description paragraph. The fill is scaled rather than resized so the ~4 Hz
 * progress events glide (see model-download.css). When the download completes the bar stays
 * mounted for one exit transition, full and green, then collapses, rather than vanishing on the
 * same frame the last byte lands.
 */
function ModelProgress({ status }: { status: ModelStatus }): ReactNode {
  const value = barPercent(status)
  const line = statusLine(status)
  const active = showsBar(status)
  // Lingering: the bar has just gone inactive and is playing its exit. Set during render when
  // `active` flips, which is React's way of deriving state from a prop change; the effect only
  // ends it.
  const [wasActive, setWasActive] = useState(active)
  const [lingering, setLingering] = useState(false)
  if (wasActive !== active) {
    setWasActive(active)
    setLingering(!active)
  }
  useEffect(() => {
    if (!lingering) return
    const timer = window.setTimeout(() => setLingering(false), BAR_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [lingering])
  return (
    <span className="model-progress" data-state={status.state} data-bar={active ? 'shown' : 'leaving'}>
      {(active || lingering) && (
        <span
          className="model-progress-track"
          role="progressbar"
          aria-label={`${status.name} model`}
          aria-valuemin={0}
          aria-valuemax={100}
          // Verifying has no measurable progress: leaving the value out makes it indeterminate.
          aria-valuenow={status.state === 'verifying' ? undefined : value}
          aria-valuetext={line}
        >
          <span className="model-progress-fill" style={{ transform: `scaleX(${value / 100})` }} />
        </span>
      )}
      <span className="model-progress-line k-num">{line}</span>
    </span>
  )
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

  return (
    <SettingsSection title="Model">
      <SettingsRow label={`${status.name} model`} description={<ModelProgress status={status} />}>
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
                {actionLabel(action, status)}
              </Button>
            ))}
          </div>
        )}
      </SettingsRow>
      {error && (
        <div className="settings-note">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete the ${status.name} model?`}
        description={`This frees ${formatBytes(status.overallTotal)}. You can download it again from here at any time.`}
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
