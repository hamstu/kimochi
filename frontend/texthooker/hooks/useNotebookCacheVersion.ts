import { useEffect, useState } from "react";
import { getNotebook, subscribeNotebook } from "@texthooker/lib/notebook";

/** Re-renders the caller whenever the notebook's cacheVersion changes. */
export function useNotebookCacheVersion(): number {
  const [v, setV] = useState(() => getNotebook().cacheVersion);
  useEffect(() => {
    return subscribeNotebook((nb) => {
      setV(nb.cacheVersion);
    });
  }, []);
  return v;
}
