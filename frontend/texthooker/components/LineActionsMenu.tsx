import { AudioPlayer } from "../../components/AudioPlayer";
import { useState } from "react";
import {
  Copy,
  Languages,
  MoreHorizontal,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@texthooker/components/ui/popover";
import { writeTextSelf } from "@texthooker/lib/clipboardWrite";
import { deleteLine } from "@texthooker/lib/store";
import { openExplain } from "@texthooker/lib/explain";
import { showOriginal, showTranslation } from "@texthooker/lib/translate";
import type { Line } from "@texthooker/lib/types";

interface Props {
  line: Line;
  /** Whatever the row currently renders — English when translated, otherwise
      the original Japanese. Copy always copies what the user sees. */
  displayText: string;
  isTranslated: boolean;
  translateEnabled: boolean;
}

export function LineActionsMenu({
  line,
  displayText,
  isTranslated,
  translateEnabled,
}: Props) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
  };

  const handleCopy = async () => {
    try {
      await writeTextSelf(displayText);
    } catch (err) {
      console.warn("copy failed", err);
    }
    setOpen(false);
  };

  const handleTranslate = () => {
    // Fire and forget: the row itself shows the interim "translating…" state
    // (and any failure note), matching the T hotkey behavior.
    void showTranslation(line);
    setOpen(false);
  };

  const handleShowOriginal = () => {
    showOriginal(line.id);
    setOpen(false);
  };

  const handleExplain = () => {
    openExplain(line);
    setOpen(false);
  };

  const handleDelete = () => {
    deleteLine(line.id);
    setOpen(false);
  };

  const itemClass =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-(--color-text) hover:bg-(--color-bg-elev-2)";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Line actions"
          // Suppress the parent .line hover dismiss when interacting.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={[
            "line-actions-trigger",
            "ml-1 inline-flex h-[1em] w-[1em] items-center justify-center align-baseline",
            "rounded text-(--color-text-muted) opacity-0 transition-opacity",
            "hover:bg-(--color-bg-elev-2) hover:text-(--color-text)",
            "focus-visible:outline-none focus-visible:opacity-100",
            open ? "opacity-100" : "",
          ].join(" ")}
        >
          <MoreHorizontal className="h-[0.7em] w-[0.7em]" strokeWidth={2.25} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="line-actions-menu w-[10rem] p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className={itemClass}>
          <AudioPlayer text={line.text} />
          <span>Read aloud</span>
        </div>
        <button type="button" onClick={handleCopy} className={itemClass}>
          <Copy className="h-3 w-3 text-(--color-text-muted)" />
          Copy text
        </button>
        {isTranslated ? (
          <button
            type="button"
            onClick={handleShowOriginal}
            className={itemClass}
          >
            <Undo2 className="h-3 w-3 text-(--color-text-muted)" />
            Show original
          </button>
        ) : translateEnabled ? (
          <button type="button" onClick={handleTranslate} className={itemClass}>
            <Languages className="h-3 w-3 text-(--color-text-muted)" />
            Translate
          </button>
        ) : null}
        <button type="button" onClick={handleExplain} className={itemClass}>
          <Sparkles className="h-3 w-3 text-(--color-text-muted)" />
          Explain
        </button>
        <button
          type="button"
          onClick={handleDelete}
          className={`${itemClass} hover:text-(--color-danger)`}
        >
          <Trash2 className="h-3 w-3 text-(--color-text-muted)" />
          Delete line
        </button>
      </PopoverContent>
    </Popover>
  );
}
