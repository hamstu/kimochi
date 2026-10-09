import { Cloud, HardDrive } from 'lucide-react'

const LOCAL = [
  ['Apple Live Text', 'macOS, nothing to download'],
  ['OneOCR', 'Built into Windows 11'],
  ['MeikiOCR and manga-ocr', 'Local models, downloaded on demand, verified'],
  ['Dictionaries, Log, Notebook', 'Stored on your machine']
]

const OPT_IN = [
  ['Cloud OCR', 'Sends the captured region to a recognition service when it is the chosen engine'],
  ['Text to speech', 'Sends the line to a voice service when you press play'],
  ['Explain', 'Uses the Claude or Codex CLI you have installed, when you ask']
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

/** On-device-first note: what runs locally, and the two things that only go out when asked. */
export function PrivacyNote() {
  return (
    <div className="grid gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-16">
      <div>
        <p className="mb-3 text-meta tracking-[0.08em] text-accent-ink uppercase">Engines and privacy</p>
        <h2 className="text-title text-ink">On your machine, if you like</h2>
        <p className="mt-4 text-lede text-ink-2">
          Every engine that reads the screen can run on your own computer, on its GPU where it can.
          Pick one of those and what you read stays with you. A cloud engine, text to speech and
          explanations are the only features that send anything out, and you choose each of them.
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
            <Cloud size={14} aria-hidden /> Only when you choose
          </p>
          <Rows rows={OPT_IN} />
        </div>
      </div>
    </div>
  )
}
