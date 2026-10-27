// The one-line Linux installer (site/public/install.sh, served as /install.sh). Each test runs it
// with a PATH shim for curl that serves a fake GitHub (API, release downloads, raw files) from a
// temporary directory, and a temporary XDG_DATA_HOME.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, access, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../site/public/install.sh", import.meta.url));
// POSIX sh with PATH shims; the Windows runners' MSYS shell is not a target.
const posix = { skip: process.platform === "win32" && "installer targets Linux shells" };

const APPIMAGE = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const REPO = "hamstu/kimochi";

// A curl that maps https://<host>/<path> to $FAKE_WEB/<host>/<path>, honours -o and -w, and
// answers 404 (or $FAKE_STATUS_<n> for the n-th request) like the real one.
const CURL = `#!/bin/sh
out= url= wfmt=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w) wfmt=$2; shift ;;
    -H|--retry) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$FAKE_WEB/requests.log"
file=$FAKE_WEB/\${url#*://}
if [ -f "$file" ]; then code=200; cp "$file" "$out"; else code=404; printf 'Not Found' > "$out"; fi
override=$FAKE_WEB/status/$(printf '%s' "\${url#*://}" | tr '/' '_')
[ -f "$override" ] && code=$(cat "$override")
[ -n "$wfmt" ] && printf '%s' "$code"
exit 0
`;

function release(tag, names) {
  return JSON.stringify({
    tag_name: tag,
    name: tag,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    body: "Notes, with a comma, and {braces}",
    assets: names.map((name) => ({
      name,
      size: 14,
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
    })),
  }, null, 2);
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimochi-linux-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const web = path.join(dir, "web");
  const bin = path.join(dir, "bin");
  const data = path.join(dir, "user data");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(web, "status"), { recursive: true });
  await writeFile(path.join(bin, "curl"), CURL);
  await chmod(path.join(bin, "curl"), 0o755);
  const put = async (url, content) => {
    const file = path.join(web, url.replace(/^https:\/\//, ""));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const status = (url, code) =>
    writeFile(path.join(web, "status", url.replace(/^https:\/\//, "").replaceAll("/", "_")), String(code));
  const publish = async (tag, names, { latest = true } = {}) => {
    const api = `https://api.github.com/repos/${REPO}/releases`;
    await put(latest ? `${api}/latest` : `${api}/tags/${tag}`, release(tag, names));
    for (const [i, name] of names.entries()) {
      // Distinct bytes per asset, so a test can tell which one was installed.
      await put(`https://github.com/${REPO}/releases/download/${tag}/${name}`, Buffer.concat([APPIMAGE, Buffer.from(name), Buffer.from([i])]));
    }
    for (const icon of ["32x32", "64x64", "128x128", "128x128@2x", "icon"]) {
      await put(`https://raw.githubusercontent.com/${REPO}/${tag}/src-tauri/icons/${icon}.png`, PNG);
    }
  };
  const run = (args = [], env = {}) =>
    spawnSync("sh", [installer, ...args], {
      encoding: "utf8",
      input: "",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        XDG_DATA_HOME: data,
        FAKE_WEB: web,
        KIMOCHI_INSTALL_ARCH: "x86_64",
        ...env,
      },
    });
  const requests = async () => (await readFile(path.join(web, "requests.log"), "utf8").catch(() => "")).trim().split("\n");
  return { dir, data, web, publish, put, status, run, requests, appimage: path.join(data, "kimochi/Kimochi.AppImage") };
}

const exists = (file) => access(file).then(() => true, () => false);
const names = (ver) => [
  `Kimochi_${ver}_aarch64.AppImage`,
  `Kimochi_${ver}_aarch64-arch.AppImage`,
  `Kimochi_${ver}_amd64-arch.AppImage`,
  `Kimochi_${ver}_amd64.AppImage`,
  `Kimochi_${ver}_amd64.AppImage.sig`,
  `Kimochi_${ver}_amd64.deb`,
  `Kimochi_${ver}_amd64-gaming-mode.tar.gz`,
  "latest.json",
];

test("installs the tagged release's generic AppImage for the CPU, with menu entries and icons", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("v0.2.0", names("0.2.0"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const installed = await readFile(f.appimage);
  assert.ok(installed.includes(Buffer.from("Kimochi_0.2.0_amd64.AppImage")));
  assert.ok(!installed.includes(Buffer.from("-arch")));
  assert.equal((await stat(f.appimage)).mode & 0o777, 0o755);

  const entry = await readFile(path.join(f.data, "applications/Kimochi.desktop"), "utf8");
  assert.match(entry, /^Name=Kimochi$/m);
  assert.match(entry, /^Icon=kimochi$/m);
  assert.match(entry, /^StartupWMClass=kimochi$/m);
  assert.match(entry, /^Categories=Education;Languages;$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/kimochi;$/m);
  assert.ok(entry.includes(`"${f.appimage}" %u`), entry);
  assert.doesNotMatch(entry, /NoDisplay/);
  const portal = await readFile(path.join(f.data, "applications/dev.kimochi.app.desktop"), "utf8");
  assert.match(portal, /^NoDisplay=true$/m);
  for (const size of ["32x32", "64x64", "128x128", "256x256", "512x512"]) {
    assert.ok(await exists(path.join(f.data, `icons/hicolor/${size}/apps/kimochi.png`)), size);
  }
  assert.match(result.stdout, /Kimochi is installed/);
  // No display in the test environment: nothing is started, and it says so.
  assert.match(result.stdout, /not started/);
  // Never left behind: the staging directory.
  assert.deepEqual(await readdir(path.join(f.data, "kimochi")), ["Kimochi.AppImage"]);
});

test("picks the aarch64 build on ARM64", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("v0.2.0", names("0.2.0"));
  const result = f.run([], { KIMOCHI_INSTALL_ARCH: "aarch64" });
  assert.equal(result.status, 0, result.stderr);
  const installed = await readFile(f.appimage);
  assert.ok(installed.includes(Buffer.from("Kimochi_0.2.0_aarch64.AppImage")));
});

test("falls back to the nightly pre-release until a tagged release exists", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("nightly", ["Kimochi_amd64.AppImage", "Kimochi_aarch64.AppImage"], { latest: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readFile(f.appimage)).includes(Buffer.from("Kimochi_amd64.AppImage")));
  assert.match(result.stdout, /nightly/);
  const requests = await f.requests();
  assert.ok(requests[0].endsWith("/releases/latest"));
  assert.ok(requests[1].endsWith("/releases/tags/nightly"));
});

test("--nightly skips the tagged release", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("v0.2.0", names("0.2.0"));
  await f.publish("nightly", ["Kimochi_amd64.AppImage"], { latest: false });
  const result = f.run(["--nightly"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readFile(f.appimage)).includes(Buffer.from("Kimochi_amd64.AppImage")));
});

test("a rate-limited API is reported, not mistaken for a missing release", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("nightly", ["Kimochi_amd64.AppImage"], { latest: false });
  await f.status(`https://api.github.com/repos/${REPO}/releases/latest`, 403);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /download limit/);
  assert.equal(await exists(f.appimage), false);
});

