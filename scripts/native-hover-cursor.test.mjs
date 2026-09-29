import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const [{ text: moduleSource }] = await build({
  entryPoints: ["frontend/shell/nativeCursor.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
}).then((result) => result.outputFiles);

const { resolveNativeCursor } = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

test("ordinary transcript text resolves WebKit auto to a stable native I-beam", () => {
  for (let poll = 0; poll < 100; poll += 1) {
    assert.equal(resolveNativeCursor("auto", false, true), "text");
  }
});

test("explicit controls and non-transcript surfaces keep their cursor decisions", () => {
  assert.equal(resolveNativeCursor("pointer", false, true), "pointer");
  assert.equal(resolveNativeCursor("crosshair", false, true), "crosshair");
  assert.equal(resolveNativeCursor("auto", false, false), "auto");
  assert.equal(resolveNativeCursor("pointer", true, true), "default");
});

test("auto on a nested transcript control remains an arrow decision", () => {
  // useNativeHover classifies controls as non-text before calling this seam.
  assert.equal(resolveNativeCursor("auto", false, false), "auto");
});
