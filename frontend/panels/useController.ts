/**
 * Controller wiring for the main window's sidebar (in Electron, `RemoteControl` in `OverlayApp.tsx`).
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
  activateSource,
  clearSource,
  clearSourceCrop,
  selectSource,
  nativeError,
  openSettings,
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
  /** The sidebar's state and actions, as Electron's `RemoteControl` took them. */
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
  /** Bring the current window source's application to the front. */
  onActivateSource: () => void
  /** Read this window or display, keeping its saved region. */
  onSelectSource: (sourceId: string) => void
  /** Forget the current source's region. */
  onClearCrop: () => void
  /** Deselect the source: nothing is read until one is chosen again. */
  onClearSource: () => void
}

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
    // Electron showed three debug windows here; they are the Diagnostics window's tabs now.
    panel('diagnostics', next ? 'show' : 'hide').catch(report('Diagnostics window'))
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
    // Drawn over the source itself by the overlay, window or screen alike.
    onEditCropArea: () => attempt('Edit region', () => triggerAction('setCropArea')),
    onOpenLog: () => attempt('Show Kimochi', () => panel('log', 'show')),
    onToggleTextOverlayVisibility: () =>
      attempt('Toggle overlay text', () => triggerAction('toggleTextOverlay')),
    onToggleDebugOverlay,
    onOpenSettings: () => attempt('Open settings', () => openSettings()),
    onOpenSource: () => attempt('Open source picker', () => openSourcePicker()),
    onCloseApp: () => attempt('Quit', () => quitApp()),
    // Hover hints are cosmetic: a failure here must not put an error strip on screen.
    onSelectRegionHover: (hovered) =>
      void triggerAction(hovered ? 'hoverSelectRegionOn' : 'hoverSelectRegionOff').catch(
        () => undefined
      ),
    onActivateSource: () => {
      const sourceId = state.source?.sourceId
      if (!sourceId) return
      // The outline lets go at once, so the window it covered is what comes forward.
      void triggerAction('hoverSourceDismiss').catch(() => undefined)
      attempt('Bring the window to the front', () => activateSource(sourceId))
    },
    onSelectSource: (sourceId) => attempt('Choose source', () => selectSource(sourceId)),
    onClearCrop: () => {
      const sourceId = state.source?.sourceId
      if (sourceId) attempt('Clear crop area', () => clearSourceCrop(sourceId))
    },
    onClearSource: () => {
      // The source's outline would otherwise stay up over a window that is no longer the source.
      void triggerAction('hoverSourceDismiss').catch(() => undefined)
      attempt('Clear source', () => clearSource())
    },
    onSourceHover: (hovered) =>
      void triggerAction(hovered ? 'hoverSourceOn' : 'hoverSourceOff').catch(() => undefined)
  }

  return { props, status: state.status, error, dismissError: () => setError(null) }
}
