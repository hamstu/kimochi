import { useId, type ReactNode } from 'react'
import { cn } from './cn'

/**
 * Settings layout: a page (title + description) of sections; each section a grouped list of rows
 * with the label and description on the left and the control on the right.
 */
export function SettingsPage({
  title,
  description,
  children,
  className
}: {
  /** Left out under `SettingsTabs`, which name the page instead. */
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={cn('k-settings-page', className)}>
      {title && (
        <header className="k-settings-page-header">
          <h1 className="k-title">{title}</h1>
          {description && <p className="k-description">{description}</p>}
        </header>
      )}
      {children}
    </div>
  )
}

export function SettingsSection({
  title,
  description,
  actions,
  footnote,
  grouped = true,
  children
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  footnote?: ReactNode
  /** false renders children without the bordered group (e.g. a ChoiceGroup). */
  grouped?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <section className="k-settings-section">
      {(title || description || actions) && (
        <div className="k-settings-section-header">
          <div>
            {title && <h2 className="k-heading">{title}</h2>}
            {description && <p className="k-description">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {grouped ? <div className="k-settings-group">{children}</div> : children}
      {footnote && <p className="k-settings-footnote">{footnote}</p>}
    </section>
  )
}

/**
 * One setting. The label is associated with the control via `htmlFor` when `controlId` is given
 * (or supply `id` on the control and pass it here); `stacked` puts wide controls under the text.
 */
export function SettingsRow({
  label,
  description,
  badge,
  children,
  stacked,
  disabled,
  controlId,
  className
}: {
  label: ReactNode
  description?: ReactNode
  badge?: ReactNode
  children?: ReactNode
  stacked?: boolean
  disabled?: boolean
  controlId?: string
  className?: string
}): ReactNode {
  const fallbackId = useId()
  const descriptionId = description ? `${controlId ?? fallbackId}-description` : undefined
  return (
    <div
      className={cn('k-settings-row', stacked && 'k-settings-row-stacked', className)}
      aria-disabled={disabled || undefined}
    >
      <div className="k-settings-row-text">
        <label className="k-settings-row-label" htmlFor={controlId}>
          {label}
          {badge}
        </label>
        {description && (
          <p className="k-description" id={descriptionId}>
            {description}
          </p>
        )}
      </div>
      {children && <div className="k-settings-row-control">{children}</div>}
    </div>
  )
}

/** Dependent settings shown under the row that enables them. */
export function SettingsSubgroup({ children }: { children: ReactNode }): ReactNode {
  return <div className="k-settings-sub">{children}</div>
}

export interface SettingsTabOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
}

/**
 * Tabs across the top of a settings page with several kinds of settings (Anki: AnkiConnect,
 * Mining, Card enhancement), in place of its title: the full width of the page, drawn like the
 * main window's Log and Notebook tabs, and kept in view: the page scrolls below them (`k-settings-tabbed-scroll`). Put them and a
 * title-less `SettingsPage` in a `k-settings-tabbed` element.
 */
export function SettingsTabs<T extends string>({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SettingsTabOption<T>[]
  'aria-label'?: string
}): ReactNode {
  return (
    <div className="k-settings-tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          className="k-settings-tab"
          aria-selected={option.value === value}
          onClick={() => onValueChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}
