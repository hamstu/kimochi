import { call, getSnapshot, subscribe, snapshotAge } from "../bridge";
import type * as Core from "../core/stats";
export const resetStats = (
  ...args: Parameters<typeof Core.resetStats>
): Promise<Awaited<ReturnType<typeof Core.resetStats>>> =>
  call("stats", "resetStats", args);

export const snapshotStats = () => ({
  ...getSnapshot().stats,
  elapsedMs:
    getSnapshot().stats.elapsedMs + (getSnapshot().running ? snapshotAge() : 0),
});
export const isRunning = () => getSnapshot().running;
export const subscribeStats = (
  fn: (
    s: ReturnType<typeof snapshotStats>["stats"],
    runningSince: number | null,
  ) => void,
) => subscribe((s) => fn(s.stats.stats, s.running ? Date.now() : null));
