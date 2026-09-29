import { useEffect } from "react";
import { snapshotLines } from "@texthooker/lib/store";
import { openExplain } from "@texthooker/lib/explain";
import { toggleTranslation } from "@texthooker/lib/translate";
import type { Line } from "@texthooker/lib/types";

/**
 * Single-key shortcuts that act on the line under the cursor (resolved via
 * CSS `:hover`, so no per-row mouse tracking is needed). No modifiers —
 * shift is scan mode.
 *
 *   t — toggle the line's translation (translate / back to original)
 *   e — open the Explain modal for the line
 */
const ACTIONS: Record<string, (line: Line) => void> = {
  t: toggleTranslation,
  e: openExplain,
};

export function useLineHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = ACTIONS[e.key.toLowerCase()];
      if (!action) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const hovered = document.querySelector<HTMLElement>(".line:hover");
      if (!hovered?.dataset.lineId) return;
      const id = Number(hovered.dataset.lineId);
      const line = snapshotLines().find((l) => l.id === id);
      if (!line) return;
      e.preventDefault();
      action(line);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
