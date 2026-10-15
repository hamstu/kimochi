/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Trash2 } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  restrictToVerticalAxis,
  restrictToWindowEdges,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  Badge,
  Button,
  portalRoot,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  IconButton,
  Input,
  isComposing,
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

export function SessionManagerModal({
  activeId,
  open,
  onOpenChange,
  sessions,
}: Props) {
  const [ordered, setOrdered] = useState(sessions);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  // Pointer drags start after a few pixels, so a click on the handle stays a click. The keyboard
  // lifts a row with Space or Enter, moves it with the arrows and drops it with Space or Enter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // The session being dragged: drawn in an overlay that follows the pointer, its row left behind
  // as the gap the others slide around.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Read by the sync below without making the end of a drag a reason to sync.
  const dragging = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The reader sends a fresh copy of the sessions with every update (stats, new lines), so only
  // a real change to them is taken up, and never mid-drag. A drop shows its new order at once;
  // the saved order arrives a moment later and matches it.
  const sessionsKey = sessions
    .map((session) => `${session.id}\u0000${session.name}`)
    .join("\u0001");
  useEffect(() => {
    if (!open || dragging.current) return;
    setOrdered(sessions);
    setDraftNames((current) => {
      const next: Record<string, string> = {};
      for (const session of sessions) {
        next[session.id] = current[session.id] ?? session.name;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sessions` is followed through its key.
  }, [open, sessionsKey]);

  useEffect(() => {
    if (deleteId && !sessions.some((session) => session.id === deleteId)) {
      setDeleteId(null);
    }
  }, [deleteId, sessions]);

  useEffect(() => {
    if (open) return;
    setDeleteId(null);
    setDraggingId(null);
    dragging.current = false;
    setError(null);
  }, [open]);

  const endDrag = () => {
    dragging.current = false;
    setDraggingId(null);
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    endDrag();
    if (!over || active.id === over.id) return;
    const from = ordered.findIndex((session) => session.id === active.id);
    const to = ordered.findIndex((session) => session.id === over.id);
    if (from === -1 || to === -1) return;
    const next = arrayMove(ordered, from, to);
    setOrdered(next);
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

  const draggingSession = ordered.find((session) => session.id === draggingId);
  const deletingSession = sessions.find((session) => session.id === deleteId);

  return (
    <>
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={({ active }) => {
              setDeleteId(null);
              dragging.current = true;
              setDraggingId(String(active.id));
              // A text selection left in the dialog would otherwise go along as a native drag.
              window.getSelection()?.removeAllRanges();
            }}
            onDragCancel={endDrag}
            onDragEnd={(event) => void onDragEnd(event)}
          >
            <SortableContext
              items={ordered.map((session) => session.id)}
              strategy={verticalListSortingStrategy}
            >
              <div
                className="log-sessions"
                role="list"
                data-sorting={draggingId ? "" : undefined}
                // Only dnd-kit drags here; WebKit's own drag of text or elements never starts.
                onDragStart={(event) => event.preventDefault()}
              >
                {ordered.map((session, index) => {
                  const isActive = session.id === activeId;
                  return (
                    <SortableSession
                      key={session.id}
                      id={session.id}
                      label={`Move ${session.name}. Position ${index + 1} of ${ordered.length}.`}
                    >
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
                          if (isComposing(event)) return;
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
                    </SortableSession>
                  );
                })}
              </div>
            </SortableContext>
            {createPortal(
              <DragOverlay
                modifiers={[restrictToVerticalAxis, restrictToWindowEdges]}
                zIndex={70}
              >
                {draggingSession ? (
                  <SessionRowFace
                    name={
                      draftNames[draggingSession.id] ?? draggingSession.name
                    }
                    active={draggingSession.id === activeId}
                  />
                ) : null}
              </DragOverlay>,
              portalRoot() ?? document.body,
            )}
          </DndContext>

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

/** A session's row: dragged by its handle, the others sliding aside to make room. */
function SortableSession({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      role="listitem"
      className="log-session-row"
      data-dragging={isDragging ? "" : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="sm"
        icon
        className="log-session-grip"
        {...attributes}
        {...listeners}
        aria-label={label}
      >
        <GripVertical />
      </Button>
      {children}
    </div>
  );
}

/** The dragged row as it floats under the pointer: a picture of the row, not its controls. */
function SessionRowFace({ name, active }: { name: string; active: boolean }) {
  return (
    <div className="log-session-row log-session-lifted" aria-hidden>
      <span className="log-session-grip k-button k-button-ghost k-button-sm k-button-icon">
        <GripVertical />
      </span>
      <span className="log-session-face-name">{name}</span>
      {active ? <Badge tone="accent">Active</Badge> : null}
      <span className="log-session-delete k-button k-button-ghost k-button-sm k-button-icon">
        <Trash2 />
      </span>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
