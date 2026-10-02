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
 *  4. The rows also form the main window's sidebar. There the source row opens `sourceMenu` (the
 *     unified Source menu: screen OCR, clipboard or WebSocket), the OCR rows give way to
 *     `inputNote` while another input is chosen (`ocrActive`), and the Log row is left out
 *     (`openMainLabel` is null) because the sidebar is already in that window. The tray popover
 *     keeps the Log row as "Show Kimochi".
 *
 * Otherwise the markup, icons, labels, switches, dividers, disabled rules and hover callbacks are
 * unchanged.
 * "Select Region" keeps its original branch: select-and-scan for a screen source, crop editing for
 * a window source.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
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
  ScanSearch,
  ChevronsUpDown
} from 'lucide-react'
import { Menu, MenuContent, MenuTrigger, Switch, Tooltip } from '@kit'
import clsx from 'clsx'
import styles from './RemoteControl.module.css'
import { isOverlayTextVisible } from '../../ui/settings'
import type { CaptureSource } from '../vendor/shared-types'
import { sourceIcon } from '../bridge/tauri'

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
  /** When set, the source row opens this menu instead of the source picker. */
  sourceMenu?: ReactNode
  /** The source row's icon and name when the input is not the screen (clipboard, WebSocket). */
  inputLabel?: { icon: ReactNode; name: string }
  /** False while another input than screen OCR is chosen: the OCR rows give way to `inputNote`. */
  ocrActive?: boolean
  inputNote?: ReactNode
  /** Label of the row that shows the main window; null leaves the row out. */
  openMainLabel?: string | null
}

/**
 * The selected window's app icon. The source catalog leaves icons out for speed, so it is fetched
 * (natively cached per app) when the source does not carry one. A soft placeholder holds the
 * slot and the icon fades in once decoded; an app without an icon keeps the generic glyph.
 */
export function SourceIcon({ source }: { source: CaptureSource }): JSX.Element {
  const app = source.appName || source.name
  const [fetched, setFetched] = useState<{
    app: string
    url: string | null
  } | null>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const url = source.icon || (fetched?.app === app ? fetched.url : undefined)
  const settled = Boolean(source.icon) || fetched?.app === app

  useEffect(() => {
    if (source.icon || !app) return
    let live = true
    sourceIcon(app)
      .then((result) => live && setFetched({ app, url: result.icon }))
      .catch(() => live && setFetched({ app, url: null }))
    return () => {
      live = false
    }
  }, [app, source.icon])

  const loaded = Boolean(url) && loadedUrl === url

  if (settled && !url) return <AppWindow width="16" height="16" className={styles.buttonIcon} />
  return (
    <span className={styles.sourceIcon} data-loaded={loaded || undefined} aria-hidden>
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={() => setLoadedUrl(url ?? null)}
          onError={() => setFetched({ app, url: null })}
        />
      )}
    </span>
  )
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
  onSourceHover,
  sourceMenu,
  inputLabel,
  ocrActive = true,
  inputNote,
  openMainLabel = 'Log'
}: RemoteControlProps): JSX.Element {
  const sourceButton = (
    <button
      className={clsx(styles.button, sourceMenu && styles.sourceTrigger)}
      onClick={() => {
        onSourceHover?.(false)
        if (!sourceMenu) (onOpenSource ?? onOpenSettings)()
      }}
      onMouseEnter={() => {
        // Only trigger hover for app sources (not screens)
        if (ocrActive && currentSource && currentSource.type === 'window') {
          onSourceHover?.(true)
        }
      }}
      onMouseLeave={() => onSourceHover?.(false)}
    >
      {!ocrActive && inputLabel ? (
        <>
          <span className={styles.buttonIcon}>{inputLabel.icon}</span>
          <span className={styles.sourceName}>{inputLabel.name}</span>
        </>
      ) : (
        <>
          {currentSource ? (
            currentSource.type === 'screen' ? (
              <Monitor width="16" height="16" className={styles.buttonIcon} />
            ) : (
              <SourceIcon source={currentSource} />
            )
          ) : (
            <AppWindow width="16" height="16" className={styles.buttonIcon} />
          )}
          <span className={styles.sourceName}>
            {currentSource
              ? currentSource.appName || currentSource.name || currentSource.sourceId
              : 'Select a source'}
          </span>
        </>
      )}
      {sourceMenu && <ChevronsUpDown className={styles.sourceChevron} aria-hidden />}
    </button>
  )

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {/* Buttons - visible when expanded */}
        <div className={styles.buttons}>
          {/* Source selection button */}
          {sourceMenu ? (
            <Menu>
              <MenuTrigger asChild>{sourceButton}</MenuTrigger>
              <MenuContent align="start" className={styles.sourceMenu}>
                {sourceMenu}
              </MenuContent>
            </Menu>
          ) : (
            sourceButton
          )}

          {!ocrActive && inputNote && <div className={styles.inputNote}>{inputNote}</div>}

          {ocrActive && (
            <>
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
            </>
          )}

          <div className={styles.divider} />

          {openMainLabel && (
            <button className={styles.button} onClick={onOpenLog}>
              <PanelLeft width="16" height="16" className={styles.buttonIcon} />
              {openMainLabel}
            </button>
          )}

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
