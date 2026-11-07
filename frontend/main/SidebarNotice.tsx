/**
 * A notice under a sidebar field, for what needs the reader (an engine not downloaded, a failed
 * switch): it eases open rather than jumping in, and always ends with something to click.
 * Anything merely under way is shown inside the field instead, so the sidebar does not move.
 */
import type { ReactNode } from 'react'
import { Callout } from '@kit'

export function SidebarNotice({
  tone = 'warn',
  action,
  onAction,
  title,
  children
}: {
  tone?: 'warn' | 'danger'
  /** The link's text, e.g. "Open dictionary settings". */
  action: string
  onAction: () => void
  /** The whole story, on hover: the notice itself is a few words. */
  title?: string
  children: ReactNode
}): ReactNode {
  return (
    <Callout tone={tone} className="src-notice sb-notice">
      <span title={title}>{children}</span>
      <button type="button" className="k-link src-notice-link" onClick={onAction}>
        {action}
      </button>
    </Callout>
  )
}
