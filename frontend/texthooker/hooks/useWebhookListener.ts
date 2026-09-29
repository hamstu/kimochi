import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  WebhookErrorEvent,
  WebhookLineEvent,
} from "@texthooker/lib/types";
import { useIngest } from "./useIngest";

export interface WebhookState {
  ready: boolean;
  error: WebhookErrorEvent | null;
}

export function useWebhookListener(
  onError: (e: WebhookErrorEvent | null) => void,
) {
  const ingest = useIngest();

  useEffect(() => {
    // Track cancellation so cleanup works even if listen() hasn't resolved yet.
    let cancelled = false;
    const unlistens: UnlistenFn[] = [];

    const register = async <T>(
      event: string,
      handler: (e: { payload: T }) => void,
    ) => {
      const u = await listen<T>(event, handler);
      if (cancelled) {
        u();
      } else {
        unlistens.push(u);
      }
    };

    void register<WebhookLineEvent>("webhook:line", (e) => {
      void ingest(e.payload.text, "webhook", e.payload.ts);
    });

    void register<WebhookErrorEvent>("webhook:error", (e) => {
      console.warn("webhook:error received", e.payload);
      onError(e.payload);
    });

    void register<unknown>("webhook:ready", () => {
      onError(null);
    });

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [ingest, onError]);
}
