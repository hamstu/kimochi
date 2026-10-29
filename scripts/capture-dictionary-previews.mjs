#!/usr/bin/env node
/**
 * Captures the dictionary chooser's preview thumbnails (frontend/assets/dictionary-previews/):
 * each engine's real pop-up over one line of game dialogue, light and dark, in headless Chrome.
 *
 *   npm run capture:dictionary-previews -- [--engine yomitan,hachidori,tenten,custom-api]
 *     [--theme light,dark] [--dicts <dir>] [--api <url> | --offline] [--out <dir>] [--port <n>]
 *
 * What runs (nothing touches the desktop or the installed app):
 *
 * - The dev server (vite.dev.config.ts) on `--port` (default 1470, so it does not collide with
 *   `npm run dev` on 1430), with Hachidori and 10ten on their own origins at +10 and +11, and the
 *   browser preview (vite.preview.config.ts) on +4000 for the Yomitan API pop-up. Both in-process,
 *   closed at the end.
 * - frontend/dev/dictionary-preview.html, the scene, which starts each engine exactly as the dictionary
 *   harness does (DICTIONARY_ENGINES.md §9). Chrome points at 食べられなかった with Shift held (a
 *   real CDP mouse event, inside the headless page), waits for the pop-up to settle and screenshots
 *   the viewport.
 *
 * Dictionary data per engine:
 *
 * - Yomitan and Hachidori start with no dictionary. Both get the same excerpt of JMdict (and of
 *   the CC100 frequency list when present): only the entries a lookup of the word can reach, cut
 *   from the Yomitan zips in `--dicts` (default `../yomitan-dicts` beside the repository, or
 *   $KIMOCHI_YOMITAN_DICTS). Yomitan imports it through its own DictionaryWorker (`?dictionary=`),
 *   Hachidori through its settings page's file input. The excerpt lives in a temp folder only.
 * - 10ten ships its own word dictionary in the extension, and fetches the full JMdict data from
 *   its server in the background (through the dev server's proxy); the capture waits for that
 *   download so the pop-up shows complete results, then shoots.
 * - The Yomitan API pop-up (`custom-api`) shows a Yomitan API `/ankiFields` answer. With the API
 *   reachable (`--api`, default http://127.0.0.1:19633) the answer is live and is recorded to
 *   scripts/fixtures/dictionary-previews/yomitan-api.json; `--offline`, or an unreachable API,
 *   replays that recording.
 *
 * Only JMdict and CC100 content is shown: glossaries and frequencies from other dictionaries in
 * the API answer are left out (`apiPayload`), so the committed images and recording carry nothing
 * but JMdict (EDRDG licence, attributed in the folder's README) and CC100 frequencies.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluate, launchChrome, waitFor } from "./cdp.mjs";
import {
  ANKI_FIELDS_REQUEST,
  SCENE,
  apiPayload,
} from "./dictionary-previews.mjs";
import {
  TENTEN_TEXT,
  excerpts,
  importIntoHachidori,
  root,
  serveFiles,
  sleep,
  startServers,
} from "./engine-browser.mjs";
import { ensureExtension } from "./sync-extension.mjs";

const ENGINES = ["yomitan", "hachidori", "tenten", "custom-api"];
const THEMES = ["light", "dark"];
/** CSS pixels and device pixel ratio of every capture: 16:10, shown at most ~720 px wide. */
const VIEWPORT = { width: 960, height: 600, deviceScaleFactor: 1.5 };
const MAX_BYTES = 150 * 1024;
const RECORDING = path.join(
  root,
  "scripts/fixtures/dictionary-previews/yomitan-api.json",
);
/** The dictionaries a screenshot may show (see the header). */
const allowed = (name) => /^JMdict\b/.test(name) || name === "CC100";

function options(argv) {
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const list = (flag, all) => {
    const picked = value(flag, all.join(",")).split(",").filter(Boolean);
    for (const item of picked)
      if (!all.includes(item))
        throw Error(`${flag}: unknown ${item} (one of ${all.join(", ")})`);
    return picked;
  };
  return {
    engines: list("--engine", ENGINES),
    themes: list("--theme", THEMES),
    dicts: path.resolve(
      value(
        "--dicts",
        process.env.KIMOCHI_YOMITAN_DICTS ??
          path.join(root, "..", "yomitan-dicts"),
      ),
    ),
    api: value("--api", "http://127.0.0.1:19633").replace(/\/+$/, ""),
    offline: argv.includes("--offline"),
    out: path.resolve(
      value("--out", path.join(root, "frontend/assets/dictionary-previews")),
    ),
    port: Number(value("--port", process.env.KIMOCHI_DEV_PORT ?? 1470)),
    tentenWait: Number(value("--tenten-wait", 300)) * 1000,
  };
}

const log = (...parts) => console.log("[capture]", ...parts);

// ---------------------------------------------------------------- data

