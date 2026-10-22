/**
 * DEV-ONLY: the UI studio's side panel. State: the controls that apply where the reader is in the
 * surface, and its JSON state. Copy: the text changed in copy-edit mode, ready to paste to an agent.
 */
import { useState, type ReactNode } from 'react'
import { Check, ClipboardCopy, RotateCcw, Trash2, WandSparkles } from 'lucide-react'
import { Button, IconButton, Input, Select, Switch, cn } from '@kit'
import { controlValue, impliedParams, storedValue, type Values } from './params'
import { copySummary, type CopyChange } from './copyEdit'
import type { Control, JsonState, StudioContext, Surface } from './types'

export function StatePanel({
  surface,
  context,
  values,
  onValue,
  onReset,
  json,
  onJson
}: {
  surface: Surface
  context: StudioContext
  values: Values
  onValue: (param: string, value: string | undefined) => void
  onReset: () => void
  json: Record<string, string>
  onJson: (key: string, text: string | undefined) => void
}): ReactNode {
  const groups = surface.groups.filter((g) => !g.when || g.when(context))
  const states = (surface.json ?? []).filter((j) => !j.when || j.when(context))
  const changed = Object.keys(values).length + Object.keys(json).length
  const implied = impliedParams(surface, context)
  return (
    <div className="studio-panel-scroll">
      <div className="studio-panel-head">
        <div>
          <h2>{surface.label}</h2>
          <p>{changed ? `${changed} changed from the defaults` : 'All defaults'}</p>
        </div>
        <Button size="sm" variant="ghost" disabled={!changed} onClick={onReset}>
          <RotateCcw />
          Reset
        </Button>
      </div>
      {groups.length === 0 && states.length === 0 && <p className="studio-empty">Nothing to change here.</p>}
      {groups.map((group) => (
        <section key={group.title} className="studio-group">
          <h3>{group.title}</h3>
          {group.controls.map((control) => (
            <ControlRow
              key={control.param}
              control={control}
              value={controlValue(control, values, implied)}
              changed={values[control.param] !== undefined}
              onChange={(value) => onValue(control.param, storedValue(control, value, implied))}
            />
          ))}
        </section>
      ))}
      {states.map((state) => (
        <JsonEditor
          // A new applied text (or a reset) starts the draft over.
          key={`${state.key}:${json[state.key] ?? ''}`}
          state={state}
          text={json[state.key]}
          onApply={(text) => onJson(state.key, text)}
        />
      ))}
    </div>
  )
}

function ControlRow({
  control,
  value,
  changed,
  onChange
}: {
  control: Control
  value: string
  changed: boolean
  onChange: (value: string) => void
}): ReactNode {
  const id = `studio-${control.param}`
  return (
    <div className={cn('studio-control', control.kind === 'toggle' && 'studio-control-inline')} data-changed={changed || undefined}>
      <label htmlFor={id}>
        <span>{control.label}</span>
        {control.help && <small>{control.help}</small>}
      </label>
      {control.kind === 'select' && (
        <Select
          aria-label={control.label}
          size="sm"
          value={value}
          onValueChange={onChange}
          options={control.options}
        />
      )}
      {control.kind === 'toggle' && (
        <Switch
          id={id}
          size="sm"
          checked={value === control.on}
          onCheckedChange={(on) => onChange(on ? control.on : (control.off ?? ''))}
        />
      )}
      {control.kind === 'text' && (
        <TextControl key={value} id={id} value={value} placeholder={control.placeholder} onCommit={onChange} />
      )}
    </div>
  )
}

/** A text parameter, sent when the field is left or Return is pressed (each change reloads). */
function TextControl({
  id,
  value,
  placeholder,
  onCommit
}: {
  id: string
  value: string
  placeholder?: string
  onCommit: (value: string) => void
}): ReactNode {
  const [text, setText] = useState(value)
  return (
    <Input
      id={id}
      size="sm"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => e.key === 'Enter' && onCommit(text)}
    />
  )
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

