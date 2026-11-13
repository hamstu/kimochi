/* eslint react-hooks/set-state-in-effect: "off" -- The names' chips go into the HTML this effect sets, which only exists once it has. */
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { markdownHtml } from "@texthooker/lib/html";
import { getMatcher, slotNames, type NameSlot } from "@texthooker/lib/nameMatch";
import { getNotebook } from "@texthooker/lib/notebook";
import { followNoteLink } from "@texthooker/lib/noteNav";
import { useNotebookCacheVersion } from "@texthooker/hooks/useNotebookCacheVersion";
import { NotebookMatchChip } from "./NotebookMatchChip";

/**
 * A note's Markdown, rendered (sanitised), with the notebook's names linked as in any line: their
 * chips render into slots in the HTML, which this sets itself (not React) so the slots stay. Again
 * whenever the text or the notebook changes. Links open in the browser, never in the window. Used
 * by the note's card in the Log and the Notebook's note pane.
 */
export const NoteMarkdown = forwardRef<
  HTMLDivElement,
  {
    text: string;
    /** The sentence a chip's pop-up shows for context: the note. */
    sentence: string;
    className?: string;
    style?: CSSProperties;
    lang?: string;
    onClick?: (event: MouseEvent<HTMLDivElement>) => void;
    onDoubleClick?: (event: MouseEvent<HTMLDivElement>) => void;
  }
>(function NoteMarkdown({ text, sentence, onClick, ...props }, ref) {
  const html = useMemo(() => markdownHtml(text), [text]);
  const body = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => body.current as HTMLDivElement, []);
  const cacheVersion = useNotebookCacheVersion();
  const [names, setNames] = useState<NameSlot[]>([]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = html;
    setNames(slotNames(el, getMatcher(getNotebook())));
  }, [html, cacheVersion]);
  return (
    <>
      <div
        ref={body}
        {...props}
        onClick={(event) => {
          if (followNoteLink(event)) return;
          onClick?.(event);
        }}
      />
      {names.map((name, i) =>
        createPortal(
          <NotebookMatchChip entryId={name.entryId} text={name.text} sentence={sentence} />,
          name.slot,
          `${i}:${name.entryId}`,
        ),
      )}
    </>
  );
});
