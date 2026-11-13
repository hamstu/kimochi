import { snapshotLines, deleteLine } from "@texthooker/lib/store";
import { openExplain } from "@texthooker/lib/explain";
import { editLine } from "@texthooker/lib/lineEdit";
import { getSettings } from "@texthooker/lib/settings";
import { toggleTranslation } from "@texthooker/lib/translate";
import { writeTextSelf } from "@texthooker/lib/clipboardWrite";
import { isNote, type Line } from "@texthooker/lib/types";
import { useCapabilities } from "../../bridge/capabilities";
import { getSetting, DEFAULT_VOICE_ID } from "../../bridge/settings";
import type { AudioSettings } from "../../bridge/types";
import { speak } from "../../bridge/tts";
import { useRowHotkeys } from "./useRowHotkeys";

/**
 * The line menu's letters (LineActionsMenu), for the line under the pointer:
 *
 *   r — read it aloud (with a Kimochi account)
 *   c — copy what the row shows (English when translated)
 *   t — translate it, or back to the original
 *   x — explain it
 *   e — edit its text
 *   d — delete it
 *
 * A note (Add a note) takes c, e and d. A, anywhere in the Log, starts a new note (`useAddNoteHotkey`).
 */
export function useLineHotkeys() {
  // Read aloud and Kimochi's explanations run on Kimochi cloud, as in the menu.
  const { cloudAccess } = useCapabilities();
  const onLine = (action: (line: Line) => void, notes = true) => (row: HTMLElement) => {
    const id = Number(row.dataset.lineId);
    const line = snapshotLines().find((l) => l.id === id);
    // A note is not read aloud, translated or explained (its menu has no such items).
    if (line && (notes || !isNote(line))) action(line);
  };
  useRowHotkeys(".line[data-line-id]", {
    r: cloudAccess
      ? onLine((line) => {
          void getSetting<AudioSettings>("audioSettings")
            .then((audio) => speak(line.text, audio?.voiceId || DEFAULT_VOICE_ID))
            .catch((err) => console.warn("read aloud failed", err));
        }, false)
      : undefined,
    c: onLine((line) => {
      const shown = line.showTranslation && line.translation ? line.translation : line.text;
      void writeTextSelf(shown).catch((err) => console.warn("copy failed", err));
    }),
    t: onLine(toggleTranslation, false),
    x:
      cloudAccess || getSettings().explainProvider !== "kimochi"
        ? onLine(openExplain, false)
        : undefined,
    e: onLine((line) => editLine(line.id)),
    d: onLine((line) => deleteLine(line.id)),
  });
}
