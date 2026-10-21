import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";
const { normalizeOcrResult, inferOrientations, logicalGroups } =
  await load("ocr-result.ts");
const { withDefaults, OCR_MODES, SETTINGS_DEFAULTS } = await load("settings.ts");
const annotation = (description, x, y, width, height, extra = {}) => ({
  description,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  },
  ...extra,
});
test("explicit direction overrides aspect; tall text and square glyph neighbors provide fallback", () => {
  const input = [
    annotation("縦書き", 0, 0, 12, 70),
    annotation("横", 100, 0, 80, 15, { isVertical: true }),
    annotation("明", 200, 0, 16, 16),
    annotation("日", 200, 20, 16, 16),
    annotation("も", 200, 40, 16, 16),
  ];
  const result = inferOrientations(input);
  assert.ok(result.every((a) => a.isVertical));
  assert.equal(
    inferOrientations([annotation("横書き", 0, 0, 80, 15)])[0].orientation,
    "horizontal",
  );
  assert.equal(
    inferOrientations([
      annotation("縦書き", 0, 0, 12, 70, { orientation: "horizontal" }),
    ])[0].isVertical,
    false,
  );
});
test("cloud character fragments become paragraphs instead of one row per character", () => {
  const result = logicalGroups([
    annotation("今", 0, 0, 16, 16),
    annotation("日", 20, 0, 16, 16),
    annotation("は", 40, 0, 16, 16),
    annotation("晴", 0, 22, 16, 16, { orientation: "horizontal" }),
    annotation("れ", 20, 22, 16, 16, { orientation: "horizontal" }),
    annotation("別", 200, 0, 16, 16),
    annotation("の", 220, 0, 16, 16),
    annotation("話", 240, 0, 16, 16),
  ]);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].text, "今日は\n晴れ");
  assert.equal(result.groups[1].text, "別の話");
});
test("vertical columns read downwards then right to left", () => {
  const a = [];
  for (const [x, text] of [
    [60, "今日は"],
    [36, "晴れだ"],
  ])
    for (const [i, c] of [...text].entries())
      a.push(annotation(c, x, i * 20, 16, 16, { orientation: "vertical" }));
  const result = logicalGroups(a);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].text, "今日は\n晴れだ");
});
test("semantic blocks remain independent even when adjacent or identical", () => {
  const result = normalizeOcrResult(
    {
      groups: [
        {
          id: "a",
          text: "うん",
          bbox: [0, 0, 20, 80],
          orientation: "vertical",
        },
        {
          id: "b",
          text: "うん",
          bbox: [22, 0, 42, 80],
          orientation: "vertical",
        },
      ],
    },
    "mangaocr",
  );
  assert.equal(result.groups.length, 2);
  assert.equal(result.fullText, "うん\nうん");
  assert.equal(result.textAnnotations[1].granularity, "block");
  assert.equal(result.textAnnotations[2].groupId, "b");
  assert.equal(result.geometry, true);
});
test("text-only engines retain text as a group without invented positions", () => {
  const result = normalizeOcrResult(
    { fullText: "文章", geometry: false },
    "cloud",
  );
  assert.equal(result.groups[0].bbox, null);
  assert.equal(result.geometry, false);
  assert.equal(result.textAnnotations.length, 0);
});
test("removed Tesseract preference migrates to native MeikiOCR", () => {
  assert.equal(withDefaults("ocrMode", "local"), "meikiocr");
  assert.equal(OCR_MODES.local, undefined);
  assert.equal(OCR_MODES.mangaocr.geometry, true);
});
test("removed OwOCR preference falls back to the default engine", () => {
  assert.equal(withDefaults("ocrMode", "websocket"), SETTINGS_DEFAULTS.ocrMode);
  assert.equal(OCR_MODES.websocket, undefined);
});

