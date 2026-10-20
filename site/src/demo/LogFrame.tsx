import { useEffect, useRef, useState, type RefObject } from 'react'
import { WINDOW_SHAPE, type DesktopPlatform } from './chrome'

/** The harness page built by `npm run demo:build` (vite.demo.config.ts) into site/public/demo/. */
const LOG_URL = '/demo/panel.html'

export type LogMessage =
  | { type: 'scan' }
  | { type: 'line'; text: string }
  | { type: 'theme'; value: 'light' | 'dark' }
  | { type: 'interactive'; value: boolean }
  | { type: 'sidebar'; value: boolean }
  | { type: 'sources'; open: string[] }
  /** Play one of the app's sounds (by name) in the Log's page, which has them. */
  | { type: 'sound'; name: string }

/** A title-bar drag inside the Log, in screen coordinates (the harness's `embedDrag`). */
export interface LogDrag {
  phase: 'start' | 'move' | 'end'
  x: number
  y: number
}

/** What the embedded Log tells the demo (the harness's `tellEmbedder`). */
export type LogEvent =
  | ({ type: 'drag' } & LogDrag)
  | { type: 'state'; sourceId: string | null; autoOcr: boolean; overlay: boolean }
  | { type: 'window'; action: 'mini' | 'expand' | 'minimize' | 'hide' | 'close' }
  | { type: 'activate'; sourceId: string | null }
  | { type: 'interact' }
  /** The visitor reached something only the app can do (the harness's demo stops). */
  | { type: 'unavailable'; feature: string }

export type PostToLog = (message: LogMessage) => void

let available: Promise<boolean> | null = null

/** Whether the harness build exists (a missing file would come back as the site's SPA fallback). */
function harnessAvailable(): Promise<boolean> {
  available ??= fetch(LOG_URL, { cache: 'no-store' })
    .then(async (res) => res.ok && (await res.text()).includes('Preview · panel'))
    .catch(() => false)
  return available
}

interface LogFrameProps {
  platform: DesktopPlatform
  theme: 'light' | 'dark'
  /** Load the iframe once the stage first comes near the viewport. */
  load: boolean
  /** Filled with a sender the demo uses to drive the Log. */
  postRef: RefObject<PostToLog | null>
  /** Everything the Log reports: title-bar drags, its state, window actions, the visitor's clicks. */
  onEvent?: (event: LogEvent) => void
  /** More harness parameters (see frontend/dev/preview-setup.ts), e.g. `{nosource: '1'}`. */
  params?: Record<string, string>
  /** Changing it reloads the window from scratch (a replayed demo). */
  reloadKey?: number
  /** Filled with the iframe, for a demo that points at (and clicks) the real controls inside. */
  iframeRef?: RefObject<HTMLIFrameElement | null>
  /** Called once the window has loaded. */
  onLoaded?: () => void
  className?: string
}

/**
 * The REAL Kimochi Log window (the app's React UI with the Tauri runtime mocked), interactive by
 * default. It never takes focus or scrolls the page on its own: the frame is out of the tab order,
 * and the harness (`?embed=1`) ignores the app's programmatic focus until the visitor clicks in it.
 */
export function LogFrame({
  platform,
  theme,
  load,
  postRef,
  onEvent,
  params: extra,
  reloadKey = 0,
  iframeRef,
  onLoaded,
  className = ''
}: LogFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    if (load) void harnessAvailable().then(setOk)
  }, [load])

  // The theme is read once per platform so a theme change does not reload the window.
  const [src, setSrc] = useState<string | null>(null)
  const extraKey = JSON.stringify(extra ?? {})
  useEffect(() => {
    if (!load || !ok) return
    const params = new URLSearchParams({ window: 'log', embed: '1', sidebar: '0', theme: themeRef.current, ...JSON.parse(extraKey) })
    if (platform !== 'macos') params.set('platform', platform)
    if (reloadKey) params.set('run', String(reloadKey))
    setLoaded(false)
    setSrc(`${LOG_URL}?${params}`)
  }, [load, ok, platform, extraKey, reloadKey])

  useEffect(() => {
    if (iframeRef) iframeRef.current = frameRef.current
  })
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded
  useEffect(() => {
    if (loaded) onLoadedRef.current?.()
  }, [loaded])

  useEffect(() => {
    postRef.current = loaded
      ? (message) => frameRef.current?.contentWindow?.postMessage({ kimochiDemo: 1, ...message }, location.origin)
      : null
    return () => {
      postRef.current = null
    }
  }, [loaded, postRef])

  useEffect(() => {
    if (loaded) postRef.current?.({ type: 'theme', value: theme })
  }, [theme, loaded, postRef])

  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== frameRef.current?.contentWindow) return
      const data = event.data as ({ kimochiDemoEvent?: number } & LogEvent) | null
      if (data?.kimochiDemoEvent === 1) onEventRef.current?.(data)
    }
    addEventListener('message', receive)
    return () => removeEventListener('message', receive)
  }, [])

  return (
    <div className={`relative overflow-hidden bg-raised ${WINDOW_SHAPE[platform]} ${className}`}>
      {src ? (
        <iframe
          ref={frameRef}
          src={src}
          title="Kimochi Log window (live)"
          className={`absolute inset-0 size-full border-0 transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          tabIndex={-1}
          onLoad={() => setLoaded(true)}
        />
      ) : null}
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-small text-ink-3">
          {ok === false ? (
            <p>
              The live Log needs the harness build: run <code className="font-mono text-meta">npm run demo:build</code>.
            </p>
          ) : (
            <span className="h-1 w-16 animate-pulse rounded-full bg-hover" />
          )}
        </div>
      )}
    </div>
  )
}
