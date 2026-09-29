import { useEffect } from "react";
import {
  UI_BASE_FONT_PX,
  UI_SCALE_FACTORS,
  type UiScale,
} from "@texthooker/lib/types";

/**
 * Scales the whole UI by resizing the document root's font size, which is the
 * basis for every rem length — Tailwind's spacing, text, radius and size
 * scales are all rem, so one root change moves the entire interface together.
 *
 * Two things deliberately stay put:
 *  - Transcript text. `.jp-text` gets its size from an inline px value driven
 *    by `fontSizePx`, so it is immune to the root change by construction.
 *  - The popover window. It's a separate document that never runs this hook,
 *    and it has its own A+/A- sizing control.
 *
 * Radix renders dialogs, selects and popovers into a portal on `document.body`
 * rather than inside the app subtree, so scaling at the root (rather than at
 * `.app-root`) is what makes the settings and notebook panels scale too.
 */
export function useUiScale(pref: UiScale) {
  useEffect(() => {
    const factor = UI_SCALE_FACTORS[pref] ?? 1;
    const root = document.documentElement;
    root.style.fontSize = `${UI_BASE_FONT_PX * factor}px`;
    // Exposed for the rare rule that needs the raw factor in CSS.
    root.style.setProperty("--ui-scale", String(factor));
  }, [pref]);
}
