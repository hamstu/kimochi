/**
 * PORT of the inactive-window hover and cursor bridge in `ui/panel.js` (the POC's, user-confirmed
 * working) into React.
 *
 * Every 50 ms it asks the native side for an occlusion-aware pointer position, resolves the element
 * under it and marks that element plus its ancestor chain with `data-native-hover` — the chain
 * matters because CSS `:hover` matches ancestors, so hovering a button's label must still light the
 * button. `hoverMirror` makes the existing `:hover` rules respond to that attribute.
 *
 * It also mirrors the element's computed `cursor` to AppKit, but only while the webview itself is
 * not tracking the pointer (see `CursorOwnership`): when it is, the webview sets the cursor and a
 * second writer makes it flicker. It never focuses or raises the window and never dispatches
 * synthetic mouse events.
 */
import { useEffect } from "react";
import { MIRROR_ATTRIBUTE, installHoverMirror } from "./hoverMirror";
import { panelCursor, panelPointer } from "../bridge/tauri";
import {
  CursorOwnership,
  nativeCursorAt,
  probeFrameCursor,
} from "./nativeCursor";

const POLL_MS = 50;

export function useNativeHover(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const uninstallMirror = installHoverMirror();

    let hovered: Element[] = [];
    let pending = false;
    let stopped = false;
    const ownership = new CursorOwnership();
    const onRealMove = (event: MouseEvent): void => {
      if (event.isTrusted) ownership.realMove(performance.now());
    };
    window.addEventListener("mousemove", onRealMove, {
      capture: true,
      passive: true,
    });

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
        ownership.poll(point, performance.now());
        const target = point
          ? document.elementFromPoint(point[0], point[1])
          : null;
        apply(target);
        // While the webview gets real mouse events, or its window has the focus (the pointer may
        // be over an iframe, whose events the parent never sees), it sets the cursor itself.
        // Inside a hosted iframe only the frame's own document knows the cursor, so it is asked.
        if (point && target && ownership.bridgeOwnsCursor() && !document.hasFocus()) {
          const kind =
            target instanceof HTMLIFrameElement
              ? await probeFrameCursor(target, point[0], point[1])
              : nativeCursorAt(document, point[0], point[1]);
          if (stopped) return;
          // Sent every tick while the bridge owns the cursor: the native side re-checks pointer
          // ownership, so an unchanged keyword still has to be reasserted after focus or edge
          // changes.
          await panelCursor(kind ?? "default");
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
      window.removeEventListener("mousemove", onRealMove, { capture: true });
      clear();
      uninstallMirror();
    };
  }, [enabled]);
}
