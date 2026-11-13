import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isComposing, Tooltip } from "@kit";
import { NotebookMatchChip } from "./NotebookMatchChip";
import { LineActionsMenu } from "./LineActionsMenu";
import { getMatcher, matchLine, type Match } from "@texthooker/lib/nameMatch";
import { getNotebook } from "@texthooker/lib/notebook";
import { useNotebookCacheVersion } from "@texthooker/hooks/useNotebookCacheVersion";
import {
  getTranslateStatus,
  subscribeTranslateStatus,
} from "@texthooker/lib/translate";
import { isNote, type Line } from "@texthooker/lib/types";
import { lineDate, lineTime } from "@texthooker/lib/logDays";
import { LineMedia } from "./LineMedia";
import { endNote, stopEditing, useLineEditing } from "@texthooker/lib/lineEdit";
import { addNote, setLineText } from "@texthooker/lib/store";
import { markdownHtml } from "@texthooker/lib/html";
import { ChevronDown } from "lucide-react";
import { followNoteLink } from "@texthooker/lib/noteNav";

interface Props {
  line: Line;
  translateEnabled: boolean;
}

interface RenderPiece {
  kind: "match" | "plain";
  start: number;
  end: number;
  match?: Match;
}

/** Walk the line and emit pieces: notebook matches, and the plain text between them. */
function buildRenderPieces(line: Line, matches: Match[]): RenderPiece[] {
  const pieces: RenderPiece[] = [];
  const text = line.text;
  let i = 0;
  for (const match of matches) {
    // `start < i` is defensive: an overlapping match never re-renders text already emitted.
    if (match.end <= i) continue;
    const start = Math.max(match.start, i);
    if (start > i) pieces.push({ kind: "plain", start: i, end: start });
    pieces.push({ kind: "match", start, end: match.end, match });
    i = match.end;
  }
  if (i < text.length) pieces.push({ kind: "plain", start: i, end: text.length });
  return pieces;
}

/**
 * The row's gutter: its time, with the full date on hover, and the accent rail that slides in
 * while the row is hovered or its menu is open. CSS draws the time from `data-time`, so it is
 * never selected, copied or looked up with the line's text.
 */
export function LineGutter({ ts }: { ts: number }) {
  return (
    <>
      <span className="line-rail" aria-hidden />
      {ts ? (
        <Tooltip content={lineDate(ts)} delayDuration={300}>
          <time
            className="line-time"
            dateTime={new Date(ts).toISOString()}
            data-time={lineTime(ts)}
          />
        </Tooltip>
      ) : null}
    </>
  );
}

/**
 * A line's text in a box that grows with it, in the transcript's own type: editing a line or a
 * note (LineEditor), or writing a new note (AddNote). Enter (not while an input method is
 * composing) or clicking away saves; Shift+Enter starts a new line; Escape keeps things as they
 * were. Switching to another window leaves the box open. The row has no `data-yomitan-scan`, so
 * lookups leave the box alone.
 */
export function LineEditorBox({
  lineId,
  ts,
  initial,
  caret,
  note = false,
  label,
  hint,
  onFinish,
}: {
  lineId?: Line["id"];
  ts: number;
  initial: string;
  caret: number | null;
  note?: boolean;
  label: string;
  hint?: (value: string) => string | null;
  onFinish: (save: boolean, value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);

  const fit = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    fit();
    const at = caret ?? el.value.length;
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
    el.scrollIntoView({ block: "nearest" });
  }, [caret]);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onFinish(save, value);
  };

  const shown = hint?.(value);
  return (
    <div
      className={`line line-editing${note ? " line-editing-note" : ""}`}
      data-line-id={lineId}
    >
      <LineGutter ts={ts} />
      <textarea
        ref={box}
        className="line-editor"
        value={value}
        rows={1}
        spellCheck={false}
        aria-label={label}
        placeholder={note ? "Write a note…" : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          fit();
        }}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            finish(true);
          }
        }}
        onBlur={() => {
          // The window lost focus (back to the game): keep editing.
          if (!document.hasFocus()) return;
          finish(true);
        }}
        // The box's own menu (paste, undo) rather than the line's.
        onContextMenu={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      {shown ? <span className="line-editor-hint" lang="en">{shown}</span> : null}
    </div>
  );
}

const NOTE_HINT = "Markdown · Enter saves · Shift+Enter for a new line · Esc cancels";

/** The line or note being edited in place. */
function LineEditor({ line, caret }: { line: Line; caret: number | null }) {
  const note = isNote(line);
  return (
    <LineEditorBox
      lineId={line.id}
      ts={line.ts}
      initial={line.text}
      caret={caret}
      note={note}
      label={note ? "Edit note" : "Edit line"}
      hint={(value) =>
        note
          ? NOTE_HINT
          : line.originalText !== undefined && line.originalText !== value
            ? `Recorded as: ${line.originalText}`
            : null
      }
      onFinish={(save, value) => {
        stopEditing(line.id);
        if (save) void setLineText(line.id, value);
      }}
    />
  );
}

/** A new note at the end of the Log (`startNote`): saved as a line once it has any text. */
export function NoteDraft({ ts }: { ts: number }) {
  return (
    <LineEditorBox
      ts={ts}
      initial=""
      caret={null}
      note
      label="New note"
      hint={() => NOTE_HINT}
      onFinish={(save, value) => {
        endNote();
        if (save) void addNote(value);
      }}
    />
  );
}

