import type { OcrGroup } from "../../ui/ocr-result";
/** Always-loaded Log realm: sole owner of session files, serialized RPC and OCR intake. */
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting, onSettingsChange } from "../bridge/settings";
import * as sessions from "./core/sessions";
import * as store from "./core/store";
import * as notebook from "./core/notebook";
import * as stats from "./core/stats";
import * as presets from "./core/presets";
import * as replacements from "./core/replacements";
import { ingestText } from "./core/ingest";
import { loadSettings, getSettings } from "./lib/settings";
import { acceptSnapshot, type ReaderSnapshot } from "./bridge";
import { matchedSession, sourceKey, type SourceName } from "./source-sessions";
let startup: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let currentSource: SourceName | null = null;
let bindings: Record<string, string> = {};
let seen: string[] = [];
export const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = queue.then(fn);
  queue = result.catch(() => undefined);
  return result;
};
const snapshot = (): ReaderSnapshot => ({
  sessions: sessions.getManifest(),
  lines: store.snapshotLines(),
  notebook: notebook.getNotebook(),
  stats: stats.snapshotStats(),
  running: stats.isRunning(),
  presets: presets.getPresetsState(),
  replacements: replacements.getReplacements(),
  dirtyPreset: presets.isDirty(),
});
function broadcast(): void {
  const value = snapshot();
  acceptSnapshot(value);
  void emit("reader:snapshot", value);
}
async function flush(): Promise<void> {
  await store.flushLines();
  await notebook.flushNotebook();
  await stats.flushStats();
}
async function selectSource(
  source: SourceName | null,
  force = false,
): Promise<void> {
  if (!force && sourceKey(source) === sourceKey(currentSource)) return;
  currentSource = source;
  if (
    getSettings().inputSource !== "ocr" ||
    !source ||
    !sourceKey(source) ||
    !getSettings().autoMatchSource
  )
    return;
  const match = matchedSession(source, sessions.listSessions(), bindings);
  if (match) await sessions.switchSession(match);
  else await sessions.createSession(source.applicationContext?.name || source.name || source.appName);
  bindings[sourceKey(source)!] = sessions.getActiveSession().id;
  await setSetting("texthookerSourceSessions", bindings);
}
interface ScanEntry {
  groups?: OcrGroup[] | null;
  engine?: string;
  id: string;
  text: string;
  timestamp: number;
  source?: SourceName | null;
  /** Earlier entries this fuller reading replaced in the history; see history_merge.rs. */
  replaces?: string[];
}
async function ingestHistory(entries: ScanEntry[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    if (seen.includes(entry.id)) continue;
    // A fuller reading of text already logged: its fragments' lines give way to it.
    if (entry.replaces?.length) {
      for (const line of store.snapshotLines()) {
        const from = line.ingestIds ?? [];
        if (from.some((key) => entry.replaces!.some((id) => key === id || key.startsWith(`${id}:group:`))))
          store.deleteLine(line.id);
      }
    }
    if (getSettings().inputSource === "ocr") {
      if (entry.source) await selectSource(entry.source);
      const groups = entry.groups?.filter(group => group.text?.trim());
      if (groups?.length) {
        for (const [index, group] of groups.entries()) {
          await ingestText(group.text, "ocr", entry.timestamp, `${entry.id}:group:${group.id}`, {
            scanId: entry.id, groupId: group.id, groupIndex: index, groupCount: groups.length,
            engine: entry.engine, orientation: group.orientation
          });
        }
      } else await ingestText(entry.text, "ocr", entry.timestamp, entry.id);
      await flush();
    }
    // Consume IDs even with another input selected: switching back must not replay
    // scans the user deliberately excluded from this transcript.

    seen = [...seen.slice(-1999), entry.id];
    await setSetting("texthookerIngestedHistory", seen);
  }
  broadcast();
}
const modules = { sessions, store, notebook, stats, presets, replacements };
const allowed: Record<string, string[]> = {
  sessions: [
    "createSession",
    "switchSession",
    "renameSession",
    "reorderSessions",
    "deleteSession",
    "updateSessionDescription",
  ],
  store: [
    "clearLines",
    "deleteLine",
    "setLineTranslation",
    "setLineTranslationVisible",
    "setLineExplanation",
  ],
  notebook: [
    "createPerson",
    "createPlace",
    "createThing",
    "updateEntry",
    "deleteEntry",
    "addNote",
    "updateNote",
    "deleteNote",
    "attachImage",
    "detachImage",
  ],
  stats: ["resetStats"],
  presets: [
    "applyPreset",
    "saveCurrentAs",
    "saveOverActive",
    "deletePreset",
    "renamePreset",
    "exportActiveToFile",
    "importFromFile",
  ],
  replacements: [
    "setReplacements",
    "addReplacement",
    "removeReplacement",
    "updateReplacement",
    "reorderReplacement",
  ],
};
export function startHost(): Promise<void> {
  if (!startup)
    startup = (async () => {
      await loadSettings();
      await sessions.migrateIfNeeded();
      await sessions.loadSessions();
      await stats.loadStats();
      await presets.loadPresets();
      await store.loadLines();
      await notebook.loadNotebook();
      // Scans that repeat a line already logged are dropped upstream (the history merge and the
      // automatic scanners remember what they published). Once the log is cleared, or another
      // session's lines are loaded in its place, that line may no longer be there, so they must
      // forget it too, or scanning it again shows nothing.
      store.subscribe((event) => {
        if (event.type === "clear" || event.type === "load")
          void invoke("history_merge_reset").catch(reportError);
      });
      bindings = await getSetting("texthookerSourceSessions", {});
      seen = await getSetting("texthookerIngestedHistory", []);
      await listen<{
        id: string;
        module: string;
        method: string;
        args: unknown[];
        sessionId?: string;
      }>("reader:request", (e) => {
        const { id, module, method, args, sessionId } = e.payload;
        void enqueue(async () => {
          try {
            let value: unknown;
            if (module === "host" && method === "snapshot") value = snapshot();
            else if (module === "host" && method === "ingest") {
              await ingestText(...(args as Parameters<typeof ingestText>));
              await flush();
            } else {
              if (
                ["notebook", "store"].includes(module) &&
                sessionId !== sessions.getActiveSession().id
              )
                throw new Error(
                  "Session changed; please retry in the current session",
                );
              if (!allowed[module]?.includes(method))
                throw new Error("Unsupported log operation");
              const target = modules[
                module as keyof typeof modules
              ] as unknown as Record<string, (...values: unknown[]) => unknown>;
              if (module === "notebook" && method === "attachImage")
                args[1] = new Blob([new Uint8Array(args[1] as number[])]);
              value = await target[method](...args);
              if (
                module === "sessions" &&
                ["switchSession", "createSession"].includes(method) &&
                sourceKey(currentSource)
              ) {
                bindings[sourceKey(currentSource)!] =
                  sessions.getActiveSession().id;
                await setSetting("texthookerSourceSessions", bindings);
              }
              await flush();
            }
            broadcast();
            await emit("reader:response", { id, value });
          } catch (error) {
            await emit("reader:response", { id, error: String(error) });
          }
        });
      });
      await listen<{ source?: SourceName }>("state", (e) => {
        if (
          e.payload.source &&
          sourceKey(e.payload.source) !== sourceKey(currentSource)
        )
          void enqueue(async () => {
            await selectSource(e.payload.source!);
            broadcast();
          }).catch(reportError);
      });
      let previousInput = getSettings().inputSource;
      onSettingsChange((key, value) => {
        if (key === "superTexthooker") {
          const nextInput = getSettings().inputSource;
          if (nextInput !== previousInput) {
            previousInput = nextInput;
            if (nextInput === "ocr")
              void enqueue(async () => {
                await selectSource(currentSource, true);
                broadcast();
              }).catch(reportError);
          }
        }
        if (key === "scannedTextHistory")
          void enqueue(() => ingestHistory(value as ScanEntry[])).catch(
            reportError,
          );
        if (key === "lastSelectedSource")
          void enqueue(async () => {
            await selectSource(value as SourceName);
            broadcast();
          }).catch(reportError);
      });
      await ingestHistory(
        await getSetting<ScanEntry[]>("scannedTextHistory", []),
      );
      await selectSource(await getSetting("lastSelectedSource", null));
      stats.subscribeStats(() => broadcast());
      broadcast();
    })().catch((error) => {
      startup = null;
      throw error;
    });
  return startup;
}
function reportError(error: unknown): void {
  void emit("reader:error", { message: String(error) });
}
