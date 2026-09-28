/**
 * Controller wiring shared by the controller window and the tray popover — the two places Electron
 * mounts `RemoteControl` (`OverlayApp.tsx` and `TrayPopoverApp.tsx`).
 *
 * In Electron the callbacks ran inside OverlayApp, which owned the session. Here each action is a
 * single `trigger_action` call so that the overlay (which owns capture and OCR orchestration) is
 * the only component deciding what a scan means; window visibility stays a panel concern.
 */
import { useCallback, useMemo, useState } from 'react'
import type { CaptureSource } from '../vendor/shared-types'
import { useViewState } from '../bridge/state'
import { useSetting } from '../bridge/useSetting'
import {
  nativeError,
  openSourcePicker,
  panel,
  quitApp,
  triggerAction
} from '../bridge/tauri'

/**
 * The native source descriptor uses the capture backend's vocabulary (`display`), while the
 * Electron components and their props use `screen`. Normalising here matters: "Select Region"
 * branches on it, so a mismatch would silently turn select-and-scan on a display into the window
 * crop picker.
 */
function normaliseType(type: string | undefined): 'screen' | 'window' {
  return type === 'screen' || type === 'display' ? 'screen' : 'window'
}

export interface ControllerWiring {
  /** Props for `RemoteControl`, exactly as the Electron mounts passed them. */
  props: RemoteControlProps
  /** The backend's current status line. */
  status: string
  /** The most recent failed action, for display next to the controls. */
  error: string | null
  dismissError: () => void
}

interface RemoteControlProps {
  isAutoOCREnabled: boolean
  isScanning: boolean
  hasSource: boolean
  isScreenSource: boolean
  isSourceInForeground: boolean
  isOverlayModeEnabled: boolean
  isTextOverlayVisible: boolean
  showDebugOverlay: boolean
  currentSource: CaptureSource | undefined
  onToggleAutoOCR: () => void
  onTriggerScan: () => void
  onSelectAndScan: () => void
  onEditCropArea: () => void
  onOpenLog: () => void
  onToggleTextOverlayVisibility: () => void
  onToggleDebugOverlay: () => void
  onOpenSettings: () => void
  onOpenSource: () => void
  onCloseApp: () => void
  onSelectRegionHover: (hovered: boolean) => void
  onSourceHover: (hovered: boolean) => void
}

/** The three debug windows Electron showed together with the overlay's debug markings. */
const DEBUG_PANELS = ['debug', 'capture', 'stream'] as const

export function useController(): ControllerWiring {
  const { state } = useViewState()
  const [liveOverlayEnabled] = useSetting<boolean>('liveOverlayEnabled', false)
  const [error, setError] = useState<string | null>(null)

  // A control that does nothing, silently, is worse than one that reports why.
  const report = useCallback(
    (what: string) => (caught: unknown) => {
      const { message } = nativeError(caught)
      console.error(`${what} failed:`, message)
      setError(`${what} failed: ${message}`)
    },
    []
  )
  const attempt = useCallback(
    (what: string, call: () => Promise<unknown>) => {
      setError(null)
      call().catch(report(what))
    },
    [report]
  )

  const currentSource = useMemo<CaptureSource | undefined>(() => {
    const source = state.source
    if (!source) return undefined
    return {
      id: 0,
      name: source.name,
      sourceId: source.sourceId,
      thumbnail: '',
      type: normaliseType(source.type),
      appName: source.appName ?? undefined,
      icon: source.icon ?? undefined
    }
  }, [state.source])

  const showDebugOverlay = Boolean(state.debugOverlayVisible)

  const onToggleDebugOverlay = useCallback((): void => {
    // The action toggles the overlay's own markings; the windows are a panel concern, so the
    // controller opens and closes them here exactly as OverlayApp's `showDebugOverlay` did.
    const next = !showDebugOverlay
    attempt('Toggle debug overlay', () => triggerAction('toggleDebugOverlay'))
    for (const label of DEBUG_PANELS) {
      panel(label, next ? 'show' : 'hide').catch(report(`Debug panel ${label}`))
    }
  }, [showDebugOverlay, attempt, report])

  const props: RemoteControlProps = {
    isAutoOCREnabled: Boolean(state.autoOcrEnabled),
    isScanning: Boolean(state.isScanning),
    hasSource: Boolean(state.source),
    isScreenSource: normaliseType(state.source?.type) === 'screen' && Boolean(state.source),
    // Electron passes `true` here from both mount sites: the overlay decides text visibility
    // itself, and the controller must never be disabled just because Kimochi has focus.
    isSourceInForeground: true,
    isOverlayModeEnabled: liveOverlayEnabled,
    isTextOverlayVisible: state.textOverlayVisible ?? true,
    showDebugOverlay,
    currentSource,
    onToggleAutoOCR: () => attempt('Toggle auto OCR', () => triggerAction('toggleAutoOcr')),
    onTriggerScan: () => attempt('Scan', () => triggerAction('triggerScan')),
    onSelectAndScan: () => attempt('Select and scan', () => triggerAction('selectAndScan')),
    onEditCropArea: () => attempt('Open crop editor', () => openSourcePicker(true)),
    onOpenLog: () => attempt('Open log', () => panel('log', 'show')),
    onToggleTextOverlayVisibility: () =>
      attempt('Toggle overlay text', () => triggerAction('toggleTextOverlay')),
    onToggleDebugOverlay,
    onOpenSettings: () => attempt('Open settings', () => panel('settings', 'show')),
    onOpenSource: () => attempt('Open source picker', () => openSourcePicker(false)),
    onCloseApp: () => attempt('Quit', () => quitApp()),
    // Hover hints are cosmetic: a failure here must not put an error strip on screen.
    onSelectRegionHover: (hovered) =>
      void triggerAction(hovered ? 'hoverSelectRegionOn' : 'hoverSelectRegionOff').catch(
        () => undefined
      ),
    onSourceHover: (hovered) =>
      void triggerAction(hovered ? 'hoverSourceOn' : 'hoverSourceOff').catch(() => undefined)
  }

  return { props, status: state.status, error, dismissError: () => setError(null) }
}
