/**
 * FORK of `src/renderer/src/components/ScannedTextWindow.tsx` for the native Log window.
 *
 * Deltas:
 *  - it is its own window, so the props OverlayApp used to pass (history, opacity, scanning state,
 *    callbacks) are read directly from the same settings keys and the shared session state;
 *  - `window.yomitan.tokenize` -> the bridge's `tokenize`, using the custom API URL already read
 *    from `yomitanSettings`;
 *  - "Settings" in the overflow menu shows the settings window instead of toggling an overlay flag.
 *
 * Entry text is rendered as real text nodes (never canvas, never virtualised) so the overlay's
 * Yomitan relay can scan ranges over it once `/ui/panel-yomitan.js` lands — see PARITY_GAPS #15.
 * The typography, timestamps, font-size controls, per-entry audio and delete, opacity submenu,
 * clear-all, auto-scroll and tokenised-term popovers are all unchanged.
 */
import { type JSX, useState, useEffect, useRef, useCallback } from 'react'
import { Flex, DropdownMenu, IconButton, Badge, Tooltip, Popover, Callout } from '@radix-ui/themes'
import { Settings, MoreHorizontal, Eye, Plus, Minus, Trash2, TriangleAlert } from 'lucide-react'
import WindowFrame from '../components/WindowFrame'
import YomitanDictionaryPopup from '../components/YomitanDictionaryPopup'
import { AudioPlayer } from '../components/AudioPlayer'
import styles from '../styles/OverlayApp.module.css'
import { TokenizedTerm, YomitanSettings, ScanHistoryEntry } from '../vendor/shared-types'
import { useSetting } from '../bridge/useSetting'
import { useViewState } from '../bridge/state'
import { historyClear, historyDelete, nativeError, panel } from '../bridge/tauri'
import { usePanelYomitan } from '../shell/panelYomitan'
import { tokenize } from '../bridge/yomitan'

// Regex to filter out non-grammatical chunks
const NON_GRAMMATICAL_REGEX = /^[?!、。\s.,()（）]+$/

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

