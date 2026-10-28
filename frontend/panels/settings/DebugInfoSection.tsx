/**
 * Settings → About → Debug info: what a remote bug report needs, in two clicks. "Copy debug info"
 * puts the report (`debug_report`, as Markdown from `ui/debug-report.ts`) on the clipboard for
 * Discord or a GitHub issue; "Save debug bundle" writes it with the recent logs to a zip. Verbose
 * logging records more (window focus, every scan) until Kimochi quits. Everything is redacted
 * natively before it reaches this page (COMMANDS.md → Debug info).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, ClipboardCopy, FileArchive } from 'lucide-react'
import { Button, SettingsRow, SettingsSection, Switch } from '@kit'
import { debugMarkdown } from '@ui/debug-report'
import { debugReport, saveDebugBundle, verboseLogging } from '../../bridge/debugReport'
import { nativeError } from '../../bridge/tauri'

type Outcome = { tone: 'ok' | 'danger'; text: string } | null

export function DebugInfoSection(): ReactNode {
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null)
  const [copied, setCopied] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [verbose, setVerbose] = useState(false)

  useEffect(() => {
    let alive = true
    verboseLogging()
      .then((on) => alive && setVerbose(on))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(timer)
  }, [copied])

  const fail = (error: unknown): void => setOutcome({ tone: 'danger', text: nativeError(error).message })

  const copy = async (): Promise<void> => {
    setBusy('copy')
    setOutcome(null)
    try {
      await navigator.clipboard.writeText(debugMarkdown(await debugReport()))
      setCopied(true)
      setOutcome({ tone: 'ok', text: 'Copied. Paste it into Discord or your GitHub issue.' })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setOutcome(null)
    try {
      const result = await saveDebugBundle(debugMarkdown(await debugReport()))
      if (result.saved) setOutcome({ tone: 'ok', text: `Saved to ${result.path ?? 'the chosen folder'}. Attach it to your report.` })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const toggleVerbose = (enabled: boolean): void => {
    setVerbose(enabled)
    verboseLogging(enabled).then(setVerbose, (error: unknown) => {
      setVerbose(!enabled)
      fail(error)
    })
  }

  return (
    <SettingsSection
      title="Debug info"
      description="Reporting a problem? Include this, so it can be tracked down from afar. Tokens, keys, e-mail addresses and your user name are left out."
      footnote={
        outcome && (
          <span role="status" className={outcome.tone === 'danger' ? 'about-debug-error' : undefined}>
            {outcome.text}
          </span>
        )
      }
    >
      <SettingsRow
        label="Copy debug info"
        description="Kimochi's version, your system and displays, the OCR engine and dictionary, Kimochi's windows and recent errors, as text."
      >
        <Button size="sm" disabled={busy !== null} onClick={() => void copy()}>
          {copied ? <Check /> : <ClipboardCopy />}
          {busy === 'copy' ? 'Gathering…' : copied ? 'Copied' : 'Copy'}
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Save debug bundle"
        description="The same, with Kimochi's recent logs, in a zip file to attach to a GitHub issue."
      >
        <Button size="sm" disabled={busy !== null} onClick={() => void save()}>
          <FileArchive />
          {busy === 'save' ? 'Saving…' : 'Save…'}
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Verbose logging"
        controlId="about-verbose-logging"
        description="Records more detail, such as window focus changes and every scan, until Kimochi quits. Turn it on, make the problem happen, then save a bundle."
      >
        <Switch id="about-verbose-logging" checked={verbose} onCheckedChange={toggleVerbose} />
      </SettingsRow>
    </SettingsSection>
  )
}
