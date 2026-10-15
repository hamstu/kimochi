import { call, getSnapshot } from "../bridge";
import type * as Core from "../core/store";
export const clearLines = (
  ...args: Parameters<typeof Core.clearLines>
): Promise<Awaited<ReturnType<typeof Core.clearLines>>> =>
  call("store", "clearLines", args);
export const deleteLine = (
  ...args: Parameters<typeof Core.deleteLine>
): Promise<Awaited<ReturnType<typeof Core.deleteLine>>> =>
  call("store", "deleteLine", args);
export const setLineTranslation = (
  ...args: Parameters<typeof Core.setLineTranslation>
): Promise<Awaited<ReturnType<typeof Core.setLineTranslation>>> =>
  call("store", "setLineTranslation", args);
export const setLineTranslationVisible = (
  ...args: Parameters<typeof Core.setLineTranslationVisible>
): Promise<Awaited<ReturnType<typeof Core.setLineTranslationVisible>>> =>
  call("store", "setLineTranslationVisible", args);
export const setLineExplanation = (
  ...args: Parameters<typeof Core.setLineExplanation>
): Promise<Awaited<ReturnType<typeof Core.setLineExplanation>>> =>
  call("store", "setLineExplanation", args);

export const snapshotLines = () => getSnapshot().lines;
export const lineCount = () => snapshotLines().length;
