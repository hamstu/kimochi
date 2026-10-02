import { ArrowRight, Box, MapPin, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@kit/Button";
import type { SerializedNotebookEntry } from "@texthooker/lib/types";
import { NotebookHero } from "./NotebookHero";
import "../notebook-card.css";

interface Props {
  entry: SerializedNotebookEntry;
  /** When provided, renders a "Notebook" button that opens the entry there. */
  onOpen?: (entryId: string) => void;
}

/* Same words and icons as the Notebook window (notebookEntry.tsx KIND_META); kept
   local so the popup does not pull in the notebook store bridge. */
const KIND_META: Record<
  SerializedNotebookEntry["kind"],
  { label: string; icon: ReactNode }
> = {
  person: { label: "Character", icon: <UserRound /> },
  place: { label: "Place", icon: <MapPin /> },
  thing: { label: "Thing", icon: <Box /> },
};

export function NotebookEntryCard({ entry, onOpen }: Props) {
  const kind = KIND_META[entry.kind];
  return (
    <article className="notebook-card">
      <NotebookHero
        imageUrl={entry.imageDataUrl}
        kind={entry.kind}
        name={entry.displayName}
        reading={entry.reading || undefined}
        actions={
          onOpen ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOpen(entry.id)}
              aria-label="Open in Notebook"
            >
              Notebook
              <ArrowRight />
            </Button>
          ) : null
        }
      />
      <div className="notebook-card-body">
        <dl className="notebook-card-meta">
          <div>
            <dt>Type</dt>
            <dd>
              <span className="notebook-card-kind">
                {kind.icon}
                {kind.label}
              </span>
            </dd>
          </div>
          {entry.aliases.length > 0 ? (
            <div>
              <dt>Nicknames</dt>
              <dd translate="no" lang="ja" className="notebook-card-alias">
                {entry.aliases.join("、")}
              </dd>
            </div>
          ) : null}
        </dl>
        {entry.description ? (
          <p className="notebook-card-description">{entry.description}</p>
        ) : (
          <p className="notebook-card-description notebook-card-description-empty">
            No description yet.
          </p>
        )}
        {entry.notes.length > 0 ? (
          <section className="notebook-card-notes">
            <h3 className="notebook-card-label">Notes</h3>
            <ul>
              {entry.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </article>
  );
}
