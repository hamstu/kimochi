import { writeTextFile } from "./files";
import { inProfile } from "./profile";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { getSettings, updateSettings } from "../lib/settings";
import { getReplacements, setReplacements } from "./replacements";
import type { Preset, PresetsFile, Replacement, Settings } from "../lib/types";
import { SETTINGS_DEFAULTS } from "../lib/types";

const FILE = "presets.json";
const DIR = BaseDirectory.AppLocalData;

/** Per-user secrets live in settings.json only. Presets must never capture
    them (exports are shareable files) nor overwrite them on apply (an old
    preset would silently clear the key). */
function stripUserSecrets(s: Settings): Settings {
  return { ...s, deeplApiKey: "" };
}

const DEFAULT_FILE: PresetsFile = {
  version: 1,
  active: "Default",
  presets: {
    Default: {
      settings: { ...SETTINGS_DEFAULTS },
      replacements: [],
    },
  },
};

type Listener = (state: PresetsFile) => void;
const subs = new Set<Listener>();
let state: PresetsFile = structuredClone(DEFAULT_FILE);

function emit() {
  for (const fn of subs) {
    try {
      fn(state);
    } catch (e) {
      console.error(e);
    }
  }
}

export function subscribePresets(fn: Listener): () => void {
  subs.add(fn);
  fn(state);
  return () => {
    subs.delete(fn);
  };
}

export function getPresetsState(): PresetsFile {
  return state;
}

async function ensureDir() {
  try {
    if (!(await exists(inProfile(""), { baseDir: DIR }))) {
      await mkdir(inProfile(""), { baseDir: DIR, recursive: true });
    }
  } catch {
    /* best-effort */
  }
}

async function persist() {
  await ensureDir();
  try {
    await writeTextFile(inProfile(FILE), JSON.stringify(state, null, 2), { baseDir: DIR });
  } catch (err) {
    console.error("presets persist failed", err);
    throw err;
  }
}

function sanitize(raw: unknown): PresetsFile {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_FILE);
  const p = raw as Partial<PresetsFile>;
  if (!p.presets || typeof p.presets !== "object") {
    return structuredClone(DEFAULT_FILE);
  }
  const presets: Record<string, Preset> = {};
  for (const [name, value] of Object.entries(p.presets)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Partial<Preset>;
    presets[name] = {
      settings: stripUserSecrets({
        ...SETTINGS_DEFAULTS,
        ...(v.settings ?? {}),
      }),
      replacements: Array.isArray(v.replacements)
        ? (v.replacements as Replacement[])
        : [],
    };
  }
  if (Object.keys(presets).length === 0) {
    return structuredClone(DEFAULT_FILE);
  }
  const active =
    typeof p.active === "string" && p.active in presets
      ? p.active
      : Object.keys(presets)[0];
  return { version: 1, active, presets };
}

export async function loadPresets(): Promise<PresetsFile> {
  await ensureDir();
  try {
    const present = await exists(inProfile(FILE), { baseDir: DIR });
    if (present) {
      const raw = await readTextFile(inProfile(FILE), { baseDir: DIR });
      state = sanitize(JSON.parse(raw));
    } else {
      // Seed the file with the user's current settings + replacements as
      // "Default" so the first preset isn't a stranger.
      state = {
        version: 1,
        active: "Default",
        presets: {
          Default: {
            settings: stripUserSecrets(getSettings()),
            replacements: getReplacements().slice(),
          },
        },
      };
      await persist();
    }
  } catch (err) {
    console.warn("loadPresets failed", err);
    state = structuredClone(DEFAULT_FILE);
  }
  // Hydrate the in-memory replacements from the active preset.
  const active = state.presets[state.active];
  if (active) {
    setReplacements(active.replacements);
  }
  emit();
  return state;
}

/** True if current settings/replacements differ from the active preset's saved snapshot. */
export function isDirty(): boolean {
  const active = state.presets[state.active];
  if (!active) return true;
  const currentSettings = JSON.stringify(stripUserSecrets(getSettings()));
  const savedSettings = JSON.stringify(active.settings);
  if (currentSettings !== savedSettings) return true;
  const currentRules = JSON.stringify(getReplacements());
  const savedRules = JSON.stringify(active.replacements);
  return currentRules !== savedRules;
}

