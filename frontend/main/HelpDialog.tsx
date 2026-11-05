/**
 * Help: the title bar's ? button opens this. Two ways to get help: the Discord, or a bug report
 * sent from here (`sendBugReport`; native posts it with the debug bundle to the Kimochi server,
 * which emails it to the maintainer). Three steps in one dialog: the choice, the form (with Back),
 * and a thank-you whose Done returns to the choice. The form keeps what was typed until it is
 * sent, so Back or closing the dialog loses nothing.
 */
import { useEffect, useId, useState, type Dispatch, type FormEvent, type JSX, type ReactNode, type SetStateAction } from 'react'
import { ArrowLeft, Bug, ChevronRight, CircleCheck, ExternalLink, MessagesSquare } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Button, Callout, Checkbox, Dialog, DialogClose, DialogContent, IconButton, Input, Spinner, Textarea } from '@kit'
import { debugMarkdown } from '@ui/debug-report'
import { DISCORD_URL, EMPTY_DRAFT, MAX_DESCRIPTION, draftProblem, type BugReportDraft as Draft } from '@ui/bug-report'
import { useAccount } from '../bridge/account'
import { debugReport } from '../bridge/debugReport'
import { sendBugReport } from '../bridge/bugReport'
import { nativeError } from '../bridge/tauri'
import './help.css'

type Step = 'menu' | 'report' | 'sent'

function Choice({
  icon,
  title,
  detail,
  trailing,
  onClick
}: {
  icon: ReactNode
  title: string
  detail: string
  trailing: ReactNode
  onClick: () => void
}): JSX.Element {
  return (
    <button type="button" className="help-choice" onClick={onClick}>
      <span className="help-choice-icon" aria-hidden="true">{icon}</span>
      <span className="help-choice-text">
        <span className="help-choice-title">{title}</span>
        <span className="help-choice-detail">{detail}</span>
      </span>
      <span className="help-choice-trailing" aria-hidden="true">{trailing}</span>
    </button>
  )
}

function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }): JSX.Element {
  return (
    <div className="help-field">
      <label htmlFor={id} className="help-label">{label}</label>
      {children}
      {hint && <span className="help-hint">{hint}</span>}
    </div>
  )
}

function ReportForm({
  draft,
  onDraft,
  onBack,
  onSent
}: {
  draft: Draft
  onDraft: (draft: Draft) => void
  onBack: () => void
  onSent: (id: string | null) => void
}): JSX.Element {
  const ids = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The first empty field takes focus as the form appears (it replaces the choice in an open dialog).
  useEffect(() => {
    const first = !draft.name ? 'name' : !draft.email ? 'email' : 'description'
    document.getElementById(`${ids}-${first}`)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, [])
  const set = (patch: Partial<Draft>): void => {
    onDraft({ ...draft, ...patch })
    setError(null)
  }

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (busy) return
    const problem = draftProblem(draft)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const markdown = draft.attachDebug ? debugMarkdown(await debugReport()) : undefined
      const { id } = await sendBugReport({
        name: draft.name.trim(),
        email: draft.email.trim(),
        description: draft.description.trim(),
        debugMarkdown: markdown
      })
      onSent(id)
    } catch (caught) {
      setError(nativeError(caught).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogContent
      className="help"
      title={
        <span className="help-title">
          <IconButton label="Back" size="sm" onClick={onBack} disabled={busy}>
            <ArrowLeft />
          </IconButton>
          Report a bug
        </span>
      }
      // Sending can't be cancelled; keep the dialog until it answers.
      onEscapeKeyDown={(event) => busy && event.preventDefault()}
      onPointerDownOutside={(event) => busy && event.preventDefault()}
      footer={
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? <Spinner label="Sending" /> : null}
          {busy ? 'Sending…' : 'Send report'}
        </Button>
      }
    >
      <form className="help-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="help-row">
          <Field label="Name" id={`${ids}-name`}>
            <Input
              id={`${ids}-name`}
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              autoComplete="name"
              maxLength={100}
              disabled={busy}
            />
          </Field>
          <Field label="Email" id={`${ids}-email`}>
            <Input
              id={`${ids}-email`}
              type="email"
              value={draft.email}
              onChange={(event) => set({ email: event.target.value })}
              autoComplete="email"
              maxLength={254}
              disabled={busy}
            />
          </Field>
        </div>
        <Field label="What happened?" id={`${ids}-description`}>
          <Textarea
            id={`${ids}-description`}
            className="help-description"
            value={draft.description}
            onChange={(event) => set({ description: event.target.value })}
            placeholder="What were you doing, what did you expect, and what happened instead?"
            maxLength={MAX_DESCRIPTION}
            spellCheck
            disabled={busy}
          />
        </Field>
        <label className="help-attach">
          <Checkbox
            checked={draft.attachDebug}
            onCheckedChange={(checked) => set({ attachDebug: checked === true })}
            disabled={busy}
          />
          <span className="help-attach-text">
            <span className="help-attach-title">Attach debug data</span>
            <span className="help-hint">
              Your Kimochi version, system, settings and recent logs, with personal details removed. It makes the
              problem much easier to track down.
            </span>
          </span>
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </DialogContent>
  )
}

