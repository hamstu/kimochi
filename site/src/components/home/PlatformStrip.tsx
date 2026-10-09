import type { ReactNode } from 'react'

/** Simple monochrome marks, drawn for this page (currentColor). */
function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
      <path d="M16.4 12.7c0-2 1.6-3 1.7-3.1-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2.1 2.5 2 1-.04 1.4-.6 2.6-.6s1.6.6 2.6.6c1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.1-.8-2.1-3z" />
      <path d="M14.5 6.4c.5-.7.9-1.6.8-2.5-.8 0-1.8.5-2.3 1.2-.5.6-.9 1.5-.8 2.4.9.1 1.8-.4 2.3-1.1z" />
    </svg>
  )
}

function WindowsMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
      <rect x="3.5" y="3.5" width="7.9" height="7.9" rx="0.6" />
      <rect x="12.6" y="3.5" width="7.9" height="7.9" rx="0.6" />
      <rect x="3.5" y="12.6" width="7.9" height="7.9" rx="0.6" />
      <rect x="12.6" y="12.6" width="7.9" height="7.9" rx="0.6" />
    </svg>
  )
}

function LinuxMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="2.75" y="4.25" width="18.5" height="15.5" rx="2.5" />
      <path d="m7 10 3 2.5L7 15M12.5 15.25H17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DeckMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="1.5" y="6.5" width="21" height="11" rx="4" />
      <rect x="7.5" y="8.75" width="9" height="6.5" rx="0.8" fill="currentColor" stroke="none" opacity="0.3" />
      <circle cx="4.6" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19.4" cy="10" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

const PLATFORMS: { name: string; detail: string; mark: ReactNode }[] = [
  { name: 'macOS', detail: 'Apple silicon', mark: <AppleMark /> },
  { name: 'Windows', detail: 'x64 and ARM64', mark: <WindowsMark /> },
  { name: 'Linux', detail: 'Ubuntu, Arch', mark: <LinuxMark /> },
  { name: 'Steam Deck', detail: 'Gaming Mode', mark: <DeckMark /> }
]

/** "Runs on" strip between the hero and the demo. */
export function PlatformStrip() {
  return (
    <div className="container-page">
      <div className="flex flex-col items-center gap-5 border-y border-hairline py-7 md:flex-row md:justify-center md:gap-10">
        <p className="text-meta tracking-[0.08em] text-ink-3 uppercase">Runs on</p>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4 md:gap-x-10">
          {PLATFORMS.map((p) => (
            <li key={p.name} className="flex items-center gap-2.5">
              <span className="text-ink-2">{p.mark}</span>
              <span className="flex flex-col leading-tight">
                <span className="text-small font-medium text-ink">{p.name}</span>
                <span className="text-meta font-normal text-ink-3">{p.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
