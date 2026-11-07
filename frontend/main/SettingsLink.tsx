import type { ReactNode } from 'react'

/** The quiet "Settings" link at the right of a sidebar group's label, on the label's baseline. */
export function SettingsLink({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return (
    <button type="button" className="sb-settings-link" aria-label={label} onClick={onClick}>
      Settings
    </button>
  )
}
