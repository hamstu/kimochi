/**
 * The session picker in the Log's footer, beside its ⋯ menu: which session is being read, and
 * everything that acts on it. Drawn as footer text (the session's name) with a chevron, so it reads
 * as part of the status bar until clicked. Destructive items confirm through `LogActionsProvider`.
 *
 * The Stats tab has its own (`StatsSessionMenu`): the same footer text, opening a checkbox list of
 * the sessions its numbers count, every one by default.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeftRight, ChevronsUpDown, Eraser, ListOrdered, PencilLine, Plus, RotateCcw, Trash2 } from 'lucide-react'
import {
  Button,
  Checkbox,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@kit'
import { createSession, getManifest, subscribeSessions, switchSession } from '@texthooker/lib/sessions'
import { getSettings, onSettingsChange, updateSettings } from '@texthooker/lib/settings'
import { useLogActions } from './logActions'

export function SessionMenu(): ReactNode {
  const [manifest, setManifest] = useState(getManifest)
  const [autoMatch, setAutoMatch] = useState(() => getSettings().autoMatchSource)
  const actions = useLogActions()
  useEffect(() => subscribeSessions(setManifest), [])
  useEffect(() => onSettingsChange((next) => setAutoMatch(next.autoMatchSource)), [])

  const active = manifest.sessions.find((session) => session.id === manifest.activeId)
  const name = active?.name ?? 'Session'

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="log-session-trigger" aria-label={`Session: ${name}`} title="Session">
          <span className="log-session-name">{name}</span>
          <ChevronsUpDown aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end" side="top" className="main-session-menu">
        <MenuLabel>{name}</MenuLabel>
        <MenuItem icon={<PencilLine />} onSelect={actions.editSession}>
          Rename…
        </MenuItem>
        <MenuItem icon={<Eraser />} onSelect={actions.clearLines}>
          Clear lines…
        </MenuItem>
        <MenuItem icon={<RotateCcw />} onSelect={actions.resetStats}>
          Reset stats…
        </MenuItem>
        <MenuItem
          icon={<Trash2 />}
          tone="danger"
          disabled={manifest.sessions.length < 2}
          onSelect={actions.deleteSession}
        >
          Delete session…
        </MenuItem>
        <MenuSeparator />
        {/* The other sessions live one level down so the top level stays short. */}
        <MenuSub>
          <MenuSubTrigger icon={<ArrowLeftRight />}>Change session</MenuSubTrigger>
          <MenuSubContent className="main-session-menu">
            <MenuRadioGroup
              value={manifest.activeId}
              onValueChange={(id) => {
                if (id !== manifest.activeId) void switchSession(id)
              }}
            >
              {manifest.sessions.map((session) => (
                <MenuRadioItem key={session.id} value={session.id}>
                  {session.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem icon={<Plus />} onSelect={() => void createSession()}>
              New session
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
        <MenuCheckboxItem
          checked={autoMatch}
          onCheckedChange={(value) => void updateSettings({ autoMatchSource: value })}
        >
          Switch session by window name
        </MenuCheckboxItem>
        <MenuItem icon={<ListOrdered />} onSelect={actions.manageSessions}>
          Manage sessions…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** A session the Stats tab can count. */
export interface StatsSessionOption {
  id: string
  name: string
  /** Gone from the session list, still in the reading history. */
  deleted?: boolean
}

/**
 * The Stats tab's session picker: which sessions its numbers count. `selected` null means every
 * session (the default), so sessions made later are counted too.
 */
export function StatsSessionMenu({
  options,
  selected,
  onSelect
}: {
  options: readonly StatsSessionOption[]
  selected: readonly string[] | null
  onSelect: (ids: readonly string[] | null) => void
}): ReactNode {
  const ids = options.map((option) => option.id)
  const chosen = new Set(selected ?? ids)
  const count = ids.filter((id) => chosen.has(id)).length
  const label =
    selected === null || count === ids.length
      ? 'All sessions'
      : count === 0
        ? 'No sessions'
        : count === 1
          ? (options.find((option) => chosen.has(option.id))?.name ?? '1 session')
          : `${count} sessions`
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(chosen)
    if (on) next.add(id)
    else next.delete(id)
    onSelect(ids.every((each) => next.has(each)) ? null : ids.filter((each) => next.has(each)))
  }
  const live = options.filter((option) => !option.deleted)
  const deleted = options.filter((option) => option.deleted)
  const row = (option: StatsSessionOption): ReactNode => (
    <label key={option.id} className="stats-session-option">
      <Checkbox checked={chosen.has(option.id)} onCheckedChange={(on) => toggle(option.id, on === true)} />
      <span>{option.name}</span>
    </label>
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="log-session-trigger"
          aria-label={`Sessions: ${label}`}
          title="Sessions counted"
        >
          <span className="log-session-name">{label}</span>
          <ChevronsUpDown aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent menu align="end" side="top" className="main-session-menu stats-session-menu">
        <div className="stats-session-head">
          <span className="k-menu-label">Sessions counted</span>
          <Button size="sm" variant="ghost" disabled={count === ids.length} onClick={() => onSelect(null)}>
            Select all
          </Button>
          <Button size="sm" variant="ghost" disabled={count === 0} onClick={() => onSelect([])}>
            Select none
          </Button>
        </div>
        <div className="stats-session-list">
          {live.map(row)}
          {deleted.length > 0 && (
            <>
              <span className="k-menu-label">Deleted sessions</span>
              {deleted.map(row)}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
