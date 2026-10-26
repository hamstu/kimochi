import { memo, useMemo, useSyncExternalStore } from "react";
import { Square, Volume2 } from "lucide-react";
import { IconButton, Tooltip } from "@kit";
import { NotebookMatchChip } from "./NotebookMatchChip";
import { LineActionsMenu } from "./LineActionsMenu";
import { getMatcher, matchLine, type Match } from "@texthooker/lib/nameMatch";
import { getNotebook } from "@texthooker/lib/notebook";
import { useNotebookCacheVersion } from "@texthooker/hooks/useNotebookCacheVersion";
import {
  getTranslateStatus,
  subscribeTranslateStatus,
} from "@texthooker/lib/translate";
import type { Line } from "@texthooker/lib/types";
import { lineDate, lineTime } from "@texthooker/lib/logDays";
import {
  toggleLineAudio,
  useLineAudio,
  useLinePlaying,
} from "@texthooker/lib/sentenceAudio";

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
function LineGutter({ ts }: { ts: number }) {
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
 * Sentence audio's word on the line (src-tauri/src/sentence_audio): a speaker that plays the clip
 * of its voice, recorded from the game, or a quiet "no voice" when none was heard. Nothing while
 * the line is still being listened to, or when sentence audio is off.
 */
function LineVoice({ uid }: { uid: string | undefined }) {
  const audio = useLineAudio(uid);
  const playing = useLinePlaying(uid);
  if (!uid || !audio) return null;
  if (audio.state === "silent") {
    return (
      <Tooltip content="No voice was detected for this line" delayDuration={300}>
        <span className="line-note line-voice-none">no voice</span>
      </Tooltip>
    );
  }
  if (audio.state !== "voiced") return null;
  const seconds = ((audio.durationMs ?? 0) / 1000).toFixed(1);
  return (
    <IconButton
      label={playing ? "Stop" : `Play the line's voice (${seconds} s)`}
      size="sm"
      className="line-voice"
      data-playing={playing || undefined}
      // Keep the row's selection / scan handling out of the button.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void toggleLineAudio(uid);
      }}
    >
      {playing ? <Square /> : <Volume2 />}
    </IconButton>
  );
}

function LineRowInner({ line, translateEnabled }: Props) {
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
      'data-ocr-count': line.ocr.groupCount,
      'data-group-label': line.ocr.groupCount > 1 ? `${line.ocr.groupIndex + 1} / ${line.ocr.groupCount}` : undefined
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
        <LineVoice uid={line.uid} />
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
      >
        <LineGutter ts={line.ts} />
        <span>{line.text}</span>
        <LineVoice uid={line.uid} />
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
      <LineVoice uid={line.uid} />
      {translateNote}
      <LineActionsMenu line={line} translateEnabled={translateEnabled} />
    </div>
  );
}

export const LineRow = memo(LineRowInner);
