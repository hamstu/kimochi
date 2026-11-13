import { NotebookPen } from "lucide-react";
import { Button } from "@kit";
import { startNote, useNoteDraft } from "@texthooker/lib/lineEdit";
import { NoteDraft } from "./LineRow";

/**
 * The end of the Log: "Add a note" on a hairline, or the note being written there. The note
 * becomes a line when it is saved with any text; an empty one is let go.
 */
export function AddNote() {
  const draft = useNoteDraft();
  if (draft !== null) return <NoteDraft ts={draft} />;
  return (
    <div className="log-add-note" lang="en">
      <Button variant="ghost" size="sm" className="log-add-note-button" onClick={startNote}>
        <NotebookPen aria-hidden />
        Add a note
        <kbd className="log-add-note-key" aria-hidden>
          A
        </kbd>
      </Button>
    </div>
  );
}
