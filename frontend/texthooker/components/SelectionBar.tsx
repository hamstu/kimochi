/**
 * Selection mode's bar (lib/logSelection.ts), in the activity ticker's place at the foot of the
 * Log: what is selected, Copy text, Delete, and Done. It shows for as long as the mode is on,
 * whether or not the ticker is turned on, and the ticker comes back as it was when the mode ends.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Trash2 } from 'lucide-react'
import { Button, ConfirmDialog } from '@kit'
import { writeTextSelf } from '@texthooker/lib/clipboardWrite'
import { deleteLines } from '@texthooker/lib/store'
import {
  selectedLines,
  selectionLabel,
  selectionText,
  stopSelecting,
  type SelectionState
} from '@texthooker/lib/logSelection'
import type { Line } from '@texthooker/lib/types'
import '../activity.css'

/** How long Copy text says it copied. */
const COPIED_MS = 1500

export function SelectionBar({ lines, selection }: { lines: readonly Line[]; selection: SelectionState }): ReactNode {
  const picked = selectedLines(lines, selection.selected)
  const label = selectionLabel(lines, selection.selected)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = (): void => {
    void writeTextSelf(selectionText(lines, selection.selected))
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
      })
      .catch((err: unknown) => console.warn('copy failed', err))
  }
  // As a line's own Delete: gone at once, everywhere Sync reaches. More than one asks first, as
  // clearing the Log does: there is no undo.
  const remove = (): void => {
    const ids = picked.map((line) => line.id)
    stopSelecting()
    void deleteLines(ids).catch((err: unknown) => console.warn('delete failed', err))
  }

  return (
    <div className="activity log-selection-bar" data-mode="select" role="toolbar" aria-label="Selected lines">
      <div className="activity-bar">
        <span className="log-selection-count k-num" role="status" aria-live="polite">
          {picked.length ? `${label} selected` : 'Click lines to select them'}
        </span>
        <Button variant="ghost" size="sm" disabled={!picked.length} onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy text'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={!picked.length}
          onClick={() => (picked.length > 1 ? setConfirming(true) : remove())}
        >
          <Trash2 />
          Delete
        </Button>
        <span className="log-selection-divider" aria-hidden />
        <Button variant="ghost" size="sm" onClick={stopSelecting} aria-keyshortcuts="Escape">
          Done
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="danger"
        title={`Delete ${label.toLowerCase()}?`}
        description="They are deleted from this session, on every computer that syncs it. This can't be undone."
        confirmLabel="Delete"
        dismissOnOutsideClick
        onConfirm={() => {
          setConfirming(false)
          remove()
        }}
      />
    </div>
  )
}
