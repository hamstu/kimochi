import { useState } from "react";
import type { ReactNode } from "react";
import { AArrowDown, AArrowUp, Box, MapPin, Pencil, UserRound } from "lucide-react";
import type { SerializedNotebookEntry } from "@texthooker/lib/types";

interface Props {
  entry: SerializedNotebookEntry;
  /** When provided, renders an Edit button that hands off to the main window. */
  onEdit?: (entryId: string) => void;
}

/* Same words and icons as the Notebook window (notebookEntry.tsx KIND_META); kept
   local so the popup does not pull in the notebook store bridge. */
const KIND_META: Record<
  SerializedNotebookEntry["kind"],
  { label: string; icon: ReactNode }
> = {
  person: { label: "Character", icon: <UserRound /> },
  place: { label: "Place", icon: <MapPin /> },
  thing: { label: "Thing", icon: <Box /> },
};

/* Card-wide font scale, persisted across launches. The card's CSS is em-based,
   so scaling the root font-size scales everything inside. */
const SCALE_KEY = "notebookCardFontScale";
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.6;
const SCALE_STEP = 0.1;
const BASE_FONT_PX = 13;

function loadScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    if (Number.isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX) return v;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return 1;
}

export function NotebookEntryCard({ entry, onEdit }: Props) {
  const [scale, setScale] = useState<number>(loadScale);

  const adjustScale = (delta: number) => {
    const next =
      Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale + delta)) * 10) /
      10;
    setScale(next);
    try {
      localStorage.setItem(SCALE_KEY, String(next));
    } catch {
      // best-effort
    }
  };

  return (
    <div
      className="notebook-card"
      style={{ fontSize: `${BASE_FONT_PX * scale}px` }}
    >
      <div className="notebook-card-header">
        {/* Avatar as in the Notebook window: a round image, a monogram in
            accent-soft (characters), or the kind icon (places, things). */}
        <span
          aria-hidden
          className="notebook-card-avatar"
          data-kind={entry.imageDataUrl ? undefined : entry.kind}
          lang="ja"
        >
          {entry.imageDataUrl ? (
            <img src={entry.imageDataUrl} alt="" draggable={false} />
          ) : entry.kind === "person" && entry.displayName.trim() ? (
            Array.from(entry.displayName.trim())[0]
          ) : (
            KIND_META[entry.kind].icon
          )}
        </span>
        <div className="notebook-card-heading">
          <div className="notebook-card-name" translate="no" lang="ja">
            {entry.displayName}
          </div>
          {entry.reading ? (
            <div className="notebook-card-reading" translate="no" lang="ja">
              {entry.reading}
            </div>
          ) : null}
          <div className="notebook-card-kind">{KIND_META[entry.kind].label}</div>
          {entry.aliases.length > 0 ? (
            <div className="notebook-card-aliases" translate="no" lang="ja">
              {entry.aliases.join(" · ")}
            </div>
          ) : null}
        </div>
        <div className="notebook-card-actions">
          <button
            type="button"
            className="notebook-card-scale-btn"
            onClick={() => adjustScale(-SCALE_STEP)}
            disabled={scale <= SCALE_MIN}
            title="Smaller text"
          >
            <AArrowDown size={13} />
          </button>
          <button
            type="button"
            className="notebook-card-scale-btn"
            onClick={() => adjustScale(SCALE_STEP)}
            disabled={scale >= SCALE_MAX}
            title="Larger text"
          >
            <AArrowUp size={13} />
          </button>
          {onEdit ? (
            <button
              type="button"
              className="notebook-card-edit"
              onClick={() => onEdit(entry.id)}
              title="Edit in notebook"
            >
              <Pencil size={12} />
              Edit
            </button>
          ) : null}
        </div>
      </div>
      {entry.description ? (
        <div className="notebook-card-description">{entry.description}</div>
      ) : (
        <div className="notebook-card-description notebook-card-description-empty">
          No description.
        </div>
      )}
      {entry.notes.length > 0 ? (
        <ul className="notebook-card-notes">
          {entry.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
