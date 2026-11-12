/**
 * A searchable single choice: `Select`'s look with a filter field, for lists too long to scan (the
 * language picker). Closed, it is a select trigger showing the chosen option; open, a menu-styled
 * popover with a search field over the options. `inline` drops the trigger and popover and shows
 * the field and list in place, for a page whose one job is this choice (the welcome guide), where
 * touch users can scroll and tap without typing.
 *
 * Keyboard: typing on the closed trigger opens it with that letter; in the field, Up/Down move
 * through the matches, Page Up/Page Down by a page, Home/End to the ends while the field is empty,
 * Enter chooses, Escape closes (inline: clears the search). Focus stays in the field and the list
 * follows it with `aria-activedescendant`. IME compositions keep their keys.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { cn } from './cn'
import { isComposing } from './ime'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'
import { comboboxMatches } from './comboboxFilter'

export interface ComboboxOption<T extends string> {
  value: T
  /** The name, shown and matched. */
  label: string
  icon?: ReactNode
  /** Trailing text in the row (the list only). */
  detail?: ReactNode
  /** A second line under the label, in the list only. */
  description?: ReactNode
  /** More text the search matches (other names, a code). */
  keywords?: readonly string[]
  disabled?: boolean
}

interface ComboboxCommon<T extends string> {
  value: T | undefined
  onValueChange: (value: T) => void
  options: readonly ComboboxOption<T>[]
  /** Whether an option matches the search; by default the label and keywords, ignoring case and accents. */
  filter?: (option: ComboboxOption<T>, query: string) => boolean
  searchPlaceholder?: string
  /** Said when nothing matches. */
  emptyText?: ReactNode
  'aria-label': string
  disabled?: boolean
  className?: string
}

const PAGE = 8

const defaultFilter = <T extends string>(option: ComboboxOption<T>, query: string): boolean =>
  comboboxMatches([option.label, ...(option.keywords ?? [])], query)

/** The search field and the list of matches, shared by the popover and the inline form. */
function ComboboxPanel<T extends string>({
  value,
  onChoose,
  onEscape,
  options,
  filter = defaultFilter,
  initialQuery = '',
  searchPlaceholder = 'Search',
  emptyText = 'No matches',
  'aria-label': ariaLabel,
  disabled,
  autoFocus,
  inline
}: Omit<ComboboxCommon<T>, 'onValueChange' | 'className'> & {
  onChoose: (value: T) => void
  onEscape?: () => boolean
  initialQuery?: string
  autoFocus?: boolean
  inline?: boolean
}): ReactNode {
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number): string => `${baseId}-option-${index}`
  const [query, setQuery] = useState(initialQuery)
  const matches = useMemo(
    () => (query.trim() ? options.filter((option) => filter(option, query.trim())) : options),
    [options, filter, query]
  )
  const selectedIndex = matches.findIndex((option) => option.value === value)
  const [active, setActive] = useState(() => (initialQuery ? 0 : Math.max(0, selectedIndex)))
  // Highlight only while the keyboard is in the field or the pointer is over the list, so an
  // inline list at rest shows just its check mark.
  const [focused, setFocused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const current = Math.min(active, matches.length - 1)

  useEffect(() => {
    if (current < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(`${baseId}-option-${current}`)}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [baseId, current])

  const move = (index: number): void => {
    if (!matches.length) return
    setActive(Math.max(0, Math.min(matches.length - 1, index)))
  }
  const choose = (index: number): void => {
    const option = matches[index]
    if (option && !option.disabled) onChoose(option.value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isComposing(event)) return
    const empty = query === ''
    switch (event.key) {
      case 'ArrowDown':
        move(current + 1)
        break
      case 'ArrowUp':
        move(current - 1)
        break
      case 'PageDown':
        move(current + PAGE)
        break
      case 'PageUp':
        move(current - PAGE)
        break
      case 'Home':
        if (!empty) return
        move(0)
        break
      case 'End':
        if (!empty) return
        move(matches.length - 1)
        break
      case 'Enter':
        choose(current)
        break
      case 'Escape':
        if (inline && query) {
          setQuery('')
          setActive(Math.max(0, options.findIndex((option) => option.value === value)))
          break
        }
        if (!onEscape?.()) return
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div className={cn('k-combobox-panel', inline && 'k-combobox-inline')} data-disabled={disabled || undefined}>
      <label className="k-combobox-search">
        <Search aria-hidden />
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 && (focused || hovered) ? optionId(current) : undefined}
          className="k-combobox-input"
          type="text"
          value={query}
          placeholder={searchPlaceholder}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          // The field is not a button: no click sound when it is tapped into.
          data-sound="none"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </label>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        className="k-combobox-list"
        onPointerLeave={() => setHovered(false)}
      >
        {matches.length === 0 && <div className="k-combobox-empty">{emptyText}</div>}
        {matches.map((option, index) => {
          const selected = option.value === value
          return (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              aria-disabled={option.disabled || undefined}
              data-highlighted={index === current && (focused || hovered) ? '' : undefined}
              data-disabled={option.disabled ? '' : undefined}
              data-state={selected ? 'checked' : undefined}
              className={cn('k-menu-item', 'k-combobox-option', option.description != null && 'k-menu-item-described')}
              // Keep the keyboard in the field.
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => {
                setHovered(true)
                if (index !== current) setActive(index)
              }}
              onClick={() => choose(index)}
            >
              {option.icon}
              <span className="k-menu-item-label">
                {option.label}
                {option.description != null && <span className="k-menu-item-description">{option.description}</span>}
              </span>
              {option.detail != null && <span className="k-combobox-detail">{option.detail}</span>}
              <span className="k-menu-item-check" aria-hidden>
                {selected && <Check />}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A select with a search field, in a popover (or `inline`, in place). */
export function Combobox<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  inline,
  size,
  className,
  disabled,
  ...rest
}: ComboboxCommon<T> & {
  placeholder?: ReactNode
  inline?: boolean
  size?: 'sm' | 'md'
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState('')
  const chosen = options.find((option) => option.value === value)

  if (inline) {
    return (
      <div className={className}>
        <ComboboxPanel {...rest} value={value} options={options} disabled={disabled} inline onChoose={onValueChange} />
      </div>
    )
  }

  const openWith = (query: string): void => {
    setSeed(query)
    setOpen(true)
  }

  // Typing on the closed trigger opens it with that text, as a select's typeahead would jump.
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openWith('')
      return
    }
    if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      openWith(event.key)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSeed('')
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-label={rest['aria-label']}
          disabled={disabled}
          className={cn('k-select-trigger', 'k-combobox-trigger', size === 'sm' && 'k-select-trigger-sm', className)}
          data-placeholder={chosen ? undefined : ''}
          onKeyDown={onTriggerKeyDown}
        >
          <span className="k-combobox-value">
            {chosen?.icon}
            <span className="k-combobox-value-label">{chosen ? chosen.label : placeholder}</span>
          </span>
          <ChevronsUpDown className="k-select-trigger-icon" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent menu align="start" className="k-combobox-content">
        <ComboboxPanel
          {...rest}
          value={value}
          options={options}
          initialQuery={seed}
          autoFocus
          onChoose={(next) => {
            onValueChange(next)
            setOpen(false)
          }}
          onEscape={() => {
            setOpen(false)
            return true
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
