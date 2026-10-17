import test, { after } from "node:test";
const cleanupHosts = [];
after(async () => {
  for (const cleanup of cleanupHosts) await cleanup();
});
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const ENV_KEY = "__kimochiReaderTestEnv";
let bundled;
function bundle() {
  bundled ??= build({
    stdin: {
      contents: `export * from './frontend/texthooker/host'; export * as bridge from './frontend/texthooker/bridge'; export * as routing from './frontend/texthooker/source-sessions'; export * as readerSettings from './frontend/texthooker/lib/settings';`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    alias: { "@texthooker": `${root}frontend/texthooker` },
    plugins: [
      {
        name: "native-test-transport",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:@tauri-apps\/)|bridge\/settings$/ },
            (args) => ({ path: args.path, namespace: "mock" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
            contents: `const env=globalThis[${JSON.stringify(ENV_KEY)}]; export const {listen,emit,invoke,getSetting,setSetting,onSettingsChange,BaseDirectory,exists,mkdir,readTextFile,writeTextFile,readFile,writeFile,remove,rename,open,save,getCurrentWindow}=env;`,
          }));
        },
      },
    ],
  }).then((built) => built.outputFiles[0].text);
  return bundled;
}
async function harness(initial = {}, persistedFiles = new Map(), options = {}) {
  const settings = {
    yomitanSettings: { popupType: "builtin", customApiUrl: "" },
    ...initial,
  };
  const files = new Map(persistedFiles);
  const listeners = new Map();
  const env = {
    settings,
    files,
    failAcknowledgment: false,
    async listen(name, fn) {
      const set = listeners.get(name) || new Set();
      set.add(fn);
      listeners.set(name, set);
      return () => set.delete(fn);
    },
    async emit(name, payload) {
      for (const fn of listeners.get(name) || []) fn({ payload });
    },
    async getSetting(key, fallback) {
      return structuredClone(settings[key] ?? fallback);
    },
    async setSetting(key, value) {
      if (env.failAcknowledgment && key === "texthookerIngestedHistory")
        throw Error("simulated acknowledgement failure");
      settings[key] = structuredClone(value);
      await env.emit("settings:changed", { key, value });
    },
    onSettingsChange(fn) {
      const wrapped = (e) => fn(e.payload.key, e.payload.value);
      void env.listen("settings:changed", wrapped);
      return () => listeners.get("settings:changed")?.delete(wrapped);
    },
    invoked: [],
    holds: [],
    async invoke(command, args) {
      env.invoked.push(command);
      if (command === "hide_popover") return;
      if (command === "history_merge_reset") return;
      if (command === "profile_current")
        return { key: null, root: options.profileRoot ?? "" };
      if (command === "sync_local_changed") return;
      if (command === "sync_hold_ready") {
        env.holds.push(args.id);
        return;
      }
      if (command === "reader_settings_patch")
        return env.setSetting("superTexthooker", {
          ...settings.superTexthooker,
          ...args.patch,
        });
      throw Error(`Unexpected native command ${command}`);
    },
    BaseDirectory: { AppLocalData: 1 },
    async exists(path) {
      return files.has(path);
    },
    async mkdir(path) {
      files.set(path, "directory");
    },
    async readTextFile(path) {
      if (!files.has(path)) throw Error("missing");
      return files.get(path);
    },
    async writeTextFile(path, value) {
      files.set(path, value);
    },
    async readFile(path) {
      return files.get(path);
    },
    async writeFile(path, bytes) {
      files.set(path, bytes);
    },
    async remove(path) {
      files.delete(path);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async open() {
      return null;
    },
    async save() {
      return null;
    },
    getCurrentWindow() {
      return { label: "log" };
    },
  };
  // One esbuild bundle per file, not per harness: the mock transport reads its environment from
  // a fixed global at module initialisation, and each harness imports a fresh copy of the same
  // bundle (a unique trailing comment keeps the data: URLs distinct) after pointing that global
  // at its own env. Bundling the reader a dozen times was most of this file's run time.
  globalThis[ENV_KEY] = env;
  const built = await bundle();
  // Real owner modules + cross-window protocol; only filesystem and Tauri I/O are replaced.
  const api = await import(
    `data:text/javascript;base64,${Buffer.from(`${built}\n//${crypto.randomUUID()}`).toString("base64")}`
  );
  await api.startHost();
  await api.bridge.initializeClient();
  cleanupHosts.push(() => api.bridge.call("stats", "resetStats", []));
  return {
    ...env,
    env,
    api,
    snapshot: () => api.bridge.getSnapshot(),
    call: api.bridge.call,
    drain: () => api.enqueue(async () => undefined),
  };
}
const source = (name, appName = "OpenEmu") => ({
  type: "window",
  name,
  appName,
});
const entry = (id, name, text = "猫が好きです") => ({
  id,
  source: source(name),
  text,
  timestamp: Number(id) || 1,
});

test("OCR intake routes to window sessions, preserves manual selection, and never replays acknowledged history", async () => {
  const h = await harness();
  await h.setSetting("scannedTextHistory", [entry("1", "Game A")]);
  await h.drain();
  assert.equal(
    h
      .snapshot()
      .sessions.sessions.find((s) => s.id === h.snapshot().sessions.activeId)
      .name,
    "Game A",
  );
  assert.equal(h.snapshot().lines.length, 1);
  const a = h.snapshot().sessions.activeId;
  const manual = await h.call("sessions", "createSession", ["Chapter 2"]);
  await h.setSetting("scannedTextHistory", [
    entry("2", "Game A", "次の台詞"),
    entry("1", "Game A"),
  ]);
  await h.drain();
  assert.equal(h.snapshot().sessions.activeId, manual.id);
  assert.deepEqual(
    h.snapshot().lines.map((l) => l.text),
    ["次の台詞"],
  );
  await h.setSetting("scannedTextHistory", [entry("3", "Game B")]);
  await h.drain();
  assert.notEqual(h.snapshot().sessions.activeId, manual.id);
  await h.setSetting("lastSelectedSource", source("Game A"));
  await h.drain();
  assert.equal(
    h.snapshot().sessions.activeId,
    manual.id,
    "explicit choice is remembered for the source",
  );
  await h.call("sessions", "switchSession", [a]);
  assert.equal(h.snapshot().lines.length, 1, "original session remains intact");
  await h.setSetting("scannedTextHistory", [entry("1", "Game A")]);
  await h.drain();
  assert.equal(h.snapshot().lines.length, 1);
  assert.ok(h.files.has(`sessions/${a}/lines.json`));
  await h.call("stats", "resetStats");
});

test("notebook edits and images use the owner and survive a session round trip", async () => {
  const h = await harness();
  const original = h.snapshot().sessions.activeId;
  const person = await h.call("notebook", "createPerson", [
    { family: "田中", given: "花子" },
  ]);
  await h.call("notebook", "addNote", [person.id, "幼なじみ"]);
  await h.call("notebook", "attachImage", [person.id, [1, 2, 3], "png"]);
  await h.call("sessions", "createSession", ["Other"]);
  assert.equal(h.snapshot().notebook.entries.length, 0);
  await h.call("sessions", "switchSession", [original]);
  assert.equal(h.snapshot().notebook.entries[0].notes[0].text, "幼なじみ");
  assert.equal(h.snapshot().notebook.entries[0].images.length, 1);
});

test("matching normalizes case and spacing, avoids ambiguous app matches, and does not associate displays", async () => {
  const { api } = await harness();
  const sessions = [
    { id: "a", name: "Game A" },
    { id: "b", name: "OpenEmu" },
    { id: "c", name: "openemu" },
  ];
  assert.equal(
    api.routing.matchedSession(source(" ＧＡＭＥ   Ａ "), sessions, {}),
    "a",
  );
  assert.equal(
    api.routing.matchedSession(source("unknown"), sessions, {}),
    null,
  );
  assert.equal(
    api.routing.sourceKey({ type: "screen", name: "Display 1" }),
    null,
  );
});

test("restart restores the selected session and never duplicates OCR after an acknowledgment failure", async () => {
  const h = await harness({ superTexthooker: { dedupeDepth: 0 } });
  h.env.failAcknowledgment = true;
  await h.setSetting("scannedTextHistory", [entry("10", "Persistent game")]);
  await h.drain();
  const id = h.snapshot().sessions.activeId;
  // The line reached disk; the separate acknowledgment did not. Its durable ingestion id wins.
  await h.call("stats", "resetStats");
  const restarted = await harness(structuredClone(h.settings), h.files);
  assert.equal(restarted.snapshot().sessions.activeId, id);
  assert.equal(restarted.snapshot().lines.length, 1);
  assert.deepEqual(restarted.snapshot().lines[0].ingestIds, ["10"]);
  await restarted.call("stats", "resetStats");
});

test("disabled matching keeps manual sessions and all input paths share deduplication", async () => {
  const h = await harness({ superTexthooker: { autoMatchSource: false } });
  const active = h.snapshot().sessions.activeId;
  await h.api.readerSettings.updateSettings({ inputSource: "clipboard" });
  await h.call("host", "ingest", ["同じ台詞", "clipboard"]);
  await h.api.readerSettings.updateSettings({ inputSource: "websocket" });
  await h.call("host", "ingest", ["同じ台詞", "websocket"]);
  await h.api.readerSettings.updateSettings({ inputSource: "ocr" });
  await h.setSetting("scannedTextHistory", [
    entry("11", "Different game", "次の台詞"),
  ]);
  await h.drain();
  assert.equal(h.snapshot().sessions.activeId, active);
  assert.deepEqual(
    h.snapshot().lines.map((l) => l.text),
    ["同じ台詞", "次の台詞"],
  );
  await h.call("stats", "resetStats");
});

test("only the selected input is accepted, and excluded scans never replay on switching back", async () => {
  const h = await harness({
    superTexthooker: { inputSource: "clipboard", autoMatchSource: false },
  });
  await h.call("host", "ingest", ["clipboard line", "clipboard"]);
  await h.call("host", "ingest", ["wrong socket", "websocket"]);
  await h.setSetting("scannedTextHistory", [
    entry("50", "Excluded game", "excluded scan"),
  ]);
  await h.drain();
  assert.deepEqual(
    h.snapshot().lines.map((l) => l.text),
    ["clipboard line"],
  );
  await h.api.readerSettings.updateSettings({ inputSource: "websocket" });
  await h.call("host", "ingest", ["late clipboard", "clipboard"]);
  await h.call("host", "ingest", ["socket line", "websocket"]);
  await h.api.readerSettings.updateSettings({ inputSource: "ocr" });
  await h.setSetting("scannedTextHistory", [
    entry("51", "Game", "new scan"),
    entry("50", "Excluded game", "excluded scan"),
  ]);
  await h.drain();
  assert.deepEqual(
    h.snapshot().lines.map((l) => l.text),
    ["clipboard line", "socket line", "new scan"],
  );
  await h.call("stats", "resetStats");
});

test("Dictionary is authoritative across reader updates and resets", async () => {
  const h = await harness({
    yomitanSettings: {
      popupType: "custom-api",
      customApiUrl: "http://localhost:1234",
    },
    superTexthooker: {
      yomitanApiUrl: "http://obsolete.invalid",
      dictionaryMode: "builtin",
    },
  });
  assert.equal(
    h.api.readerSettings.getSettings().yomitanApiUrl,
    "http://localhost:1234",
  );
  assert.equal(h.api.readerSettings.getSettings().dictionaryMode, "custom-api");
  await h.api.readerSettings.updateSettings({
    yomitanApiUrl: "http://ignored.invalid",
    dictionaryMode: "builtin",
    fontSizePx: 20,
  });
  assert.equal(
    h.api.readerSettings.getSettings().yomitanApiUrl,
    "http://localhost:1234",
  );
  assert.equal(h.api.readerSettings.getSettings().fontSizePx, 20);
  await h.api.readerSettings.resetSettings();
  assert.equal(h.api.readerSettings.getSettings().dictionaryMode, "custom-api");
  await h.setSetting("yomitanSettings", {
    popupType: "builtin",
    customApiUrl: "http://localhost:2345",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.api.readerSettings.getSettings().yomitanApiUrl,
    "http://localhost:2345",
  );
  assert.equal(h.api.readerSettings.getSettings().dictionaryMode, "builtin");
  await h.call("stats", "resetStats");
});

test('semantic OCR groups remain separate with independent durable replay IDs', async () => {
  const scan={...entry('page-1','Manga','同じ台詞\n同じ台詞\n同じ台詞の続き'),engine:'mangaocr',groups:[
    {id:'bubble-1',text:'同じ台詞',bbox:[0,0,20,80],orientation:'vertical'},
    {id:'bubble-2',text:'同じ台詞',bbox:[50,0,70,80],orientation:'vertical'},
    {id:'bubble-3',text:'同じ台詞の続き',bbox:[100,0,120,80],orientation:'vertical'}
  ]}
  const h=await harness({scannedTextHistory:[scan],superTexthooker:{inputSource:'ocr',startMergeEnabled:true,startMergePrefixLen:2,dedupeDepth:100,cjkOnly:true,tokenizeOnArrival:false}})
  assert.deepEqual(h.snapshot().lines.map(l=>l.text),scan.groups.map(g=>g.text))
  assert.deepEqual(h.snapshot().lines.map(l=>l.ocr.groupIndex),[0,1,2])
  assert.equal(h.snapshot().lines[0].ocr.groupCount,3)
  const replay=await harness({...h.settings,texthookerIngestedHistory:[]},h.files)
  assert.equal(replay.snapshot().lines.length,3)
})

const resets = (h) => h.invoked.filter((c) => c === 'history_merge_reset').length;

test('clearing the log tells native to forget the scans it held, so the same text logs again', async () => {
  const h = await harness({ superTexthooker: { autoMatchSource: false } });
  await h.setSetting('scannedTextHistory', [entry('20', 'Game', '消した台詞')]);
  await h.drain();
  assert.deepEqual(h.snapshot().lines.map((l) => l.text), ['消した台詞']);
  const before = resets(h);
  await h.setSetting('scannedTextHistory', [entry('21', 'Game', '次の台詞'), entry('20', 'Game', '消した台詞')]);
  await h.drain();
  assert.equal(resets(h), before, 'nothing to forget while the log holds its lines');
  await h.call('store', 'clearLines');
  await h.drain();
  assert.deepEqual(h.snapshot().lines, []);
  // Native merges a rescan of recent text into the entry already there; after the clear it
  // must not, and only this signal tells it the log no longer holds that entry.
  assert.equal(resets(h), before + 1);
  await h.setSetting('scannedTextHistory', [entry('22', 'Game', '消した台詞'), entry('21', 'Game', '次の台詞'), entry('20', 'Game', '消した台詞')]);
  await h.drain();
  assert.deepEqual(h.snapshot().lines.map((l) => l.text), ['消した台詞']);
  await h.call('stats', 'resetStats');
});

test('a new or switched-to session tells native to forget the scans, so the same text logs there too', async () => {
  const h = await harness({ superTexthooker: { autoMatchSource: false } });
  const first = h.snapshot().sessions.activeId;
  await h.setSetting('scannedTextHistory', [entry('30', 'Game', '同じ台詞')]);
  await h.drain();
  let before = resets(h);
  await h.call('sessions', 'createSession', ['Empty']);
  assert.deepEqual(h.snapshot().lines, []);
  assert.ok(resets(h) > before, 'creating a session forgets');
  await h.setSetting('scannedTextHistory', [entry('31', 'Game', '同じ台詞'), entry('30', 'Game', '同じ台詞')]);
  await h.drain();
  assert.deepEqual(h.snapshot().lines.map((l) => l.text), ['同じ台詞']);
  before = resets(h);
  await h.call('sessions', 'switchSession', [first]);
  assert.ok(resets(h) > before, 'switching sessions forgets');
  await h.call('stats', 'resetStats');
});

test("whole-screen Gaming Mode routes sessions by game identity without renaming the portal source", async () => {
  const { api } = await harness();
  const a = {
    type: "screen",
    sourceId: "portal:display:80",
    name: "Screen",
    applicationContext: { id: "steam:42", name: "Game" },
  };
  const b = { ...a, applicationContext: { id: "steam:43", name: "Game" } };
  const sessions = [
    { id: "a", name: "Game" },
    { id: "b", name: "Game" },
  ];
  assert.equal(api.routing.sourceKey(a), "application:steam:42");
  assert.equal(api.routing.matchedSession(a, sessions, {}), null);
  assert.equal(
    api.routing.matchedSession(a, sessions, { "application:steam:42": "a" }),
    "a",
  );
  assert.equal(
    api.routing.matchedSession(b, sessions, { "application:steam:42": "a" }),
    null,
  );
  assert.equal(api.routing.sourceKey({ type: "screen", name: "Screen" }), null);
});

test("game sidecar context reuses its reader session across portal IDs and keeps other games separate", async () => {
  const h = await harness();
  const source = (id, sourceId = "portal:display:80") => ({
    type: "screen",
    name: "Screen",
    sourceId,
    applicationContext: { id: `steam:${id}`, name: "Game" },
  });
  await h.setSetting("scannedTextHistory", [
    { id: "game-1", text: "猫", timestamp: 1, source: source(42) },
  ]);
  await h.drain();
  const first = h.snapshot().sessions.activeId;
  assert.equal(
    h.snapshot().sessions.sessions.find((s) => s.id === first).name,
    "Game",
  );
  await h.setSetting("scannedTextHistory", [
    { id: "game-2", text: "犬", timestamp: 2, source: source(43) },
  ]);
  await h.drain();
  assert.notEqual(h.snapshot().sessions.activeId, first);
  await h.setSetting("scannedTextHistory", [
    {
      id: "game-3",
      text: "鳥",
      timestamp: 3,
      source: source(42, "portal:display:99"),
    },
  ]);
  await h.drain();
  assert.equal(h.snapshot().sessions.activeId, first);
  assert.deepEqual(
    h.snapshot().lines.map((line) => line.text),
    ["猫", "鳥"],
  );
});

const waitFor = async (check) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out");
};
const linesFile = (h, sid) => JSON.parse(h.files.get(`sessions/${sid}/lines.json`));

test("an account's profile keeps the Log in its own folder", async () => {
  const h = await harness({}, new Map(), { profileRoot: "profiles/cloud-u1" });
  await h.setSetting("scannedTextHistory", [entry("1", "Game A")]);
  await h.drain();
  const sid = h.snapshot().sessions.activeId;
  assert.ok(h.files.has("profiles/cloud-u1/sessions.json"));
  assert.ok(h.files.has(`profiles/cloud-u1/sessions/${sid}/lines.json`));
  assert.ok(!h.files.has("sessions.json"), "the Local profile is untouched");
});

test("lines carry uids for Sync, old lines get the same uid Rust derives, and deletes are remembered", async () => {
  const files = new Map([
    [
      "sessions.json",
      JSON.stringify({ version: 1, activeId: "s1", sessions: [{ id: "s1", name: "Old", description: "", createdAt: 1, updatedAt: 1 }] }),
    ],
    [
      "sessions/s1/lines.json",
      JSON.stringify({ version: 1, lines: [{ id: 7, text: "猫", source: "ocr", ts: 1700000000000 }] }),
    ],
  ]);
  const h = await harness({ superTexthooker: { inputSource: "ocr" } }, files);
  // The same vector as sync_core's `lines_without_uids_get_the_same_uid_everywhere`.
  assert.equal(h.snapshot().lines[0].uid, "lac08c75e3214c5be");
  await h.setSetting("scannedTextHistory", [{ id: "n1", text: "犬", timestamp: 2 }]);
  await h.drain();
  const fresh = h.snapshot().lines.find((l) => l.text === "犬");
  assert.match(fresh.uid, /^[0-9a-f-]{36}$/);
  await h.call("store", "deleteLine", [7]);
  const file = linesFile(h, "s1");
  assert.deepEqual(file.deleted.map((d) => d.uid), ["lac08c75e3214c5be"]);
  assert.equal(file.lines[0].uid, fresh.uid, "uids are written to the file");
});

test("Sync's hold pauses the Log's writes, and its release reloads the merged lines", async () => {
  const h = await harness();
  await h.setSetting("scannedTextHistory", [entry("1", "Game A")]);
  await h.drain();
  const sid = h.snapshot().sessions.activeId;
  await h.emit("sync:hold", { id: 1 });
  await waitFor(() => h.holds.includes(1));
  // Meanwhile a Log operation waits its turn rather than writing over the merge.
  const pending = h.call("sessions", "renameSession", [sid, "Renamed"]);
  const merged = linesFile(h, sid);
  merged.lines.push({ id: 2, uid: "from-other-computer", text: "二", source: "ocr", ts: 9e12 });
  h.files.set(`sessions/${sid}/lines.json`, JSON.stringify(merged));
  await h.emit("sync:release", { id: 1, changed: { sessions: false, lines: [sid], notebook: [], presets: false } });
  await pending;
  await h.drain();
  assert.deepEqual(h.snapshot().lines.map((l) => l.text), ["猫が好きです", "二"]);
  assert.equal(h.snapshot().sessions.sessions.find((s) => s.id === sid).name, "Renamed");
  assert.equal(linesFile(h, sid).lines.length, 2, "the merged file is kept");
});
