import { Dialog, DialogContent, Row, RowList } from "@kit";
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

// The kanji marks match the notebook chips in the transcript (人 person, 地 place, 物 thing).
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
        title="Add to notebook"
        style={{ width: "min(22rem, calc(100vw - 2rem))" }}
      >
        <div className="log-add-term" translate="no" lang="ja">
          {text}
        </div>
        <p className="log-add-label">What is it?</p>
        <RowList className="log-kinds">
          {KINDS.map(({ kind, glyph, label, hint }) => (
            <Row
              key={kind}
              icon={
                <span className="log-kind-glyph" aria-hidden lang="ja">
                  {glyph}
                </span>
              }
              trailing={<span className="k-row-meta">{hint}</span>}
              onClick={() => void handlePick(kind)}
            >
              {label}
            </Row>
          ))}
        </RowList>
      </DialogContent>
    </Dialog>
  );
}
