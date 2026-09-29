/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { NotebookPen } from "lucide-react";

interface Props {
  /** Scrollable container holding the transcript lines. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Only offered when lines render as selectable text (token mode off). */
  enabled: boolean;
  onAdd: (text: string) => void;
}

interface Anchor {
  /** Viewport coordinates of the selection's top-center. */
  x: number;
  y: number;
  text: string;
}

const MAX_SELECTION_LEN = 80;

/** Floating "Add to notebook" pill that appears above a text selection inside
 *  the transcript, with a little arrow pointing at the selected text. */
export function SelectionAddButton({ containerRef, enabled, onAdd }: Props) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return;
    }

    let raf = 0;
    const recompute = () => {
      raf = 0;
      const sel = window.getSelection();
      const container = containerRef.current;
      if (
        !sel ||
        sel.isCollapsed ||
        sel.rangeCount === 0 ||
        !container ||
        !sel.anchorNode ||
        !sel.focusNode ||
        !container.contains(sel.anchorNode) ||
        !container.contains(sel.focusNode)
      ) {
        setAnchor(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length > MAX_SELECTION_LEN) {
        setAnchor(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setAnchor(null);
        return;
      }
      setAnchor({ x: rect.left + rect.width / 2, y: rect.top, text });
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(recompute);
    };

    document.addEventListener("selectionchange", schedule);
    const container = containerRef.current;
    container?.addEventListener("scroll", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      container?.removeEventListener("scroll", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, containerRef]);

  if (!anchor) return null;

  return (
    <button
      type="button"
      className="selection-add-btn"
      style={{ left: anchor.x, top: anchor.y }}
      // mousedown would collapse the selection before click fires.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const text = anchor.text;
        setAnchor(null);
        window.getSelection()?.removeAllRanges();
        onAdd(text);
      }}
    >
      <NotebookPen aria-hidden />
      Add to notebook
    </button>
  );
}
