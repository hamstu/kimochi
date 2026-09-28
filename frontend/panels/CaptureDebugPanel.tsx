/**
 * REPLACEMENT for `src/renderer/src/components/StreamDebugPanel.tsx` (the `stream` window).
 *
 * The Electron panel probes `navigator.mediaDevices`, `getUserMedia` with `chromeMediaSource`,
 * `desktopCapturer` and the Electron screenshot pipeline. None of that exists here — capture is
 * native — so those probes are NOT reproduced and are NOT stubbed to look like they pass. Each one
 * is replaced by the native equivalent that answers the same question, and the panel keeps the
 * original's shape: a timestamped, colour-coded terminal log with copy and clear.
 *
 * | Electron probe | Native equivalent here |
 * | --- | --- |
 * | `navigator.mediaDevices` present | Screen Recording permission status |
 * | `desktopCapturer` / `load-sources` dump | `source_catalog()` dump |
 * | `getUserMedia` stream + video element | timed `capture_frame()` with pixel dimensions |
 * | screenshot pipeline round-trip | crop scaling check against the reported reference |
 * | OCR round-trip | `scan(ocr: true)` against the configured endpoint |
 * | — | native window state dump (`panel(inspect)`, `desktop()`) |
 *
 * The OCR probe is the only one that sends pixels anywhere; its button says so.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import WindowFrame from '../components/WindowFrame'
import { useViewState } from '../bridge/state'
import {
  captureFrame,
  desktop,
  enumerateSources,
  nativeError,
  panel,
  requestPermission,
  scan,
  sourceCatalog,
  systemState
} from '../bridge/tauri'
import type { NativeSource, PanelLabel } from '../bridge/types'

interface LogEntry {
  time: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

const LOG_COLORS: Record<LogEntry['level'], string> = {
  info: '#8be9fd',
  warn: '#f1fa8c',
  error: '#ff5555',
  success: '#50fa7b'
}

const INSPECTED: PanelLabel[] = ['controller', 'log', 'settings', 'overlay']

export default function CaptureDebugPanel(): JSX.Element {
  const { state } = useViewState()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    const time = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      fractionalSecondDigits: 3
    })
    setLogs((previous) => [...previous.slice(-200), { time, level, message }])
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const sourceId = state.source?.sourceId ?? null

  const run = useCallback(
    async (name: string, body: () => Promise<void>) => {
      if (isRunning) return
      setIsRunning(true)
      addLog('info', `--- ${name} ---`)
      try {
        await body()
      } catch (error) {
        const { kind, message } = nativeError(error)
        addLog('error', `${name} failed [${kind}]: ${message}`)
      } finally {
        setIsRunning(false)
      }
    },
    [isRunning, addLog]
  )

  const describeSources = (sources: NativeSource[]): void => {
    addLog('success', `Catalog returned ${sources.length} sources`)
    for (const source of sources) {
      addLog(
        'info',
        `  [${source.kind}] "${source.name}" id=${source.id} app=${source.app ?? 'n/a'} icon=${source.icon ? 'yes' : 'no'} onScreen=${source.on_screen ?? 'n/a'}`
      )
    }
  }

  const testPermission = (): Promise<void> =>
    run('Screen Recording permission', async () => {
      const granted = await requestPermission()
      addLog(
        granted ? 'success' : 'error',
        granted
          ? 'Screen Recording is granted for this bundle'
          : 'Screen Recording is NOT granted; capture will fail until it is enabled in System Settings'
      )
    })

  const testCatalog = (): Promise<void> =>
    run('Source catalog', async () => {
      try {
        describeSources(await sourceCatalog())
      } catch (error) {
        addLog('warn', `source_catalog unavailable (${nativeError(error).kind}); trying enumerate()`)
        describeSources(await enumerateSources())
      }
    })

  const testCapture = (): Promise<void> =>
    run('Native capture (local only)', async () => {
      if (!sourceId) {
        addLog('warn', 'No source selected; choose one in the source picker first')
        return
      }
      const started = performance.now()
      const frame = await captureFrame({ source_id: sourceId, crop: state.crop ?? null })
      const elapsed = Math.round(performance.now() - started)
      addLog('success', `Captured in ${elapsed} ms · id=${frame.id}`)
      addLog('info', `  captured px: ${frame.info.width} × ${frame.info.height}`)
      addLog('info', `  full source px: ${frame.info.full_width} × ${frame.info.full_height}`)
      addLog('info', `  url: ${frame.url}`)
      setPreviewUrl(frame.url)
    })

  const testCropScaling = (): Promise<void> =>
    run('Crop scaling', async () => {
      const crop = state.crop
      if (!crop) {
        addLog('warn', 'No crop saved for this source; nothing to scale')
        return
      }
      if (!sourceId) {
        addLog('warn', 'No source selected')
        return
      }
      const frame = await captureFrame({ source_id: sourceId, crop })
      const scaleX = frame.info.full_width / crop.reference_width
      const scaleY = frame.info.full_height / crop.reference_height
      addLog(
        'info',
        `  reference ${crop.reference_width}×${crop.reference_height} -> current ${frame.info.full_width}×${frame.info.full_height} (x${scaleX.toFixed(3)}, x${scaleY.toFixed(3)})`
      )
      const expectedWidth = Math.round(crop.width * scaleX)
      const expectedHeight = Math.round(crop.height * scaleY)
      const matches =
        Math.abs(frame.info.width - expectedWidth) <= 2 &&
        Math.abs(frame.info.height - expectedHeight) <= 2
      addLog(
        matches ? 'success' : 'error',
        `  expected ${expectedWidth}×${expectedHeight}, captured ${frame.info.width}×${frame.info.height}`
      )
    })

  const testOcr = (): Promise<void> =>
    run('OCR endpoint round-trip (SENDS PIXELS)', async () => {
      if (!sourceId) {
        addLog('warn', 'No source selected')
        return
      }
      const started = performance.now()
      const result = await scan({ source_id: sourceId, crop: state.crop ?? null }, true)
      const elapsed = Math.round(performance.now() - started)
      const annotations = result.ocr?.textAnnotations?.length ?? 0
      addLog('success', `OCR returned in ${elapsed} ms with ${annotations} annotations`)
      const text = result.ocr?.fullText ?? ''
      if (text) addLog('info', `  first line: ${text.split('\n')[0]}`)
    })

  const testNativeState = (): Promise<void> =>
    run('Native window state', async () => {
      const displays = await desktop().catch(() => [])
      addLog('info', `  displays: ${JSON.stringify(displays)}`)
      const system = await systemState().catch(() => null)
      if (system) addLog('info', `  frontmost app: ${system.frontmostApp ?? 'unknown'}`)
      for (const label of INSPECTED) {
        try {
          const info = await panel(label, 'inspect')
          addLog(
            'info',
            `  ${label}: bounds=(${info.bounds.x},${info.bounds.y}) ${info.bounds.width}×${info.bounds.height} scale=${info.scale} pinned=${info.pinned} level=${info.native?.level}`
          )
        } catch (error) {
          addLog('warn', `  ${label}: ${nativeError(error).message}`)
        }
      }
    })

  const clearLogs = useCallback(() => {
    setLogs([])
    setPreviewUrl(null)
  }, [])

  const copyLogs = useCallback(() => {
    const text = logs.map((entry) => `${entry.time} [${entry.level}] ${entry.message}`).join('\n')
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      (error) => addLog('error', `Copy failed: ${error}`)
    )
  }, [logs, addLog])

  const buttonStyle: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid #ffffff22',
    background: '#282a36',
    color: '#f8f8f2',
    cursor: isRunning ? 'wait' : 'pointer'
  }

  return (
    <WindowFrame>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          color: '#f8f8f2',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 10 }}>
          <button style={buttonStyle} disabled={isRunning} onClick={() => void testPermission()}>
            Permission
          </button>
          <button style={buttonStyle} disabled={isRunning} onClick={() => void testCatalog()}>
            Sources
          </button>
          <button style={buttonStyle} disabled={isRunning} onClick={() => void testCapture()}>
            Capture (local)
          </button>
          <button style={buttonStyle} disabled={isRunning} onClick={() => void testCropScaling()}>
            Crop scaling
          </button>
          <button style={buttonStyle} disabled={isRunning} onClick={() => void testNativeState()}>
            Native state
          </button>
          <button
            style={{ ...buttonStyle, borderColor: '#ff5555' }}
            disabled={isRunning}
            title="Sends the current capture to the configured OCR endpoint"
            onClick={() => void testOcr()}
          >
            OCR round-trip
          </button>
          <button style={buttonStyle} onClick={copyLogs}>
            {copied ? 'Copied' : 'Copy log'}
          </button>
          <button style={buttonStyle} onClick={clearLogs}>
            Clear
          </button>
        </div>

        <div style={{ padding: '0 10px 6px', color: '#8be9fd' }}>
          Source: {state.source ? `${state.source.name}` : 'none selected'} · capture is local;
          only the OCR round-trip leaves this machine.
        </div>

        {previewUrl && (
          <div style={{ padding: '0 10px 8px' }}>
            <img
              src={previewUrl}
              alt="Last local capture"
              style={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain' }}
            />
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 10px' }}>
          {logs.length === 0 ? (
            <div style={{ color: '#6272a4' }}>Run a probe to see native capture diagnostics.</div>
          ) : (
            logs.map((entry, index) => (
              <div key={index} style={{ color: LOG_COLORS[entry.level], whiteSpace: 'pre-wrap' }}>
                <span style={{ color: '#6272a4' }}>{entry.time}</span> {entry.message}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </WindowFrame>
  )
}