function ScannedTextWindow(): JSX.Element {
  // In Electron these arrived as props from OverlayApp; this is its own window now, so it reads
  // the same settings keys and the same shared session state directly.
  const { state } = useViewState()
  const [scanHistory] = useSetting<ScanHistoryEntry[]>('scannedTextHistory', [])
  const [backdropOpacityPct, setBackdropOpacityPct] = useSetting<number>('overlayOpacity', 80)
  const scannedText = state.scan?.ocr?.fullText ?? ''
  const isScanning = Boolean(state.isScanning)
  const visible = true

  const onOpenSettings = useCallback((): void => {
    panel('settings', 'show').catch((error) =>
      console.error('Open settings failed:', nativeError(error).message)
    )
  }, [])
  const onSetBackdropOpacity = useCallback(
    (opacity: number): void => {
      void setBackdropOpacityPct(opacity)
    },
    [setBackdropOpacityPct]
  )
  // Deletion goes through the backend, which owns the history key and its 50-entry cap, rather
  // than this window rewriting the whole array and racing the writer.
  const onDeleteHistoryEntry = useCallback((id: string): void => {
    historyDelete(id).catch((error) =>
      console.error('Delete log entry failed:', nativeError(error).message)
    )
  }, [])
  const onClearAllHistory = useCallback((): void => {
    historyClear().catch((error) =>
      console.error('Clear log failed:', nativeError(error).message)
    )
  }, [])

  const logContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)

  // Use the new hooks for settings
  const [fontSize, setFontSize] = useSetting<number>('scannedTextFontSize', 14)
  const [yomitanSettings] = useSetting<YomitanSettings>('yomitanSettings', {
    popupType: 'builtin',
    customApiUrl: ''
  })

  // Local state
  const [tokenizedTerms, setTokenizedTerms] = useState<TokenizedTerm[]>([])


  // Derived state from settings
  const useCustomApi = yomitanSettings.popupType === 'custom-api'
  const customApiUrl = yomitanSettings.customApiUrl || ''

  // Built-in lookup: the relay is imported by the window entry before React mounts, but starting
  // the scanner has to wait until the entries are real text nodes in the DOM, which is here.
  // Only the built-in popup type uses it; the custom-API path does its own lookups.
  const lookup = usePanelYomitan(!useCustomApi)

  // Get history in reverse order (oldest first, newest at bottom)
  const sortedHistory = [...scanHistory].reverse()

  // Auto-scroll to bottom when new entries are added
  useEffect(() => {
    if (logContainerRef.current && scanHistory.length > 0) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (logContainerRef.current && !userHasScrolled) {
          logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
        }
      })
    }
  }, [scanHistory.length, userHasScrolled])

  // Handle scroll to detect if user has manually scrolled up
  const handleScroll = (): void => {
    if (!logContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 20
    setUserHasScrolled(!isAtBottom)
  }

  // Tokenize text when scanned text changes and in custom API mode
  useEffect(() => {
    const tokenizeText = async (): Promise<void> => {
      if (!useCustomApi || !scannedText || isScanning) {
        setTokenizedTerms([])
        return
      }

      try {
        const result = await tokenize(scannedText, customApiUrl)
        if (result && result[0]?.content) {
          setTokenizedTerms(result[0].content)
        }
      } catch (error) {
        console.error('Failed to tokenize text:', error)
        setTokenizedTerms([])
      }
    }
    tokenizeText()
  }, [scannedText, useCustomApi, isScanning, customApiUrl])

  const handleFontSizeChange = (newSize: number): void => {
    const clampedSize = Math.max(8, Math.min(32, newSize)) // Clamp between 8px and 32px
    setFontSize(clampedSize)
  }

  const handlePlayAudio = (): void => {
    // Audio playback handled by audio service
  }

  const renderTokenizedText = (
    _text: string,
    entryTokenizedTerms: TokenizedTerm[]
  ): JSX.Element => {
    return (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '2px',
          alignItems: 'baseline',
          whiteSpace: 'pre'
        }}
      >
        {entryTokenizedTerms.map((term, index) => {
          const termText = term.map((part) => part.text).join('')
          const isGrammatical = !NON_GRAMMATICAL_REGEX.test(termText)

          if (isGrammatical) {
            return (
              <Popover.Root key={index}>
                <Popover.Trigger>
                  <span
                    style={{
                      cursor: 'pointer',
                      padding: '2px 4px',
                      borderRadius: '3px',
                      backgroundColor: 'var(--accent-a3)',
                      transition: 'background-color 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--accent-a5)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--accent-a3)'
                    }}
                  >
                    {termText}
                  </span>
                </Popover.Trigger>
                <Popover.Content
                  style={{
                    maxWidth: '450px',
                    maxHeight: '300px',
                    padding: 10,
                    overflow: 'hidden'
                  }}
                >
                  <YomitanDictionaryPopup word={termText} apiUrl={customApiUrl} />
                </Popover.Content>
              </Popover.Root>
            )
          } else {
            return (
              <span key={index} style={{ whiteSpace: 'pre' }}>
                {termText}
              </span>
            )
          }
        })}
      </div>
    )
  }

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 0.2s ease'
      }}
    >
      <WindowFrame>
        <Flex direction="column" style={{ height: '100%', minHeight: 0, position: 'relative' }}>
          {lookup.status === 'unavailable' && (
            <Callout.Root size="1" color="amber" m="2" role="status">
              <Callout.Icon>
                <TriangleAlert size={14} />
              </Callout.Icon>
              <Callout.Text>
                Hover-to-look-up is not running in this window: {lookup.message} Scanned text is
                still logged, and audio and the texthooker are unaffected.
              </Callout.Text>
            </Callout.Root>
          )}
          {/* Main content area - Log View */}
          <div
            ref={logContainerRef}
            onScroll={handleScroll}
            className={styles.logContainer}
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: `${fontSize}px`,
              lineHeight: 1.5
            }}
          >
            {sortedHistory.length > 0 ? (
              // Log entries
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {sortedHistory.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      padding: '6px 8px',
                      borderBottom: '1px solid var(--gray-a4)',
                      gap: '12px'
                    }}
                  >
                    {/* Timestamp */}
                    <span
                      style={{
                        color: 'var(--gray-a9)',
                        fontSize: `${fontSize * 0.7}px`,
                        flexShrink: 0,
                        minWidth: '38px',
                        paddingTop: '2px'
                      }}
                    >
                      {formatTimestamp(entry.timestamp)}
                    </span>

                    {/* Text content */}
                    <div
                      style={{
                        flex: 1,
                        whiteSpace: 'pre-wrap',
                        wordWrap: 'break-word',
                        overflowWrap: 'break-word',
                        userSelect: 'text',
                        cursor: 'text'
                      }}
                    >
                      {useCustomApi &&
                      tokenizedTerms.length > 0 &&
                      entry === sortedHistory[sortedHistory.length - 1]
                        ? renderTokenizedText(entry.text, tokenizedTerms)
                        : entry.text}
                    </div>

                    {/* Action buttons */}
                    <Flex gap="1" style={{ flexShrink: 0, marginTop: '2px' }}>
                      <AudioPlayer
                        text={entry.text}
                        disabled={!entry.text}
                        onPlay={handlePlayAudio}
                      />
                      <Tooltip content="Delete">
                        <IconButton
                          variant="ghost"
                          size="1"
                          color="red"
                          style={{ opacity: 0.5 }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = '1'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = '0.5'
                          }}
                          onClick={() => onDeleteHistoryEntry(entry.id)}
                        >
                          <Trash2 width="12" height="12" />
                        </IconButton>
                      </Tooltip>
                    </Flex>
                  </div>
                ))}
              </div>
            ) : (
              // Empty state - show nothing or a subtle hint
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: 'var(--gray-a8)',
                  fontSize: `${fontSize * 0.9}px`
                }}
              >
                Scan text to see results here
              </div>
            )}
          </div>

          {/* Status Bar */}
          <Flex align="center" justify="end" p="2" className={styles.statusBar}>
            {/* Controls */}
            <Flex align="center" gap="3">
              {/* Font size controls */}
              <Tooltip content="Decrease font size">
                <IconButton
                  variant="ghost"
                  size="1"
                  onClick={() => handleFontSizeChange(fontSize - 1)}
                  disabled={fontSize <= 8}
                >
                  <Minus width="12" height="12" />
                </IconButton>
              </Tooltip>

              <Tooltip content="Increase font size">
                <IconButton
                  variant="ghost"
                  size="1"
                  onClick={() => handleFontSizeChange(fontSize + 1)}
                  disabled={fontSize >= 32}
                >
                  <Plus width="12" height="12" />
                </IconButton>
              </Tooltip>

              {/* 3-dot menu button */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <IconButton variant="ghost" size="1" aria-label="Log options">
                    <MoreHorizontal width="14" height="14" />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  {/* Change opacity submenu */}
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger>
                      <Eye width="14" height="14" /> Opacity
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.SubContent>
                      {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => (
                        <DropdownMenu.Item key={pct} onClick={() => onSetBackdropOpacity(pct)}>
                          {pct}% {backdropOpacityPct === pct ? <Badge>Current</Badge> : ''}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Sub>

                  {/* Clear all logs */}
                  {sortedHistory.length > 0 && (
                    <DropdownMenu.Item color="red" onClick={onClearAllHistory}>
                      <Trash2 width="14" height="14" />
                      Clear all logs
                    </DropdownMenu.Item>
                  )}

                  {/* Settings */}
                  <DropdownMenu.Item onClick={onOpenSettings}>
                    <Settings width="14" height="14" />
                    Settings
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Flex>
          </Flex>
        </Flex>
      </WindowFrame>
    </div>
  )
}

export default ScannedTextWindow
