import { useEffect } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { getSettings, onSettingsChange } from "@texthooker/lib/settings";
import { consumeIfSelfWrite } from "@texthooker/lib/clipboardWrite";
import { useIngest } from "./useIngest";

export function useClipboardPoll(): void {
  const ingest = useIngest();
  useEffect(() => {
    let epoch = 0;
    let key = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selfCopies = new Set<string>();
    const onCopy = (): void => {
      const text = window.getSelection()?.toString();
      if (text) {
        if (selfCopies.size >= 32) selfCopies.clear();
        selfCopies.add(text);
      }
    };
    window.addEventListener("copy", onCopy);
    const stop = (): void => {
      epoch++;
      if (timer !== undefined) clearTimeout(timer);
    };
    const configure = (): void => {
      const settings = getSettings();
      const next = JSON.stringify([
        settings.inputSource,
        settings.clipboardPollMs,
      ]);
      if (key === next) return;
      key = next;
      stop();
      if (settings.inputSource !== "clipboard") return;
      const mine = epoch;
      const ms = Math.max(
        50,
        Number.isFinite(settings.clipboardPollMs)
          ? settings.clipboardPollMs
          : 200,
      );
      let previous: string | null = null;
      const poll = async (): Promise<void> => {
        try {
          const text = await readText();
          if (mine !== epoch) return;
          if (typeof text === "string") {
            const changed = previous !== null && text !== previous;
            previous = text;
            if (
              changed &&
              !consumeIfSelfWrite(text) &&
              !selfCopies.delete(text)
            ) {
              await ingest(text, "clipboard");
            }
          }
        } catch {
          /* Clipboard can be temporarily unavailable. Retry without overlap. */
        }
        if (mine === epoch) timer = setTimeout(() => void poll(), ms);
      };
      // First sample seeds the clipboard; enabling input must not import old clipboard contents.
      void poll();
    };
    configure();
    const unsubscribe = onSettingsChange(configure);
    return () => {
      stop();
      unsubscribe();
      window.removeEventListener("copy", onCopy);
    };
  }, [ingest]);
}
