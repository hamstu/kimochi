import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";
const { normalizeOcrResult, inferOrientations, logicalGroups } =
  await load("ocr-result.ts");
const { withDefaults, OCR_MODES } = await load("settings.ts");
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
    "websocket",
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
