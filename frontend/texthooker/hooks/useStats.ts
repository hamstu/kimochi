import { useEffect, useState } from "react";
import {
  isRunning,
  snapshotStats,
  subscribeStats,
} from "@texthooker/lib/stats";
import type { Stats } from "@texthooker/lib/types";

interface Snapshot {
  stats: Stats;
  elapsedMs: number;
}

/**
 * Live stats snapshot: refreshes on every module-side update PLUS once a
 * second when the timer is running and the window is visible. Footer reads
 * this and renders compactly.
 */
export function useStats(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(() => snapshotStats());

  useEffect(() => {
    return subscribeStats(() => setSnap(snapshotStats()));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (!isRunning()) return;
        setSnap(snapshotStats());
      }, 1000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    start();
    const onVis = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return snap;
}
