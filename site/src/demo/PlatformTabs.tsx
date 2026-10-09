import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { Platform } from './env'

const MARK = 'size-4 shrink-0'

function Apple() {
  return (
    <svg viewBox="0 0 17 20" className={MARK} fill="currentColor" aria-hidden="true">
      <path d="M14.1 10.6c0-2.5 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.8C3.8 5 2.2 6 1.4 7.6c-1.8 3-.5 7.5 1.2 10 .8 1.2 1.8 2.5 3.1 2.5 1.2-.1 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.6-1-2.3-4.3zM11.7 3.2c.7-.8 1.1-1.9 1-3.1-1 .1-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z" />
    </svg>
  )
}

function Windows() {
  return (
    <svg viewBox="0 0 16 16" className={MARK} fill="currentColor" aria-hidden="true">
      <rect width="7.4" height="7.4" />
      <rect x="8.6" width="7.4" height="7.4" />
      <rect y="8.6" width="7.4" height="7.4" />
      <rect x="8.6" y="8.6" width="7.4" height="7.4" />
    </svg>
  )
}

/** A small penguin. */
function Linux() {
  return (
    <svg viewBox="0 0 16 18" className={MARK} aria-hidden="true">
      <ellipse cx="8" cy="10" rx="6" ry="7.5" fill="currentColor" />
      <ellipse cx="8" cy="11.6" rx="3.7" ry="5" className="fill-[var(--k-bg)]" />
      <circle cx="6.3" cy="5.2" r="0.9" className="fill-[var(--k-bg)]" />
      <circle cx="9.7" cy="5.2" r="0.9" className="fill-[var(--k-bg)]" />
      <path d="M6.6 7h2.8L8 8.6z" fill="currentColor" opacity="0.6" />
    </svg>
  )
}

/** A handheld outline: screen with a stick either side. */
function Handheld() {
  return (
    <svg viewBox="0 0 24 14" className="h-4 w-6 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="0.7" y="0.7" width="22.6" height="12.6" rx="4.5" />
      <rect x="6.5" y="3" width="11" height="8" rx="1" />
      <circle cx="3.6" cy="7" r="1.3" />
      <circle cx="20.4" cy="7" r="1.3" />
    </svg>
  )
}

const TABS: { id: Platform; label: string; short?: string; mark: ReactNode }[] = [
  { id: 'macos', label: 'macOS', mark: <Apple /> },
  { id: 'windows', label: 'Windows', mark: <Windows /> },
  { id: 'linux', label: 'Linux', mark: <Linux /> },
  { id: 'deck', label: 'Steam Deck', short: 'Deck', mark: <Handheld /> }
]

/** macOS · Windows · Linux · Steam Deck, as a segmented control (ARIA tabs, arrow keys move). */
export function PlatformTabs({ value, onChange }: { value: Platform; onChange: (p: Platform) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent): void => {
    const i = TABS.findIndex((t) => t.id === value)
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + TABS.length) % TABS.length
    onChange(TABS[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label="Platform"
      onKeyDown={onKey}
      className="flex w-full max-w-full gap-1 overflow-x-auto rounded-lg border border-hairline bg-bar p-1 sm:inline-flex sm:w-auto"
    >
      {TABS.map((tab, i) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={tab.label}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 sm:px-3 text-small font-medium transition-colors duration-100 sm:flex-none ${
              selected ? 'bg-raised text-ink shadow-pop' : 'text-ink-2 hover:bg-hover hover:text-ink'
            }`}
          >
            <span className="hidden min-[440px]:contents">{tab.mark}</span>
            {tab.short ? (
              <>
                <span className="hidden min-[440px]:inline">{tab.label}</span>
                <span className="min-[440px]:hidden">{tab.short}</span>
              </>
            ) : (
              tab.label
            )}
          </button>
        )
      })}
    </div>
  )
}
