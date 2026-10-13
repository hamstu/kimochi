/**
 * The Yomitan API setup's native side: where the browser helper is installed
 * (`yomitan_host_status`), whether the API answers (`yomitan_api_check`), and Kimochi's one-click
 * install of its helper (`install_yomitan_native_host`). See `ui/yomitan-api-setup.ts` for the
 * model and COMMANDS.md → Yomitan API setup for the commands.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ApiStatus, HostStatus } from '@ui/yomitan-api-setup'
import { nativeError } from './tauri'

export const hostStatus = (): Promise<HostStatus> => invoke<HostStatus>('yomitan_host_status')

export const apiCheck = (url: string): Promise<ApiStatus> => invoke<ApiStatus>('yomitan_api_check', { url })

export const installHost = (): Promise<string> => invoke<string>('install_yomitan_native_host')

/** An address the check refused (`invalid: …`), as an answer rather than a thrown error. */
const refused = (url: string, error: unknown): ApiStatus => ({
  url,
  server: false,
  yomitan: false,
  yomitanVersion: null,
  latencyMs: null,
  error: nativeError(error).message
})

export interface YomitanApiSetup {
  host: HostStatus | null
  api: ApiStatus | null
  /** Asks both again now (the Check again button, and after an install). */
  refresh: () => Promise<void>
}

/**
 * Both answers, kept fresh while `active`: the API every `apiEveryMs` (the wizard asks every
 * second while a step is visible), the helper's registrations less often (they only change when
 * something is installed, and on Windows each look runs `reg.exe`). A check still running is never
 * overlapped by the next one.
 */
export function useYomitanApiSetup(
  url: string,
  { active = true, apiEveryMs = 1000, hostEveryMs = 3000 }: { active?: boolean; apiEveryMs?: number; hostEveryMs?: number } = {}
): YomitanApiSetup {
  const [host, setHost] = useState<HostStatus | null>(null)
  const [api, setApi] = useState<ApiStatus | null>(null)
  const apiBusy = useRef(false)
  const hostBusy = useRef(false)
  const alive = useRef(true)

  const checkApi = useCallback(async (): Promise<void> => {
    if (apiBusy.current) return
    apiBusy.current = true
    try {
      const next = await apiCheck(url).catch((error: unknown) => refused(url, error))
      if (alive.current) setApi(next)
    } finally {
      apiBusy.current = false
    }
  }, [url])

  const checkHost = useCallback(async (): Promise<void> => {
    if (hostBusy.current) return
    hostBusy.current = true
    try {
      const next = await hostStatus().catch((error: unknown) => {
        console.error('Yomitan API helper status failed:', nativeError(error).message)
        return null
      })
      if (alive.current && next) setHost(next)
    } finally {
      hostBusy.current = false
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void checkApi()
    const timer = setInterval(() => void checkApi(), apiEveryMs)
    return () => clearInterval(timer)
  }, [active, apiEveryMs, checkApi])

  useEffect(() => {
    if (!active) return
    void checkHost()
    const timer = setInterval(() => void checkHost(), hostEveryMs)
    return () => clearInterval(timer)
  }, [active, hostEveryMs, checkHost])

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([checkHost(), checkApi()])
  }, [checkHost, checkApi])

  return { host, api, refresh }
}
