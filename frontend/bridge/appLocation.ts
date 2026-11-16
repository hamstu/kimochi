/**
 * Where Kimochi is running from (`app_location`, `app_move_to_applications`,
 * `app_location_dismiss`; COMMANDS.md → App location). On macOS an app outside Applications is
 * missing from the Screen Recording and System Audio lists and from Spotlight, so the panels offer
 * to move it before anything else (MoveToApplicationsDialog.tsx).
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { onEvent } from './tauri'

export type AppLocation = {
  needsMove: boolean
  path: string | null
  translocated: boolean
  copyOnly: boolean
  diskImage: boolean
  destination: string | null
  replaces: boolean
  needsAdmin: boolean
  dismissed: boolean
}

const STAYS: AppLocation = {
  needsMove: false,
  path: null,
  translocated: false,
  copyOnly: false,
  diskImage: false,
  destination: null,
  replaces: false,
  needsAdmin: false,
  dismissed: false
}

/** A reply as an `AppLocation`; anything unexpected (or no backend) means nothing to move. */
export function normalizeAppLocation(raw: unknown): AppLocation {
  if (!raw || typeof raw !== 'object') return STAYS
  const value = raw as Record<string, unknown>
  const text = (key: string): string | null => (typeof value[key] === 'string' ? (value[key] as string) : null)
  return {
    needsMove: value.needsMove === true && text('destination') !== null,
    path: text('path'),
    translocated: value.translocated === true,
    copyOnly: value.copyOnly === true,
    diskImage: value.diskImage === true,
    destination: text('destination'),
    replaces: value.replaces === true,
    needsAdmin: value.needsAdmin === true,
    dismissed: value.dismissed === true
  }
}

/** It cannot change while the app runs (a move relaunches), so the first answer is kept. */
let pending: Promise<AppLocation> | null = null

export function fetchAppLocation(): Promise<AppLocation> {
  pending ??= invoke<unknown>('app_location').then(normalizeAppLocation, () => STAYS)
  return pending
}

/** Null until the backend answers; follows `app-location` ("Not now" in another window). */
export function useAppLocation(): AppLocation | null {
  const [location, setLocation] = useState<AppLocation | null>(null)
  useEffect(() => {
    let live = true
    let unlisten: (() => void) | undefined
    void fetchAppLocation().then((found) => live && setLocation((seen) => seen ?? found))
    try {
      onEvent<unknown>('app-location', (payload) => live && setLocation(normalizeAppLocation(payload)))
        .then((stop) => {
          if (live) unlisten = stop
          else stop()
        })
        .catch(() => undefined)
    } catch {
      // No event bridge (a plain browser).
    }
    return () => {
      live = false
      unlisten?.()
    }
  }, [])
  return location
}

/** Moves (or copies) Kimochi into /Applications; on success the app quits and reopens from there. */
export function moveToApplications(): Promise<void> {
  return invoke<void>('app_move_to_applications')
}

/** "Not now" for this run, in every window. */
export function dismissAppLocation(): Promise<void> {
  return invoke<unknown>('app_location_dismiss').then(
    () => undefined,
    () => undefined
  )
}

/** Where the bundle is, in words: "your Downloads folder", "the disk image", or its folder. */
export function describeLocation(location: AppLocation): string {
  const path = location.path ?? ''
  const folder = path.replace(/\/[^/]+\/?$/, '') || '/'
  if (location.diskImage) return 'the disk image'
  if (/^\/Users\/[^/]+\/Downloads(\/|$)/.test(folder)) return 'your Downloads folder'
  if (/^\/Users\/[^/]+\/Desktop$/.test(folder)) return 'your Desktop'
  return folder
}
