/**
 * What a window shows when something in it fails to render, instead of a blank (gray) window.
 *
 * A render error used to unmount the whole React tree, which left nothing but the window's
 * background: 0.8.1's main window was gray over a setting written by 0.9.0, with nothing to say
 * why. Now the failure is caught, reported to the diagnostics record as before (`panel-error`,
 * Settings → About → Debug info), and explained in place, with a way to try again and the
 * details to copy into a bug report.
 *
 * Two layers, so one of them is always standing: `PanelShell` wraps a window's content in one
 * (the title bar keeps working: the window can still be moved and closed), and each entry wraps
 * everything in another, for when the shell or the providers are what failed. The fallback uses
 * nothing but plain elements and the kit's classes, so it cannot fail the same way.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { reportError } from '../entries/reportErrors'

interface Props {
  /** The window, for the diagnostics record. */
  window: string
  children: ReactNode
}

interface State {
  error: Error | null
  copied: boolean
}

function describe(error: Error, window: string, version: string | null): string {
  return [
    `Kimochi${version ? ` ${version}` : ''}, window "${window}"`,
    `${error.name}: ${error.message}`,
    error.stack ?? ''
  ]
    .join('\n')
    .trim()
}

export class WindowErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = info.componentStack ? `\nIn:${info.componentStack.split('\n').slice(0, 8).join('\n')}` : ''
    const base = error instanceof Error ? error : new Error(String(error))
    const reported = new Error(base.message)
    reported.stack = `${base.stack ?? ''}${stack}`
    reportError(this.props.window, 'render', reported)
  }

  private copy = async (): Promise<void> => {
    const { error } = this.state
    if (!error) return
    const version = await getVersion().catch(() => null)
    try {
      await navigator.clipboard.writeText(describe(error, this.props.window, version))
      this.setState({ copied: true })
    } catch {
      /* no clipboard: the message is on screen to select */
    }
  }

  render(): ReactNode {
    const { error, copied } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        className="k-empty window-error"
        style={{ padding: 24, maxWidth: 560, margin: '0 auto', textAlign: 'left', userSelect: 'text' }}
      >
        <h2 style={{ margin: '0 0 8px' }}>This window couldn&apos;t load</h2>
        <p style={{ margin: '0 0 8px' }}>
          Something in it failed while it was being drawn. Your Log, sessions and settings are safe:
          nothing was changed.
        </p>
        <p style={{ margin: '0 0 12px' }}>
          If you recently ran a newer version of Kimochi, it may have saved a setting this version
          doesn&apos;t understand; updating Kimochi usually fixes it. Otherwise, reloading often does.
        </p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 140,
            overflow: 'auto',
            fontSize: 12,
            opacity: 0.8,
            margin: '0 0 12px'
          }}
        >
          {error.message}
        </pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="k-button k-button-primary" onClick={() => location.reload()}>
            Reload window
          </button>
          <button type="button" className="k-button k-button-secondary" onClick={() => void this.copy()}>
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      </div>
    )
  }
}
