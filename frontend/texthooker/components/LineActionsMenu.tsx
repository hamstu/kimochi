import { AudioPlayer } from "../../components/AudioPlayer";
import { useCapabilities } from "../../bridge/capabilities";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  BookPlus,
  Copy,
  Languages,
  MoreHorizontal,
  Sparkles,
  TextSelect,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@kit";
import { writeTextSelf } from "@texthooker/lib/clipboardWrite";
import { deleteLine } from "@texthooker/lib/store";
import { openExplain } from "@texthooker/lib/explain";
import { getSettings } from "@texthooker/lib/settings";
import { showOriginal, showTranslation } from "@texthooker/lib/translate";
import type { Line } from "@texthooker/lib/types";

const copy = async (text: string) => {
  try {
    await writeTextSelf(text);
  } catch (err) {
    console.warn("copy failed", err);
  }
};

/**
 * What can be done with a line: the ⋯ menu at its end and a right-click anywhere on it list the
 * same items. Copy copies what the row shows, English when translated; `selection` adds a Copy
 * for the text selected when the menu was opened.
 */
function LineMenuItems({
  line,
  translateEnabled,
  selection,
  onAddToNotebook,
}: {
  line: Line;
  translateEnabled: boolean;
  selection?: string;
  onAddToNotebook?: (text: string) => void;
}) {
  const audioSlot = useRef<HTMLSpanElement>(null);
  // Read aloud runs on Kimochi cloud, which needs a signed-in Kimochi account.
  const { cloudAccess } = useCapabilities();
  const isTranslated = Boolean(line.showTranslation && line.translation);
  const displayText = isTranslated ? line.translation! : line.text;

  return (
    <>
      {/* Read aloud: the row activates the shared AudioPlayer button, which keeps its own
          playing state and error tooltip. The menu stays open while it plays. Only when signed in
          to a Kimochi account (Kimochi cloud access). */}
      {cloudAccess && (
        <MenuItem
          icon={
            <span
              ref={audioSlot}
              className="log-audio-slot"
              // A direct click on the speaker plays it; don't also select the row.
              onClick={(e) => e.stopPropagation()}
            >
              <AudioPlayer text={line.text} />
            </span>
          }
          onSelect={(e) => {
            e.preventDefault();
            audioSlot.current?.querySelector("button")?.click();
          }}
        >
          Read aloud
        </MenuItem>
      )}
      {selection ? (
        <MenuItem icon={<TextSelect />} onSelect={() => void copy(selection)}>
          Copy selection
        </MenuItem>
      ) : null}
      {selection && onAddToNotebook ? (
        <MenuItem
          icon={<BookPlus />}
          onSelect={() => onAddToNotebook(selection)}
        >
          Add to notebook…
        </MenuItem>
      ) : null}
      <MenuItem icon={<Copy />} onSelect={() => void copy(displayText)}>
        Copy {selection ? "line" : "text"}
      </MenuItem>
      {isTranslated ? (
        <MenuItem icon={<Undo2 />} onSelect={() => showOriginal(line.id)}>
          Show original
        </MenuItem>
      ) : translateEnabled ? (
        // Fire and forget: the row shows the interim "translating…" state (and any failure
        // note), matching the T hotkey.
        <MenuItem
          icon={<Languages />}
          onSelect={() => void showTranslation(line)}
        >
          Translate
        </MenuItem>
      ) : null}
      {/* Explanations from Kimochi cloud need Kimochi Cloud; the CLI providers always work. */}
      {(cloudAccess || getSettings().explainProvider !== "kimochi") && (
        <MenuItem icon={<Sparkles />} onSelect={() => openExplain(line)}>
          Explain
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 />}
        tone="danger"
        onSelect={() => deleteLine(line.id)}
      >
        Delete line
      </MenuItem>
    </>
  );
}

/** The ⋯ button at the end of a line, shown on hover. */
export function LineActionsMenu({
  line,
  translateEnabled,
}: {
  line: Line;
  translateEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="line-actions">
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <IconButton
            label="Line actions"
            size="sm"
            className="line-actions-trigger"
            // Keep the row's selection / scan handling out of trigger clicks.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" className="log-line-menu">
          <LineMenuItems line={line} translateEnabled={translateEnabled} />
        </MenuContent>
      </Menu>
    </span>
  );
}

/**
 * A right-click on any line opens its menu in place of the system's. One menu serves the whole
 * transcript: the line is found from the row clicked. Selected text still copies with ⌘C / Ctrl+C,
 * and the menu offers it too. A right-click between lines does nothing.
 */
export function LineContextMenu({
  lines,
  translateEnabled,
  onAddToNotebook,
  children,
}: {
  lines: readonly Line[];
  translateEnabled: boolean;
  /** Offered for selected text, as the selection's own button does. */
  onAddToNotebook: (text: string) => void;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<{
    id: Line["id"];
    selection: string;
  } | null>(null);
  // The row the menu is for, lit as a hovered row is while its menu is open.
  const row = useRef<HTMLElement | null>(null);
  const line = target ? lines.find((l) => l.id === target.id) : undefined;

  const onContextMenu = (event: MouseEvent) => {
    const rowElement = (event.target as Element).closest<HTMLElement>(
      "[data-line-id]",
    );
    const id = rowElement?.dataset.lineId;
    const found = id ? lines.find((l) => String(l.id) === id) : undefined;
    if (!found) {
      // Nothing to act on: no menu at all, the system's included.
      event.preventDefault();
      return;
    }
    const selected = window.getSelection();
    const text =
      selected &&
      !selected.isCollapsed &&
      rowElement?.closest(".log-lines")?.contains(selected.anchorNode)
        ? selected.toString().trim()
        : "";
    row.current?.removeAttribute("data-menu-open");
    row.current = rowElement;
    rowElement?.setAttribute("data-menu-open", "");
    setTarget({ id: found.id, selection: text });
  };

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) return;
        row.current?.removeAttribute("data-menu-open");
        row.current = null;
        setTarget(null);
      }}
    >
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <MenuContent className="log-line-menu">
        {line ? (
          <LineMenuItems
            line={line}
            translateEnabled={translateEnabled}
            selection={target?.selection}
            onAddToNotebook={onAddToNotebook}
          />
        ) : null}
      </MenuContent>
    </ContextMenu>
  );
}