test("a download that is not an AppImage leaves the installed one untouched", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("v0.2.0", names("0.2.0"));
  assert.equal(f.run().status, 0);
  const before = await readFile(f.appimage);
  await f.put(`https://github.com/${REPO}/releases/download/v0.2.0/Kimochi_0.2.0_amd64.AppImage`, "<html>oops</html>");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected a Kimochi AppImage/);
  assert.deepEqual(await readFile(f.appimage), before);
});

test("re-running updates in place and keeps app data; uninstall keeps it too", posix, async (t) => {
  const f = await fixture(t);
  const settings = path.join(f.data, "dev.kimochi.app/settings.json");
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, '{"keep":true}');
  await f.publish("v0.2.0", names("0.2.0"));
  assert.equal(f.run().status, 0);
  await f.publish("v0.3.0", names("0.3.0"));
  const update = f.run();
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /Kimochi is updated/);
  assert.ok((await readFile(f.appimage)).includes(Buffer.from("Kimochi_0.3.0_amd64.AppImage")));

  // The app's own deep-link handler entry, pointing at this AppImage.
  const handler = path.join(f.data, "applications/kimochi-handler.desktop");
  await writeFile(handler, `[Desktop Entry]\nExec="${f.appimage}" %u\nNoDisplay=true\n`);
  const removed = f.run(["--uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /uninstalled/);
  for (const file of [f.appimage, handler, path.join(f.data, "applications/Kimochi.desktop"),
    path.join(f.data, "applications/dev.kimochi.app.desktop"),
    path.join(f.data, "icons/hicolor/128x128/apps/kimochi.png"), path.join(f.data, "kimochi")]) {
    assert.equal(await exists(file), false, file);
  }
  assert.equal(await readFile(settings, "utf8"), '{"keep":true}');
});

