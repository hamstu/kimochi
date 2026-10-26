import { type ReactNode } from "react";
import { Button, Dialog, DialogClose, DialogContent } from "@kit";
import type { SessionMeta } from "@texthooker/lib/types";
import { SessionList } from "./SessionList";

interface Props {
  activeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionMeta[];
}

export function SessionManagerModal({
  activeId,
  open,
  onOpenChange,
  sessions,
}: Props): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Manage sessions"
        description="Drag a handle to reorder, or focus it, press Space and use the arrow keys. Click a name to rename it."
        footer={
          <>
            <span className="log-footer-count k-num">
              {sessions.length} session{sessions.length === 1 ? "" : "s"}
            </span>
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          </>
        }
      >
        {/* Mounted only while open, so each opening starts from the saved names and order. */}
        <SessionList activeId={activeId} sessions={sessions} />
      </DialogContent>
    </Dialog>
  );
}
