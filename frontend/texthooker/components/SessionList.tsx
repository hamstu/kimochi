/* eslint react-hooks/set-state-in-effect: "off" -- Name and description drafts synchronize to session changes. */
/**
 * The sessions, one row each: tick to select (Shift-click ticks or unticks a run), drag a handle
 * to reorder, click a name to rename, see each one's reading time and lines, switch to it, delete
 * it (confirmed), or open it to edit its description and read its newest lines. Selected sessions
 * can be cleared (emptied, kept) or deleted together from the bar that appears under the list.
 * Shared by the Log's "Manage sessions" dialog and Settings → Log & Sessions; every change goes
 * through the Log (`@texthooker/lib/sessions`), which owns the session files.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Eraser, GripVertical, Trash2, X } from "lucide-react";
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
  Checkbox,
  ConfirmDialog,
  IconButton,
  Input,
  Textarea,
  cn,
  isComposing,
} from "@kit";
import {
  clearSessions,
  deleteSessions,
  renameSession,
  reorderSessions,
  sessionSummaries,
  subscribeSessions,
  switchSession,
  updateSessionDescription,
} from "@texthooker/lib/sessions";
import { getSettings } from "@texthooker/lib/settings";
import { snapshotLines } from "@texthooker/lib/store";
import {
  formatReadingTime,
  summarizeLines,
  type SessionSummary,
} from "@texthooker/lib/sessionSummary";
import type { SessionMeta } from "@texthooker/lib/types";
import { openSettings } from "../../bridge/tauri";
import "./session-list.css";

interface Props {
  activeId: string;
  sessions: SessionMeta[];
  className?: string;
  /** Called before the export link moves to Settings → Account (the dialog closes itself). */
  onOpenSettings?: () => void;
}

/** A confirmed action on one or more sessions. */
type Pending = { kind: "delete" | "clear"; ids: string[] } | null;

