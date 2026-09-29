import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@texthooker/components/ui/dialog";
import { Button } from "@texthooker/components/ui/button";
import {
  createPerson,
  createPlace,
  createThing,
} from "@texthooker/lib/notebook";
import { openEditModal } from "@texthooker/lib/editModal";
import { splitJapaneseName } from "@texthooker/lib/vndbImport";
import type { NotebookKind } from "@texthooker/lib/types";

interface Props {
  /** Selected text to seed the new entry with, or null when closed. */
  text: string | null;
  onClose: () => void;
}

const KINDS: {
  kind: NotebookKind;
  glyph: string;
  label: string;
  hint: string;
}[] = [
  { kind: "person", glyph: "人", label: "Person", hint: "Character, name" },
  { kind: "place", glyph: "地", label: "Place", hint: "Location, region" },
  { kind: "thing", glyph: "物", label: "Thing", hint: "Item, term, concept" },
];

/** Picks an entry kind for the selected text, creates the entry, then hands
 *  off to the edit modal for details and images. */
export function AddToNotebookModal({ text, onClose }: Props) {
  const handlePick = async (kind: NotebookKind) => {
    const t = (text ?? "").trim();
    onClose();
    const entry =
      kind === "person"
        ? await createPerson(splitJapaneseName(t))
        : kind === "place"
          ? await createPlace({ name: t })
          : await createThing({ name: t });
    openEditModal(entry.id);
  };

  return (
    <Dialog open={text !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="left-1/2 right-auto top-1/2 bottom-auto -translate-x-1/2 -translate-y-1/2 w-[22.5rem] max-w-[calc(100vw-48px)] max-h-[80vh] border border-(--color-border) rounded-lg shadow-[var(--shadow-pop)]"
        aria-describedby={undefined}
      >
        <div className="flex items-center justify-between mb-3">
          <DialogTitle className="text-sm font-semibold">
            Add to notebook
          </DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </div>

        <div
          className="mb-3 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-3 py-2 text-[1rem] text-(--color-text)"
          style={{ fontFamily: "var(--font-jp)" }}
          translate="no"
          lang="ja"
        >
          {text}
        </div>

        <div className="text-[0.6875rem] text-(--color-text-muted) mb-2">
          What is it?
        </div>
        <div className="grid grid-cols-3 gap-2">
          {KINDS.map(({ kind, glyph, label, hint }) => (
            <button
              key={kind}
              type="button"
              onClick={() => void handlePick(kind)}
              className="flex flex-col items-center gap-1 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-3 hover:border-(--color-accent) hover:bg-(--color-accent-soft)"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-(--color-accent-soft) text-[0.9375rem] text-(--color-accent)">
                {glyph}
              </span>
              <span className="text-xs font-medium text-(--color-text)">
                {label}
              </span>
              <span className="text-[0.625rem] text-(--color-text-muted)">
                {hint}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
