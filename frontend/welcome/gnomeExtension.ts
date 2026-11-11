/** The GNOME extension step's route and status, shared by the step and the guide's flow. */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useCapabilities } from '../bridge/capabilities'

export const GNOME_ROUTE = '/gnome-extension'

export interface GnomeStatus {
  /** GNOME is running the extension. */
  available?: boolean
  /** Its files are in place (GNOME loads a new one at the next login). */
  installed?: boolean
  /** Installed and not turned off in GNOME's Extensions app. */
  enabled?: boolean
}

/** Set up and turned on, but GNOME hasn't loaded it yet: it does at the next login. */
export function awaitingLogin(status: GnomeStatus | null, result: InstallResult | null): boolean {
  if (status?.available) return false
  return result?.needsLogin === true || (status?.installed === true && status.enabled === true)
}

export interface InstallResult {
  live?: boolean
  needsLogin?: boolean
  message?: string
}

/** GNOME on Wayland without layer-shell: the desktop the extension is for. */
export function useGnomeEligible(): boolean {
  const { os, session } = useCapabilities()
  return (
    os === 'linux' &&
    session?.backend === 'wayland' &&
    session.compositor?.toLowerCase() === 'gnome' &&
    !session.layerShell
  )
}

/** The extension's state, null until known (and for ever off GNOME). Polled while `watch`. */
export function useGnomeExtension(watch: boolean): [GnomeStatus | null, () => void] {
  const eligible = useGnomeEligible()
  const [status, setStatus] = useState<GnomeStatus | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    if (!eligible) return
    let alive = true
    const check = (): void => {
      invoke<GnomeStatus>('gnome_overlay', { operation: 'status', payload: null })
        .then((next) => alive && setStatus(next))
        .catch(() => alive && setStatus({ available: false, installed: false }))
    }
    check()
    const timer = watch ? setInterval(check, 2000) : undefined
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [eligible, watch, tick])
  return [eligible ? status : null, refresh]
}

/** Sets the extension up, or turns it back on; GNOME runs a first install from the next login. */
export function installGnomeExtension(): Promise<InstallResult> {
  return invoke<InstallResult>('gnome_overlay', { operation: 'install', payload: null })
}
