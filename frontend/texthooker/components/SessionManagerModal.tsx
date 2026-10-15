/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState, type ReactNode } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import {
  DndContext,
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
  restrictToParentElement,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
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
    setDeleteId(null);
    setError(null);
  }, [open]);

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
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
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={() => setDeleteId(null)}
            onDragEnd={(event) => void onDragEnd(event)}
          >
            <SortableContext
              items={ordered.map((session) => session.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="log-sessions" role="list">
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
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
