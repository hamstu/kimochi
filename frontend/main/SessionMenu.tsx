/**
 * The session picker in the Log's footer, beside its ⋯ menu: which session is being read, and
 * everything that acts on it. Drawn as footer text (the session's name) with a chevron, so it reads
 * as part of the status bar until clicked. Destructive items confirm through `LogActionsProvider`.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  ChevronsUpDown,
  Eraser,
  ListOrdered,
  PencilLine,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
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
} from "@kit";
import {
  createSession,
  getManifest,
  subscribeSessions,
  switchSession,
} from "@texthooker/lib/sessions";
import {
  getSettings,
  onSettingsChange,
  updateSettings,
} from "@texthooker/lib/settings";
import { useLogActions } from "./logActions";

export function SessionMenu(): ReactNode {
  const [manifest, setManifest] = useState(getManifest);
  const [autoMatch, setAutoMatch] = useState(
    () => getSettings().autoMatchSource,
  );
  const actions = useLogActions();
  useEffect(() => subscribeSessions(setManifest), []);
  useEffect(
    () => onSettingsChange((next) => setAutoMatch(next.autoMatchSource)),
    [],
  );

  const active = manifest.sessions.find(
    (session) => session.id === manifest.activeId,
  );
  const name = active?.name ?? "Session";

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="log-session-trigger"
          aria-label={`Session: ${name}`}
          title="Session"
        >
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
          <MenuSubTrigger icon={<ArrowLeftRight />}>
            Change session
          </MenuSubTrigger>
          <MenuSubContent className="main-session-menu">
            <MenuRadioGroup
              value={manifest.activeId}
              onValueChange={(id) => {
                if (id !== manifest.activeId) void switchSession(id);
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
          onCheckedChange={(value) =>
            void updateSettings({ autoMatchSource: value })
          }
        >
          Switch session by window name
        </MenuCheckboxItem>
        <MenuItem icon={<ListOrdered />} onSelect={actions.manageSessions}>
          Manage sessions…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
