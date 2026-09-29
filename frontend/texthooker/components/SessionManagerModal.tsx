/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { GripVertical, Trash2, X } from "lucide-react";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@texthooker/components/ui/dialog";
import {
  deleteSession,
  renameSession,
  reorderSessions,
} from "@texthooker/lib/sessions";
import type { SessionMeta } from "@texthooker/lib/types";
import { cn } from "@texthooker/lib/utils";

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
      setError(errorMessage(err, "Couldn't delete the session."));
    } finally {
      setDeleting(false);
    }
  };

  const deletingSession = sessions.find((session) => session.id === deleteId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-1/2 right-auto top-1/2 bottom-auto w-[31rem] max-w-[calc(100vw-3rem)] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-(--color-border) p-0 shadow-[var(--shadow-pop)]">
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <DialogTitle className="text-sm font-semibold text-(--color-text) [text-wrap:balance]">
              Manage sessions
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-relaxed text-(--color-text-muted) [text-wrap:pretty]">
              Drag a handle to reorder. Focus a handle and use the arrow keys
              for precise moves.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 flex-none active:scale-[0.96] transition-transform"
              aria-label="Close session manager"
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </div>

        <div className="min-h-0 overflow-y-auto px-3 pb-3">
          <div className="space-y-1.5">
            {ordered.map((session, index) => {
              const isActive = session.id === activeId;
              const isDropTarget = dropTarget?.id === session.id;
              return (
                <div
                  key={session.id}
                  className={cn(
                    "relative flex items-center gap-2 rounded-xl bg-(--color-bg-elev) p-1.5 shadow-[0_1px_0_rgba(0,0,0,0.08)] transition-[opacity,transform] duration-150",
                    draggedId === session.id && "opacity-40",
                    isDropTarget &&
                      dropTarget.position === "before" &&
                      "before:absolute before:inset-x-2 before:-top-1 before:h-0.5 before:rounded-full before:bg-(--color-accent)",
                    isDropTarget &&
                      dropTarget.position === "after" &&
                      "after:absolute after:inset-x-2 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-(--color-accent)",
                  )}
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
                  <button
                    type="button"
                    draggable
                    className="flex h-10 w-10 flex-none cursor-grab items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-bg-elev-2) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) active:cursor-grabbing active:scale-[0.96]"
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
                    <GripVertical className="h-4 w-4" />
                  </button>

                  <div className="min-w-0 flex-1">
                    <label
                      className="sr-only"
                      htmlFor={`session-name-${session.id}`}
                    >
                      Session name
                    </label>
                    <Input
                      id={`session-name-${session.id}`}
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
                          event.currentTarget.value = session.name;
                          setDraftNames((current) => ({
                            ...current,
                            [session.id]: session.name,
                          }));
                          event.currentTarget.blur();
                        }
                      }}
                      className="h-10 w-full min-w-0 rounded-md border border-(--color-border) bg-(--color-bg) px-2 text-xs text-(--color-text) outline-none transition-[background-color,border-color] hover:border-(--color-text-muted) focus:border-(--color-accent)"
                      aria-describedby={
                        isActive ? `active-session-${session.id}` : undefined
                      }
                      spellCheck={false}
                    />
                    {isActive ? (
                      <span
                        id={`active-session-${session.id}`}
                        className="sr-only"
                      >
                        Active session
                      </span>
                    ) : null}
                  </div>

                  {isActive ? (
                    <span className="flex-none rounded-full bg-(--color-accent-soft) px-2 py-0.5 text-[0.625rem] font-medium text-(--color-accent)">
                      Active
                    </span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 flex-none text-(--color-text-muted) hover:text-(--color-danger) active:scale-[0.96] transition-[color,background-color,transform]"
                    onClick={() => {
                      setDeleteId(session.id);
                      setError(null);
                    }}
                    disabled={sessions.length === 1 || deleting}
                    aria-label={`Delete ${session.name}`}
                    title={
                      sessions.length === 1
                        ? "Create another session before deleting this one"
                        : `Delete ${session.name}`
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        {deletingSession ? (
          <div className="mx-3 mb-3 rounded-lg bg-(--color-danger)/10 p-3 text-xs shadow-[inset_0_0_0_1px_rgba(248,81,73,0.28)]">
            <p className="font-medium text-(--color-text)">
              Delete “{deletingSession.name}”?
            </p>
            <p className="mt-1 leading-relaxed text-(--color-text-dim) [text-wrap:pretty]">
              Its transcript, notebook, and images will be permanently deleted.
              {deletingSession.id === activeId
                ? " A nearby session will become active."
                : ""}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                className="h-10 px-3 active:scale-[0.96] transition-transform"
                onClick={() => setDeleteId(null)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                className="h-10 px-3 active:scale-[0.96] transition-transform"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting…" : "Delete session"}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="px-5 pb-3 text-xs text-(--color-danger)" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between bg-(--color-bg-elev) px-5 py-3 text-[0.6875rem] text-(--color-text-muted)">
          <span className="tabular-nums">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
          <DialogClose asChild>
            <Button
              variant="default"
              className="h-10 px-3 active:scale-[0.96] transition-transform"
            >
              Done
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
