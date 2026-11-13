/**
 * Settings → Command line: install the `kimochi` command (cli/install.rs), a few examples, and
 * the way to the full guide on the docs site. The command itself is the app's own executable in
 * command-line mode (src-tauri/src/cli/).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Badge, Button, Callout, IconButton, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { useCapabilities } from '../../bridge/capabilities'
import { writeTextSelf } from '@texthooker/lib/clipboardWrite'
import './cli.css'

export const CLI_DOCS_URL = 'https://docs.kimochiapp.com/reference/cli/'

/** `cli_status` (cli/install.rs `Status`). */
export interface CliStatus {
  installed: boolean
  builtIn: boolean
  stale: boolean
  path: string | null
  target: string | null
  onPath: boolean
  note: string | null
}

type Os = 'macos' | 'windows' | 'linux'

/** The command that pipes the clipboard in, on each system. */
const PASTE: Record<Os, string> = {
  macos: 'pbpaste | kimochi log add',
  windows: 'Get-Clipboard | kimochi log add',
  linux: 'wl-paste | kimochi log add'
}

function examples(os: Os): { command: string; what: string }[] {
  return [
    { command: 'kimochi status', what: 'What Kimochi is reading, with which engine, and the open session.' },
    { command: 'kimochi scan --wait', what: 'Scan the source now and print the text it read.' },
    { command: 'kimochi log --follow', what: 'Print every new line of the Log as it comes in.' },
    { command: 'kimochi session switch "Persona 5"', what: 'Open another session by name.' },
    { command: 'kimochi ocr meikiocr', what: 'Switch the OCR engine.' },
    { command: PASTE[os], what: "Add the clipboard's text to the Log as a line." }
  ]
}

function CopyButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  return (
    <IconButton
      label={copied ? 'Copied' : `Copy ${text}`}
      size="sm"
      onClick={() =>
        void writeTextSelf(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  )
}

/** What the install row says about the command. */
function describe(status: CliStatus | null, os: Os): string {
  if (!status) return 'Checking…'
  if (status.builtIn) return `It came with this install: ${status.path}.`
  if (status.installed) return `Installed at ${status.path}.`
  if (status.stale) return `${status.path} runs another copy of Kimochi. Install it again to use this one.`
  if (os === 'macos') return "Adds a link at /usr/local/bin/kimochi. macOS asks for an administrator's password."
  if (os === 'windows') return 'Adds a kimochi command to your user PATH.'
  return 'Adds a link at ~/.local/bin/kimochi.'
}

const errorText = (error: unknown): string => String(error).replace(/^(invalid|native|busy|gone):\s*/, '')

export function CliTab(): ReactNode {
  const os = (useCapabilities().os ?? 'macos') as Os
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void invoke<CliStatus>('cli_status')
      .then(setStatus)
      .catch((e: unknown) => setError(errorText(e)))
  }, [])
  useEffect(refresh, [refresh])

  const change = (command: 'cli_install' | 'cli_uninstall'): void => {
    setWorking(true)
    setError(null)
    void invoke<CliStatus>(command)
      .then(setStatus)
      .catch((e: unknown) => {
        const message = errorText(e)
        if (message !== 'cancelled') setError(message)
      })
      .finally(() => setWorking(false))
  }

  const action = (() => {
    if (!status || status.builtIn) return null
    if (status.installed)
      return (
        <Button size="sm" disabled={working} onClick={() => change('cli_uninstall')}>
          Remove
        </Button>
      )
    return (
      <Button size="sm" variant="primary" disabled={working} onClick={() => change('cli_install')}>
        {status.stale ? 'Install again' : 'Install'}
      </Button>
    )
  })()

  return (
    <SettingsPage
      title="Command line"
      description="Drive Kimochi from a terminal or a script. The command starts Kimochi when it isn't running."
    >
      <SettingsSection title="The kimochi command" grouped={false}>
        <div className="k-settings-group">
          <SettingsRow
            label="kimochi"
            badge={
              status?.installed ? (
                <Badge tone="ok">Installed</Badge>
              ) : status?.stale ? (
                <Badge tone="warn">Out of date</Badge>
              ) : null
            }
            description={describe(status, os)}
          >
            {action}
          </SettingsRow>
        </div>
        {error && <Callout tone="danger">{error}</Callout>}
        {status?.note && <Callout tone="warn">{status.note}</Callout>}
        {status?.installed && os === 'windows' && !status.note && <Callout>Open a new terminal to use it.</Callout>}
      </SettingsSection>

      <SettingsSection
        title="Examples"
        description="Add --json to any command for output a script can read."
        footnote={
          <>
            Every command, the events <code className="cli-inline">kimochi watch</code> streams, and scripting recipes
            are in the guide.
          </>
        }
      >
        {examples(os).map(({ command, what }) => (
          <SettingsRow key={command} label={<code className="cli-command">{command}</code>} description={what}>
            <CopyButton text={command} />
          </SettingsRow>
        ))}
        <SettingsRow label="Command line guide" description="docs.kimochiapp.com">
          <IconButton
            label="Open the command line guide"
            size="sm"
            onClick={() => void openUrl(CLI_DOCS_URL).catch(() => undefined)}
          >
            <ExternalLink />
          </IconButton>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
