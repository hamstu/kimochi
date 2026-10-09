import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  readlink,
  rm,
  mkdir,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const installer = fileURLToPath(
  new URL("./steam-deck/install-gaming-mode.sh", import.meta.url),
);
// The installer runs on SteamOS and relies on GNU coreutils (`mv -T` for the atomic
// `current` symlink swap), which BSD mv on macOS does not have.
const gnuOnly = {
  skip:
    process.platform !== "linux" && "installer needs GNU coreutils (SteamOS)",
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kimochi-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, "user data");
  const artifact = path.join(directory, "Kimochi.AppImage");
  await writeFile(
    artifact,
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2]),
  );
  const run = () =>
    spawnSync("sh", [installer, artifact], {
      encoding: "utf8",
      env: { ...process.env, XDG_DATA_HOME: data },
    });
  return { data, artifact, run };
}
test(
  "install and update use a stable quoted Steam entry and preserve prior version and app data",
  gnuOnly,
  async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.data, "dev.kimochi.app"), { recursive: true });
    const settings = path.join(f.data, "dev.kimochi.app/settings.json");
    await writeFile(settings, '{"keep":true}');
    assert.equal(f.run().status, 0);
    const root = path.join(f.data, "kimochi/gaming-mode");
    const first = await readlink(path.join(root, "current"));
    const desktop = await readFile(
      path.join(f.data, "applications/kimochi-gaming-mode.desktop"),
      "utf8",
    );
    assert.ok(desktop.includes(`Exec=/bin/sh "${root}/launch.sh"`));
    assert.equal(
      (await readFile(path.join(root, first, "Kimochi.AppImage"))).length,
      11,
    );
    assert.equal(f.run().status, 0);
    assert.notEqual(await readlink(path.join(root, "current")), first);
    assert.equal((await readdir(path.join(root, "releases"))).length, 2);
    assert.equal(await readFile(settings, "utf8"), '{"keep":true}');
  },
);
test(
  "invalid artifact leaves the existing installation untouched",
  gnuOnly,
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.run().status, 0);
    const current = path.join(f.data, "kimochi/gaming-mode/current");
    const before = await readlink(current);
    await writeFile(f.artifact, "not an AppImage");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected a Kimochi AppImage/);
    assert.equal(await readlink(current), before);
  },
);
test(
  "desktop entry escapes percent expansion and shell-sensitive characters",
  gnuOnly,
  async (t) => {
    const f = await fixture(t);
    const data = f.data + ' % $ ` "';
    const result = spawnSync("sh", [installer, f.artifact], {
      encoding: "utf8",
      env: { ...process.env, XDG_DATA_HOME: data },
    });
    assert.equal(result.status, 0);
    const desktop = await readFile(
      path.join(data, "applications/kimochi-gaming-mode.desktop"),
      "utf8",
    );
    assert.ok(desktop.includes('%% \\$ \\` \\"'));
  },
);
test("release companion contains everything needed for installation including the icon", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.data, "companion.tar.gz");
  await mkdir(f.data, { recursive: true });
  const packager = fileURLToPath(
    new URL("./steam-deck/package-gaming-mode.sh", import.meta.url),
  );
  const packed = spawnSync("sh", [packager, f.artifact, output], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const contents = spawnSync("tar", ["-tzf", output], { encoding: "utf8" });
  assert.equal(contents.status, 0);
  assert.match(contents.stdout, /Kimochi-Gaming-Mode\/install-gaming-mode.sh/);
  assert.match(contents.stdout, /Kimochi-Gaming-Mode\/kimochi.png/);
  assert.match(contents.stdout, /Kimochi-Gaming-Mode\/INSTALL.txt/);
  assert.match(contents.stdout, /Kimochi-Gaming-Mode\/Kimochi.AppImage/);
});
