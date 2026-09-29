/**
 * ADAPTED from `src/renderer/src/windows/panel/PanelApp.tsx`.
 *
 * Reproduces the native title bar: title, pin / minimize / close, a compact 28 px frame for every
 * panel, and the controller's content-height autosize.
 *
 * Deltas:
 *  - the snapshot-over-IPC plumbing is gone; each window renders its own panel directly and reads
 *    shared state from the bridge;
 *  - dragging calls `panel(label, 'drag')` rather than relying on `-webkit-app-region: drag`, so
 *    the first click in an INACTIVE window still starts a drag (the POC's user-confirmed fix);
 *  - `useNativeHover()` supplies hover and cursor feedback while the window is inactive.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Minus, Pin, PinOff, X } from 'lucide-react'
import { nativeError, panel, panelContentHeight, onEvent } from '../bridge/tauri'
import type { PanelStateEvent } from '../bridge/types'
import { useNativeHover } from './useNativeHover'

interface PanelShellProps {
  label: string
  title: string
  /** The controller alone sizes itself to its content. All panels use compact window chrome. */
  mini?: boolean
  children: ReactNode
}

export default function PanelShell({
  label,
  title,
  mini = false,
  children
}: PanelShellProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useNativeHover()

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    let active = true
    panel(label, 'inspect')
      .then((info) => {
        if (active) setPinned(Boolean(info?.pinned))
      })
      .catch(() => {
        /* The window may not be registered yet; the panel:state event corrects this. */
      })
    let unlisten: (() => void) | undefined
    onEvent<PanelStateEvent>('panel:state', (payload) => {
      if (payload?.label === label) setPinned(Boolean(payload.pinned))
    })
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unlisten?.()
    }
  }, [label])

  // Controller only: report rendered height so the native window hugs its menu rows.
  useEffect(() => {
    const element = panelRef.current
    if (!mini || !element) return
    let last = 0
    const measure = (): void => {
      const height = Math.ceil(element.getBoundingClientRect().height)
      if (height !== last && height > 0) {
        last = height
        panelContentHeight(label, height).catch(() => undefined)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [mini, label])

  const run = useCallback(
    (action: 'pin' | 'unpin' | 'minimize' | 'hide' | 'drag') => {
      panel(label, action)
        .then((info) => {
          if (action === 'pin' || action === 'unpin') setPinned(Boolean(info?.pinned))
          setError(null)
        })
        .catch((caught) => setError(nativeError(caught).message))
    },
    [label]
  )

  return (
    <div ref={panelRef} className={`native-panel native-panel-${label}`}>
      <header
        className="native-titlebar"
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          run('drag')
        }}
      >
        <span className="native-titlebar-title">{title}</span>
        <div className="native-window-actions">
          <button
            title={pinned ? 'Unpin window' : 'Keep on top'}
            aria-label={pinned ? 'Unpin window' : 'Keep on top'}
            aria-pressed={pinned}
            onClick={() => run(pinned ? 'unpin' : 'pin')}
          >
            {pinned ? <Pin /> : <PinOff />}
          </button>
          <button aria-label="Minimize window" title="Minimize" onClick={() => run('minimize')}>
            <Minus />
          </button>
          <button aria-label="Close window" title="Close" onClick={() => run('hide')}>
            <X />
          </button>
        </div>
      </header>
      {error && (
        <div className="native-panel-error" role="status">
          {error}
        </div>
      )}
      <main className="native-content">{children}</main>
    </div>
  )
}
