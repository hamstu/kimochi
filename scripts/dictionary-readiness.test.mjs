import assert from "node:assert/strict";
import test from "node:test";
import {
  hachidoriReadiness,
  canLookUp,
  tentenReadiness,
  watchReadiness,
} from "../host/ext/readiness.js";

test("Hachidori needs a loaded dictionary, not merely a running background", () => {
  assert.equal(
    hachidoriReadiness({ ok: true, ready: false }).phase,
    "starting",
  );
  assert.equal(
    hachidoriReadiness({ ok: true, ready: true, dictionaryCount: 0 }).phase,
    "setup-needed",
  );
  assert.equal(
    hachidoriReadiness({
      ok: true,
      ready: true,
      dictionaryCount: 2,
      loading: true,
    }).phase,
    "installing",
  );
  assert.equal(
    hachidoriReadiness({
      ok: true,
      ready: true,
      dictionaryCount: 2,
      updating: { id: "import" },
    }).phase,
    "installing",
  );
  assert.equal(
    hachidoriReadiness({ ok: false, error: "WASM failed" }).phase,
    "failed",
  );
  assert.equal(
    hachidoriReadiness({
      ok: true,
      ready: true,
      dictionaryCount: 2,
      failedDictionaries: ["missing"],
    }).phase,
    "failed",
  );
  assert.equal(
    hachidoriReadiness({ ok: true, ready: true, dictionaryCount: 2 }).phase,
    "ready",
  );
  const install = {
    finished: false,
    entries: [{ phase: "downloading", receivedBytes: 25, totalBytes: 100 }],
  };
  assert.equal(
    hachidoriReadiness({ ready: true, dictionaryCount: 1 }, install).phase,
    "downloading",
  );
  assert.equal(hachidoriReadiness(null, install).progress, 25);
  assert.equal(
    hachidoriReadiness(null, { finished: true, entries: [{ phase: "failed" }] })
      .phase,
    "failed",
  );
});

const data = (state = "ok") =>
  Object.fromEntries(
    ["words", "kanji", "radicals", "names"].map((name) => [name, { state }]),
  );

test("an installed Hachidori engine is checked promptly while loading, then returns to idle polling", async () => {
  const scheduled = [];
  const statuses = [];
  const replies = [{ ready: false }, { ready: true, dictionaryCount: 1 }];
  const stop = watchReadiness({
    win: { addEventListener() {}, clearTimeout() {}, setTimeout(job, delay) { scheduled.push({ job, delay }); return 1; } },
    engine: "hachidori",
    chrome: { runtime: { sendMessage: async () => replies.shift() } },
    publish: (status) => statuses.push(status),
  });
  await Promise.resolve();
  assert.equal(scheduled[0].delay, 250);
  await scheduled[0].job();
  assert.equal(statuses.at(-1).phase, "ready");
  assert.equal(scheduled[1].delay, 2000);
  stop();
});
test("10ten waits for every data series and the end of database writes", () => {
  assert.equal(
    tentenReadiness({ ...data("init"), updateState: { type: "idle" } }).phase,
    "setup-needed",
  );
  const downloading = {
    ...data("empty"),
    updateState: { type: "updating", series: "words", totalProgress: 0.42 },
  };
  assert.equal(tentenReadiness(downloading).progress, 42);
  assert.equal(tentenReadiness(downloading).phase, "downloading");
  assert.equal(
    tentenReadiness({ ...data(), updateState: { type: "updating" } }).phase,
    "downloading",
  );
  assert.equal(
    tentenReadiness({
      ...data(),
      names: { state: "unavailable" },
      updateState: { type: "idle" },
    }).phase,
    "setup-needed",
  );
  assert.equal(
    tentenReadiness({ ...data("empty"), updateError: { message: "Offline" } })
      .phase,
    "failed",
  );
  assert.equal(
    tentenReadiness({ ...data(), updateState: { type: "idle" } }).phase,
    "ready",
  );
});

test("10ten looks words up in every phase, Hachidori only once ready", () => {
  // 10ten's bundled words (data/words.ljson) answer while the full dictionary downloads or fails.
  for (const state of [
    { updateState: { type: "updating", series: "words", totalProgress: 0.1 } },
    { updateError: { message: "Offline" } },
    { updateState: { type: "idle" } },
  ])
    assert.equal(canLookUp(tentenReadiness(state)), true);
  assert.equal(canLookUp({ phase: "downloading" }), false);
  assert.equal(canLookUp({ phase: "ready" }), true);
  assert.equal(canLookUp(hachidoriReadiness({ ok: true, ready: false })), false);
});

test("10ten observer follows its options port through progress, failure, recovery and shutdown", () => {
  let message,
    disconnected,
    closed = false;
  const statuses = [];
  const win = { addEventListener() {}, setTimeout, clearTimeout };
  const chrome = {
    runtime: {
      connect: ({ name }) => {
        assert.equal(name, "options");
        return {
          onMessage: {
            addListener: (fn) => {
              message = fn;
            },
          },
          onDisconnect: {
            addListener: (fn) => {
              disconnected = fn;
            },
          },
          disconnect: () => {
            closed = true;
          },
        };
      },
    },
  };
  const stop = watchReadiness({
    win,
    engine: "tenten",
    chrome,
    publish: (state) => statuses.push(state),
  });
  message({
    type: "dbstateupdated",
    state: {
      ...data("empty"),
      updateState: { type: "updating", totalProgress: 0.25 },
    },
  });
  message({
    type: "dbstateupdated",
    state: { ...data("empty"), updateError: {} },
  });
  message({
    type: "dbstateupdated",
    state: { ...data(), updateState: { type: "idle" } },
  });
  assert.deepEqual(
    statuses.map((s) => s.phase),
    ["starting", "downloading", "failed", "ready"],
  );
  assert.equal(typeof disconnected, "function");
  stop();
  assert.equal(closed, true);
  message({ type: "dbstateupdated", state: {} });
  assert.equal(statuses.length, 4);
});

test("Hachidori's ready status says how its engine runs", () => {
  assert.deepEqual(
    hachidoriReadiness({ ok: true, ready: true, dictionaryCount: 5, threaded: true, storageBackend: "idbfs" }),
    { phase: "ready", message: "Hachidori is ready.", dictionaries: 5, threaded: true, storage: "idbfs" },
  );
  assert.equal(hachidoriReadiness({ ok: true, ready: true, dictionaryCount: 1 }).threaded, false);
});
