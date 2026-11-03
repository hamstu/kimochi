import type { ReactNode } from 'react'

/** The quiet "Manage" link at the right of a sidebar group's label, on the label's baseline. */
export function ManageLink({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return (
    <button type="button" className="sb-manage" aria-label={label} onClick={onClick}>
      Manage
    </button>
  )
}
