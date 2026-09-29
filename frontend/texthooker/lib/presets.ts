import { call, getSnapshot, subscribe } from "../bridge";
import type * as Core from "../core/presets";
export const applyPreset = (
  ...args: Parameters<typeof Core.applyPreset>
): Promise<Awaited<ReturnType<typeof Core.applyPreset>>> =>
  call("presets", "applyPreset", args);
export const saveCurrentAs = (
  ...args: Parameters<typeof Core.saveCurrentAs>
): Promise<Awaited<ReturnType<typeof Core.saveCurrentAs>>> =>
  call("presets", "saveCurrentAs", args);
export const saveOverActive = (
  ...args: Parameters<typeof Core.saveOverActive>
): Promise<Awaited<ReturnType<typeof Core.saveOverActive>>> =>
  call("presets", "saveOverActive", args);
export const deletePreset = (
  ...args: Parameters<typeof Core.deletePreset>
): Promise<Awaited<ReturnType<typeof Core.deletePreset>>> =>
  call("presets", "deletePreset", args);
export const renamePreset = (
  ...args: Parameters<typeof Core.renamePreset>
): Promise<Awaited<ReturnType<typeof Core.renamePreset>>> =>
  call("presets", "renamePreset", args);
export const exportActiveToFile = (
  ...args: Parameters<typeof Core.exportActiveToFile>
): Promise<Awaited<ReturnType<typeof Core.exportActiveToFile>>> =>
  call("presets", "exportActiveToFile", args);
export const importFromFile = (
  ...args: Parameters<typeof Core.importFromFile>
): Promise<Awaited<ReturnType<typeof Core.importFromFile>>> =>
  call("presets", "importFromFile", args);

export const getPresetsState = () => getSnapshot().presets;
export const isDirty = () => getSnapshot().dirtyPreset;
export const subscribePresets = (
  fn: (s: ReturnType<typeof getPresetsState>) => void,
) => {
  fn(getSnapshot().presets);
  return subscribe((s) => fn(s.presets));
};
