/**
 * Settings → OCR & Overlay → a local engine's detail panel (`EngineChooser`): its model. One
 * progress bar, one status line under it ("Downloading Manga OCR · 212 MB of 539 MB", "Paused at
 * 40%", "Ready · 539 MB"), and the actions that make sense now: Download, Pause, Resume, Retry or
 * Cancel. Download is offered here without a further dialog: the button, which names the size,
 * is the consent. Removing a downloaded model is not a button here but an item in the panel's
 * overflow menu, confirmed by `RemoveModelDialog`.
 *
 * The download runs in Rust (`model_store.rs`) and survives this window closing; this only shows
 * its `model-download` events and sends the commands.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Callout, ConfirmDialog } from '@kit'
import {
  actionLabel,
  barPercent,
  formatBytes,
  primaryModelActions,
  showsBar,
  statusLine,
  type DownloadStatus,
  type ModelAction
} from '@ui/model-download'
import type { ModelControls } from '../../bridge/models'

/** Any download's controls: an OCR model's (`useModelControls`) or an engine's (`useExtensionControls`). */
export interface DownloadControls {
  status: DownloadStatus | null
  pending: ModelAction | null
  error: string | null
  run: (action: ModelAction) => void
}
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
function ModelProgress({ status, noun }: { status: DownloadStatus; noun: string }): ReactNode {
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
          aria-label={`${status.name} ${noun}`}
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

/**
 * The bar, the line and the buttons. `emphasis` makes the next step (Download, Resume, Retry) the
 * primary button; off while the panel is showing an engine that is not in use, whose primary
 * action is "Use <name>".
 */
export function ModelDownload({
  controls,
  emphasis,
  label = 'Model'
}: {
  controls: DownloadControls
  emphasis: boolean
  /** The row's label: "Model" for OCR, "Download" for a dictionary engine. */
  label?: string
}): ReactNode {
  const { status, pending, error, run } = controls
  // A backend without model downloads says nothing.
  if (!status) return null
  const actions = primaryModelActions(status)
  return (
    <div className="model-download">
      <div className="model-download-row">
        <div className="model-download-text">
          <span className="model-download-label">{label}</span>
          <ModelProgress status={status} noun={label === 'Model' ? 'model' : 'download'} />
        </div>
        {actions.length > 0 && (
          <div className="model-actions">
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={
                  emphasis && action !== 'cancel' && action !== 'pause' ? 'primary' : 'secondary'
                }
                disabled={pending !== null}
                onClick={() => run(action)}
              >
                {actionLabel(action, status)}
              </Button>
            ))}
          </div>
        )}
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  )
}

/** "Remove the Manga OCR model?", opened from the panel's overflow menu. */
export function RemoveModelDialog({
  controls,
  open,
  onOpenChange
}: {
  controls: ModelControls
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const { status, run } = controls
  // The last status asked about, so the words stay put while the dialog fades out.
  const [last, setLast] = useState(status)
  if (status && status !== last) setLast(status)
  const shown = status ?? last
  return (
    <ConfirmDialog
      open={open && shown !== null}
      onOpenChange={onOpenChange}
      title={shown ? `Remove the ${shown.name} model?` : ''}
      description={
        shown
          ? `This frees ${formatBytes(shown.overallTotal)}. You can download it again from here at any time.`
          : undefined
      }
      confirmLabel="Remove"
      tone="danger"
      onConfirm={() => {
        onOpenChange(false)
        run('delete')
      }}
    />
  )
}
