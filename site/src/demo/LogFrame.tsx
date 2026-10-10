import { useEffect, useRef, useState, type RefObject } from 'react'
import { WINDOW_SHAPE, type DesktopPlatform } from './chrome'

/** The harness page built by `npm run demo:build` (vite.demo.config.ts) into site/public/demo/. */
const LOG_URL = '/demo/panel.html'

export type LogMessage =
  | { type: 'scan' }
  | { type: 'line'; text: string }
  | { type: 'theme'; value: 'light' | 'dark' }
  | { type: 'interactive'; value: boolean }

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
  className?: string
}

/**
 * The REAL Kimochi Log window (the app's React UI with the Tauri runtime mocked), interactive by
 * default. It never takes focus or scrolls the page on its own: the frame is out of the tab order,
 * and the harness (`?embed=1`) ignores the app's programmatic focus until the visitor clicks in it.
 */
export function LogFrame({ platform, theme, load, postRef, className = '' }: LogFrameProps) {
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
  useEffect(() => {
    if (!load || !ok) return
    const params = new URLSearchParams({ window: 'log', embed: '1', sidebar: '0', theme: themeRef.current })
    if (platform !== 'macos') params.set('platform', platform)
    setLoaded(false)
    setSrc(`${LOG_URL}?${params}`)
  }, [load, ok, platform])

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
