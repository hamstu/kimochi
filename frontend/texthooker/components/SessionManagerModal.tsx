/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  IconButton,
  Input,
} from "@kit";
import {
  deleteSession,
  renameSession,
  reorderSessions,
} from "@texthooker/lib/sessions";
import type { SessionMeta } from "@texthooker/lib/types";

interface Props {
  activeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionMeta[];
}

type DropPosition = "before" | "after";

export function SessionManagerModal({
  activeId,
  open,
  onOpenChange,
  sessions,
}: Props) {
  const [ordered, setOrdered] = useState(sessions);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: DropPosition;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOrdered(sessions);
    setDraftNames((current) => {
      const next: Record<string, string> = {};
      for (const session of sessions) {
        next[session.id] = current[session.id] ?? session.name;
      }
      return next;
    });
  }, [open, sessions]);

  useEffect(() => {
    if (deleteId && !sessions.some((session) => session.id === deleteId)) {
      setDeleteId(null);
    }
  }, [deleteId, sessions]);

  useEffect(() => {
    if (open) return;
    setDraggedId(null);
    setDropTarget(null);
    setDeleteId(null);
    setError(null);
  }, [open]);

  const moveSession = async (id: string, direction: -1 | 1) => {
    const from = ordered.findIndex((session) => session.id === id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= ordered.length) return;
    const next = ordered.slice();
    [next[from], next[to]] = [next[to], next[from]];
    setOrdered(next);
    setError(null);
    try {
      await reorderSessions(next.map((session) => session.id));
    } catch (err) {
      setOrdered(sessions);
      setError(errorMessage(err, "Couldn't reorder sessions."));
    }
  };

  const dropSession = async (targetId: string, position: DropPosition) => {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDropTarget(null);
      return;
    }

    const moved = ordered.find((session) => session.id === draggedId);
    if (!moved) return;
    const next = ordered.filter((session) => session.id !== draggedId);
    const targetIndex = next.findIndex((session) => session.id === targetId);
    next.splice(targetIndex + (position === "after" ? 1 : 0), 0, moved);
    setOrdered(next);
    setDraggedId(null);
    setDropTarget(null);
    setError(null);
    try {
      await reorderSessions(next.map((session) => session.id));
    } catch (err) {
      setOrdered(sessions);
      setError(errorMessage(err, "Couldn't reorder sessions."));
    }
  };

  const commitName = async (session: SessionMeta, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setDraftNames((current) => ({ ...current, [session.id]: session.name }));
      return;
    }
    setDraftNames((current) => ({ ...current, [session.id]: trimmed }));
    setError(null);
    try {
      await renameSession(session.id, trimmed);
    } catch (err) {
      setDraftNames((current) => ({ ...current, [session.id]: session.name }));
      setError(errorMessage(err, "Couldn't rename the session."));
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteSession(deleteId);
      setDeleteId(null);
    } catch (err) {
      // Close the confirmation so the error shows in the manager.
      setDeleteId(null);
      setError(errorMessage(err, "Couldn't delete the session."));
    } finally {
      setDeleting(false);
    }
  };

  const deletingSession = sessions.find((session) => session.id === deleteId);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          title="Manage sessions"
          description="Drag a handle to reorder, or focus it and use the arrow keys. Click a name to rename it."
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
          <div className="log-sessions" role="list">
            {ordered.map((session, index) => {
              const isActive = session.id === activeId;
              const drop =
                dropTarget?.id === session.id ? dropTarget.position : undefined;
              return (
                <div
                  key={session.id}
                  role="listitem"
                  className="log-session-row"
                  data-dragging={draggedId === session.id ? "" : undefined}
                  data-drop={drop}
                  onDragOver={(event) => {
                    if (!draggedId || draggedId === session.id) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const position =
                      event.clientY < rect.top + rect.height / 2
                        ? "before"
                        : "after";
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget({ id: session.id, position });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void dropSession(
                      session.id,
                      dropTarget?.position ?? "before",
                    );
                  }}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    icon
                    draggable
                    className="log-session-grip"
                    aria-label={`Move ${session.name}. Position ${index + 1} of ${ordered.length}. Use up and down arrow keys to reorder.`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", session.id);
                      setDraggedId(session.id);
                      setDeleteId(null);
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDropTarget(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        void moveSession(session.id, -1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        void moveSession(session.id, 1);
                      }
                    }}
                  >
                    <GripVertical />
                  </Button>

                  <Input
                    size="sm"
                    className="log-session-name"
                    aria-label={`Session name${isActive ? " (active session)" : ""}`}
                    value={draftNames[session.id] ?? session.name}
                    onChange={(event) =>
                      setDraftNames((current) => ({
                        ...current,
                        [session.id]: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      void commitName(session, event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        // Revert the draft without closing the dialog.
                        event.stopPropagation();
                        event.preventDefault();
                        event.currentTarget.value = session.name;
                        setDraftNames((current) => ({
                          ...current,
                          [session.id]: session.name,
                        }));
                        event.currentTarget.blur();
                      }
                    }}
                  />

                  {isActive ? <Badge tone="accent">Active</Badge> : null}
                  <IconButton
                    label={
                      sessions.length === 1
                        ? "Create another session before deleting this one"
                        : `Delete ${session.name}`
                    }
                    size="sm"
                    className="log-session-delete"
                    onClick={() => {
                      setDeleteId(session.id);
                      setError(null);
                    }}
                    disabled={sessions.length === 1 || deleting}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              );
            })}
          </div>

          {error ? (
            <Callout tone="danger" className="log-dialog-error">
              {error}
            </Callout>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deletingSession)}
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteId(null);
        }}
        title={`Delete “${deletingSession?.name ?? ""}”?`}
        description={`Its transcript, notebook and images will be permanently deleted.${
          deletingSession?.id === activeId
            ? " A nearby session will become active."
            : ""
        }`}
        confirmLabel={deleting ? "Deleting…" : "Delete session"}
        tone="danger"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