function JsonEditor({
  state,
  text,
  onApply
}: {
  state: JsonState
  /** The applied text, or undefined for the surface's own default. */
  text: string | undefined
  onApply: (text: string | undefined) => void
}): ReactNode {
  const applied = text ?? pretty(state.initial)
  const [draft, setDraft] = useState(applied)
  let error: string | null = null
  try {
    JSON.parse(draft)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const dirty = draft !== applied
  const lines = draft.split('\n').length
  return (
    <section className="studio-group studio-json" data-changed={text !== undefined || undefined}>
      <div className="studio-json-head">
        <h3>{state.label}</h3>
        <span className="studio-json-actions">
          <IconButton
            size="sm"
            label="Format"
            disabled={Boolean(error)}
            onClick={() => setDraft(pretty(JSON.parse(draft)))}
          >
            <WandSparkles />
          </IconButton>
          <IconButton size="sm" label="Back to the default" disabled={text === undefined && !dirty} onClick={() => onApply(undefined)}>
            <RotateCcw />
          </IconButton>
        </span>
      </div>
      {state.help && <p className="studio-help">{state.help}</p>}
      <div className="studio-code">
        <div className="studio-code-gutter" aria-hidden>
          {Array.from({ length: lines }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <textarea
          spellCheck={false}
          value={draft}
          rows={Math.min(24, Math.max(4, lines))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !error) onApply(draft)
            if (e.key === 'Tab') {
              e.preventDefault()
              const el = e.currentTarget
              const { selectionStart: start, selectionEnd: end } = el
              const next = `${draft.slice(0, start)}  ${draft.slice(end)}`
              setDraft(next)
              requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
            }
          }}
        />
      </div>
      <div className="studio-json-foot">
        <span className={cn('studio-json-status', error && 'studio-json-error')}>
          {error ?? (dirty ? 'Not applied yet · ⌘↩ applies' : text === undefined ? 'The page’s default' : 'Applied')}
        </span>
        <Button size="sm" variant="primary" disabled={!dirty || Boolean(error)} onClick={() => onApply(draft)}>
          Apply
        </Button>
      </div>
    </section>
  )
}

export function CopyPanel({
  editing,
  onEditing,
  changes,
  onChanges,
  place,
  surface
}: {
  editing: boolean
  onEditing: (on: boolean) => void
  changes: CopyChange[]
  onChanges: (changes: CopyChange[]) => void
  place: string
  surface: Surface
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState('')
  const copy = (): void => {
    void navigator.clipboard.writeText(copySummary(changes)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  const addNote = (): void => {
    if (!note.trim()) return
    onChanges([
      ...changes,
      { key: `note:${Date.now()}`, surface: surface.label, place, where: 'note', tag: 'note', before: '', after: '', note: note.trim() }
    ])
    setNote('')
  }
  return (
    <div className="studio-panel-scroll">
      <div className="studio-panel-head">
        <div>
          <h2>Copy edits</h2>
          <p>{changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'No changes yet'}</p>
        </div>
        <Switch checked={editing} onCheckedChange={onEditing} aria-label="Edit copy" />
      </div>
      <p className="studio-help studio-pad">
        {editing
          ? 'Click any text in the window to change it; Return keeps it, Escape puts it back. Clicks edit instead of pressing, so turn this off to use the app.'
          : 'Turn on to edit the window’s text in place. Changes are listed here and copied as one summary for an agent to make.'}
      </p>
      <section className="studio-group">
        <h3>Note on this view</h3>
        <p className="studio-help">{place}</p>
        <div className="studio-note">
          <Input
            size="sm"
            value={note}
            placeholder="Something to change that isn’t one piece of text…"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
          />
          <Button size="sm" disabled={!note.trim()} onClick={addNote}>
            Add
          </Button>
        </div>
      </section>
      {changes.length > 0 && (
        <section className="studio-group">
          <div className="studio-json-head">
            <h3>Changes</h3>
            <span className="studio-json-actions">
              <Button size="sm" variant="primary" onClick={copy}>
                {copied ? <Check /> : <ClipboardCopy />}
                {copied ? 'Copied' : 'Copy summary'}
              </Button>
              <IconButton size="sm" label="Clear all" onClick={() => onChanges([])}>
                <Trash2 />
              </IconButton>
            </span>
          </div>
          <ol className="studio-changes">
            {changes.map((c) => (
              <li key={c.key}>
                <div className="studio-change-where">
                  <span>{c.place}</span>
                  {c.before && <span>{c.where}</span>}
                  <IconButton size="sm" label="Remove" onClick={() => onChanges(changes.filter((x) => x.key !== c.key))}>
                    <Trash2 />
                  </IconButton>
                </div>
                {c.before ? (
                  <>
                    <del>{c.before}</del>
                    <ins>{c.after}</ins>
                    <Input
                      size="sm"
                      value={c.note ?? ''}
                      placeholder="Why (optional)"
                      onChange={(e) =>
                        onChanges(changes.map((x) => (x.key === c.key ? { ...x, note: e.target.value || undefined } : x)))
                      }
                    />
                  </>
                ) : (
                  <p className="studio-change-note">{c.note}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
