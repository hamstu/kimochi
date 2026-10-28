import test from "node:test";
import assert from "node:assert/strict";
import { createDictionarySetup } from "../ui/setup-dictionaries.js";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness({
  existing = [],
  http = 200,
  importError = null,
  enableError = false,
  backendError = false,
  entries = 4,
} = {}) {
  const calls = [];
  const jobs = createDictionarySetup({
    api: async (action, params) => {
      calls.push([action, params]);
      if (backendError) throw Error("Backend disconnected");
      if (action === "getDictionaryInfo") return existing;
      if (action === "optionsGetFull")
        return {
          profileCurrent: 1,
          profiles: [
            { options: {} },
            {
              options: { dictionaries: [{ name: "Keep me", enabled: false }] },
            },
          ],
        };
      if (action === "modifySettings")
        return [
          { error: enableError ? { message: "Storage full" } : undefined },
        ];
    },
    countEntries: async () => entries,
    fetchArchive: async () => ({
      ok: http === 200,
      status: http,
      arrayBuffer: async () => new ArrayBuffer(1),
    }),
    importArchive: async () => {
      if (importError) return { errors: [Error(importError)] };
      existing.push({
        title: "Jitendex.org [2026-10-03]",
        importSuccess: true,
      });
      return { errors: [], result: existing.at(-1) };
    },
  });
  return { jobs, calls };
}
async function run(jobs) {
  const { id } = await jobs.handle({
    command: "start",
    dictionaryId: "jitendex",
  });
  await tick();
  return jobs.handle({ command: "status", id });
}
test("job returns immediately, duplicate starts reuse it, only selected profile dictionary changes", async () => {
  const { jobs, calls } = harness();
  const first = await jobs.handle({
    command: "start",
    dictionaryId: "jitendex",
  });
  assert.equal(
    (await jobs.handle({ command: "start", dictionaryId: "jitendex" })).id,
    first.id,
  );
  await tick();
  assert.equal(
    (await jobs.handle({ command: "status", id: first.id })).stage,
    "complete",
  );
  assert.equal(
    calls.find(([action]) => action === "modifySettings")[1].targets[0].path,
    "profiles[1].options.dictionaries",
  );
  assert.equal(
    calls.some(([action]) => action === "setAllSettings"),
    false,
  );
});
test("complete existing import is reused", async () => {
  assert.equal(
    (
      await run(
        harness({
          existing: [{ title: "Jitendex.org [2026]", importSuccess: true }],
        }).jobs,
      )
    ).stage,
    "complete",
  );
});
for (const [name, config, error] of [
  ["download HTTP failure", { http: 503 }, /HTTP 503/],
  [
    "import failure",
    { importError: "Media decode failed" },
    /Media decode failed/,
  ],
  ["enable failure", { enableError: true }, /Storage full/],
  ["backend failure", { backendError: true }, /Backend disconnected/],
  ["empty import", { entries: 0 }, /no term entries/],
  [
    "incomplete existing import preserved",
    { existing: [{ title: "Jitendex.org [2026]", importSuccess: false }] },
    /incomplete/,
  ],
])
  test(name, async () => {
    const { jobs } = harness(config);
    const result = await run(jobs);
    assert.equal(result.stage, "failed");
    assert.match(result.error, error);
  });
test("unknown selection rejected before downloads", async () => {
  await assert.rejects(
    harness().jobs.handle({ command: "start", dictionaryId: "other" }),
    /Unknown recommended/,
  );
});

