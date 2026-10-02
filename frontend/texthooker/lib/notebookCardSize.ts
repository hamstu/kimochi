/**
 * Sizing for the notebook entry popover. The Log measures the card off-screen at its width,
 * with the same stylesheet, before asking native code to open the popover, so the window opens
 * at the card's real height (clamped) instead of a fixed size with empty space under short
 * entries.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { NotebookEntryCard } from "@texthooker/components/NotebookEntryCard";
import type { SerializedNotebookEntry } from "@texthooker/lib/types";

/** The card's fixed width, and the bounds on its measured height. */
const CARD_WIDTH = 320;
const CARD_MIN_HEIGHT = 140;
const CARD_MAX_HEIGHT = 560;

/**
 * The popover size for an entry: a fixed width, and the card's natural height at that width
 * (clamped).
 */
export function notebookCardSize(entry: SerializedNotebookEntry): {
  width: number;
  height: number;
} {
  const width = CARD_WIDTH;
  const maxHeight = CARD_MAX_HEIGHT;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${width}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  // Inside the theme root, so the Radix colour and size variables resolve as in the popover.
  (document.querySelector(".radix-themes") ?? document.body).append(host);
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(createElement(NotebookEntryCard, { entry, onOpen: () => undefined }));
    });
    const natural = Math.ceil(host.getBoundingClientRect().height);
    return { width, height: Math.min(maxHeight, Math.max(CARD_MIN_HEIGHT, natural)) };
  } finally {
    root.unmount();
    host.remove();
  }
}
