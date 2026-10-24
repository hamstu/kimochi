import type { ReactNode } from "react";
import { Callout, Spinner } from "@kit";
import { useDictionaryReadiness } from "../bridge/dictionaryReadiness";
import type { DictionaryEngine } from "../bridge/dictionaryEngine";

/** The engine in use while it is not ready: not downloaded, starting, fetching data, or failed. */
export function DictionaryReadiness({
  engine,
}: {
  engine: DictionaryEngine;
}): ReactNode {
  const { view } = useDictionaryReadiness(engine);
  if (!view.show) return null;
  return (
    <Callout tone={view.tone} icon={view.busy ? <Spinner /> : undefined}>
      <span>{view.text}</span>
      {view.progress !== null && (
        <progress
          max={100}
          value={view.progress}
          aria-label="Dictionary data download"
        />
      )}
    </Callout>
  );
}