export async function applyPreset(name: string) {
  const p = state.presets[name];
  if (!p) return;
  state = { ...state, active: name };
  emit();
  await persist();
  // Apply the snapshot to live state. Lines are NOT cleared. The DeepL key is
  // carried over from live settings — presets store it blanked.
  await updateSettings({
    ...p.settings,
    deeplApiKey: getSettings().deeplApiKey,
  });
  setReplacements(p.replacements.slice());
}

export async function saveCurrentAs(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  state = {
    ...state,
    active: trimmed,
    presets: {
      ...state.presets,
      [trimmed]: {
        settings: stripUserSecrets(getSettings()),
        replacements: getReplacements().slice(),
      },
    },
  };
  emit();
  await persist();
  return true;
}

export async function saveOverActive(): Promise<boolean> {
  if (!state.active || !state.presets[state.active]) return false;
  return saveCurrentAs(state.active);
}

export async function deletePreset(name: string): Promise<boolean> {
  if (!state.presets[name]) return false;
  if (Object.keys(state.presets).length <= 1) return false; // keep at least one
  const next: Record<string, Preset> = { ...state.presets };
  delete next[name];
  const active = state.active === name ? Object.keys(next)[0] : state.active;
  state = { ...state, active, presets: next };
  emit();
  await persist();
  // If we just switched active, push the new active preset live.
  if (state.active !== name) await applyPreset(state.active);
  return true;
}

export async function renamePreset(from: string, to: string): Promise<boolean> {
  const trimmed = to.trim();
  if (!trimmed || from === trimmed) return false;
  if (!state.presets[from] || state.presets[trimmed]) return false;
  const next: Record<string, Preset> = {};
  for (const [k, v] of Object.entries(state.presets)) {
    next[k === from ? trimmed : k] = v;
  }
  state = {
    ...state,
    active: state.active === from ? trimmed : state.active,
    presets: next,
  };
  emit();
  await persist();
  return true;
}

interface PresetExport {
  format: "super-texthooker-preset";
  version: 1;
  name: string;
  preset: Preset;
}

export async function exportActiveToFile(): Promise<string | null> {
  const active = state.presets[state.active];
  if (!active) return null;
  const path = await saveDialog({
    title: `Export preset "${state.active}"`,
    defaultPath: `${state.active}.preset.json`,
    filters: [{ name: "Preset JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  const payload: PresetExport = {
    format: "super-texthooker-preset",
    version: 1,
    name: state.active,
    preset: active,
  };
  try {
    // tauri-plugin-dialog returns the chosen path; write via plugin-fs without
    // a baseDir so the absolute path is honored.
    await writeTextFile(path, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("preset export failed", err);
    return null;
  }
  return path;
}

export async function importFromFile(): Promise<string | null> {
  const picked = await openDialog({
    title: "Import preset",
    multiple: false,
    filters: [{ name: "Preset JSON", extensions: ["json"] }],
  });
  if (!picked || typeof picked !== "string") return null;
  let payload: PresetExport;
  try {
    const raw = await readTextFile(picked);
    payload = JSON.parse(raw) as PresetExport;
  } catch (err) {
    console.error("preset import read failed", err);
    return null;
  }
  if (
    !payload ||
    payload.format !== "super-texthooker-preset" ||
    !payload.preset
  ) {
    return null;
  }
  // Disambiguate name collisions.
  let name = payload.name || "Imported";
  let suffix = 1;
  while (name in state.presets) {
    suffix += 1;
    name = `${payload.name || "Imported"} (${suffix})`;
  }
  const preset: Preset = {
    settings: stripUserSecrets({
      ...SETTINGS_DEFAULTS,
      ...(payload.preset.settings ?? {}),
    }),
    replacements: Array.isArray(payload.preset.replacements)
      ? (payload.preset.replacements as Settings extends never
          ? never
          : Replacement[])
      : [],
  };
  state = {
    ...state,
    presets: { ...state.presets, [name]: preset },
  };
  emit();
  await persist();
  return name;
}
