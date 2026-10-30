import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { downloadEngineFor } from "@ui/extension-download";
import { newerReadiness, readinessView, type DownloadState, type ReadinessView } from "@ui/dictionary-readiness";
import { onEvent } from "./tauri";
import { DICTIONARY_ENGINES, hostEngineOf, type DictionaryEngine } from "./dictionaryEngine";
import { useExtensionStatus } from "./extensions";

export interface DictionaryReadiness {
  engine: string;
  /** The settings host initialized; dictionary data may still be downloading. */
  settingsReady: boolean;
  phase:
    | "starting"
    | "downloading"
    | "installing"
    | "setup-needed"
    | "ready"
    | "failed";
  message: string;
  progress?: number | null;
  /** Lookups work now, whatever the phase (10ten reads its bundled words while it downloads). */
  lookups?: boolean;
  /** Native's number for this report (`src-tauri/src/dictionary_runtime.rs`): higher is newer. */
  seq?: number;
  /** The engine's download (`extension_status`), or null when there is none to report. */
  download: DownloadState;
  /** What Settings, the sidebar and onboarding show for it (`ui/dictionary-readiness.ts`). */
  view: ReadinessView;
}

type Reported = Omit<DictionaryReadiness, "download" | "view">;

/**
 * The engine's readiness, with its extension archive's download: an engine that is not downloaded
 * runs nowhere, so no readiness is ever reported for it and the download is what to show.
 */
export function useDictionaryReadiness(
  engine: DictionaryEngine,
): DictionaryReadiness {
  const host = hostEngineOf(engine);
  const [status, setStatus] = useState<Reported | null>(null);
  const downloadStatus = useExtensionStatus(downloadEngineFor(engine));
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const accept = (next: Reported): void => {
      if (live && next.engine === host) {
        setStatus((current) => (newerReadiness(current, next) ? next : current));
      }
    };
    // Subscribe before reading: a fast startup cannot land between the read and listener.
    void onEvent<Reported>("dictionary-readiness", accept)
      .then(async (unlisten) => {
        if (!live) return unlisten();
        stop = unlisten;
        accept(
          await invoke<Reported>("dictionary_runtime_status", {
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
  const reported: Reported =
    engine === "custom-api"
      ? { engine: host, phase: "ready", settingsReady: true, message: "" }
      : status?.engine === host
        ? status
        : { engine: host, phase: "starting", settingsReady: false, message: "Starting the dictionary…" };
  const download: DownloadState =
    engine !== "custom-api" && downloadStatus?.engine === engine ? downloadStatus.state : null;
  return { ...reported, download, view: readinessView(reported, download, DICTIONARY_ENGINES[engine].name) };
}
