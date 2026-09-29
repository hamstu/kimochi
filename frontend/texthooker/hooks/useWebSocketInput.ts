import { useEffect } from "react";
import { getSettings, onSettingsChange } from "../lib/settings";
import { connectTextSocket, type SocketStatus } from "../websocket-input";
import { useIngest } from "./useIngest";

export function useWebSocketInput(
  onStatus: (value: SocketStatus | null) => void,
): void {
  const ingest = useIngest();
  useEffect(() => {
    let key = "";
    let disconnect = () => {};
    const configure = (): void => {
      const settings = getSettings();
      const next = JSON.stringify([
        settings.inputSource,
        settings.websocketUrl,
      ]);
      if (next === key) return;
      key = next;
      disconnect();
      if (settings.inputSource !== "websocket") {
        onStatus(null);
        return;
      }
      disconnect = connectTextSocket(
        settings.websocketUrl,
        (text) => {
          void ingest(text, "websocket").catch((error) => {
            onStatus({
              state: "retrying",
              message: `Could not save received text: ${String(error)}`,
            });
          });
        },
        onStatus,
      );
    };
    configure();
    const unsubscribe = onSettingsChange(configure);
    return () => {
      unsubscribe();
      disconnect();
    };
  }, [ingest, onStatus]);
}
