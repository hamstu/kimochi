/**
 * The confirmations behind the session menu and the Log's ⋯ menu. Every action that destroys data
 * asks first, in the same words: what goes, how much of it, and that it cannot be undone.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, ConfirmDialog, Dialog, DialogClose, DialogContent, Input, Textarea } from '@kit'
import { SessionManagerModal } from '@texthooker/components/SessionManagerModal'
import { clearLines, lineCount } from '@texthooker/lib/store'
import { resetStats } from '@texthooker/lib/stats'
import {
  deleteSession,
  getActiveSession,
  getManifest,
  renameSession,
  subscribeSessions,
  updateSessionDescription
} from '@texthooker/lib/sessions'
import { LogActionsContext, type LogActions } from './logActions'

type Pending = 'clear' | 'stats' | 'delete' | null

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

export function LogActionsProvider({ children }: { children: ReactNode }): ReactNode {
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [managing, setManaging] = useState(false)
  // Captured when a dialog opens, so its wording cannot change underneath the reader.
  const [subject, setSubject] = useState({ id: '', name: '', lines: 0 })
  const [manifest, setManifest] = useState(getManifest)
  useEffect(() => subscribeSessions(setManifest), [])

  const actions = useMemo<LogActions>(() => {
    const ask = (kind: Exclude<Pending, null>) => () => {
      const session = getActiveSession()
      setSubject({ id: session.id, name: session.name, lines: lineCount() })
      setError(null)
      setPending(kind)
    }
    return {
      clearLines: ask('clear'),
      resetStats: ask('stats'),
      deleteSession: ask('delete'),
      editSession: () => setEditing(true),
      manageSessions: () => setManaging(true)
    }
  }, [])

  const run = async (work: () => unknown): Promise<void> => {
    setBusy(true)
    try {
      await work()
      setPending(null)
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(false)
    }
  }

  const close = (open: boolean): void => {
    if (!open && !busy) setPending(null)
  }

  return (
    <LogActionsContext.Provider value={actions}>
      {children}
      <ConfirmDialog
        open={pending === 'clear'}
        onOpenChange={close}
        tone="danger"
        title={`Clear the log of “${subject.name}”?`}
        description={
          <>
            {plural(subject.lines, 'line', 'lines')} will be deleted. This can’t be undone. The
            session, its notebook and its stats are kept.
            {error && <span className="main-dialog-error">{error}</span>}
          </>
        }
        confirmLabel={busy ? 'Clearing…' : 'Clear lines'}
        busy={busy}
        onConfirm={() => void run(() => clearLines())}
      />
      <ConfirmDialog
        open={pending === 'stats'}
        onOpenChange={close}
        tone="danger"
        title={`Reset the stats of “${subject.name}”?`}
        description={
          <>
            Reading time, character count and speed start again from zero. This can’t be undone.
            Lines are kept.
            {error && <span className="main-dialog-error">{error}</span>}
          </>
        }
        confirmLabel={busy ? 'Resetting…' : 'Reset stats'}
        busy={busy}
        onConfirm={() => void run(() => resetStats())}
      />
      <ConfirmDialog
        open={pending === 'delete'}
        onOpenChange={close}
        tone="danger"
        title={`Delete “${subject.name}”?`}
        description={
          <>
            The session, its {plural(subject.lines, 'line', 'lines')}, its notebook and its stats
            will be deleted. This can’t be undone.
            {error && <span className="main-dialog-error">{error}</span>}
          </>
        }
        confirmLabel={busy ? 'Deleting…' : 'Delete session'}
        busy={busy}
        onConfirm={() => void run(() => deleteSession(subject.id))}
      />
      <SessionDetailsDialog open={editing} onOpenChange={setEditing} />
      <SessionManagerModal
        activeId={manifest.activeId}
        open={managing}
        onOpenChange={setManaging}
        sessions={manifest.sessions}
      />
    </LogActionsContext.Provider>
  )
}

/** Name and description of the active session. */
function SessionDetailsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <SessionDetailsForm onDone={() => onOpenChange(false)} />}
    </Dialog>
  )
}

function SessionDetailsForm({ onDone }: { onDone: () => void }): ReactNode {
  const session = getActiveSession()
  const [name, setName] = useState(session.name)
  const [description, setDescription] = useState(session.description)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    try {
      if (name.trim() && name.trim() !== session.name) await renameSession(session.id, name.trim())
      if (description !== session.description)
        await updateSessionDescription(session.id, description)
      onDone()
    } catch (caught) {
      setError(String(caught))
    }
  }

  return (
    <DialogContent
      title="Session details"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        document.getElementById('session-details-name')?.focus()
      }}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="main-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="main-form-field">
          <span className="main-form-label">Name</span>
          <Input
            id="session-details-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="main-form-field">
          <span className="main-form-label">Description</span>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            spellCheck={false}
            placeholder="What is this session about?"
          />
        </label>
        {error && <span className="main-dialog-error">{error}</span>}
      </form>
    </DialogContent>
  )
}
