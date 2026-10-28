import { MiniWindow, VisualFrame } from './parts'

const ENGINES = [
  { name: 'Yomitan', meta: 'Your own dictionaries', selected: true },
  { name: 'Hachidori', meta: 'One-click download' },
  { name: '10ten', meta: 'One-click download' },
  { name: 'Yomitan API', meta: 'The Yomitan in your browser' }
]

/** The dictionary engine picker. */
export function DictionariesVisual() {
  return (
    <VisualFrame>
      <MiniWindow title="Settings · Dictionary" className="w-full max-w-[18rem]">
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