/** The Yomitan API answer for the word: live (and recorded) when reachable, else the recording. */
async function apiAnswer({ api, offline }) {
  if (!offline) {
    try {
      const response = await fetch(`${api}/ankiFields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...ANKI_FIELDS_REQUEST, text: SCENE.word }),
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const payload = apiPayload(await response.json(), {
        term: SCENE.word,
        sentence: SCENE.word,
        baseUrl: api,
        allowed,
      });
      if (payload.entries.length === 0)
        throw Error("no JMdict entries in the answer");
      await mkdir(path.dirname(RECORDING), { recursive: true });
      await writeFile(RECORDING, `${JSON.stringify(payload, null, 2)}\n`);
      return {
        payload,
        source: `live Yomitan API at ${api} (recorded to ${path.relative(root, RECORDING)})`,
      };
    } catch (error) {
      log(
        `Yomitan API at ${api} unavailable (${error.message}); using the recording`,
      );
    }
  }
  const payload = JSON.parse(await readFile(RECORDING, "utf8"));
  return {
    payload,
    source: `recorded answer ${path.relative(root, RECORDING)}`,
  };
}

// ---------------------------------------------------------------- browser

/** Points at the word's first character with Shift held, arriving from the left as a hand would. */
async function hover(page) {
  const target = await evaluate(page, "window.__preview.wordPoint()");
  for (let step = 4; step >= 0; step--) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x - step * 14,
      y: target.y + step * 3,
      modifiers: 8,
    });
    await sleep(60);
  }
  return target;
}

/** The pop-up's box once it has stopped changing. */
async function settledPopup(page, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let same = 0;
  while (Date.now() < deadline) {
    const rect = await evaluate(page, "window.__preview.popupRect()");
    if (rect && last && JSON.stringify(rect) === JSON.stringify(last)) same++;
    else same = 0;
    last = rect;
    if (rect && same >= 4) return rect;
    await sleep(150);
  }
  return null;
}

async function capture(browser, { engine, theme, origins, data, opts }) {
  const page = await browser.newPage();
  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      mobile: false,
    });
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    const url = new URL(`${origins.app}/app/dev/dictionary-preview.html`);
    url.searchParams.set("engine", engine);
    url.searchParams.set("theme", theme);
    url.searchParams.set("hachidori", origins.hachidori);
    url.searchParams.set("tenten", origins.tenten);
    if (engine === "tenten") url.searchParams.set("fetch", "proxy");
    if (engine === "yomitan")
      for (const dictionary of data.dictionaries)
        url.searchParams.append("dictionary", dictionary.url);
    if (engine === "custom-api")
      url.searchParams.set("popup", `${origins.preview}/dev/reader-popup.html`);
    await page.send("Page.navigate", { url: url.href });
    await waitFor(
      page,
      'document.readyState === "complete" && window.__preview',
      { label: "the scene" },
    );

    if (engine !== "custom-api") {
      const start = await waitFor(page, "window.__harness?.start", {
        timeout: 120000,
        label: `${engine} to start`,
      });
      if (!start.ready) throw Error(`${engine} did not start: ${start.error}`);
    }
    if (engine === "yomitan") {
      // Yomitan's pop-up has its own theme setting; match the scene's.
      await evaluate(
        page,
        `(async () => {
          const host = window.__harness.host
          const options = await host.api('optionsGetFull')
          const general = options.profiles[options.profileCurrent].options.general
          general.popupTheme = ${JSON.stringify(theme)}
          general.popupOuterTheme = ${JSON.stringify(theme)}
          await host.api('setAllSettings', { value: options, source: 'kimochi-preview' })
        })()`,
      );
      await sleep(500);
    }
    if (engine === "hachidori" && !data.hachidoriImported) {
      log(
        `hachidori: ${await importIntoHachidori(
          page,
          origins,
          data.dictionaries.map((d) => d.file),
        )}`,
      );
      data.hachidoriImported = true;
    }

    // The engines' extension windows open as tabs of their own; the scene has to be the visible
    // one, or its animation frames (which report the pop-up) stop.
    await page.send("Page.bringToFront");
    await hover(page);
    if (engine === "custom-api")
      await evaluate(
        page,
        `window.__preview.showApiPopup(${JSON.stringify(data.api.payload)})`,
      );
    if (engine === "tenten") {
      // Complete results only once 10ten's own dictionary download has finished.
      const deadline = Date.now() + opts.tentenWait;
      for (;;) {
        await settledPopup(page);
        const text = await evaluate(page, TENTEN_TEXT);
        if (text && !/updating|incomplete/i.test(text)) break;
        if (Date.now() > deadline)
          throw Error(
            "10ten is still downloading its dictionary (raise --tenten-wait)",
          );
        await page.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 4,
          y: 4,
        });
        await sleep(3000);
        await hover(page);
      }
    }
    const rect = await settledPopup(page);
    if (!rect) {
      const seen = await evaluate(
        page,
        "JSON.stringify([window.__preview.popupRect(), window.__harness?.popup])",
      );
      throw Error(`${engine}: no pop-up settled (last seen ${seen})`);
    }
    // Fonts, images and the pop-ups' own fade-ins.
    await sleep(800);
    const inside =
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.width <= VIEWPORT.width &&
      rect.y + rect.height <= VIEWPORT.height;
    if (!inside)
      throw Error(
        `${engine}: the pop-up ${JSON.stringify(rect)} does not fit the ${VIEWPORT.width}×${VIEWPORT.height} scene`,
      );

    let quality = 88;
    let image;
    for (;;) {
      const { data: base64 } = await page.send("Page.captureScreenshot", {
        format: "webp",
        quality,
      });
      image = Buffer.from(base64, "base64");
      if (image.length <= MAX_BYTES || quality <= 50) break;
      quality -= 6;
    }
    const file = path.join(opts.out, `${engine}-${theme}.webp`);
    await writeFile(file, image);
    return { file, bytes: image.length, quality, rect };
  } catch (error) {
    // What the engine reported, for the failure message.
    const reports = await evaluate(
      page,
      "window.__harness?.log.slice(-12) ?? []",
    ).catch(() => []);
    if (reports.length)
      error.message += `\n    last reports:\n      ${reports.join("\n      ")}`;
    // And what the page looked like.
    const shot = await page
      .send("Page.captureScreenshot", { format: "png" })
      .catch(() => null);
    if (shot) {
      const file = path.join(
        os.tmpdir(),
        `kimochi-preview-failed-${engine}-${theme}.png`,
      );
      await writeFile(file, Buffer.from(shot.data, "base64"));
      error.message += `\n    screenshot: ${file}`;
    }
    throw error;
  } finally {
    await browser
      .send("Target.closeTarget", { targetId: page.targetId })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = options(process.argv.slice(2));
  await mkdir(opts.out, { recursive: true });
  for (const id of ["yomitan", "hachidori", "tenten"])
    await ensureExtension(id, { log });

  const results = [];
  const skipped = [];
  const data = { dictionaries: [], hachidoriImported: false, api: null };
  const temp = await mkdtemp(path.join(os.tmpdir(), "kimochi-previews-"));
  const cleanup = [];
  try {
    let engines = opts.engines;
    if (engines.includes("yomitan") || engines.includes("hachidori")) {
      const zips = await excerpts(opts.dicts);
      if (!zips) {
        for (const engine of ["yomitan", "hachidori"])
          if (engines.includes(engine))
            skipped.push({
              engine,
              why: `no JMdict Yomitan zip in ${opts.dicts} (pass --dicts <dir>)`,
            });
        engines = engines.filter(
          (engine) => engine !== "yomitan" && engine !== "hachidori",
        );
      } else {
        const files = new Map(zips.map((zip) => [zip.name, zip.zip]));
        const server = await serveFiles(files);
        cleanup.push(server.close);
        for (const zip of zips) {
          const file = path.join(temp, zip.name);
          await writeFile(file, zip.zip);
          data.dictionaries.push({ ...zip, file, url: server.url(zip.name) });
          log(
            `excerpt of ${zip.title} (${zip.source}): ${zip.zip.length} bytes`,
          );
        }
      }
    }
    if (engines.includes("custom-api")) {
      try {
        data.api = await apiAnswer(opts);
        log(`custom-api: ${data.api.source}`);
      } catch (error) {
        skipped.push({
          engine: "custom-api",
          why: `no Yomitan API and no recording (${error.message})`,
        });
        engines = engines.filter((engine) => engine !== "custom-api");
      }
    }

    const servers = await startServers(opts.port);
    cleanup.push(servers.close);
    log(
      `dev server ${servers.origins.app}, preview ${servers.origins.preview}`,
    );
    const browser = await launchChrome({
      args: [
        "--disable-popup-blocking",
        "--lang=en-US",
        "--font-render-hinting=none",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    cleanup.push(browser.close);
    for (const engine of engines) {
      for (const theme of opts.themes) {
        log(`${engine} (${theme})…`);
        try {
          const result = await capture(browser, {
            engine,
            theme,
            origins: servers.origins,
            data,
            opts,
          });
          results.push({ engine, theme, ...result });
          log(
            `  ${path.relative(root, result.file)}: ${(result.bytes / 1024).toFixed(0)} KB (webp q${result.quality})`,
          );
        } catch (error) {
          skipped.push({ engine, theme, why: error.message });
          log(`  failed: ${error.message}`);
        }
      }
    }
  } finally {
    for (const close of cleanup.reverse())
      await close().catch((error) => log(`cleanup: ${error.message}`));
    await rm(temp, { recursive: true, force: true });
  }
  console.log("");
  for (const result of results)
    console.log(
      `captured ${result.engine} ${result.theme}: ${path.relative(root, result.file)}`,
    );
  for (const skip of skipped)
    console.log(
      `NOT captured ${skip.engine}${skip.theme ? ` ${skip.theme}` : ""}: ${skip.why}`,
    );
  if (data.api) console.log(`custom-api data: ${data.api.source}`);
  if (skipped.length) process.exitCode = 1;
}

await main();
