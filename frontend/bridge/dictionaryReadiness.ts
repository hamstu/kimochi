import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onEvent } from "./tauri";
import { hostEngineOf, type DictionaryEngine } from "./dictionaryEngine";

export interface DictionaryReadiness {
  engine: string;
  phase:
    | "starting"
    | "downloading"
    | "installing"
    | "setup-needed"
    | "ready"
    | "failed";
  message: string;
  progress?: number | null;
}

/** The running engine's readiness, independent of its extension archive's download. */
export function useDictionaryReadiness(
  engine: DictionaryEngine,
): DictionaryReadiness {
  const host = hostEngineOf(engine);
  const [status, setStatus] = useState<DictionaryReadiness | null>(null);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const accept = (next: DictionaryReadiness): void => {
      if (live && next.engine === host) setStatus(next);
    };
    // Subscribe before reading: a fast startup cannot land between the read and listener.
    void onEvent<DictionaryReadiness>("dictionary-readiness", accept)
      .then(async (unlisten) => {
        if (!live) return unlisten();
        stop = unlisten;
        accept(
          await invoke<DictionaryReadiness>("dictionary_runtime_status", {
            engine: host,
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [host]);
  if (engine === "custom-api")
    return { engine: host, phase: "ready", message: "" };
  return status?.engine === host
    ? status
    : { engine: host, phase: "starting", message: "Starting the dictionary…" };
}
