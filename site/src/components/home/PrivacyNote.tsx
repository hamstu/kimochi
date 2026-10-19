import { Cloud, HardDrive } from 'lucide-react'

const LOCAL = [
  ['Apple Live Text', 'macOS, nothing to download'],
  ['OneOCR', 'Built into Windows 11'],
  ['MeikiOCR and manga-ocr', 'Local models, downloaded when you pick them'],
  ['Dictionaries, Log, Notebook', 'Stored on your machine']
]

const ONLINE = [
  ['Google Lens', 'The default. Sends each capture to Google'],
  ['Kimochi account', 'Optional. Sync, read aloud and the like'],
  ['Explain', 'Your own Claude or Codex, when you ask']
]

function Rows({ rows }: { rows: string[][] }) {
  return (
    <ul className="divide-y divide-hairline border-y border-hairline">
      {rows.map(([name, note]) => (
        <li key={name} className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
          <span className="text-small font-medium text-ink">{name}</span>
          <span className="text-small text-ink-3 sm:text-right">{note}</span>
        </li>
      ))}
    </ul>
  )
}

/** Engines and privacy: what runs locally, and the two things that send anything out. */
export function PrivacyNote() {
  return (
    <div className="grid gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-16">
      <div>
        <p className="mb-3 text-meta tracking-[0.08em] text-accent-ink uppercase">Privacy</p>
        <h2 className="text-title text-ink">Your call</h2>
        <p className="mt-4 text-lede text-ink-2">
          Out of the box Kimochi uses Google Lens, which reads captures online. Every other engine
          runs on your own computer. No analytics, no tracking, and an account is optional.
        </p>
      </div>
      <div className="space-y-8">
        <div>
          <p className="mb-2 flex items-center gap-2 text-meta text-ink-2 uppercase tracking-[0.08em]">
            <HardDrive size={14} aria-hidden /> On device
          </p>
          <Rows rows={LOCAL} />
        </div>
        <div>
          <p className="mb-2 flex items-center gap-2 text-meta text-ink-2 uppercase tracking-[0.08em]">
            <Cloud size={14} aria-hidden /> Online
          </p>
          <Rows rows={ONLINE} />
        </div>
      </div>
    </div>
  )
}
