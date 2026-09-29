/**
 * ADAPTED from `src/renderer/src/components/DebugOverlay.tsx` (its `mode="panel"` half only; the
 * `mode="overlay"` markings belong to the overlay workstream).
 *
 * Same purpose, same monospace presentation: what the app currently believes about the source, the
 * capture, the crop and the displays, so a misplaced overlay can be diagnosed.
 *
 * Deltas, and why:
 *  - the Electron panel recomputed scale factors with `utils/ocr-coordinates.ts`, which reconstructs
 *    them from `cropRegion.videoWidth/videoHeight` because Electron has no native crop rescaling.
 *    capture-core already rescales the saved reference crop per axis and reports the result, so
 *    this panel prints the backend's own numbers instead of a second, possibly disagreeing,
 *    calculation (kimochi-19 owns the single geometry implementation in `ui/geometry.ts`).
 *  - display and window geometry come from `desktop()`, `system_state()` and `panel(inspect)`.
 *  - annotation statistics are printed from the raw boxes. The authoritative small-text filter
 *    lives in the overlay's `ui/annotations.ts`; this panel does not reimplement it.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Bar, BarSpacer } from '@kit'
import WindowFrame from '../components/WindowFrame'
import './diagnostics.css'
import { useViewState } from '../bridge/state'
import { displays as nativeDisplays, nativeError, panel, systemState } from '../bridge/tauri'
import type { DisplayInfo, PanelInfo, Rect, SystemState, TextAnnotation } from '../bridge/types'

const REFRESH_MS = 1000

const label = { color: 'yellow' } as const

function Section({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }) {
  return (
    <div
      style={{
        marginBottom: 8,
        padding: 6,
        backgroundColor: 'rgba(0,100,255,0.2)',
        borderRadius: 4,
        border: '1px solid #0066ff'
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: 6, color: '#00aaff' }}>{title}</div>
      {children}
    </div>
  )
}

const rect = (value: Rect | null | undefined): string =>
  value ? `(${value.x}, ${value.y}) ${value.width}×${value.height}` : 'null'

export default function DebugPanel(): JSX.Element {
  const { state, transport, error } = useViewState()
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [system, setSystem] = useState<SystemState | null>(null)
  const [overlay, setOverlay] = useState<PanelInfo | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const results = await Promise.allSettled([
        nativeDisplays(),
        systemState(),
        panel('overlay', 'inspect')
      ])
      if (!active) return
      const [displayResult, systemResult, overlayResult] = results
      if (displayResult.status === 'fulfilled') setDisplays(displayResult.value)
      if (systemResult.status === 'fulfilled') setSystem(systemResult.value)
      if (overlayResult.status === 'fulfilled') setOverlay(overlayResult.value)
      const failure = results.find((result) => result.status === 'rejected')
      setProbeError(
        failure && failure.status === 'rejected' ? nativeError(failure.reason).message : null
      )
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  // `system_state()` reports rich displays; `desktop()` only reports rectangles. Normalise both.
  const displayList: DisplayInfo[] = useMemo(
    () => (displays.length > 0 ? displays : (system?.displays ?? [])),
    [system, displays]
  )

  const stats = useMemo(() => {
    // The first annotation is the whole block; the rest are words.
    const annotations: TextAnnotation[] = state.scan?.ocr?.textAnnotations ?? []
    const words = annotations.slice(1)
    if (words.length === 0) return null
    const heights = words.map((annotation) => {
      const ys = annotation.boundingPoly.vertices.map((vertex) => vertex.y ?? 0)
      return Math.max(...ys) - Math.min(...ys)
    })
    const sorted = [...heights].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const median =
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
    return { count: words.length, min: sorted[0], max: sorted[sorted.length - 1], median }
  }, [state.scan])

  return (
    <WindowFrame>
      <Bar position="top" className="diag-bar diag-bar-text">
        <span className="k-medium">Debug coordinates</span>
        <BarSpacer />
        <span className="k-num">Refreshes every {REFRESH_MS / 1000}s</span>
      </Bar>
      <div className="diag-terminal diag-scroll">

        {(error || probeError) && (
          <div style={{ color: '#ff8080', marginBottom: 8 }}>{error ?? probeError}</div>
        )}

        <Section title="Session">
          <div>
            <span style={label}>revision:</span> {state.revision} <span style={label}>via</span>{' '}
            {transport}
          </div>
          <div>
            <span style={label}>status:</span> {state.status || '—'}
          </div>
          <div>
            <span style={label}>source:</span>{' '}
            {state.source
              ? `${state.source.type} · ${state.source.appName ?? '—'} · ${state.source.name} [${state.source.sourceId}]`
              : 'none'}
          </div>
          <div>
            <span style={label}>scanning:</span> {String(Boolean(state.isScanning))}{' '}
            <span style={label}>autoOCR:</span> {String(Boolean(state.autoOcrEnabled))}
          </div>
          <div>
            <span style={label}>overlay:</span> {String(state.overlayVisible ?? true)}{' '}
            <span style={label}>text:</span> {String(state.textOverlayVisible ?? true)}{' '}
            <span style={label}>debug:</span> {String(state.debugOverlayVisible ?? false)}
          </div>
          <div>
            <span style={label}>frontmost app:</span> {system?.frontmostApp ?? 'unknown'}
          </div>
        </Section>

        <Section title="Capture">
          {state.scan ? (
            <>
              <div>
                <span style={label}>capture id:</span> {state.scan.id}
              </div>
              <div>
                <span style={label}>captured px:</span> {state.scan.info.width} ×{' '}
                {state.scan.info.height}
              </div>
              <div>
                <span style={label}>full source px:</span> {state.scan.info.full_width} ×{' '}
                {state.scan.info.full_height}
              </div>
            </>
          ) : (
            <div>No capture yet.</div>
          )}
          <div>
            <span style={label}>crop enabled:</span> {String(Boolean(state.cropEnabled))}
          </div>
          <div>
            <span style={label}>crop:</span>{' '}
            {state.crop
              ? `(${state.crop.x}, ${state.crop.y}) ${state.crop.width}×${state.crop.height} ref ${state.crop.reference_width}×${state.crop.reference_height}`
              : 'full source'}
          </div>
        </Section>

        <Section title="Overlay window">
          <div>
            <span style={label}>origin:</span> {rect(state.origin)}
          </div>
          <div>
            <span style={label}>bounds:</span> {rect(overlay?.bounds)}
          </div>
          <div>
            <span style={label}>scale:</span> {overlay?.scale ?? '—'}{' '}
            <span style={label}>level:</span> {overlay?.native?.level ?? '—'}{' '}
            <span style={label}>click-through:</span>{' '}
            {overlay ? String(overlay.native.ignores_mouse) : '—'}
          </div>
          <div>
            <span style={label}>captured window:</span>{' '}
            {state.sourceFocus
              ? [
                  state.sourceFocus.focused ? 'in front' : 'behind',
                  state.sourceFocus.present ? 'on screen' : 'gone',
                  state.sourceFocus.held ? '(held: Kimochi is frontmost)' : ''
                ]
                  .filter(Boolean)
                  .join(', ')
              : '—'}
          </div>
          <div>
            <span style={label}>interactive regions:</span>{' '}
            {Object.entries(state.regions)
              .map(([window, rects]) => `${window} ${rects.length}`)
              .join(', ') || 'none'}
          </div>
        </Section>

        <Section title={`Displays (${displayList.length})`}>
          <>
            {displayList.map((display, index) => (
              <div
                key={index}
                style={{ paddingLeft: 8, borderLeft: '2px solid #444', marginBottom: 4 }}
              >
                <div>
                  <span style={label}>#{display.id ?? index}</span> bounds {rect(display.bounds)}
                </div>
                {display.workArea && <div>&nbsp;&nbsp;workArea {rect(display.workArea)}</div>}
                {display.scaleFactor !== undefined && (
                  <div>&nbsp;&nbsp;scaleFactor {display.scaleFactor}</div>
                )}
              </div>
            ))}
          </>
        </Section>

        <Section title="Text annotations">
          {stats ? (
            <>
              <div>
                <span style={label}>words:</span> {stats.count}
              </div>
              <div>
                <span style={label}>height px:</span> min {stats.min}, median {stats.median}, max{' '}
                {stats.max}
              </div>
              <div style={{ color: '#aaa', marginTop: 4 }}>
                The small-text (furigana) filter itself runs in the overlay; these are the raw boxes
                the backend returned.
              </div>
            </>
          ) : (
            <div>No annotations in the last result.</div>
          )}
        </Section>
      </div>
    </WindowFrame>
  )
}
