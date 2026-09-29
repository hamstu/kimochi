import { AudioPlayer } from "../../components/AudioPlayer";
import { useRef, useState } from "react";
import {
  Copy,
  Languages,
  MoreHorizontal,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import {
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
  const audioSlot = useRef<HTMLSpanElement>(null);

  const handleCopy = async () => {
    try {
      await writeTextSelf(displayText);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

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
        <MenuContent
          align="end"
          className="log-line-menu"
        >
          {/* Read aloud: the row activates the shared AudioPlayer button, which keeps its own
              playing state and error tooltip. The menu stays open while it plays. */}
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
          <MenuItem icon={<Copy />} onSelect={() => void handleCopy()}>
            Copy text
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
          <MenuItem icon={<Sparkles />} onSelect={() => openExplain(line)}>
            Explain
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 />}
            tone="danger"
            onSelect={() => deleteLine(line.id)}
          >
            Delete line
          </MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
}
