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
import { useCapabilities } from '../bridge/capabilities'

async function hasScreenRecordingPermission(): Promise<boolean> {
  try {
    const status = await invoke<string | boolean>('permission_status')
    return status === true || status === 'granted'
  } catch (error) {
    console.error('Screen recording permission check failed:', error)
    return false
  }
}

function useHasScreenRecordingPermission(enabled = true): boolean {
  const [hasPermission, setHasPermission] = useState(false)

  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])

  return hasPermission
}

/**
 * Which capture step onboarding needs, from `capture.authorization`:
 *  - `permission`: macOS-style Screen Recording, granted in System Settings (polled live);
 *  - `picker`: the system asks what to share each time a source is chosen (Wayland portals);
 *  - `none`: nothing to grant — already granted, not required, or capture is unavailable here.
 */
export type CaptureStep = 'permission' | 'picker' | 'none'

function useCaptureStep(): CaptureStep {
  const { capture } = useCapabilities()
  const needsGrant = capture.authorization === 'granted' || capture.authorization === 'denied'
  const polled = useHasScreenRecordingPermission(needsGrant)
  if (capture.authorization === 'promptOnSelect') return 'picker'
  if (!needsGrant) return 'none'
  return polled || capture.authorization === 'granted' ? 'none' : 'permission'
}

export { useCaptureStep, useHasScreenRecordingPermission }
