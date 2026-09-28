/**
 * Session state shared by every window.
 *
 * In Electron `OverlayApp` is the single React controller and panels receive its props over IPC
 * (`NativePanel.tsx`). Tauri windows are separate WebViews with no shared tree, so Rust owns the
 * state and each window subscribes to it.
 *
 * The backend emits a `state` event carrying the whole snapshot whenever anything a panel renders
 * changes, so this fetches `snapshot()` once for the initial paint and then listens. There is no
 * polling: an event-driven panel cannot show a stale frame, and a 500 ms poll on every window is
 * work the backend explicitly removed the need for.
 */
import { useEffect, useState } from 'react'
import type { ViewState } from './types'
import { nativeError, onEvent, snapshot } from './tauri'

export const EMPTY_VIEW_STATE: ViewState = {
  revision: -1,
  status: '',
  scan: null,
  logs: [],
  regions: {},
  origin: null,
  interactive: false,
  dictionary: false,
  dismiss: 0
}

export interface ViewStateResult {
  state: ViewState
  error: string | null
  /** `event` once the subscription is live; `initial` until then. */
  transport: 'event' | 'initial'
}

export function useViewState(): ViewStateResult {
  const [state, setState] = useState<ViewState>(EMPTY_VIEW_STATE)
  const [error, setError] = useState<string | null>(null)
  const [transport, setTransport] = useState<'event' | 'initial'>('initial')

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    let eventSeen = false

    const apply = (next: ViewState): void => {
      if (!active) return
      setState(next)
      setError(null)
    }

    onEvent<ViewState>('state', (payload) => {
      if (!active) return
      eventSeen = true
      setTransport('event')
      apply(payload)
    })
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch((caught) => {
        if (active) setError(`Live updates unavailable: ${nativeError(caught).message}`)
      })

    // One fetch for the initial paint. An event that lands first is newer, so it wins.
    snapshot()
      .then((next) => {
        if (!eventSeen) apply(next)
      })
      .catch((caught) => {
        if (active && !eventSeen) setError(nativeError(caught).message)
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  return { state, error, transport }
}
