import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertIsolatedPaths, IDENTIFIER } from "./e2e-windows/profile.mjs";

test("desktop harness refuses either installed profile before changing settings", () => {
  const roaming = "C:\\Users\\tester\\AppData\\Roaming\\dev.kimochi.e2e\\";
  const local = "C:\\Users\\tester\\AppData\\Local\\dev.kimochi.e2e";
  assert.doesNotThrow(() => assertIsolatedPaths(roaming, local));
  for (const unsafe of [
    undefined,
    "",
    "dev.kimochi.e2e",
    "C:\\Users\\tester\\AppData\\Roaming\\dev.kimochi.app",
  ]) {
    assert.throws(() => assertIsolatedPaths(unsafe, local), /Refusing/);
    assert.throws(() => assertIsolatedPaths(roaming, unsafe), /Refusing/);
  }
});

test("desktop build isolates both data identifier and URL scheme", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("./e2e-windows/tauri.e2e.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.identifier, IDENTIFIER);
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, [
    "kimochi-e2e",
  ]);
});
