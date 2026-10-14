import { memo, useMemo, useSyncExternalStore } from "react";
import { TokenSpan } from "./TokenSpan";
import { NotebookMatchChip } from "./NotebookMatchChip";
import { LineActionsMenu } from "./LineActionsMenu";
import { getMatcher, matchLine, type Match } from "@texthooker/lib/nameMatch";
import { getNotebook } from "@texthooker/lib/notebook";
import { useNotebookCacheVersion } from "@texthooker/hooks/useNotebookCacheVersion";
import {
  getTranslateStatus,
  subscribeTranslateStatus,
} from "@texthooker/lib/translate";
import type { Line, Token } from "@texthooker/lib/types";

interface Props {
  line: Line;
  yomitanBaseUrl: string;
  showFurigana: boolean;
  disableClickToDefine: boolean;
  translateEnabled: boolean;
}

interface RenderPiece {
  kind: "match" | "token" | "plain";
  start: number;
  end: number;
  match?: Match;
  token?: Token;
}

/**
 * Walk the line and emit pieces, letting notebook matches override tokens.
 *
 * Both `matches` and the token stream advance monotonically by absolute offset.
 * A token is only emitted as a clickable `token` piece when the emitted segment
 * covers the *whole* token (`[i, nextStop] === [tok.start, tok.end]`). When a
 * notebook match consumes part of a token — common, because the tokenizer often
 * merges a name with a trailing particle (e.g. アキラ + と → アキラと) — the
 * leftover fragment is emitted as `plain` text, sliced to `[i, nextStop]`,
 * rather than re-emitting the full token. Re-emitting was the old bug: it
 * duplicated the already-matched prefix and clobbered later matches, so the
 * second occurrence of a name appeared broken.
 */
function buildRenderPieces(line: Line, matches: Match[]): RenderPiece[] {
  const pieces: RenderPiece[] = [];
  const text = line.text;
  const tokens = line.tokens ?? null;

  // Compute token offset map (UTF-16 code units in line.text).
  const tokenOffsets: Array<{ token: Token; start: number; end: number }> = [];
  if (tokens) {
    let off = 0;
    for (const t of tokens) {
      tokenOffsets.push({ token: t, start: off, end: off + t.text.length });
      off += t.text.length;
    }
  }

  let i = 0;
  let tokenIdx = 0;
  let matchIdx = 0;

  while (i < text.length) {
    // Drop matches/tokens that end at or before the cursor.
    while (matchIdx < matches.length && matches[matchIdx].end <= i) matchIdx++;
    while (tokenIdx < tokenOffsets.length && tokenOffsets[tokenIdx].end <= i)
      tokenIdx++;

    const nextMatch = matches[matchIdx];

    // A match covers the cursor → emit the whole match. `start <= i` rather than
    // `=== i` is defensive: if a match somehow started before the cursor we still
    // consume from i forward and never re-render its prefix.
    if (nextMatch && nextMatch.start <= i) {
      pieces.push({
        kind: "match",
        start: i,
        end: nextMatch.end,
        match: nextMatch,
      });
      i = nextMatch.end;
      matchIdx++;
      continue;
    }

    const tok = tokenIdx < tokenOffsets.length ? tokenOffsets[tokenIdx] : null;

    // The next offset we must stop at. Only boundaries strictly ahead of i count.
    const stops: number[] = [text.length];
    if (nextMatch) stops.push(nextMatch.start);
    if (tok) stops.push(tok.start > i ? tok.start : tok.end);
    const nextStop = Math.min(...stops.filter((s) => s > i));

    if (tok && tok.start <= i && i < tok.end) {
      // Inside a token. Emit it clamped to [i, nextStop]. Only treat it as a
      // real clickable token when the segment is the entire token; otherwise a
      // match has split it and we emit the fragment as plain text.
      const segEnd = Math.min(tok.end, nextStop);
      const isWhole = i === tok.start && segEnd === tok.end;
      pieces.push(
        isWhole
          ? { kind: "token", start: i, end: segEnd, token: tok.token }
          : { kind: "plain", start: i, end: segEnd },
      );
      i = segEnd;
      if (i >= tok.end) tokenIdx++;
    } else {
      // No token covers i; emit plain text up to the next stop.
      pieces.push({ kind: "plain", start: i, end: nextStop });
      i = nextStop;
    }
  }

  return pieces;
}

function LineRowInner({
  line,
  yomitanBaseUrl,
  showFurigana,
  disableClickToDefine,
  translateEnabled,
}: Props) {
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
  }, [line.id, line.text, line.tokens, cacheVersion]);

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
  // tokens, no notebook chips. The menu offers Copy (English) / Show original.
  if (line.showTranslation && line.translation) {
    return (
      <div
        className="line line-translated"
        lang="en"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.translation}
      >
        <span>{line.translation}</span>
        <LineActionsMenu line={line} translateEnabled={translateEnabled} />
      </div>
    );
  }

  // Hot path: if no matches AND no tokens, render plain text (existing behavior).
  if (matches.length === 0 && (!line.tokens || line.tokens.length === 0)) {
    return (
      <div
        className="line"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.text}
      >
        <span>{line.text}</span>
        {translateNote}
        <LineActionsMenu line={line} translateEnabled={translateEnabled} />
      </div>
    );
  }

  // Hot path: no matches, tokens exist → reuse the original token render.
  if (matches.length === 0 && line.tokens && line.tokens.length > 0) {
    return (
      <div
        className="line"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.text}
      >
        {line.tokens.map((tok, i) => (
          <TokenSpan
            key={i}
            token={tok}
            yomitanBaseUrl={yomitanBaseUrl}
            showFurigana={showFurigana}
            sentence={line.text}
            disableClickToDefine={disableClickToDefine}
          />
        ))}
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
        if (piece.kind === "token" && piece.token) {
          return (
            <TokenSpan
              key={`t-${i}`}
              token={piece.token}
              yomitanBaseUrl={yomitanBaseUrl}
              showFurigana={showFurigana}
              sentence={line.text}
              disableClickToDefine={disableClickToDefine}
            />
          );
        }
        return (
          <span key={`p-${i}`}>{line.text.slice(piece.start, piece.end)}</span>
        );
      })}
      {translateNote}
      <LineActionsMenu line={line} translateEnabled={translateEnabled} />
    </div>
  );
}

export const LineRow = memo(LineRowInner);
