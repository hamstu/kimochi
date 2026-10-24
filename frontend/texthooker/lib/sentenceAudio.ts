/* sentenceAudio.ts — the Log's side of sentence audio (src-tauri/src/sentence_audio): each line
   it adds is reported with its arrival time, so a card mined from it can be given the audio that
   played then, and the pop-up's cards ask for theirs once added. Nothing is sent while the setting
   is off. */

import { invoke } from "@tauri-apps/api/core";
import { getSetting, onSettingsChange } from "../../bridge/settings";
import type { SentenceAudioSettings } from "@ui/settings";
import type { Line } from "./types";

/** What Settings → Anki shows about the recording (`sentence_audio_status`). */
export type SentenceAudioStatus = (
  | { state: "off" }
  | { state: "starting" }
  | {
      state: "recording";
      /** What is recorded ("Speakers (Realtek Audio)", "Everything this Mac plays"). */
      source: string;
      /** Kimochi's own sounds are left out of the recording. */
      excludesOwnAudio: boolean;
    }
  | { state: "noPermission"; message: string }
  /** This computer cannot record its audio now (no PipeWire, no output); tried again later. */
  | { state: "unavailable"; message: string }
  | { state: "unsupported"; message: string }
  | { state: "error"; message: string }
) & {
  platform: "macos" | "windows" | "linux" | string;
  /** Seconds of audio held. */
  held: number;
  /** Loudness of the last half second, 0..1. */
  level: number;
  last: { at: number; ok: boolean; message: string } | null;
};

let enabled = false;
let watching = false;

function watch(): void {
  if (watching) return;
  watching = true;
  const apply = (value: unknown): void => {
    enabled = Boolean((value as Partial<SentenceAudioSettings> | null)?.enabled);
  };
  void getSetting<SentenceAudioSettings>("sentenceAudio").then(apply, () => {});
  onSettingsChange((key, value) => {
    if (key === "sentenceAudio") apply(value);
  });
}

/** The Log added `line`, or changed its text (a start-merge keeps its uid and arrival). */
export function reportLine(line: Line): void {
  watch();
  if (!enabled || !line.uid) return;
  invoke("sentence_audio_line", {
    uid: line.uid,
    text: line.text,
    ts: line.ts,
    source: line.source,
  }).catch(() => {});
}

/** The pop-up added note `noteId` from `sentence`: its audio follows in the background, into
    `field` (the field mapped to (sentence audio)) or the one in Settings → Anki. */
export function attachSentenceAudio(
  url: string,
  noteId: number,
  sentence: string | null,
  field: string | null,
): void {
  invoke("sentence_audio_attach", { url, noteId, sentence, field }).catch(
    () => {},
  );
}

export function sentenceAudioStatus(): Promise<SentenceAudioStatus> {
  return invoke<SentenceAudioStatus>("sentence_audio_status");
}
