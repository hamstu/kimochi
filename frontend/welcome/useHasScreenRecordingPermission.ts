/**
 * ADAPTED from `src/renderer/src/windows/welcome/useHasScreenRecordingPermission.ts`.
 * Delta: the `check-for-screen-recording-permission` IPC becomes `permission_status()`. Same 2 s
 * poll, so the screen updates once the user grants access in System Settings.
 *
 * `permission_status` must be a *query*: the onboarding screen polls it, and a command that
 * re-prompts every two seconds would be unusable (PARITY_GAPS #8).
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

async function hasScreenRecordingPermission(): Promise<boolean> {
  try {
    const status = await invoke<string | boolean>('permission_status')
    return status === true || status === 'granted'
  } catch (error) {
    console.error('Screen recording permission check failed:', error)
    return false
  }
}

function useHasScreenRecordingPermission(): boolean {
  const [hasPermission, setHasPermission] = useState(false)

  useEffect(() => {
    let active = true
    const check = (): void => {
      hasScreenRecordingPermission().then((result) => {
        if (active) setHasPermission(result)
      })
    }
    check()
    const interval = setInterval(check, 2000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  return hasPermission
}

export { useHasScreenRecordingPermission }
