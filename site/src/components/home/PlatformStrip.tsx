import type { ReactNode } from 'react'
import { AppleMark, DeckMark, LinuxMark, WindowsMark } from '../PlatformMarks'

const PLATFORMS: { name: string; detail: string; mark: ReactNode }[] = [
  { name: 'macOS', detail: 'Apple silicon', mark: <AppleMark /> },
  { name: 'Windows', detail: 'x64 and ARM64', mark: <WindowsMark /> },
  { name: 'Linux', detail: 'Ubuntu, Arch', mark: <LinuxMark /> },
  { name: 'Steam Deck', detail: 'Gaming Mode', mark: <DeckMark /> }
]

/** "Runs on", between the hero and the live preview: where Kimochi runs, nothing to pick. */
export function PlatformStrip() {
  return (
    <div className="container-page">
      <div className="flex flex-col items-center border-y border-hairline py-5 md:flex-row md:justify-center md:gap-10 md:py-6">
        <p id="runs-on" className="text-meta tracking-[0.08em] text-ink-3 uppercase">
          Runs on
        </p>
        <ul aria-labelledby="runs-on" className="grid w-full grid-cols-4 md:flex md:w-auto md:gap-8">
          {PLATFORMS.map((p) => (
            <li
              key={p.name}
              className="flex min-w-0 flex-col items-center gap-1.5 px-1 py-3 text-center text-ink-2 sm:flex-row sm:gap-2.5 sm:text-left md:py-0"
            >
              <span className="text-ink-3">{p.mark}</span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-small font-medium text-ink">{p.name}</span>
                <span className="hidden text-meta font-normal text-ink-3 sm:block">{p.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
