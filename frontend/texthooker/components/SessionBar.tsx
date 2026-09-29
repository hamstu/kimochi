import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, NotebookText, Plus, Settings2 } from "lucide-react";
import {
  Bar,
  BarSpacer,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@kit";
import { closeAutoFocusFromKeyboardOnly } from "@kit/focus";
import { SessionManagerModal } from "@texthooker/components/SessionManagerModal";
import {
  createSession,
  getActiveSession,
  listSessions,
  subscribeSessions,
  switchSession,
} from "@texthooker/lib/sessions";
import type { SessionMeta } from "@texthooker/lib/types";

interface Props {
  onOpenNotebook: () => void;
}

/** The Log's 28px tool bar: session picker on the left, Notebook on the right. */
export function SessionBar({ onOpenNotebook }: Props) {
  const [active, setActive] = useState<SessionMeta>(() => getActiveSession());
  const [sessions, setSessions] = useState<SessionMeta[]>(() => listSessions());
  const [managerOpen, setManagerOpen] = useState(false);
  // Opening the manager from the menu: skip returning focus to the trigger so the dialog keeps it.
  const openingManager = useRef(false);

  useEffect(() => {
    return subscribeSessions((m) => {
      const a = m.sessions.find((s) => s.id === m.activeId);
      if (a) setActive(a);
      setSessions(m.sessions.slice());
    });
  }, []);

  const handleSwitch = (id: string) => {
    if (id === active.id) return;
    void switchSession(id);
  };

  return (
    <Bar position="top">
      <Menu>
        <MenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="log-session-trigger"
            aria-label={`Session: ${active.name}`}
          >
            <span className="k-truncate" title={active.name}>
              {active.name}
            </span>
            <ChevronsUpDown />
          </Button>
        </MenuTrigger>
        <MenuContent
          align="start"
          className="log-session-menu"
          onCloseAutoFocus={(e) => {
            if (openingManager.current) {
              e.preventDefault();
              openingManager.current = false;
              return;
            }
            closeAutoFocusFromKeyboardOnly(e);
          }}
        >
          <MenuRadioGroup value={active.id} onValueChange={handleSwitch}>
            {sessions.map((s) => (
              <MenuRadioItem key={s.id} value={s.id}>
                {s.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem icon={<Plus />} onSelect={() => void createSession()}>
            New session
          </MenuItem>
          <MenuItem
            icon={<Settings2 />}
            onSelect={() => {
              openingManager.current = true;
              setManagerOpen(true);
            }}
          >
            Manage sessions…
          </MenuItem>
        </MenuContent>
      </Menu>

      <BarSpacer />

      <Button variant="ghost" size="sm" onClick={onOpenNotebook}>
        <NotebookText />
        Notebook
      </Button>

      <SessionManagerModal
        activeId={active.id}
        open={managerOpen}
        onOpenChange={setManagerOpen}
        sessions={sessions}
      />
    </Bar>
  );
}
