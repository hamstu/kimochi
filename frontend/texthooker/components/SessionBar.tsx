import { useEffect, useState } from "react";
import { NotebookText, Plus, Settings2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@texthooker/components/ui/select";
import { Button } from "@texthooker/components/ui/button";
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

const NEW_SENTINEL = "__new__";
const MANAGE_SENTINEL = "__manage__";

export function SessionBar({ onOpenNotebook }: Props) {
  const [active, setActive] = useState<SessionMeta>(() => getActiveSession());
  const [sessions, setSessions] = useState<SessionMeta[]>(() => listSessions());
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    return subscribeSessions((m) => {
      const a = m.sessions.find((s) => s.id === m.activeId);
      if (a) setActive(a);
      setSessions(m.sessions.slice());
    });
  }, []);

  const handleChange = async (value: string) => {
    if (value === NEW_SENTINEL) {
      await createSession();
      return;
    }
    if (value === MANAGE_SENTINEL) {
      setManagerOpen(true);
      return;
    }
    if (value === active.id) return;
    await switchSession(value);
  };

  return (
    <div className="flex h-[1.75rem] flex-none items-center justify-between border-b border-(--color-border) bg-(--color-bg-elev) px-2.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select value={active.id} onValueChange={handleChange}>
          <SelectTrigger className="h-6 max-w-[17.5rem] min-w-[10rem] truncate">
            <SelectValue>
              <span className="truncate" title={active.name}>
                {active.name}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
            <SelectItem value={NEW_SENTINEL}>
              <span className="inline-flex items-center gap-1">
                <Plus className="h-3 w-3" />
                New session…
              </span>
            </SelectItem>
            <SelectItem value={MANAGE_SENTINEL}>
              <span className="inline-flex items-center gap-1">
                <Settings2 className="h-3 w-3" />
                Manage sessions…
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onOpenNotebook}
        title="Open notebook"
      >
        <NotebookText className="h-3.5 w-3.5" />
        Notebook
      </Button>

      <SessionManagerModal
        activeId={active.id}
        open={managerOpen}
        onOpenChange={setManagerOpen}
        sessions={sessions}
      />
    </div>
  );
}
