import { call, getSnapshot, subscribe } from "../bridge";
import type * as Core from "../core/replacements";
export const setReplacements = (
  ...args: Parameters<typeof Core.setReplacements>
): Promise<Awaited<ReturnType<typeof Core.setReplacements>>> =>
  call("replacements", "setReplacements", args);
export const addReplacement = (
  ...args: Parameters<typeof Core.addReplacement>
): Promise<Awaited<ReturnType<typeof Core.addReplacement>>> =>
  call("replacements", "addReplacement", args);
export const removeReplacement = (
  ...args: Parameters<typeof Core.removeReplacement>
): Promise<Awaited<ReturnType<typeof Core.removeReplacement>>> =>
  call("replacements", "removeReplacement", args);
export const updateReplacement = (
  ...args: Parameters<typeof Core.updateReplacement>
): Promise<Awaited<ReturnType<typeof Core.updateReplacement>>> =>
  call("replacements", "updateReplacement", args);
export const reorderReplacement = (
  ...args: Parameters<typeof Core.reorderReplacement>
): Promise<Awaited<ReturnType<typeof Core.reorderReplacement>>> =>
  call("replacements", "reorderReplacement", args);

export const getReplacements = () => getSnapshot().replacements;
export const subscribeReplacements = (
  fn: (s: ReturnType<typeof getReplacements>) => void,
) => {
  fn(getSnapshot().replacements);
  return subscribe((s) => fn(s.replacements));
};

export { isPatternErrored } from "../core/replacements";
