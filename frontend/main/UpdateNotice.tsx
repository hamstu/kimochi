/**
 * The sidebar's update notice, above Settings: "Kimochi 0.2.0 is available" with Download, the
 * bar while it downloads, "Restart to update" once it is in, and what went wrong if it did not.
 * Nothing shows until a check has found something; "Not now" puts an offer away for this run
 * (Settings → General → Updates still has it). The status is the same one that page shows: the
 * download runs in Rust (`updater.rs`) and both read `update-status`.
 */
import type { JSX } from 'react'
import { ArrowDownToLine, CircleAlert, RotateCw, X } from 'lucide-react'
import { Button, IconButton, Spinner } from '@kit'
import {
  actionLabel,
  isPrimaryAction,
  noticeDetail,
  noticeShown,
  noticeTitle,
  showsBar,
  updateActions,
  type UpdateStatus
} from '@ui/update'
import { useUpdateControls } from '../bridge/updates'
import { UpdateBar } from '../components/UpdateBar'

function NoticeIcon({ status }: { status: UpdateStatus }): JSX.Element | null {
  switch (status.state) {
    case 'available':
      return <ArrowDownToLine aria-hidden />
    case 'ready':
      return <RotateCw aria-hidden />
    case 'installing':
      return <Spinner label="Installing" />
    case 'failed':
      return <CircleAlert aria-hidden />
    default:
      return null
  }
}

export function UpdateNotice(): JSX.Element | null {
  const { status, pending, error, run } = useUpdateControls()
  if (!status || !noticeShown(status)) return null
  const actions = updateActions(status)
  const dismissable = status.state === 'available' || status.state === 'failed'
  const detail = error ?? noticeDetail(status)
  return (
    <section
      className="sb-update"
      data-state={status.state}
      aria-label="Update"
      aria-live="polite"
    >
      <div className="sb-update-head">
        <NoticeIcon status={status} />
        <span className="sb-update-title">{noticeTitle(status)}</span>
        {dismissable && (
          <IconButton
            label="Not now"
            size="sm"
            variant="ghost"
            className="sb-update-dismiss"
            disabled={pending !== null}
            onClick={() => run('dismiss')}
          >
            <X />
          </IconButton>
        )}
      </div>
      {showsBar(status) && <UpdateBar status={status} label="Update download" />}
      {detail && (
        <p className="sb-update-detail k-num" data-tone={error || status.state === 'failed' ? 'danger' : undefined}>
          {detail}
        </p>
      )}
      {actions.length > 0 && (
        <div className="sb-update-actions">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={isPrimaryAction(action) ? 'primary' : 'secondary'}
              disabled={pending !== null}
              onClick={() => run(action)}
            >
              {actionLabel(action, status)}
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}
