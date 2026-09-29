import { listen } from "@tauri-apps/api/event";
/** Kimochi owns persistence and broadcasts changes across native windows. */
import { invoke } from "@tauri-apps/api/core";
import {
  getSetting,
  onSettingsChange as onNativeChange,
} from "../../bridge/settings";
import { inputSourceOf } from "../input-source";
import { SETTINGS_DEFAULTS, type Settings } from "./types";
let current: Settings = { ...SETTINGS_DEFAULTS };
let loaded = false;
let loading: Promise<Settings> | null = null;
const subs = new Set<(s: Settings) => void>();
const emit = (): void => {
  for (const fn of subs) fn(current);
};
const mergeDictionary = async (): Promise<void> => {
  const dictionary = await getSetting<{
    popupType: string;
    customApiUrl: string;
  }>("yomitanSettings", {
    popupType: "builtin",
    customApiUrl: SETTINGS_DEFAULTS.yomitanApiUrl,
  });
  current = {
    ...current,
    dictionaryMode:
      dictionary.popupType === "custom-api" ? "custom-api" : "builtin",
    yomitanApiUrl: dictionary.customApiUrl ?? SETTINGS_DEFAULTS.yomitanApiUrl,
  };
};
onNativeChange((key, value) => {
  if (key === "superTexthooker") {
    current = {
      ...SETTINGS_DEFAULTS,
      ...(value as Partial<Settings>),
      inputSource: inputSourceOf(value as Partial<Settings>),
      alwaysOnTop: current.alwaysOnTop,
      dictionaryMode: current.dictionaryMode,
      yomitanApiUrl: current.yomitanApiUrl,
    };
    emit();
  }
  if (key === "yomitanSettings") void mergeDictionary().then(emit);
});
export function loadSettings(): Promise<Settings> {
  if (!loading)
    loading = (async () => {
      const saved = await getSetting<Partial<Settings>>("superTexthooker", {});
      current = {
        ...SETTINGS_DEFAULTS,
        ...saved,
        inputSource: inputSourceOf(saved),
      };
      const pins = await getSetting<Record<string, boolean>>(
        "nativeWindowPinned",
        {},
      );
      current.alwaysOnTop = pins.log ?? true;
      await mergeDictionary();
      loaded = true;
      emit();
      return current;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  return loading;
}
export const getSettings = (): Settings => current;
export const isSettingsLoaded = (): boolean => loaded;
export async function updateSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  // Dictionary owns these values. Legacy presets/resets cannot create a second URL.
  const writable = { ...patch };
  delete writable.yomitanApiUrl;
  delete writable.dictionaryMode;
  await invoke("reader_settings_patch", { patch: writable });
  // The command returns after publishing the authoritative merged settings.
  current = { ...current, ...writable };
  emit();
  return current;
}
export const resetSettings = (): Promise<Settings> =>
  updateSettings({ ...SETTINGS_DEFAULTS });
export function onSettingsChange(fn: (s: Settings) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

void listen<{ label: string; pinned?: boolean }>("panel:state", (e) => {
  if (e.payload.label === "log" && typeof e.payload.pinned === "boolean") {
    current = { ...current, alwaysOnTop: e.payload.pinned };
    emit();
  }
});
