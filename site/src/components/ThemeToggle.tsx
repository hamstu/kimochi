import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemeChoice } from '../lib/theme'

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'System theme', Icon: Monitor },
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'dark', label: 'Dark theme', Icon: Moon }
]

/** Three-way segmented control: system / light / dark. */
export function ThemeToggle() {
  const [choice, setChoice] = useTheme()
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex h-7 items-center gap-0.5 rounded-md p-0.5 shadow-[inset_0_0_0_1px_var(--k-line)]"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = choice === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setChoice(value)}
            className={`grid size-6 place-items-center rounded-sm transition-colors duration-100 ${
              active ? 'bg-press text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink'
            }`}
          >
            <Icon size={14} aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
