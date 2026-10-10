import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Platform } from '../../demo/env'

/** Simple monochrome marks, drawn for this page (currentColor). */
function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="currentColor" aria-hidden>
      <path d="M16.4 12.7c0-2 1.6-3 1.7-3.1-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2.1 2.5 2 1-.04 1.4-.6 2.6-.6s1.6.6 2.6.6c1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.1-.8-2.1-3z" />
      <path d="M14.5 6.4c.5-.7.9-1.6.8-2.5-.8 0-1.8.5-2.3 1.2-.5.6-.9 1.5-.8 2.4.9.1 1.8-.4 2.3-1.1z" />
    </svg>
  )
}

function WindowsMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="currentColor" aria-hidden>
      <rect x="3.5" y="3.5" width="7.9" height="7.9" rx="0.6" />
      <rect x="12.6" y="3.5" width="7.9" height="7.9" rx="0.6" />
      <rect x="3.5" y="12.6" width="7.9" height="7.9" rx="0.6" />
      <rect x="12.6" y="12.6" width="7.9" height="7.9" rx="0.6" />
    </svg>
  )
}

function LinuxMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="2.75" y="4.25" width="18.5" height="15.5" rx="2.5" />
      <path d="m7 10 3 2.5L7 15M12.5 15.25H17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DeckMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="1.5" y="6.5" width="21" height="11" rx="4" />
      <rect x="7.5" y="8.75" width="9" height="6.5" rx="0.8" fill="currentColor" stroke="none" opacity="0.3" />
      <circle cx="4.6" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19.4" cy="10" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

const PLATFORMS: { id: Platform; name: string; detail: string; mark: ReactNode }[] = [
  { id: 'macos', name: 'macOS', detail: 'Apple silicon', mark: <AppleMark /> },
  { id: 'windows', name: 'Windows', detail: 'x64 and ARM64', mark: <WindowsMark /> },
  { id: 'linux', name: 'Linux', detail: 'Ubuntu, Arch', mark: <LinuxMark /> },
  { id: 'deck', name: 'Steam Deck', detail: 'Gaming Mode', mark: <DeckMark /> }
]

interface PlatformStripProps {
  value: Platform
  onChange: (platform: Platform) => void
}

/**
 * "Runs on" strip between the hero and the demo, and the demo's platform selector (ARIA tabs:
 * arrow keys move, Home/End jump). The selected item lights a thicker segment of the bottom
 * hairline, which slides between items.
 */
export function PlatformStrip({ value, onChange }: PlatformStripProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)
  const index = PLATFORMS.findIndex((p) => p.id === value)

  useLayoutEffect(() => {
    const strip = stripRef.current
    const tab = tabs.current[index]
    if (!strip || !tab) return
    const place = (): void => {
      const l = strip.getBoundingClientRect()
      const t = tab.getBoundingClientRect()
      setBar({ left: t.left - l.left, width: t.width })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [index])

  const onKey = (e: KeyboardEvent): void => {
    const last = PLATFORMS.length - 1
    const next =
      e.key === 'ArrowRight' ? (index + 1) % PLATFORMS.length
      : e.key === 'ArrowLeft' ? (index + last) % PLATFORMS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1
    if (next < 0) return
    e.preventDefault()
    onChange(PLATFORMS[next].id)
    tabs.current[next]?.focus()
  }

  return (
    <div className="container-page">
      <div ref={stripRef} className="relative flex flex-col items-center border-t border-hairline pt-5 md:flex-row md:justify-center md:gap-10 md:pt-0">
        <p id="runs-on" className="text-meta tracking-[0.08em] text-ink-3 uppercase">
          Runs on
        </p>
        <div
          role="tablist"
          aria-labelledby="runs-on"
          onKeyDown={onKey}
          className="relative grid w-full grid-cols-4 md:flex md:w-auto md:gap-2"
        >
          {PLATFORMS.map((p, i) => {
            const selected = i === index
            return (
              <button
                key={p.id}
                ref={(el) => {
                  tabs.current[i] = el
                }}
                type="button"
                role="tab"
                id={`platform-${p.id}`}
                aria-selected={selected}
                aria-controls="demo-stage"
                tabIndex={selected ? 0 : -1}
                onClick={() => onChange(p.id)}
                className={`group flex min-w-0 flex-col items-center gap-1.5 px-1 py-4 text-center transition-colors duration-150 sm:flex-row sm:gap-2.5 sm:px-3 sm:text-left md:py-6 ${
                  selected ? 'text-ink' : 'text-ink-2 hover:text-ink'
                }`}
              >
                <span className={selected ? 'text-ink' : 'text-ink-3 transition-colors group-hover:text-ink-2'}>
                  {p.mark}
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-small font-medium">{p.name}</span>
                  <span className="hidden text-meta font-normal text-ink-3 sm:block">{p.detail}</span>
                </span>
              </button>
            )
          })}
        </div>
        {/* The bottom hairline (ink, faint) and the lit segment under the selected platform. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-ink/15" />
        {bar && (
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-ink transition-[transform,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
            style={{ left: 0, width: bar.width, transform: `translateX(${bar.left}px)` }}
          />
        )}
      </div>
    </div>
  )
}