test("Apple Live Text's lines become one block each, vertical where the engine says so", () => {
  const column = [[300, 10], [330, 10], [330, 130], [300, 130]];
  const result = normalizeOcrResult({
    fullText: "日本語のテスト\n縦書き",
    groups: [
      { id: "livetext-line-0", text: "日本語のテスト", bbox: [10, 20, 270, 62], orientation: "horizontal", linePolygons: [[[10, 20], [270, 20], [270, 62], [10, 62]]] },
      { id: "livetext-line-1", text: "縦書き", bbox: [300, 10, 330, 130], orientation: "vertical", linePolygons: [column] },
    ],
    textAnnotations: [
      annotation("日本語のテスト", 10, 20, 260, 42, { granularity: "line", groupId: "livetext-line-0" }),
      annotation("縦書き", 300, 10, 30, 120, { granularity: "line", groupId: "livetext-line-1" }),
    ]
  }, "livetext");
  assert.equal(result.geometry, true);
  assert.equal(result.groups.length, 2);
  assert.equal(result.textAnnotations.length, 3);
  assert.equal(result.textAnnotations[2].description, "縦書き");
  assert.equal(result.textAnnotations[2].granularity, "block");
  assert.equal(result.textAnnotations[2].isVertical, true);
  assert.deepEqual(result.textAnnotations[2].linePolygons, [column]);
});

test("OneOCR's semantic line overrides jittered glyph gaps without inserting Japanese spaces", () => {
  const polygon = [[10, 20], [270, 20], [270, 62], [10, 62]];
  const result = normalizeOcrResult({
    fullText: "日本語のテスト API",
    groups: [{ id: "oneocr-line-0", text: "日本語のテスト API", bbox: [10, 20, 270, 62], orientation: "horizontal", linePolygons: [polygon] }],
    textAnnotations: [
      annotation("日", 10, 24, 8, 20, { granularity: "fragment", groupId: "oneocr-line-0" }),
      annotation("本", 70, 20, 25, 42, { granularity: "fragment", groupId: "oneocr-line-0" }),
      annotation("語", 120, 22, 13, 26, { granularity: "fragment", groupId: "oneocr-line-0" }),
    ]
  }, "oneocr");
  assert.equal(result.fullText, "日本語のテスト API");
  assert.equal(result.textAnnotations.length, 2);
  assert.equal(result.textAnnotations[1].description, "日本語のテスト API");
  assert.equal(result.textAnnotations[1].granularity, "block");
  assert.deepEqual(result.textAnnotations[1].linePolygons, [polygon]);
});

test("normalising a saved result again keeps the engine's words, not one box per group", () => {
  // A cloud result: words, no groups. A reloaded overlay redraws the saved, normalised scan.
  const words = ["今日", "は", "いい", "天気", "です", "ね"].map((d, i) =>
    annotation(d, 100 + i * 60, 100, 55, 40),
  );
  const raw = {
    fullText: "今日はいい天気ですね",
    textAnnotations: [annotation("今日はいい天気ですね", 100, 100, 360, 40), ...words],
  };
  const live = normalizeOcrResult(raw, "cloud");
  assert.equal(live.textAnnotations.length - 1, 6);
  assert.ok(live.groups.every((g) => g.inferred));
  assert.deepEqual(normalizeOcrResult(live, "cloud"), live);
});

test("groups an engine supplied are still drawn as its blocks", () => {
  const raw = {
    fullText: "猫",
    groups: [{ id: "b0", text: "猫", bbox: [0, 0, 40, 40], orientation: "horizontal" }],
    textAnnotations: [annotation("猫", 0, 0, 40, 40, { granularity: "line" })],
  };
  const once = normalizeOcrResult(raw, "googlelens");
  assert.equal(once.textAnnotations[1].granularity, "block");
  assert.deepEqual(normalizeOcrResult(once, "googlelens").textAnnotations, once.textAnnotations);
});

test("Manga OCR's lines, each read on its own, reach the overlay with the lines they were read from", () => {
  const right = [[60, 0], [90, 0], [90, 150], [60, 150]];
  const left = [[30, 0], [60, 0], [60, 120], [30, 120]];
  const raw = {
    fullText: "ご主人さまトカゲは",
    groups: [
      { id: "block-0", text: "ご主人さまトカゲは", bbox: [30, 0, 90, 150], orientation: "vertical", linePolygons: [right, left], lines: ["ご主人さま", "トカゲは"] },
      { id: "block-1", text: "あ", bbox: [0, 200, 30, 240], orientation: "vertical", linePolygons: [right, left], lines: ["あ"] },
    ],
  };
  const result = normalizeOcrResult(raw, "mangaocr");
  assert.deepEqual(result.textAnnotations[1].lineTexts, ["ご主人さま", "トカゲは"]);
  // One string short of its lines: not trusted, the layout shares the text out as before.
  assert.equal(result.textAnnotations[2].lineTexts, undefined);
});
