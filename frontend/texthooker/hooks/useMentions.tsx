/* eslint react-hooks/set-state-in-effect: "off" -- The menu is placed from the caret, which only the laid-out text area can say. */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { isComposing, portalRoot } from "@kit";
import { caretPoint } from "@texthooker/lib/caretPoint";
import { applyMention, mentionAt, rankMentions, type MentionOption } from "@texthooker/lib/mentions";
import { getNotebook, subscribeNotebook } from "@texthooker/lib/notebook";
import { EntryAvatar } from "../components/notebookParts";
import { KIND_META, entryReading, entryTitle } from "../components/notebookEntry";
// The entries' avatars (.nb-avatar), which the Notebook's own view may not have loaded yet.
import "../notebook.css";

const subscribe = (fn: () => void) => subscribeNotebook(() => fn());

/** The menu's width and an option's height, for placing it before it has laid out. */
const MENU_WIDTH = 288;
const OPTION_HEIGHT = 40;

export interface Mentions {
  /** For the text area's `onKeyDown`, first: true when the menu took the key. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** For the text area's caret moving (input, clicks, arrow keys, selection). */
  sync: () => void;
  /** The menu, while it shows (portalled; render it anywhere). */
  menu: ReactNode;
  /** The text area's combobox attributes. */
  inputProps: {
    "aria-autocomplete": "list";
    "aria-expanded": boolean;
    "aria-controls"?: string;
    "aria-activedescendant"?: string;
  };
}

/**
 * @-mentions for a note's text area: typing "@" (or "＠") opens the notebook's entries at the caret,
 * narrowed as you type. ↑ ↓ choose, Enter or Tab writes the name in place of the "@…", Escape
 * closes the menu (and leaves the editor open); a click chooses too. `apply` sets the new text and
 * caret. Entries come from this session's notebook (`rankMentions`).
 */
export function useMentions({
  box,
  value,
  apply,
}: {
  box: RefObject<HTMLTextAreaElement | null>;
  value: string;
  apply: (text: string, caret: number) => void;
}): Mentions {
  const notebook = useSyncExternalStore(subscribe, getNotebook);
  const [caret, setCaret] = useState<number | null>(null);
  // The "@" whose menu Escape closed: it stays closed until another one is typed.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [selected, setSelected] = useState({ key: "", index: 0 });
  const id = useId();

  const mention = caret === null ? null : mentionAt(value, caret);
  const key = mention ? `${mention.start}:${mention.query}` : "";
  const query = mention?.query ?? null;
  // A few hundred entries at most, ranked per keystroke: cheap enough not to memoise.
  const options = query === null ? [] : rankMentions(notebook.entries, query);
  const open = mention !== null && mention.start !== dismissed && options.length > 0;
  const index = selected.key === key ? Math.min(selected.index, options.length - 1) : 0;

  const sync = () => {
    const el = box.current;
    if (!el) return;
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  const choose = (option: MentionOption) => {
    if (!mention) return;
    const next = applyMention(value, mention, option.insert);
    apply(next.text, next.caret);
    setCaret(next.caret);
  };

  // Placed under the caret's line (over it when there's no room below), and kept there as the Log
  // scrolls or the window resizes.
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const at = mention?.start ?? null;
  useLayoutEffect(() => {
    const el = box.current;
    if (!open || at === null || !el) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const point = caretPoint(el, at);
      const height = options.length * OPTION_HEIGHT + 8;
      const left = Math.max(8, Math.min(point.left - 10, window.innerWidth - MENU_WIDTH - 8));
      const below = point.top + point.height + 4;
      setPlace(
        below + height > window.innerHeight - 8 && point.top - height > 8
          ? { left, bottom: window.innerHeight - point.top + 4 }
          : { left, top: below },
      );
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, at, options.length, box]);

  // A new "@" may open again.
  useEffect(() => {
    if (dismissed !== null && mention?.start !== dismissed) setDismissed(null);
  }, [dismissed, mention?.start]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || isComposing(event)) return false;
    const move = (to: number) => {
      event.preventDefault();
      setSelected({ key, index: (to + options.length) % options.length });
      return true;
    };
    if (event.key === "ArrowDown") return move(index + 1);
    if (event.key === "ArrowUp") return move(index - 1);
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      choose(options[index]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(mention.start);
      return true;
    }
    return false;
  };

  const menu =
    open && place
      ? createPortal(
          <div
            id={id}
            className="mention-menu"
            role="listbox"
            aria-label="Mention from the notebook"
            style={{ left: place.left, top: place.top, bottom: place.bottom, width: MENU_WIDTH }}
            // Choosing keeps the text area's focus (and its edit open).
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((option, i) => {
              const title = entryTitle(option.entry);
              // Under the name: the entry it belongs to when an alias is written, else its reading.
              const plain = (text: string) => text.replace(/[\s\u3000]/g, "");
              const sub =
                plain(option.insert) !== plain(title) ? title : entryReading(option.entry);
              return (
                <div
                  key={option.entry.id}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === index}
                  className="mention-option"
                  onPointerMove={() => i !== index && setSelected({ key, index: i })}
                  onClick={() => choose(option)}
                >
                  <EntryAvatar entry={option.entry} />
                  <span className="mention-text">
                    <span className="mention-name" lang="ja">
                      {option.insert}
                    </span>
                    {sub ? (
                      <span className="mention-sub" lang="ja">
                        {sub}
                      </span>
                    ) : null}
                  </span>
                  <span className="mention-kind">{KIND_META[option.entry.kind].one}</span>
                </div>
              );
            })}
          </div>,
          portalRoot() ?? document.body,
        )
      : null;

  return {
    onKeyDown,
    sync,
    menu,
    inputProps: {
      "aria-autocomplete": "list",
      "aria-expanded": open,
      "aria-controls": open ? id : undefined,
      "aria-activedescendant": open ? `${id}-${index}` : undefined,
    },
  };
}
