/**
 * Settings → Shortcuts & Controls on niri without a shortcuts portal: whether niri reads the binds
 * Kimochi writes (`~/.config/niri/kimochi.kdl`), the line that makes it, and a button that adds the
 * line to niri's config (backed up, appended, validated; never edited silently).
 */
import { useEffect, type ReactNode } from 'react'
import { Badge, Button, Callout, SettingsRow, SettingsSection } from '@kit'
import {
  refreshNiriShortcuts,
  useNiriInclude,
  useNiriShortcuts,
  type NiriShortcutSetup
} from '../../bridge/niriShortcuts'
import { CopyButton } from './CliTab'
import './cli.css'

/** Kimochi won't append the line itself (`blocked`): say what to do instead. */
function blockedNote(setup: NiriShortcutSetup): ReactNode {
  switch (setup.blocked) {
    case 'nix':
      return (
        <>
          Your niri config is in the Nix store, so Kimochi can&rsquo;t add the line. If Home Manager or NixOS writes it,
          add <code className="cli-inline">{setup.nixIncludeLine}</code> to the config there.
        </>
      )
    case 'readOnly':
      return <>Kimochi can&rsquo;t write to {setup.config}. Add the line to it yourself.</>
    case 'missing':
    case 'notFile':
      return <>There&rsquo;s no niri config at {setup.config}. Add the line to your niri config yourself.</>
    default:
      return null
  }
}

export function NiriShortcutsSection(): ReactNode {
  const setup = useNiriShortcuts()
  const { busy, error, add } = useNiriInclude()
  // The reader may have added the line by hand since Kimochi last looked.
  const known = setup !== null
  useEffect(() => {
    if (known) void refreshNiriShortcuts().catch(() => undefined)
  }, [known])
  if (!setup) return null
  const active = setup.status === 'active'
  const unsupported = setup.status === 'unsupported'
  const note = active ? null : blockedNote(setup)
  return (
    <SettingsSection
      id="niri-shortcuts"
      title="Global shortcuts on niri"
      description={
        <>
          niri runs Kimochi&rsquo;s shortcuts from <code className="cli-inline">{setup.binds}</code>, which Kimochi
          keeps up to date. Your niri config needs to include it once.
        </>
      }
    >
      <SettingsRow
        label="Status"
        badge={
          active ? (
            <Badge tone="ok">Active</Badge>
          ) : unsupported ? (
            <Badge tone="warn">niri too old</Badge>
          ) : (
            <Badge tone="warn">Needs setup</Badge>
          )
        }
        description={
          active
            ? 'Your niri config includes Kimochi’s shortcuts.'
            : unsupported
              ? 'This niri can’t include another file. Update niri to 25.11 or later.'
              : `Add the line below to ${setup.config}.`
        }
      >
        {!active && !unsupported && !setup.blocked && (
          <Button size="sm" variant="primary" disabled={busy} onClick={add}>
            {busy ? 'Adding…' : 'Add to my niri config'}
          </Button>
        )}
      </SettingsRow>
      {!unsupported && (
        <SettingsRow
          label={<code className="cli-command">{setup.includeLine}</code>}
          description={
            active
              ? 'The line in your niri config.'
              : setup.blocked
                ? 'Put it above your own binds if you want yours to win when a key is in both.'
                : 'Kimochi adds it at the end of your config, after a backup. Put it above your own binds if you want yours to win when a key is in both.'
          }
        >
          <CopyButton text={setup.includeLine} />
        </SettingsRow>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      {note && <Callout tone="neutral">{note}</Callout>}
    </SettingsSection>
  )
}
