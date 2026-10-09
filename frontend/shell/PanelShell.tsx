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
import { nativeError, panel, panelContentHeight, onEvent, quitApp } from '../bridge/tauri'
import type { PanelStateEvent } from '../bridge/types'
import { usePanelController } from './usePanelController'
import { useNativeHover } from './useNativeHover'
import { TitleBarSlotContext } from './titleBarSlot'

interface PanelShellProps {
  label: string
  title: string
  /** Sizes the window to its content (fixed-size panels only). */
  mini?: boolean
  /** Leave the title text out of the title bar: the panel fills it through `TitleBarPortal`. */
  hideTitle?: boolean
  children: ReactNode
}

export default function PanelShell({
  label,
  title,
  mini = false,
  hideTitle = false,
  children
}: PanelShellProps): JSX.Element {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useNativeHover()
  usePanelController(label)

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

  // Fixed-size panels only: report rendered height so the native window hugs its menu rows.
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

  const headerRef = useRef<HTMLElement>(null)
  const run = useCallback(
    (action: 'pin' | 'unpin' | 'minimize' | 'hide' | 'drag') => {
      // The icon flips on the click; the reply confirms it (or reverts it on failure below).
      if (action === 'pin' || action === 'unpin') setPinned(action === 'pin')
      panel(label, action)
        .then((info) => {
          if (action === 'pin' || action === 'unpin') setPinned(Boolean(info?.pinned))
          setError(null)
        })
        .catch((caught) => {
          if (action === 'pin' || action === 'unpin') setPinned(action !== 'pin')
          setError(nativeError(caught).message)
        })
    },
    [label]
  )

  // A DOM listener, not React's onMouseDown: controls a panel portals into the title bar belong to
  // the panel's React tree, so their events never reach a React handler on the header. Anything
  // that is not a control starts a window drag.
  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('button, [role="button"], [role="radio"], a, input, select, textarea'))
        return
      run('drag')
    }
    header.addEventListener('mousedown', onMouseDown)
    return () => header.removeEventListener('mousedown', onMouseDown)
  }, [run])

  return (
    <div ref={panelRef} className={`native-panel native-panel-${label}`}>
      <header ref={headerRef} className="native-titlebar">
        {hideTitle ? null : <span className="native-titlebar-title">{title}</span>}
        <div ref={setSlot} className="native-titlebar-slot" />
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
          {/* The main window is the app: closing it quits. Every other window just hides. */}
          <button
            aria-label={label === 'log' ? 'Quit Kimochi' : 'Close window'}
            title={label === 'log' ? 'Quit Kimochi' : 'Close'}
            onClick={() =>
              label === 'log'
                ? void quitApp().catch((caught) => setError(nativeError(caught).message))
                : run('hide')
            }
          >
            <X />
          </button>
        </div>
      </header>
      {error && (
        <div className="native-panel-error" role="status">
          {error}
        </div>
      )}
      <main className="native-content">
        <TitleBarSlotContext.Provider value={slot}>{children}</TitleBarSlotContext.Provider>
      </main>
    </div>
  )
}
