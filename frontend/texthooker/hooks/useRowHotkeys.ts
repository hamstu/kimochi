import { useEffect, useRef } from "react";

/**
 * Single-letter shortcuts for the row under the pointer, the same letters its ⋯ menu shows
 * (`MenuItem`'s `shortcut`). The row is found by `selector` with CSS `:hover` (or the native
 * hover macOS reports while the window isn't key, `data-native-hover`), so no per-row mouse
 * tracking is needed. No modifiers (Shift is scan mode), not while typing, and not while a menu
 * or dialog is open (a menu takes its own letters).
 *
 * `actions` maps a letter to what it does with the row's element; it may change every render.
 */
export function useRowHotkeys(
  selector: string,
  actions: Record<string, ((row: HTMLElement) => void) | undefined>,
): void {
  const current = useRef(actions);
  useEffect(() => {
    current.current = actions;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
      const action = current.current[e.key.toLowerCase()];
      if (!action) return;
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
      if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      const row =
        document.querySelector<HTMLElement>(`${selector}:hover`) ??
        document.querySelector<HTMLElement>(`${selector}[data-native-hover], ${selector}:has([data-native-hover])`);
      if (!row) return;
      e.preventDefault();
      action(row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selector]);
}
