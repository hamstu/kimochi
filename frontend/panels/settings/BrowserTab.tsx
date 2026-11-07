/**
 * Settings → Browser Extension: what the Kimochi browser extension does, its connection
 * (src-tauri/src/browser_bridge.rs), and how to install it: from the Chrome Web Store once the
 * listing is approved, or by hand from the folder Kimochi keeps for it (Load unpacked).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Badge, Button, Callout, IconButton, SettingsPage, SettingsRow, SettingsSection, StatusDot, Switch, Tooltip } from '@kit'
import { useSetting } from '../../bridge/useSetting'
import { browserExtensionFolder, useBrowserBridge } from '../../bridge/browserBridge'
import { writeTextSelf } from '@texthooker/lib/clipboardWrite'
import appIcon from '../../assets/app-icon.svg'
import { BrowserDemoArt } from './BrowserDemoArt'
import './browser-tab.css'

/** The listing (browser-extension/store/LISTING.md). Until it is approved the link stays off. */
const STORE_URL = 'https://chromewebstore.google.com/detail/aciakombihkdppgjigibggnmoninegjm'
const STORE_LIVE = false

const visit = (url: string): void => void openUrl(url).catch(() => undefined)

/** The pop-up dictionaries that read the text the extension puts on pictures, in their stores. */
const DICTIONARIES = [
  { name: 'Yomitan', url: 'https://chromewebstore.google.com/detail/likgccmbimhjbgkjambclfkhldnlhbnn' },
  { name: 'Hachidori', url: 'https://chromewebstore.google.com/detail/mikpaebfdmidjnopgffchicnmoahhcbe' },
  { name: '10ten', url: 'https://chromewebstore.google.com/detail/pnmaklegiibbioifkmfkgpfnmdehdfan' }
]

/** A value to copy (a browser address, the folder's path), with its copy button. */
function CopyValue({ value, label }: { value: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="browser-copy">
      <code className="browser-copy-value">{value}</code>
      <IconButton
        label={copied ? 'Copied' : `Copy ${label}`}
        size="sm"
        variant="ghost"
        onClick={() => void writeTextSelf(value).then(() => setCopied(true), () => undefined)}
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </span>
  )
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <li className="browser-step">
      <span className="browser-step-n k-num" aria-hidden>
        {n}
      </span>
      <div className="browser-step-body">
        <span className="browser-step-title">{title}</span>
        {children}
      </div>
    </li>
  )
}

export function BrowserTab(): ReactNode {
  const [enabled, setEnabled] = useSetting<boolean>('browserExtension.enabled', true)
  const status = useBrowserBridge()
  const [folder, setFolder] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    browserExtensionFolder(false).then(
      (path) => alive && setFolder(path),
      (error: unknown) => alive && setFolderError(String(error))
    )
    return () => {
      alive = false
    }
  }, [])

  const connected = status.connected ?? 0
  const state = !enabled
    ? { tone: 'neutral' as const, text: 'Off' }
    : status.error
      ? { tone: 'danger' as const, text: status.error }
      : connected
        ? { tone: 'ok' as const, text: `Connected: ${[...new Set(status.browsers ?? [])].join(', ') || 'your browser'}` }
        : { tone: 'neutral' as const, text: 'Waiting for the extension' }

  return (
    <SettingsPage title="Browser Extension" className="browser-page">
      <header className="browser-hero">
        <img className="browser-hero-icon" src={appIcon} alt="" width={56} height={56} draggable={false} />
        <div className="browser-hero-text">
          <h2 className="browser-hero-title">Read Japanese in pictures on the web</h2>
          <p className="browser-hero-summary">
            Kimochi&rsquo;s OCR in Chrome, Edge, Brave, Arc and other Chromium browsers. Kimochi has to be running.
          </p>
        </div>
      </header>
      <div className="browser-intro">
        <figure className="browser-demo">
          <BrowserDemoArt />
          <figcaption className="browser-demo-caption">
            Click Kimochi in the toolbar, then a picture. Hold Shift over the text to look words up.
          </figcaption>
        </figure>
        <Callout tone="warn" className="browser-needs">
          <p className="browser-needs-title">Your browser needs its own pop-up dictionary</p>
          <p className="browser-needs-text">
            The extension turns pictures into text on the page, and a dictionary extension in your browser looks the words
            up. Any of these works:
          </p>
          <span className="browser-needs-links">
            {DICTIONARIES.map((dictionary) => (
              <button key={dictionary.name} type="button" className="browser-needs-link" onClick={() => visit(dictionary.url)}>
                {dictionary.name}
                <ExternalLink aria-hidden />
              </button>
            ))}
          </span>
        </Callout>
      </div>

      <SettingsSection title="Connection">
        <SettingsRow
          label="Connect to the browser extension"
          controlId="browser-extension-enabled"
          description="Lets the extension send Kimochi the pictures you pick."
        >
          <Switch id="browser-extension-enabled" checked={enabled} onCheckedChange={(value) => void setEnabled(value)} />
        </SettingsRow>
        {enabled ? (
          <SettingsRow label="Status">
            <span className="settings-status">
              <StatusDot tone={state.tone} />
              {state.text}
            </span>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Install">
        <SettingsRow
          label="Chrome Web Store"
          badge={STORE_LIVE ? undefined : <Badge tone="warn">Pending approval</Badge>}
          description={
            STORE_LIVE
              ? 'Updates itself. Works in Chrome, Edge, Brave, Arc, Vivaldi and Opera.'
              : 'The extension is waiting for Google to approve it. Until then, install it by hand below.'
          }
        >
          {STORE_LIVE ? (
            <Button size="sm" variant="primary" onClick={() => visit(STORE_URL)}>
              <ExternalLink />
              Open the store
            </Button>
          ) : (
            <Tooltip content="Available once Google approves the listing">
              <span tabIndex={0}>
                <Button size="sm" disabled>
                  <ExternalLink />
                  Open the store
                </Button>
              </span>
            </Tooltip>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Install by hand"
        description="Load the extension from Kimochi's folder."
        grouped={false}
        footnote="Kimochi refreshes the folder when it updates. After an update, click the reload arrow on Kimochi's card on the extensions page."
      >
        <ol className="browser-steps k-settings-group">
          <Step n={1} title="Open your browser's extensions page">
            <span className="browser-step-detail">Paste this into the address bar (Edge: edge://extensions, Brave: brave://extensions).</span>
            <CopyValue value="chrome://extensions" label="address" />
          </Step>
          <Step n={2} title="Turn on Developer mode">
            <span className="browser-step-detail">The switch at the top right of the page (in Edge, in the left sidebar).</span>
          </Step>
          <Step n={3} title="Click Load unpacked and choose this folder">
            {folder ? (
              <span className="browser-folder">
                <CopyValue value={folder} label="folder path" />
                <Button
                  size="sm"
                  onClick={() => {
                    setFolderError(null)
                    void browserExtensionFolder().catch((error: unknown) => setFolderError(String(error)))
                  }}
                >
                  <FolderOpen />
                  Show folder
                </Button>
              </span>
            ) : null}
            {folderError ? <span className="browser-step-detail browser-step-error">{folderError}</span> : null}
          </Step>
          <Step n={4} title="Pin Kimochi and try it">
            <span className="browser-step-detail">
              Pin it from the puzzle-piece menu, then click it (or press Alt+K) and click a picture with Japanese in
              it.
            </span>
          </Step>
        </ol>
      </SettingsSection>
    </SettingsPage>
  )
}
