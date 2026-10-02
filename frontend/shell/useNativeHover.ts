/**
 * PORT of the inactive-window hover and cursor bridge in `ui/panel.js` (the POC's, user-confirmed
 * working) into React.
 *
 * Every 50 ms it asks the native side for an occlusion-aware pointer position, resolves the element
 * under it and marks that element plus its ancestor chain with `data-native-hover` — the chain
 * matters because CSS `:hover` matches ancestors, so hovering a button's label must still light the
 * button. `hoverMirror` makes the existing `:hover` rules respond to that attribute.
 *
 * It also mirrors the element's computed `cursor` to AppKit. It never focuses or raises the window
 * and never dispatches synthetic mouse events.
 */
import { useEffect } from "react";
import { MIRROR_ATTRIBUTE, installHoverMirror } from "./hoverMirror";
import { panelCursor, panelPointer } from "../bridge/tauri";
import { isPointOverText, resolveNativeCursor } from "./nativeCursor";

const POLL_MS = 50;

export function useNativeHover(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const uninstallMirror = installHoverMirror();

    let hovered: Element[] = [];
    let pending = false;
    let stopped = false;

    const clear = (): void => {
      for (const element of hovered) element.removeAttribute(MIRROR_ATTRIBUTE);
      hovered = [];
    };

    const apply = (target: Element | null): void => {
      const chain: Element[] = [];
      for (let node: Element | null = target; node; node = node.parentElement)
        chain.push(node);
      if (
        chain.length === hovered.length &&
        chain.every((node, i) => node === hovered[i])
      )
        return;
      clear();
      for (const element of chain) element.setAttribute(MIRROR_ATTRIBUTE, "");
      hovered = chain;
    };

    const tick = async (): Promise<void> => {
      if (pending || stopped) return;
      pending = true;
      try {
        const point = await panelPointer();
        if (stopped) return;
        const target = point
          ? document.elementFromPoint(point[0], point[1])
          : null;
        apply(target);
        if (target) {
          const control = target.closest(
            'button, [role="button"], input, select, textarea, a',
          );
          const disabled =
            control instanceof HTMLElement && control.hasAttribute("disabled");
          // `auto` means an I-beam only over actual selectable text, which is WebKit's own rule:
          // over a line's padding, the empty space beside it or any unselectable chrome WebKit
          // shows the arrow, and so must the bridge, or the two alternate every tick. Nested
          // controls may also compute to `auto`; they keep the arrow.
          const style = getComputedStyle(target);
          const selectable =
            (style.webkitUserSelect || style.userSelect) !== "none";
          const transcriptText =
            control === null &&
            point !== null &&
            selectable &&
            isPointOverText(point[0], point[1]);
          // Sent every tick, as ui/panel.js does: the native side re-checks pointer ownership, so
          // an unchanged keyword still has to be reasserted after focus or edge changes.
          await panelCursor(
            resolveNativeCursor(
              style.cursor,
              disabled,
              transcriptText,
            ),
          );
        }
      } catch {
        // The native pointer is unavailable (no backend yet, or the window is gone): drop the
        // highlight rather than leaving a stale one behind.
        clear();
      } finally {
        pending = false;
      }
    };

    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      clear();
      uninstallMirror();
    };
  }, [enabled]);
}