function HelpContent({
  draft,
  setDraft,
  onClose
}: {
  draft: Draft
  setDraft: Dispatch<SetStateAction<Draft>>
  onClose: () => void
}): JSX.Element {
  const account = useAccount()
  const [step, setStep] = useState<Step>('menu')
  const [sent, setSent] = useState<{ id: string | null; email: string } | null>(null)

  // A signed-in account fills in who's reporting; anything already typed stays.
  useEffect(() => {
    const user = account.user
    if (!user) return
    setDraft((current) => ({
      ...current,
      name: current.name || user.displayName?.trim() || '',
      email: current.email || user.email || ''
    }))
  }, [account.user, setDraft])

  if (step === 'report') {
    return (
      <ReportForm
        draft={draft}
        onDraft={setDraft}
        onBack={() => setStep('menu')}
        onSent={(id) => {
          setSent({ id, email: draft.email.trim() })
          // Name and email stay for the next report; the description doesn't.
          setDraft({ ...draft, description: '', attachDebug: true })
          setStep('sent')
        }}
      />
    )
  }

  if (step === 'sent') {
    return (
      <DialogContent
        className="help"
        title="Report sent"
        footer={
          <Button variant="primary" onClick={() => setStep('menu')}>
            Done
          </Button>
        }
      >
        <div className="help-sent">
          <CircleCheck className="help-sent-icon" aria-hidden="true" />
          <p className="help-sent-title">Thank you!</p>
          <p className="help-sent-detail">
            Your report is on its way{sent?.id ? <> (reference <span className="k-num">{sent.id}</span>)</> : null}. If we
            need anything else, we’ll reply to {sent?.email || 'your email'}.
          </p>
        </div>
      </DialogContent>
    )
  }

  return (
    <DialogContent
      className="help"
      title="Help"
      description="Stuck, or something not working? Here’s how to reach us."
      footer={
        <DialogClose asChild>
          <Button variant="primary">Close</Button>
        </DialogClose>
      }
    >
      <div className="help-choices">
        <Choice
          icon={<MessagesSquare />}
          title="Join the Discord"
          detail="Ask questions, share setups and get help from other players and the developer."
          trailing={<ExternalLink />}
          onClick={() => {
            void openUrl(DISCORD_URL).catch(() => undefined)
            onClose()
          }}
        />
        <Choice
          icon={<Bug />}
          title="Report a bug"
          detail="Tell us what went wrong. Every report is read."
          trailing={<ChevronRight />}
          onClick={() => setStep('report')}
        />
      </div>
    </DialogContent>
  )
}

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  // Here, not in the content (which unmounts on close), so closing mid-report keeps the draft.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <HelpContent draft={draft} setDraft={setDraft} onClose={() => onOpenChange(false)} />}
    </Dialog>
  )
}
