import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(path.join(tmpdir(), "kimochi-meiki-routing-"));
const outfile = path.join(directory, "ocr.mjs");
await build({
  entryPoints: ["ui/ocr.js"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
});
const calls = [];
globalThis.__TAURI__ = {
  core: {
    invoke: async (command, args) => {
      calls.push({ command, args });
      return {
        id: args.id,
        ocr: {
          geometry: args.engine !== "mangaocr",
          fullText: "日本語",
          textAnnotations: [{ description: "日本語", boundingPoly: { vertices: [{x: 0,y:0},{x:60,y:0},{x:60,y:20},{x:0,y:20}] } }],
        },
      };
    },
  },
};
const { recognize } = await import(pathToFileURL(outfile).href);
after(async () => {
  delete globalThis.__TAURI__;
  await rm(directory, { recursive: true, force: true });
});

test("MeikiOCR uses the retained native frame and returns overlay geometry", async () => {
  const result = await recognize({ id: 42 }, { ocrMode: "meikiocr" });
  assert.deepEqual(calls.pop(), {
    command: "ocr_frame",
    args: { id: 42, engine: "meikiocr" },
  });
  assert.equal(result.fullText, "日本語");
  assert.equal(result.geometry, true);
  assert.equal(result.nativeScanId, 42);
  assert.equal(result.textAnnotations.length, 2);
});

test("cloud OCR retains its existing route", async () => {
  await recognize({ id: 43 }, { ocrMode: "cloud" });
  assert.deepEqual(calls.pop(), {
    command: "ocr_frame",
    args: { id: 43, engine: "cloud" },
  });
});

test("OneOCR uses the retained native frame with overlay geometry", async () => {
  const result = await recognize({ id: 45 }, { ocrMode: "oneocr" });
  assert.deepEqual(calls.pop(), {
    command: "ocr_frame",
    args: { id: 45, engine: "oneocr" },
  });
  assert.equal(result.fullText, "日本語");
  assert.equal(result.geometry, true);
  assert.equal(result.nativeScanId, 45);
});

test("Manga OCR uses the retained native frame and reports text only", async () => {
  const result = await recognize({ id: 44 }, { ocrMode: "mangaocr" });
  assert.deepEqual(calls.pop(), {
    command: "ocr_frame",
    args: { id: 44, engine: "mangaocr" },
  });
  assert.equal(result.fullText, "日本語");
  assert.equal(result.geometry, false);
  assert.equal(result.nativeScanId, 44);
});
