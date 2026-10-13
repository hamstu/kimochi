import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "./sync-extension.mjs";
import {
  SCENE,
  apiPayload,
  buildExcerpt,
  dictionaryTitle,
  limitDictionaries,
  lookupTerms,
  writeZip,
} from "./dictionary-previews.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const previews = path.join(root, "frontend/assets/dictionary-previews");
const json = (value) => Buffer.from(JSON.stringify(value));

/** A small Yomitan dictionary: an index, a tag bank, two term banks and a frequency bank. */
function dictionary() {
  return writeZip(
    new Map([
      [
        "index.json",
        json({
          title: "JMdict [test]",
          format: 3,
          revision: "test",
          attribution: "EDRDG",
        }),
      ],
      ["tag_bank_1.json", json([["v1", "partOfSpeech", 0, "Ichidan verb", 0]])],
      [
        "term_bank_1.json",
        json([["食べる", "たべる", "v1", "v1", 0, ["to eat"], 1, ""]]),
      ],
      [
        "term_bank_2.json",
        json([
          ["猫", "ねこ", "", "n", 0, ["cat"], 2, ""],
          ["食", "しょく", "", "n", 0, ["food"], 3, ""],
        ]),
      ],
      [
        "term_meta_bank_1.json",
        json([
          ["食べる", "freq", 173],
          ["猫", "freq", 900],
        ]),
      ],
    ]),
  );
}

test("the scene looks up a conjugated verb in its line", () => {
  assert.ok(SCENE.line.includes(SCENE.word));
  const terms = lookupTerms();
  for (const term of ["食", "食べ", SCENE.word, ...SCENE.lemmas])
    assert.ok(terms.has(term), term);
  assert.ok(!terms.has("あの日"), "nothing before the word");
});

test("writeZip round-trips through the release zip reader", () => {
  const entries = readZip(dictionary());
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [
      "index.json",
      "tag_bank_1.json",
      "term_bank_1.json",
      "term_bank_2.json",
      "term_meta_bank_1.json",
    ],
  );
  assert.equal(dictionaryTitle(dictionary()), "JMdict [test]");
});

test("an excerpt keeps the index, every tag and only the entries the lookup reaches", () => {
  const files = buildExcerpt(dictionary(), lookupTerms());
  assert.deepEqual(
    [...files.keys()],
    [
      "index.json",
      "tag_bank_1.json",
      "term_bank_1.json",
      "term_bank_2.json",
      "term_meta_bank_1.json",
    ],
  );
  assert.deepEqual(
    JSON.parse(files.get("term_bank_2.json")).map((row) => row[0]),
    ["食"],
  );
  assert.deepEqual(JSON.parse(files.get("term_meta_bank_1.json")), [
    ["食べる", "freq", 173],
  ]);
  assert.equal(JSON.parse(files.get("index.json")).attribution, "EDRDG");
  assert.equal(buildExcerpt(dictionary(), new Set(["犬"])), null);
});

test("a Yomitan API answer keeps only the allowed dictionaries", () => {
  const allowed = (name) => name.startsWith("JMdict") || name === "CC100";
  const glossary =
    '<div><ol><li data-dictionary="JMdict [x]"><i>(v1)</i> to eat</li><style>.a{}</style>' +
    '<li data-dictionary="新和英"><i>(新和英)</i> eat</li><style>.a{}</style></ol></div>';
  assert.equal(
    limitDictionaries(glossary, allowed),
    '<div><ol><li data-dictionary="JMdict [x]"><i>(v1)</i> to eat</li><style>.a{}</style></ol></div>',
  );
  assert.equal(
    limitDictionaries(
      "<ul><li>CC100: 173</li><li>JPDB: 195</li></ul>",
      allowed,
    ),
    "<ul><li>CC100: 173</li></ul>",
  );
  const payload = apiPayload(
    {
      fields: [
        {
          expression: "食べる",
          dictionary: "JMdict [x]",
          glossary,
          frequencies: "<ul><li>JPDB: 195</li></ul>",
        },
        {
          expression: "食べる",
          dictionary: "新和英",
          glossary: "",
          frequencies: "",
        },
      ],
    },
    {
      term: "食べられなかった",
      sentence: "食べられなかった",
      baseUrl: "http://127.0.0.1:19633",
      allowed,
    },
  );
  assert.equal(payload.kind, "loaded");
  assert.equal(payload.entries.length, 1);
  assert.ok(!payload.entries[0].glossary.includes("新和英"));
  assert.equal(payload.entries[0].frequencies, "<ul></ul>");
});

test("the recorded Yomitan API answer shows only JMdict and CC100", async () => {
  const recording = JSON.parse(
    await readFile(
      path.join(root, "scripts/fixtures/dictionary-previews/yomitan-api.json"),
      "utf8",
    ),
  );
  assert.equal(recording.kind, "loaded");
  assert.ok(recording.entries.length > 0);
  for (const entry of recording.entries) {
    assert.match(entry.dictionary, /^JMdict\b/);
    for (const [, name] of entry.glossary.matchAll(
      /data-dictionary="([^"]*)"/g,
    ))
      assert.match(name, /^JMdict\b/);
  }
});

test("the preview pictures are named for an engine and theme and stay small", async () => {
  const names = (await readdir(previews)).filter(
    (name) => name !== "README.md",
  );
  for (const name of names) {
    assert.match(
      name,
      /^(yomitan|hachidori|tenten|custom-api)-(light|dark)\.(webp|png|jpe?g)$/,
      name,
    );
    const { size } = await stat(path.join(previews, name));
    assert.ok(
      size <= 150 * 1024,
      `${name} is ${Math.round(size / 1024)} KB (at most 150 KB)`,
    );
  }
});