test("coexists with the Steam Deck Gaming Mode helper's entries and icon", posix, async (t) => {
  const f = await fixture(t);
  const apps = path.join(f.data, "applications");
  await mkdir(apps, { recursive: true });
  const portal = "[Desktop Entry]\nName=Kimochi Gaming Mode\nExec=/bin/sh launch.sh\nNoDisplay=true\n";
  await writeFile(path.join(apps, "dev.kimochi.app.desktop"), portal);
  await mkdir(path.join(f.data, "kimochi/gaming-mode"), { recursive: true });
  await f.publish("v0.2.0", names("0.2.0"));
  assert.equal(f.run().status, 0);
  assert.equal(await readFile(path.join(apps, "dev.kimochi.app.desktop"), "utf8"), portal);
  assert.equal(f.run(["--uninstall"]).status, 0);
  assert.equal(await readFile(path.join(apps, "dev.kimochi.app.desktop"), "utf8"), portal);
  assert.ok(await exists(path.join(f.data, "icons/hicolor/128x128/apps/kimochi.png")));
  assert.ok(await exists(path.join(f.data, "kimochi/gaming-mode")));
});

test("replaces the app's generated entry but backs up a hand-written one", posix, async (t) => {
  const f = await fixture(t);
  const apps = path.join(f.data, "applications");
  await mkdir(apps, { recursive: true });
  await writeFile(path.join(apps, "Kimochi.desktop"), "[Desktop Entry]\nName=Mine\n");
  await f.publish("v0.2.0", names("0.2.0"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(apps, "Kimochi.desktop.bak"), "utf8"), "[Desktop Entry]\nName=Mine\n");
  await writeFile(path.join(apps, "Kimochi.desktop"), "[Desktop Entry]\nName=Kimochi\nX-Kimochi-Generated=true\n");
  await rm(path.join(apps, "Kimochi.desktop.bak"));
  assert.equal(f.run().status, 0);
  assert.equal(await exists(path.join(apps, "Kimochi.desktop.bak")), false);
});

test("--appimage installs a local file without any network", posix, async (t) => {
  const f = await fixture(t);
  const local = path.join(f.dir, "Downloaded.AppImage");
  await writeFile(local, APPIMAGE);
  const result = f.run(["--appimage", local, "--no-launch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(f.appimage), APPIMAGE);
  assert.match(result.stdout, /application menu/);
  // Only the icon fallback may reach out.
  assert.ok((await f.requests()).every((url) => url === "" || url.includes("raw.githubusercontent.com")));
});

test("the desktop entry escapes percent and shell-sensitive characters in the path", posix, async (t) => {
  const f = await fixture(t);
  await f.publish("v0.2.0", names("0.2.0"));
  const data = f.data + ' % $ ` "';
  const result = f.run([], { XDG_DATA_HOME: data });
  assert.equal(result.status, 0, result.stderr);
  const entry = await readFile(path.join(data, "applications/Kimochi.desktop"), "utf8");
  assert.ok(entry.includes('%% \\$ \\` \\"/kimochi/Kimochi.AppImage" %u'), entry);
});

test("refuses unsupported CPUs and unknown options", posix, async (t) => {
  const f = await fixture(t);
  const cpu = f.run([], { KIMOCHI_INSTALL_ARCH: "riscv64" });
  assert.equal(cpu.status, 1);
  assert.match(cpu.stderr, /x86_64 and ARM64/);
  const option = f.run(["--frobnicate"]);
  assert.equal(option.status, 1);
  assert.match(option.stderr, /Unknown option/);
});

test("the script body only runs once it has fully arrived", async () => {
  const text = await readFile(installer, "utf8");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.at(-1), 'kimochi_install "$@"');
  // Nothing but comments before the main function's definition.
  const first = lines.findIndex((line) => line.trim() && !line.startsWith("#"));
  assert.match(lines[first], /^kimochi_install\(\) \{$/);
});
