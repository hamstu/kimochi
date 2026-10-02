/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "@texthooker/lib/settings";
import {
  readImageAsObjectURL,
  serializeEntryForPopover,
} from "@texthooker/lib/notebook";
import { notebookCardSize } from "@texthooker/lib/notebookCardSize";
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
      // A fixed size like the dictionary pop-up's, whatever the Log's text size.
      const serialized = await serializeEntryForPopover(entry);
      const size = notebookCardSize(serialized);
      await invoke("show_popover", {
        kind: "notebook",
        term: text,
        cursorX: e.screenX,
        cursorY: e.screenY,
        // A fixed card width and the content's own height (measured here, before the window
        // opens), so short entries get a compact popover.
        width: size.width,
        height: size.height,
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
        aria-label={entry ? `${text}: open notebook entry` : text}
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
    </span>
  );
}
