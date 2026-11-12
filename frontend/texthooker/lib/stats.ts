import { call, getSnapshot, subscribe, snapshotAge } from "../bridge";
import type * as Core from "../core/stats";
export const resetStats = (
  ...args: Parameters<typeof Core.resetStats>
): Promise<Awaited<ReturnType<typeof Core.resetStats>>> =>
  call("stats", "resetStats", args);

/** The Log's stats, ticked on by the time since they arrived, up to where its running interval stops. */
export const snapshotStats = () => {
  const { stats, running } = getSnapshot();
  const ticked = running ? Math.min(snapshotAge(), stats.runningLeftMs ?? Infinity) : 0;
  return { ...stats, elapsedMs: stats.elapsedMs + ticked };
};
export const isRunning = () => getSnapshot().running;
export const subscribeStats = (
  fn: (
    s: ReturnType<typeof snapshotStats>["stats"],
    runningSince: number | null,
  ) => void,
) => subscribe((s) => fn(s.stats.stats, s.running ? Date.now() : null));
