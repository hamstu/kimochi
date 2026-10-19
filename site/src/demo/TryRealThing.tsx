import { useEffect, useRef } from 'react'
import { ArrowUp } from 'lucide-react'
import { TitleBar, WINDOW_SHAPE, type DesktopPlatform } from './chrome'

/**
 * What the demo shows when the visitor reaches something only the app can do (the harness's
 * `unavailable` event): a small Kimochi window over the desk, offering the download.
 */
export function TryRealThing({
  platform,
  feature,
  onTry,
  onClose
}: {
  platform: DesktopPlatform
  /** What was stopped, as a sentence's subject ("Settings", "That"). */
  feature: string
  onTry: () => void
  onClose: () => void
}) {
  const tryRef = useRef<HTMLButtonElement>(null)
  // Focused for the keyboard, without scrolling the page to it.
  useEffect(() => tryRef.current?.focus({ preventScroll: true }), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Closes this, not the maximised demo under it.
      event.stopImmediatePropagation()
      onClose()
    }
    addEventListener('keydown', onKey, { capture: true })
    return () => removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  return (
    <div className="kd-try-scrim absolute inset-0 z-[75] grid place-items-center p-4" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kd-try-title"
        className={`kd-try flex w-full max-w-[22rem] flex-col overflow-hidden bg-raised ${WINDOW_SHAPE[platform]}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <TitleBar platform={platform} title="Kimochi" icon={<img src="/icon.svg" alt="" className="size-3.5" />} onClose={onClose} />
        <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-5 text-center">
          <img src="/icon.svg" alt="" className="size-12" />
          <h3 id="kd-try-title" className="text-[1.0625rem] font-semibold text-ink">
            Try the real thing
          </h3>
          <p className="text-small text-ink-2">
            {feature} isn’t in this preview, but it’s all in the app. Free, for macOS, Windows and Linux.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={onClose} className="kd-try-later rounded-lg px-3.5 py-2 text-small font-medium">
              Keep playing
            </button>
            <button
              type="button"
              ref={tryRef}
              onClick={onTry}
              className="kd-egg-go inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-small font-semibold"
            >
              Try the real thing
              <ArrowUp size={14} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