export function SessionList({
  activeId,
  sessions,
  className,
  onOpenSettings,
}: Props): ReactNode {
  const [ordered, setOrdered] = useState(sessions);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [draftDescriptions, setDraftDescriptions] = useState<
    Record<string, string>
  >({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The last row ticked or unticked without Shift: where a Shift-click's run starts.
  const anchor = useRef<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Pointer drags start after a few pixels, so a click on the handle stays a click. The keyboard
  // lifts a row with Space or Enter, moves it with the arrows and drops it with Space or Enter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [pending, setPending] = useState<Pending>(null);
  // The session being dragged: drawn in an overlay that follows the pointer, its row left behind
  // as the gap the others slide around.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Read by the sync below without making the end of a drag a reason to sync.
  const dragging = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const summaries = useSummaries(sessions, activeId, summaryVersion);

  // The reader sends a fresh copy of the sessions with every update (stats, new lines), so only
  // a real change to them is taken up, and never mid-drag. A drop shows its new order at once;
  // the saved order arrives a moment later and matches it.
  const sessionsKey = sessions
    .map(
      (session) =>
        `${session.id}\u0000${session.name}\u0000${session.description}`,
    )
    .join("\u0001");
  useEffect(() => {
    if (dragging.current) return;
    setOrdered(sessions);
    setDraftNames((current) => {
      const next: Record<string, string> = {};
      for (const session of sessions) {
        next[session.id] = current[session.id] ?? session.name;
      }
      return next;
    });
    setDraftDescriptions((current) => {
      const next: Record<string, string> = {};
      for (const session of sessions) {
        next[session.id] = current[session.id] ?? session.description ?? "";
      }
      return next;
    });
    // Sessions that are gone leave the selection and the open rows.
    const ids = new Set(sessions.map((session) => session.id));
    setSelected((current) => keepKnown(current, ids));
    setExpanded((current) => keepKnown(current, ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sessions` is followed through its key.
  }, [sessionsKey]);

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
    if (!trimmed || trimmed === session.name) {
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

  const commitDescription = async (session: SessionMeta, value: string) => {
    const trimmed = value.trim();
    if (trimmed === (session.description ?? "")) return;
    setError(null);
    try {
      await updateSessionDescription(session.id, trimmed);
    } catch (err) {
      setDraftDescriptions((current) => ({
        ...current,
        [session.id]: session.description ?? "",
      }));
      setError(errorMessage(err, "Couldn't save the description."));
    }
  };

  const activate = async (id: string) => {
    setError(null);
    try {
      await switchSession(id);
    } catch (err) {
      setError(errorMessage(err, "Couldn't switch sessions."));
    }
  };

  /** Tick or untick a row; with Shift, every row from the last one ticked takes the same state. */
  const toggle = (id: string, shift: boolean) => {
    const turnOn = !selected.has(id);
    const next = new Set(selected);
    const from = anchor.current
      ? ordered.findIndex((session) => session.id === anchor.current)
      : -1;
    const to = ordered.findIndex((session) => session.id === id);
    if (shift && from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      for (const session of ordered.slice(start, end + 1)) {
        if (turnOn) next.add(session.id);
        else next.delete(session.id);
      }
    } else {
      if (turnOn) next.add(id);
      else next.delete(id);
    }
    anchor.current = id;
    setSelected(next);
  };

  const toggleAll = () => {
    anchor.current = null;
    setSelected(
      selected.size === ordered.length
        ? new Set()
        : new Set(ordered.map((session) => session.id)),
    );
  };

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirmPending = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === "delete") await deleteSessions(pending.ids);
      else await clearSessions(pending.ids);
      setSelected((current) => {
        const next = new Set(current);
        for (const id of pending.ids) next.delete(id);
        return next;
      });
    } catch (err) {
      setError(
        errorMessage(
          err,
          pending.kind === "delete"
            ? "Couldn't delete the sessions."
            : "Couldn't clear the sessions.",
        ),
      );
    } finally {
      // Close the confirmation either way, so an error shows by the list.
      setPending(null);
      setBusy(false);
      setSummaryVersion((v) => v + 1);
    }
  };

  const draggingSession = ordered.find((session) => session.id === draggingId);
  const pendingSessions = pending
    ? sessions.filter((session) => pending.ids.includes(session.id))
    : [];
  const pendingTitle =
    pendingSessions.length === 1
      ? `“${pendingSessions[0].name}”`
      : `${pendingSessions.length} sessions`;
  const pendingHasActive = pendingSessions.some(
    (session) => session.id === activeId,
  );
  const allSelected = ordered.length > 0 && selected.size === ordered.length;

  return (
    <div className={cn("log-sessions-wrap", className)}>
      <div className="log-sessions-head" aria-hidden={ordered.length === 0}>
        <Checkbox
          className="log-session-check"
          aria-label={
            allSelected ? "Deselect all sessions" : "Select all sessions"
          }
          checked={
            allSelected ? true : selected.size > 0 ? "indeterminate" : false
          }
          onClick={(event) => {
            event.preventDefault();
            toggleAll();
          }}
        />
        <span className="log-sessions-head-name">Session</span>
        <span className="log-sessions-head-stats">Time · Lines</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => {
          dragging.current = true;
          setDraggingId(String(active.id));
          // A text selection left on the page would otherwise go along as a native drag.
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
            aria-label="Sessions"
            data-sorting={draggingId ? "" : undefined}
            // Only dnd-kit drags here; WebKit's own drag of text or elements never starts.
            onDragStart={(event) => event.preventDefault()}
          >
            {ordered.map((session, index) => {
              const isActive = session.id === activeId;
              const isOpen = expanded.has(session.id);
              const isSelected = selected.has(session.id);
              const summary = summaries[session.id];
              const detailsId = `session-details-${session.id}`;
              return (
                <SortableSession
                  key={session.id}
                  id={session.id}
                  label={`Move ${session.name}. Position ${index + 1} of ${ordered.length}.`}
                  leading={
                    <Checkbox
                      className="log-session-check"
                      aria-label={`Select ${session.name}`}
                      checked={isSelected}
                      onClick={(event) => {
                        event.preventDefault();
                        toggle(session.id, event.shiftKey);
                      }}
                    />
                  }
                  selected={isSelected}
                  open={isOpen}
                  details={
                    isOpen ? (
                      <div className="log-session-details" id={detailsId}>
                        <Textarea
                          className="log-session-description"
                          aria-label={`Description of ${session.name}`}
                          placeholder="Add a description…"
                          rows={2}
                          value={
                            draftDescriptions[session.id] ??
                            session.description ??
                            ""
                          }
                          onChange={(event) =>
                            setDraftDescriptions((current) => ({
                              ...current,
                              [session.id]: event.target.value,
                            }))
                          }
                          onBlur={(event) =>
                            void commitDescription(session, event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape" && !isComposing(event)) {
                              event.stopPropagation();
                              event.preventDefault();
                              setDraftDescriptions((current) => ({
                                ...current,
                                [session.id]: session.description ?? "",
                              }));
                              event.currentTarget.blur();
                            }
                          }}
                        />
                        <div className="log-session-recent">
                          <div className="log-session-recent-head">
                            <span>Last lines</span>
                            <span className="k-num">
                              Started {formatDate(session.createdAt)}
                            </span>
                          </div>
                          {summary && summary.recent.length > 0 ? (
                            <ol className="log-session-recent-lines" lang="ja">
                              {summary.recent.map((text, i) => (
                                <li key={i}>{text}</li>
                              ))}
                            </ol>
                          ) : (
                            <p className="log-session-recent-empty">
                              {summary ? "No lines yet." : "Loading…"}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : null
                  }
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
                        // Revert the draft without closing a dialog around the list.
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
                  <SessionStats summary={summary} />
                  <span className="log-session-state">
                    {isActive ? (
                      <Badge tone="accent">Active</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="log-session-switch"
                        aria-label={`Switch to ${session.name}`}
                        onClick={() => void activate(session.id)}
                      >
                        Switch
                      </Button>
                    )}
                  </span>
                  <IconButton
                    label={
                      sessions.length === 1
                        ? "Create another session before deleting this one"
                        : `Delete ${session.name}`
                    }
                    size="sm"
                    className="log-session-delete"
                    onClick={() => {
                      setPending({ kind: "delete", ids: [session.id] });
                      setError(null);
                    }}
                    disabled={sessions.length === 1 || busy}
                  >
                    <Trash2 />
                  </IconButton>
                  <IconButton
                    label={
                      isOpen
                        ? `Hide details of ${session.name}`
                        : `Show details of ${session.name}`
                    }
                    size="sm"
                    className="log-session-expand"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? detailsId : undefined}
                    onClick={() => toggleExpanded(session.id)}
                  >
                    <ChevronDown />
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
                name={draftNames[draggingSession.id] ?? draggingSession.name}
                active={draggingSession.id === activeId}
                summary={summaries[draggingSession.id]}
              />
            ) : null}
          </DragOverlay>,
          portalRoot() ?? document.body,
        )}
      </DndContext>

      {selected.size > 0 ? (
        <div
          className="log-sessions-bulk"
          role="toolbar"
          aria-label="Selected sessions"
        >
          <span className="log-sessions-bulk-count k-num">
            {selected.size} selected
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setPending({ kind: "clear", ids: [...selected] });
            }}
          >
            <Eraser /> Clear…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="log-sessions-bulk-delete"
            disabled={busy || selected.size >= sessions.length}
            title={
              selected.size >= sessions.length
                ? "Keep at least one session: deselect one to delete the rest"
                : undefined
            }
            onClick={() => {
              setError(null);
              setPending({ kind: "delete", ids: [...selected] });
            }}
          >
            <Trash2 /> Delete…
          </Button>
          <IconButton
            label="Deselect all"
            size="sm"
            onClick={() => {
              anchor.current = null;
              setSelected(new Set());
            }}
          >
            <X />
          </IconButton>
        </div>
      ) : null}

      {error ? (
        <Callout tone="danger" className="log-dialog-error">
          {error}
        </Callout>
      ) : null}

      <p className="log-sessions-export">
        To keep a copy of your sessions,{" "}
        <button
          type="button"
          className="k-link"
          onClick={() => {
            onOpenSettings?.();
            void openSettings("account");
          }}
        >
          export your data in Settings → Account
        </button>{" "}
        (with a Kimochi account).
      </p>

      <ConfirmDialog
        open={pendingSessions.length > 0}
        onOpenChange={(next) => {
          if (!next && !busy) setPending(null);
        }}
        title={
          pending?.kind === "clear"
            ? `Clear ${pendingTitle}?`
            : `Delete ${pendingTitle}?`
        }
        description={
          pending?.kind === "clear"
            ? `${pendingSessions.length === 1 ? "Its" : "Their"} lines, notebook and images will be permanently deleted, here and on your other computers. ${pendingSessions.length === 1 ? "The session keeps its" : "The sessions keep their"} names and descriptions.`
            : `${pendingSessions.length === 1 ? "Its" : "Their"} transcript, notebook and images will be permanently deleted.${
                pendingHasActive ? " A nearby session will become active." : ""
              }`
        }
        confirmLabel={
          pending?.kind === "clear"
            ? busy
              ? "Clearing…"
              : pendingSessions.length === 1
                ? "Clear session"
                : `Clear ${pendingSessions.length} sessions`
            : busy
              ? "Deleting…"
              : pendingSessions.length === 1
                ? "Delete session"
                : `Delete ${pendingSessions.length} sessions`
        }
        tone="danger"
        busy={busy}
        onConfirm={() => void confirmPending()}
      />
    </div>
  );
}

/**
 * Each session's summary: asked of the Log for them all when the list opens or changes, and kept
 * live for the open session from the lines the Log sends with every update.
 */
function useSummaries(
  sessions: SessionMeta[],
  activeId: string,
  version: number,
): Record<string, SessionSummary> {
  const [stored, setStored] = useState<Record<string, SessionSummary>>({});
  const [live, setLive] = useState<SessionSummary | null>(null);
  const idsKey = sessions.map((session) => session.id).join("\u0001");

  useEffect(() => {
    let current = true;
    sessionSummaries()
      .then((list) => {
        if (current) setStored(Object.fromEntries(list.map((s) => [s.id, s])));
      })
      .catch(() => {
        // The rows show no stats until the next change; the list still works.
      });
    return () => {
      current = false;
    };
  }, [idsKey, activeId, version]);

  useEffect(() => {
    const update = () => {
      try {
        const idleMs = Math.max(10, getSettings().afkThresholdSec) * 1000;
        const next = summarizeLines(activeId, snapshotLines(), idleMs);
        setLive((previous) => (sameSummary(previous, next) ? previous : next));
      } catch {
        // The Log has not sent its first snapshot yet.
      }
    };
    update();
    return subscribeSessions(update);
  }, [activeId]);

  return useMemo(
    () =>
      live && live.id === activeId ? { ...stored, [activeId]: live } : stored,
    [stored, live, activeId],
  );
}

function sameSummary(a: SessionSummary | null, b: SessionSummary): boolean {
  return (
    !!a &&
    a.id === b.id &&
    a.lines === b.lines &&
    a.readingMs === b.readingMs &&
    a.recent.join("\n") === b.recent.join("\n")
  );
}

function SessionStats({ summary }: { summary?: SessionSummary }) {
  if (!summary) return <span className="log-session-stats" aria-hidden />;
  const lines = `${summary.lines.toLocaleString()} line${summary.lines === 1 ? "" : "s"}`;
  return (
    <span
      className="log-session-stats k-num"
      title="Time between lines, leaving out idle pauses (Settings → Reading timer)"
    >
      <span>{formatReadingTime(summary.readingMs)}</span>
      <span className="log-session-stats-sep" aria-hidden>
        ·
      </span>
      <span>{lines}</span>
    </span>
  );
}

/** A session's row: dragged by its handle, the others sliding aside to make room. */
function SortableSession({
  id,
  label,
  leading,
  selected,
  open,
  details,
  children,
}: {
  id: string;
  label: string;
  leading: ReactNode;
  selected: boolean;
  open: boolean;
  details: ReactNode;
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
      className="log-session-item"
      data-dragging={isDragging ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-open={open ? "" : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="log-session-row">
        {leading}
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
      {details}
    </div>
  );
}

/** The dragged row as it floats under the pointer: a picture of the row, not its controls. */
function SessionRowFace({
  name,
  active,
  summary,
}: {
  name: string;
  active: boolean;
  summary?: SessionSummary;
}) {
  return (
    <div className="log-session-row log-session-lifted" aria-hidden>
      <span className="log-session-check-space" />
      <span className="log-session-grip k-button k-button-ghost k-button-sm k-button-icon">
        <GripVertical />
      </span>
      <span className="log-session-face-name">{name}</span>
      <SessionStats summary={summary} />
      {active ? <Badge tone="accent">Active</Badge> : null}
    </div>
  );
}

function keepKnown(
  set: ReadonlySet<string>,
  known: Set<string>,
): ReadonlySet<string> {
  const next = new Set([...set].filter((id) => known.has(id)));
  return next.size === set.size ? set : next;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
