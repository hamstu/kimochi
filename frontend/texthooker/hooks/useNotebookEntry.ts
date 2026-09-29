/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { getNotebook, subscribeNotebook } from "@texthooker/lib/notebook";
import type { NotebookEntry } from "@texthooker/lib/types";

export function useNotebookEntry(entryId: string): NotebookEntry | undefined {
  const [entry, setEntry] = useState<NotebookEntry | undefined>(() =>
    getNotebook().entries.find((e) => e.id === entryId),
  );
  useEffect(() => {
    // Recompute immediately: when entryId changes between renders the state
    // still holds the previous entry, and no notebook emit is coming to fix it.
    setEntry(getNotebook().entries.find((e) => e.id === entryId));
    return subscribeNotebook((nb) => {
      setEntry(nb.entries.find((e) => e.id === entryId));
    });
  }, [entryId]);
  return entry;
}
