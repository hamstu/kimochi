/**
 * Settings → General → Updates: the running version, when it was last checked, and Check for
 * updates. When one is offered the same row carries the download (the bar, the bytes, Cancel),
 * then "Restart to update"; it is the same status as the sidebar's notice, so a download started
 * there shows here and the other way round. "What's new" opens the release on GitHub.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Button, Callout, SettingsRow, SettingsSection } from '@kit'
import {
  actionLabel,
  checkedLine,
  isPrimaryAction,
  releaseUrl,
  showsBar,
  updateActions
} from '@ui/update'
import { useUpdateControls } from '../../bridge/updates'
import { UpdateBar } from '../../components/UpdateBar'

/** GitHub repository the releases live in; the updater's endpoint in tauri.conf.json names it. */
const REPOSITORY = 'hamstu/kimochi-tauri'

/** "checked 4 minutes ago" moves on its own: the clock, once a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

export function UpdatesSection(): ReactNode {
  const { status, pending, error, run } = useUpdateControls()
  const now = useNow()
  // A backend without self-updates (a preview without the mock) says nothing.
  if (!status) return null
  const actions = updateActions(status)
  const notes = releaseUrl(REPOSITORY, status)
  return (
    <SettingsSection title="Updates">
      <SettingsRow
        label={`Kimochi ${status.currentVersion}`}
        description={
          <>
            {showsBar(status) && <UpdateBar status={status} label="Update download" />}
            <span className="k-num">{checkedLine(status, now)}</span>
          </>
        }
      >
        {notes && status.state !== 'installing' && (
          <Button size="sm" variant="ghost" onClick={() => void openUrl(notes).catch(() => undefined)}>
            What&apos;s new
          </Button>
        )}
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
      </SettingsRow>
      {error && <Callout tone="danger">{error}</Callout>}
    </SettingsSection>
  )
}
