/**
 * COPY of `src/renderer/src/components/RemoteControl.tsx`.
 *
 * Deltas (only these):
 *  1. `CaptureSource` imports from the vendored copy of `src/shared/types.ts`.
 *  2. Added the optional `onOpenSource` prop. In Electron the source button called
 *     `onOpenSettings` because the source lived in the Settings "Source" tab; that tab is gone, so
 *     the button now opens the source picker while the Settings button still opens Settings. When
 *     the prop is absent the original behaviour is used.
 *  3. The Overlay row is always rendered. Electron hid it unless `isOverlayModeEnabled`, which
 *     defaults to off, so on a fresh profile the compact remote had no way to turn the OCR overlay
 *     on at all — the user had to find the Settings switch first. The row now reflects and drives
 *     `isOverlayTextVisible(...)`, the same predicate the renderer gates on, so the switch can never
 *     read as on while nothing is drawn.
 *
 * The markup, icons, labels, switches, dividers, disabled rules and hover callbacks are unchanged.
 * "Select Region" keeps its original branch: select-and-scan for a screen source, crop editing for
 * a window source.
 */
import type { JSX } from 'react'
import {
  Search,
  Crop,
  PanelLeft,
  Settings,
  Power,
  Eye,
  Bug,
  Monitor,
  AppWindow,
  ScanSearch
} from 'lucide-react'
import { Switch, Tooltip } from '@kit'
import clsx from 'clsx'
import styles from './RemoteControl.module.css'
import { isOverlayTextVisible } from '../../ui/settings'
import type { CaptureSource } from '../vendor/shared-types'

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
  /** Opens the source picker. Falls back to `onOpenSettings` when absent (Electron behaviour). */
  onOpenSource?: () => void
  onCloseApp: () => void
  /** Called when hovering over "Select Region" button */
  onSelectRegionHover?: (isHovered: boolean) => void
  /** Called when hovering over the source button (for app sources only) */
  onSourceHover?: (isHovered: boolean) => void
}

function RemoteControl({
  isAutoOCREnabled,
  isScanning,
  hasSource,
  isScreenSource,
  isSourceInForeground,
  isOverlayModeEnabled,
  isTextOverlayVisible,
  showDebugOverlay,
  currentSource,
  onToggleAutoOCR,
  onTriggerScan,
  onSelectAndScan,
  onEditCropArea,
  onOpenLog,
  onToggleTextOverlayVisibility,
  onToggleDebugOverlay,
  onOpenSettings,
  onOpenSource,
  onCloseApp,
  onSelectRegionHover,
  onSourceHover
}: RemoteControlProps): JSX.Element {
  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {/* Buttons - visible when expanded */}
        <div className={styles.buttons}>
          {/* Source selection button */}
          <button
            className={styles.button}
            onClick={() => {
              onSourceHover?.(false)
              ;(onOpenSource ?? onOpenSettings)()
            }}
            onMouseEnter={() => {
              // Only trigger hover for app sources (not screens)
              if (currentSource && currentSource.type === 'window') {
                onSourceHover?.(true)
              }
            }}
            onMouseLeave={() => onSourceHover?.(false)}
          >
            {currentSource ? (
              currentSource.type === 'screen' ? (
                <Monitor width="16" height="16" className={styles.buttonIcon} />
              ) : (
                <img
                  src={currentSource.icon}
                  width="16"
                  height="16"
                  className={styles.buttonIcon}
                  style={{ borderRadius: '2px' }}
                />
              )
            ) : (
              <AppWindow width="16" height="16" className={styles.buttonIcon} />
            )}
            <span className={styles.sourceName}>
              {currentSource
                ? currentSource.appName || currentSource.name || currentSource.sourceId
                : 'Select a source'}
            </span>
          </button>

          {/* Select region - for screens opens select-and-scan, for apps opens crop editor */}
          <button
            className={styles.button}
            onClick={() => {
              onSelectRegionHover?.(false)
              if (isScreenSource) {
                onSelectAndScan()
              } else {
                onEditCropArea()
              }
            }}
            disabled={!hasSource || (isScreenSource && (isAutoOCREnabled || isScanning))}
            onMouseEnter={() => onSelectRegionHover?.(true)}
            onMouseLeave={() => onSelectRegionHover?.(false)}
          >
            <Crop width="16" height="16" className={styles.buttonIcon} />
            Select Region
          </button>

          <div className={styles.divider} />

          {/* Auto OCR toggle */}
          <div
            className={clsx(styles.button, !hasSource && styles.buttonDisabled)}
            onClick={hasSource ? onToggleAutoOCR : undefined}
            role="button"
            tabIndex={hasSource ? 0 : -1}
            onKeyDown={(e) => e.key === 'Enter' && hasSource && onToggleAutoOCR()}
          >
            <ScanSearch width="16" height="16" className={styles.buttonIcon} />
            <span className={styles.buttonLabel}>Auto OCR</span>
            <Switch checked={isAutoOCREnabled} tabIndex={-1} />
          </div>

          {/* Manual scan */}
          <button
            className={styles.button}
            onClick={onTriggerScan}
            disabled={!hasSource || isAutoOCREnabled || isScanning}
          >
            <Search width="16" height="16" className={styles.buttonIcon} />
            Trigger Scan
          </button>

          <div className={styles.divider} />

          {/* Toggle the OCR text overlay. Always available: turning it on enables overlay
              mode as well, so this is the only switch needed to see scanned text. */}
          <Tooltip
            content="Bring the selected source to the front to show its overlay"
            hidden={isSourceInForeground}
            side="left"
          >
            <div
              className={clsx(styles.button, !isSourceInForeground && styles.buttonDisabled)}
              onClick={isSourceInForeground ? onToggleTextOverlayVisibility : undefined}
              role="button"
              tabIndex={isSourceInForeground ? 0 : -1}
              onKeyDown={(e) =>
                e.key === 'Enter' && isSourceInForeground && onToggleTextOverlayVisibility()
              }
            >
              <Eye width="16" height="16" className={styles.buttonIcon} />
              <span className={styles.buttonLabel}>Overlay</span>
              <Switch
                checked={
                  isOverlayTextVisible(isOverlayModeEnabled, isTextOverlayVisible) &&
                  isSourceInForeground
                }
                disabled={!isSourceInForeground}
                tabIndex={-1}
              />
            </div>
          </Tooltip>

          {/* Debug overlay toggle */}
          <div
            className={styles.button}
            onClick={onToggleDebugOverlay}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onToggleDebugOverlay()}
          >
            <Bug width="16" height="16" className={styles.buttonIcon} />
            <span className={styles.buttonLabel}>Debug</span>
            <Switch checked={showDebugOverlay} tabIndex={-1} />
          </div>

          <div className={styles.divider} />

          <button className={styles.button} onClick={onOpenLog}>
            <PanelLeft width="16" height="16" className={styles.buttonIcon} />
            Log
          </button>

          {/* Settings button */}
          <button className={styles.button} onClick={onOpenSettings}>
            <Settings width="16" height="16" className={styles.buttonIcon} />
            Settings
          </button>

          <div className={styles.divider} />

          {/* Quit button */}
          <button className={clsx(styles.button, styles.buttonDanger)} onClick={onCloseApp}>
            <Power width="16" height="16" className={styles.buttonIcon} />
            Quit
          </button>
        </div>
      </div>
    </div>
  )
}

export default RemoteControl
