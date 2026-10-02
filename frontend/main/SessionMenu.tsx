/**
 * The session picker in the main window's sidebar: which session is being read, and everything
 * that acts on it. Destructive items confirm through `LogActionsProvider`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronsUpDown,
  Eraser,
  ListOrdered,
  PencilLine,
  Plus,
  RotateCcw,
  Trash2
} from 'lucide-react'
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger
} from '@kit'
import {
  createSession,
  getManifest,
  subscribeSessions,
  switchSession
} from '@texthooker/lib/sessions'
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
        {/* Drawn as a select field, like the OCR model above it. */}
        <button type="button" className="k-select-trigger sb-select" aria-label={`Session: ${name}`}>
          <span>{name}</span>
          <ChevronsUpDown className="k-select-trigger-icon" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="main-session-menu">
        <MenuLabel>Sessions</MenuLabel>
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
        <MenuItem icon={<Plus />} onSelect={() => void createSession()}>
          New session
        </MenuItem>
        <MenuSeparator />
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
        <MenuCheckboxItem
          checked={autoMatch}
          onCheckedChange={(value) => void updateSettings({ autoMatchSource: value })}
        >
          Switch by window name
        </MenuCheckboxItem>
        <MenuItem icon={<ListOrdered />} onSelect={actions.manageSessions}>
          Manage sessions…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
