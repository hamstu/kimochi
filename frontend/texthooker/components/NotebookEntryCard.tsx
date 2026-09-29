import { useState } from "react";
import { AArrowDown, AArrowUp, Pencil } from "lucide-react";
import type { SerializedNotebookEntry } from "@texthooker/lib/types";

interface Props {
  entry: SerializedNotebookEntry;
  /** When provided, renders an Edit button that hands off to the main window. */
  onEdit?: (entryId: string) => void;
}

const KIND_LABEL: Record<SerializedNotebookEntry["kind"], string> = {
  person: "Person",
  place: "Place",
  thing: "Thing",
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
        {entry.imageDataUrl ? (
          <img
            className="notebook-card-image"
            src={entry.imageDataUrl}
            alt=""
            draggable={false}
          />
        ) : (
          <div className="notebook-card-image notebook-card-image-fallback">
            {entry.kind === "person"
              ? "人"
              : entry.kind === "place"
                ? "地"
                : "物"}
          </div>
        )}
        <div className="notebook-card-heading">
          <div className="notebook-card-name" translate="no" lang="ja">
            {entry.displayName}
          </div>
          {entry.reading ? (
            <div className="notebook-card-reading" translate="no" lang="ja">
              {entry.reading}
            </div>
          ) : null}
          <div className="notebook-card-kind">{KIND_LABEL[entry.kind]}</div>
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
