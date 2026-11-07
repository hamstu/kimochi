/**
 * The browser extension's connection (`src-tauri/src/browser_bridge.rs`, COMMANDS.md "Browser
 * bridge"): whether Kimochi is listening for it, which browsers are connected, and the page it
 * last read a picture from.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface BrowserBridgeStatus {
  enabled: boolean
  listening: boolean
  port?: number
  /** Why the bridge couldn't listen (its port is taken). */
  error?: string | null
  /** Connected browsers. */
  connected?: number
  browsers?: string[]
  page?: { title: string; url: string } | null
  lastScan?: { lines: number; ms: number; at: number } | null
  reading?: boolean
}

const OFF: BrowserBridgeStatus = { enabled: false, listening: false }

export const browserBridgeStatus = (): Promise<BrowserBridgeStatus> =>
  invoke<BrowserBridgeStatus>('browser_bridge_status')
/** Ask the page to read its picture again; false when no browser is connected. */
export const browserRescan = (): Promise<boolean> => invoke<boolean>('browser_rescan')
/** The extension's folder (for Load unpacked), opened in the file manager. */
export const browserExtensionFolder = (reveal = true): Promise<string> =>
  invoke<string>('browser_extension_folder', { reveal })

export function useBrowserBridge(): BrowserBridgeStatus {
  const [status, setStatus] = useState<BrowserBridgeStatus>(OFF)
  useEffect(() => {
    let alive = true
    void browserBridgeStatus()
      .then((next) => alive && setStatus(next))
      .catch(() => undefined)
    const stop = listen<BrowserBridgeStatus>('browser-bridge', ({ payload }) => alive && setStatus(payload))
    return () => {
      alive = false
      void stop.then((unlisten) => unlisten())
    }
  }, [])
  return status
}
