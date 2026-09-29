/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil } from "lucide-react";
import { getSettings } from "@texthooker/lib/settings";
import {
  readImageAsObjectURL,
  serializeEntryForPopover,
} from "@texthooker/lib/notebook";
import { openEditModal } from "@texthooker/lib/editModal";
import { useNotebookEntry } from "@texthooker/hooks/useNotebookEntry";

interface Props {
  entryId: string;
  /** The matched substring as it appears in the line. */
  text: string;
  /** Full line text for the popover sentence context. */
  sentence: string;
}

const KIND_GLYPH = { person: "人", place: "地", thing: "物" } as const;

export function NotebookMatchChip({ entryId, text, sentence }: Props) {
  const entry = useNotebookEntry(entryId);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Build a fresh object URL for the first image whenever it changes.
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    const first = entry?.images[0];
    if (!first) {
      setAvatarUrl(null);
      return;
    }
    void readImageAsObjectURL(first).then((u) => {
      if (revoked) {
        URL.revokeObjectURL(u);
        return;
      }
      url = u;
      setAvatarUrl(u);
    });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.images[0]?.id]);

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!entry) return;
    const settings = getSettings();
    try {
      const serialized = await serializeEntryForPopover(entry);
      await invoke("show_popover", {
        kind: "notebook",
        term: text,
        cursorX: e.screenX,
        cursorY: e.screenY,
        width: settings.popoverWidth,
        height: settings.popoverHeight,
        baseUrl: settings.yomitanApiUrl,
        focus: true,
        sentence,
        notebookEntry: serialized,
      });
    } catch (err) {
      console.warn("show_popover (notebook) failed", err);
    }
  };

  const glyph = entry ? KIND_GLYPH[entry.kind] : "?";

  return (
    <span className="notebook-chip-wrap">
      <button
        type="button"
        translate="no"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleClick}
        className="notebook-chip"
        title={entry ? `Notebook: ${entry.kind}` : "Notebook"}
      >
        {avatarUrl ? (
          <img
            className="notebook-chip-avatar"
            src={avatarUrl}
            alt=""
            draggable={false}
          />
        ) : (
          <span className="notebook-chip-glyph" aria-hidden>
            <span>{glyph}</span>
          </span>
        )}
        <span className="notebook-chip-name">{text}</span>
      </button>
      {entry ? (
        <button
          type="button"
          className="notebook-chip-edit"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openEditModal(entry.id);
          }}
          title="Edit notebook entry"
        >
          <Pencil aria-hidden />
          Edit
        </button>
      ) : null}
    </span>
  );
}
