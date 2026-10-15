import type { ReactNode } from "react";
import { Callout, Spinner } from "@kit";
import { useDictionaryReadiness } from "../bridge/dictionaryReadiness";
import type { DictionaryEngine } from "../bridge/dictionaryEngine";

export function DictionaryReadiness({
  engine,
}: {
  engine: DictionaryEngine;
}): ReactNode {
  const status = useDictionaryReadiness(engine);
  if (status.phase === "ready") return null;
  return (
    <Callout
      tone={status.phase === "failed" ? "warn" : "neutral"}
      icon={
        ["starting", "downloading", "installing"].includes(status.phase) ? (
          <Spinner />
        ) : undefined
      }
    >
      <span>
        {status.message} Lookups will be available when setup is complete.
      </span>
      {typeof status.progress === "number" && (
        <progress
          max={100}
          value={status.progress}
          aria-label="Dictionary data download"
        />
      )}
    </Callout>
  );
}
