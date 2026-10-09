import { MiniWindow, VisualFrame } from './parts'

const ENGINES = [
  { name: 'Apple Live Text', meta: 'macOS · built in', selected: true },
  { name: 'MeikiOCR', meta: 'On device · GPU' },
  { name: 'manga-ocr', meta: 'On device · manga' },
  { name: 'OneOCR', meta: 'Windows 11 · built in' },
  { name: 'Cloud OCR', meta: 'Opt-in' }
]

/** The OCR engine picker. */
export function EnginesVisual() {
  return (
    <VisualFrame>
      <MiniWindow title="Settings · OCR engine" className="w-full max-w-[18rem]">
        <ul className="py-1 text-[12px]">
          {ENGINES.map((e) => (
            <li
              key={e.name}
              className={`flex h-[1.9rem] items-center gap-2.5 px-3 ${e.selected ? 'bg-press' : ''}`}
            >
              <span
                className={`grid size-3 shrink-0 place-items-center rounded-full border ${
                  e.selected ? 'border-accent bg-accent' : 'border-line-strong'
                }`}
              >
                {e.selected && <span className="size-1 rounded-full bg-accent-contrast" />}
              </span>
              <span className="font-medium text-ink">{e.name}</span>
              <span className="ml-auto truncate text-[11px] text-ink-3">{e.meta}</span>
            </li>
          ))}
        </ul>
      </MiniWindow>
    </VisualFrame>
  )
}