/**
 * A note the person wrote: its Markdown rendered in a card that stands off the transcript. A long
 * one is cut short until opened (a click on it, or Show more), and closes again with Show less.
 * Links open in the browser, never in the Log.
 */
function NoteView({ line, translateEnabled }: Props) {
  const html = useMemo(() => markdownHtml(line.text), [line.text]);
  const body = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(0);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      setFull(el.scrollHeight);
      // Cut short (CSS caps a closed note's height): more of it than shows.
      if (!open) setTall(el.scrollHeight > el.clientHeight + 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [html, open]);

  const groupProps = { 'data-yomitan-scan': '' };
  return (
    <div
      className="line line-own-note"
      {...groupProps}
      data-line-id={line.id}
      data-line-text={line.text}
    >
      <LineGutter ts={line.ts} />
      <div className="note-card" data-tall={tall ? "" : undefined} data-open={open ? "" : undefined}>
        <div
          ref={body}
          className="note-body explain-markdown"
          style={tall && open ? { maxHeight: full } : undefined}
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            if (followNoteLink(e)) return;
            // A click (not the end of a selection) on a cut-short note opens it.
            if (tall && !open && window.getSelection()?.isCollapsed) setOpen(true);
          }}
        />
        {tall ? (
          <button
            type="button"
            className="note-toggle"
            lang="en"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            <ChevronDown aria-hidden />
            {open ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
      <LineActionsMenu line={line} translateEnabled={translateEnabled} />
    </div>
  );
}

function LineRowInner({ line, translateEnabled }: Props) {
  const editingCaret = useLineEditing(line.id);
  if (editingCaret !== undefined) return <LineEditor line={line} caret={editingCaret} />;
  if (isNote(line)) return <NoteView line={line} translateEnabled={translateEnabled} />;
  return <LineView line={line} translateEnabled={translateEnabled} />;
}

function LineView({ line, translateEnabled }: Props) {
  // Subscribe so this row re-renders when notebook content changes.
  const cacheVersion = useNotebookCacheVersion();
  // Transient translate status (loading / error) for this line.
  const translateStatus = useSyncExternalStore(subscribeTranslateStatus, () =>
    getTranslateStatus(line.id),
  );

  const matches: Match[] = useMemo(() => {
    const matcher = getMatcher(getNotebook());
    return matchLine(line, matcher);
    // Include cacheVersion so retroactive notebook edits invalidate this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.id, line.text, cacheVersion]);

  // Every row form below spreads these. `data-yomitan-scan` is the only thing that lets the main
  // window's Yomitan scanner read text (ui/panel-yomitan.js): transcript lines are looked up, the
  // rest of the window (settings, sidebar, notebook) is not.
  const groupProps = {
    'data-yomitan-scan': '',
    ...(line.ocr ? {
      'data-ocr-scan': line.ocr.scanId,
      'data-ocr-index': line.ocr.groupIndex,
      'data-ocr-count': line.ocr.groupCount
    } : {})
  };

  // Interim state while DeepL is in flight: the row itself signals progress
  // (the menu closes immediately and the T hotkey has no other UI).
  if (translateStatus?.state === "loading") {
    return (
      <div
        className="line"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.text}
      >
        <LineGutter ts={line.ts} />
        <span className="line-pending">{line.text}</span>
        <span className="line-note line-pending" role="status">
          translating…
        </span>
        <LineMedia line={line} />
      </div>
    );
  }

  // Transient inline failure note (auto-clears after a few seconds).
  const translateNote =
    translateStatus?.state === "error" ? (
      <span className="line-note line-note-danger" role="alert">
        translation failed: {translateStatus.message}
      </span>
    ) : null;

  // Translated mode: plain selectable English at the inherited font size — no
  // notebook chips. The menu offers Copy (English) / Show original.
  if (line.showTranslation && line.translation) {
    return (
      <div
        className="line line-translated"
        lang="en"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.translation}
      >
        <LineGutter ts={line.ts} />
        <span>{line.translation}</span>
        <LineMedia line={line} />
        <LineActionsMenu line={line} translateEnabled={translateEnabled} />
      </div>
    );
  }

  // Hot path: no notebook matches, so the line is its text.
  if (matches.length === 0) {
    return (
      <div
        className="line"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.text}
        data-edited={line.originalText !== undefined ? "" : undefined}
      >
        <LineGutter ts={line.ts} />
        <span>{line.text}</span>
        <LineMedia line={line} />
        {translateNote}
        <LineActionsMenu line={line} translateEnabled={translateEnabled} />
      </div>
    );
  }

  const pieces = buildRenderPieces(line, matches);

  return (
    <div
      className="line"
      {...groupProps}
      data-line-id={line.id}
      data-line-text={line.text}
      data-edited={line.originalText !== undefined ? "" : undefined}
    >
      <LineGutter ts={line.ts} />
      {pieces.map((piece, i) => {
        if (piece.kind === "match" && piece.match) {
          return (
            <NotebookMatchChip
              key={`m-${i}`}
              entryId={piece.match.entryId}
              text={line.text.slice(piece.start, piece.end)}
              sentence={line.text}
            />
          );
        }
        return (
          <span key={`p-${i}`}>{line.text.slice(piece.start, piece.end)}</span>
        );
      })}
      <LineMedia line={line} />
      {translateNote}
      <LineActionsMenu line={line} translateEnabled={translateEnabled} />
    </div>
  );
}

export const LineRow = memo(LineRowInner);