test("long import runs independently of requesting panel and status polling", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const existing = [];
  const jobs = createDictionarySetup({
    api: async (action) => {
      if (action === "getDictionaryInfo") return existing;
      if (action === "optionsGetFull")
        return {
          profileCurrent: 0,
          profiles: [{ options: { dictionaries: [] } }],
        };
    },
    countEntries: async () => 7,
    fetchArchive: async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    }),
    importArchive: async () => {
      await pending;
      existing.push({ title: "Jitendex.org [test]", importSuccess: true });
      return { errors: [], result: existing[0] };
    },
  });
  const { id } = await jobs.handle({
    command: "start",
    dictionaryId: "jitendex",
  });
  await tick();
  assert.equal(
    (await jobs.handle({ command: "status", id })).stage,
    "importing",
  );
  finish();
  await tick();
  assert.equal(
    (await jobs.handle({ command: "status", id })).stage,
    "complete",
  );
});
test("practice uses the selected profile and reports real lookup results", async () => {
  let received;
  const jobs = createDictionarySetup({
    api: async (action, params) => {
      received = { action, params };
      return { dictionaryEntries: [{}, {}] };
    },
  });
  assert.deepEqual(await jobs.handle({ command: "practice" }), {
    text: "日本語",
    matches: 2,
  });
  assert.equal(received.action, "termsFind");
  assert.equal(received.params.optionsContext.current, true);
});
test("catalog can add a second dictionary without changing job behavior", async () => {
  const enabled = [];
  const jobs = createDictionarySetup({
    catalog: [
      {
        id: "other",
        title: "Other dictionary",
        titlePrefix: "Other ",
        url: "https://example.com/other.zip",
      },
    ],
    api: async (action, params) => {
      if (action === "getDictionaryInfo")
        return [{ title: "Other [1]", importSuccess: true }];
      if (action === "optionsGetFull")
        return {
          profileCurrent: 0,
          profiles: [{ options: { dictionaries: [] } }],
        };
      if (action === "modifySettings") {
        enabled.push(params.targets[0].items[0].name);
        return [{}];
      }
    },
    countEntries: async () => 123,
    fetchArchive: async () => {
      throw Error("Complete dictionaries must not download again");
    },
  });
  const { id } = await jobs.handle({ command: "start", dictionaryId: "other" });
  await tick();
  assert.equal(
    (await jobs.handle({ command: "status", id })).stage,
    "complete",
  );
  assert.deepEqual(enabled, ["Other [1]"]);
});
test("catalog reports installed dictionaries and which the current profile uses", async () => {
  const { jobs } = harness({
    existing: [
      { title: "Keep me", importSuccess: true },
      { title: "JMnedict [2026-01-01]", importSuccess: true },
    ],
  });
  const { catalog, dictionaries } = await jobs.handle({ command: "catalog" });
  assert.equal(catalog[0].id, "jitendex");
  // The harness's current profile lists "Keep me", disabled, and nothing else.
  assert.deepEqual(
    dictionaries.map(({ title, enabled }) => [title, enabled]),
    [
      ["Keep me", false],
      ["JMnedict [2026-01-01]", false],
    ],
  );
});
test("a dictionary enabled in the current profile is reported ready", async () => {
  const jobs = createDictionarySetup({
    api: async (action) => {
      if (action === "getDictionaryInfo")
        return [{ title: "Jitendex.org [2026-10-03]", importSuccess: true }];
      if (action === "optionsGetFull")
        return {
          profileCurrent: 0,
          profiles: [
            {
              options: {
                dictionaries: [{ name: "Jitendex.org [2026-10-03]", enabled: true }],
              },
            },
          ],
        };
    },
  });
  const { dictionaries } = await jobs.handle({ command: "catalog" });
  assert.equal(dictionaries[0].enabled, true);
});

test("catalog hands back the latest job, so a reopened guide resumes its progress", async () => {
  const { jobs } = harness();
  assert.equal((await jobs.handle({ command: "catalog" })).job, null);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = createDictionarySetup({
    api: async (action) => (action === "getDictionaryInfo" ? [] : undefined),
    countEntries: async () => 1,
    fetchArchive: async () => {
      await gate;
      return { ok: false, status: 503 };
    },
    importArchive: async () => ({ errors: [] }),
  });
  const { id } = await slow.handle({ command: "start", dictionaryId: "jitendex" });
  await tick();
  const during = await slow.handle({ command: "catalog" });
  assert.equal(during.job.id, id);
  assert.equal(during.job.stage, "downloading");
  release();
  await tick();
  await tick();
  const after = await slow.handle({ command: "catalog" });
  assert.equal(after.job.id, id);
  assert.equal(after.job.stage, "failed");
});
