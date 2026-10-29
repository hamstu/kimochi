#!/usr/bin/env node
/**
 * The engine contract suite: Read along's direct lookups (ui/controller.js `lookupWord`), run
 * against each real dictionary engine in headless Chrome, so an extension update that breaks them
 * fails here, by name, before it ships.
 *
 *   npm run test:engines -- [--engine yomitan,hachidori,tenten] [--headed] [--dicts <dir>]
 *     [--port <n>] [--tenten-wait <seconds>]
 *
 * Why it exists: the controller asks each engine for a lookup directly, with no pointer events,
 * key presses or selection, which leans on engine internals the pins (extensions/<id>.source.json)
 * may move: Hachidori's patched `kimochiLookupAt` (host/ext/patches.json, checked statically by
 * scripts/extension-patches.test.mjs), 10ten's `lookup` message and its iframe-origin mapping
 * (host/ext/content.js `lookupText`), Yomitan's `termsFind` and `Popup#showContent`
 * (host/frontend-mode.js `lookupText`). This runs them for real and checks what the reader sees.
 *
 * What runs (nothing touches the desktop, the installed app or its data):
 *
 * - The dev server (vite.dev.config.ts) in this process on `--port` (default 1490, clear of
 *   `npm run dev` on 1430 and the preview capture on 1470), with Hachidori and 10ten on their own
 *   origins at +10 and +11; Chrome on a throwaway profile (scripts/cdp.mjs), closed at the end.
 * - frontend/dev/engine-contract.html, the scene: lines of Japanese, one held at opacity 0 as the
 *   overlay holds its text while the controller reads, each engine started as the dictionary
 *   harness starts it. Its `window.__contract` makes the lookups as the overlay does.
 * - Yomitan and Hachidori get a JMdict excerpt holding only the scene's words, cut from the
 *   owner's Yomitan zips (`--dicts`, $KIMOCHI_YOMITAN_DICTS, or ../yomitan-dicts) as the preview
 *   capture does (scripts/engine-browser.mjs). 10ten needs none: it downloads its own data through
 *   the dev server's proxy, which the suite waits for (`--tenten-wait`, default 300 s).
 *
 * Checks, per engine: each word found and shown with its own headword; consecutive lookups each
 * show their own; a miss answers promptly with nothing shown; no selection left and hidden text
 * still hidden; the pop-up over a given rectangle, and beside the word without one; (10ten) beside
 * the word with an unrelated iframe on the page; dismissal. Exits non-zero on any failure.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluate, launchChrome, waitFor } from "./cdp.mjs";
import {
  defaultDictsDir,
  excerpts,
  importIntoHachidori,
  root,
  serveFiles,
  sleep,
  startServers,
} from "./engine-browser.mjs";
import { ensureExtension } from "./sync-extension.mjs";

const ENGINES = ["yomitan", "hachidori", "tenten"];
const VIEWPORT = { width: 960, height: 600, deviceScaleFactor: 1 };

/** The scene's lines (frontend/dev/engine-contract.html), for the excerpt; the misses' lines left out. */
const LINES = [
  "あの日は怖くて、何も食べられなかったんだ。",
  "今日も大人が走る。",
  "とても綺麗な花です。",
  "猫がいる。",
];
/** Dictionary forms the scene's words deinflect to. */
const LEMMAS = ["食べる", "食べられる", "走る"];

/**
 * The words looked up (the scene's span ids) and a headword each pop-up must show: any of `heads`.
 * 食べられなかった sits in the line held at opacity 0.
 */
const WORDS = {
  taberu: { heads: ["食べる", "食べられる"] },
  kyou: { heads: ["今日"] },
  otona: { heads: ["大人"] },
  hashiru: { heads: ["走る"] },
  kirei: { heads: ["綺麗"] },
};
/**
 * The word the suite waits on until the engine answers; a word of its own, since 10ten answers a
 * repeated lookup from its cache without saying how much it matched (length null).
 */
const WARM_UP = { id: "neko", heads: ["猫"] };
/**
 * Text with no entry, looked up while another word's pop-up shows: none may be left standing.
 * `miss` has no entry in any engine and no kanji for 10ten to fall back to (not ｑ or ー: JMdict
 * has both, and 10ten finds them); `kana-miss` is Japanese text that only the excerpt lacks, so
 * only for the engines that read it (10ten has its full JMdict).
 */
const MISSES = [
  { id: "miss", name: "miss (not Japanese)", engines: ENGINES },
  {
    id: "kana-miss",
    name: "miss (no entry)",
    engines: ["yomitan", "hachidori"],
  },
];
/** Read along's full-screen dictionary rectangle, clear of the scene's text. */
const PLACE = { x: 60, y: 30, width: 520, height: 240 };
/** How close a placed pop-up must be to its rectangle, and an unplaced one to its word (CSS px). */
const PLACE_SLACK = 4;
const NEAR_WORD = 300;
const MISS_MS = 2000;

function options(argv) {
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const engines = value("--engine", ENGINES.join(","))
    .split(",")
    .filter(Boolean);
  for (const engine of engines)
    if (!ENGINES.includes(engine))
      throw Error(`--engine: unknown ${engine} (one of ${ENGINES.join(", ")})`);
  return {
    engines,
    headed: argv.includes("--headed"),
    dicts: path.resolve(value("--dicts", defaultDictsDir())),
    port: Number(value("--port", 1490)),
    tentenWait: Number(value("--tenten-wait", 300)) * 1000,
  };
}

const log = (...parts) => console.log("[engines]", ...parts);

/** Every term a lookup in the scene may try: each run of up to 16 characters, and the lemmas. */
function sceneTerms() {
  const terms = new Set(LEMMAS);
  for (const line of LINES)
    for (let start = 0; start < line.length; start++)
      for (let end = start + 1; end <= Math.min(line.length, start + 16); end++)
        terms.add(line.slice(start, end));
  return terms;
}

async function versionOf(id) {
  const source = JSON.parse(
    await readFile(path.join(root, "extensions", `${id}.source.json`), "utf8"),
  );
  return source.version ?? source.tag ?? "?";
}

// ---------------------------------------------------------------- geometry

/** Gap between two boxes (0 when they touch or overlap). */
function gap(a, b) {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/** The largest difference between two boxes' edges. */
function edgeDelta(a, b) {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

const fmt = (rect) =>
  rect
    ? `(${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)})`
    : "none";

// ---------------------------------------------------------------- one engine

class Failure extends Error {}
const expect = (ok, message) => {
  if (!ok) throw new Failure(message);
};

async function runEngine(browser, engine, { origins, data, opts }) {
  const results = [];
  const page = await browser.newPage();
  const js = (expression) => evaluate(page, expression);
  const contract = (call) => js(`window.__contract.${call}`);
  const popup = () => contract("popup()");
  const lookup = (id) => contract(`lookup(${JSON.stringify(id)})`);

  /** Polls the pop-up until `accept` takes it, or `ms` pass; the last state either way. */
  async function popupUntil(accept, ms = 2000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popup();
      if (accept(state) || Date.now() > deadline) return state;
      await sleep(50);
    }
  }
  /** Whether the pop-up shows one of the word's headwords (`word`: a WORDS id, or {heads}). */
  const hasHead = (state, word) =>
    Boolean(state.text) &&
    (typeof word === "string" ? WORDS[word] : word).heads.some((head) =>
      state.text.includes(head),
    );
  async function dismissed() {
    await contract("dismiss()");
    return popupUntil((state) => !state.visible, 1500);
  }

  async function check(name, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({
        engine,
        name,
        pass: true,
        detail: detail ?? "",
        ms: Date.now() - started,
      });
    } catch (error) {
      const detail =
        error instanceof Failure ? error.message : `error: ${error.message}`;
      results.push({
        engine,
        name,
        pass: false,
        detail,
        ms: Date.now() - started,
      });
    }
  }
  const skipRest = (why) => {
    for (const name of [
      "lookup each word",
      "consecutive lookups",
      ...(engine === "hachidori" ? ["clear before draw", "blur during a lookup"] : []),
      ...MISSES.filter((m) => m.engines.includes(engine)).map((m) => m.name),
      "selection and opacity",
      "placed pop-up",
      "pop-up beside the word",
      ...(engine === "tenten" ? ["beside the word with an iframe"] : []),
      "dismiss",
    ])
      if (!results.some((r) => r.name === name))
        results.push({ engine, name, pass: false, detail: `not run: ${why}` });
  };

  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      mobile: false,
    });
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const url = new URL(`${origins.app}/app/dev/engine-contract.html`);
    url.searchParams.set("engine", engine);
    url.searchParams.set("hachidori", origins.hachidori);
    url.searchParams.set("tenten", origins.tenten);
    if (engine === "tenten") url.searchParams.set("fetch", "proxy");
    if (engine === "yomitan")
      for (const dictionary of data.dictionaries)
        url.searchParams.append("dictionary", dictionary.url);
    await page.send("Page.navigate", { url: url.href });
    await waitFor(
      page,
      'document.readyState === "complete" && window.__contract',
      {
        label: "the scene",
      },
    );

    let started = false;
    await check("start", async () => {
      const start = await waitFor(page, "window.__harness?.start", {
        timeout: 150000,
        label: `${engine} to start`,
      });
      expect(start.ready, `did not start: ${start.error}`);
      if (engine === "hachidori")
        log(
          `hachidori: ${await importIntoHachidori(
            page,
            origins,
            data.dictionaries.map((d) => d.file),
          )}`,
        );
      started = true;
      return engine === "tenten"
        ? ""
        : `dictionaries: ${data.dictionaries.map((d) => d.title).join(", ")}`;
    });
    if (!started) {
      skipRest("the engine did not start");
      return results;
    }
    // The engines' extension windows open as tabs of their own; the scene has to be the visible
    // one, or its animation frames (which the pop-ups wait on) stop.
    await page.send("Page.bringToFront");

    if (engine === "hachidori") {
      await check("lookup patch served", async () => {
        const served = await fetch(`${origins.hachidori}/content.js`).then(
          (r) => r.text(),
        );
        expect(
          served.includes("kimochiLookupAt"),
          "the served content.js has no kimochiLookupAt: host/ext/patches.json `hachidori-lookup-at` no longer applies (its `find` is gone from the pinned content.js)",
        );
        const reader = await contract("reader()");
        expect(reader.ready, "HDReaderReady did not resolve");
        expect(
          reader.kimochiLookupAt,
          `HDReaderReady resolves without kimochiLookupAt (keys: ${reader.keys.join(", ")})`,
        );
        expect(
          reader.kimochiClear,
          `HDReaderReady resolves without kimochiClear (keys: ${reader.keys.join(", ")})`,
        );
        return "content.js patched; HDReaderReady.kimochiLookupAt and kimochiClear present";
      });
    }

    // Ready: a word found and shown. 10ten fills its database in the background on a new profile
    // and answers "updating" meanwhile, so it gets as long as its download takes.
    let ready = false;
    await check("ready", async () => {
      const deadline =
        Date.now() + (engine === "tenten" ? opts.tentenWait : 60000);
      let last = null;
      for (let attempt = 0; ; attempt++) {
        last = await lookup(WARM_UP.id);
        const state = await popupUntil((s) => hasHead(s, WARM_UP), 1500);
        const updating =
          engine === "tenten" && /updating|incomplete/i.test(state.text ?? "");
        if (last.result?.shown && hasHead(state, WARM_UP) && !updating) {
          ready = true;
          await dismissed();
          return `after ${attempt + 1} lookup(s)`;
        }
        if (Date.now() > deadline) {
          throw new Failure(
            last.result === null
              ? "lookupText answers null: the engine has no direct lookup here (for Hachidori, the patch did not apply)"
              : `no pop-up for 猫 (last answer ${JSON.stringify(last.result)}, pop-up ${JSON.stringify(state.text?.slice(0, 80) ?? null)})`,
          );
        }
        await dismissed();
        await sleep(engine === "tenten" ? 3000 : 1000);
      }
    });
    if (!ready) {
      skipRest("the engine never showed a word");
      return results;
    }

    await check("lookup each word", async () => {
      const notes = [];
      for (const id of Object.keys(WORDS)) {
        const { result, ms, text, word } = await lookup(id);
        expect(
          result !== null,
          `${text}: lookupText answered null (no direct lookup)`,
        );
        expect(
          result.shown === true,
          `${text}: shown=${result.shown} (${JSON.stringify(result)})`,
        );
        expect(
          result.length > 0,
          `${text}: length=${result.length}, expected the characters matched`,
        );
        const state = await popupUntil((s) => s.visible && hasHead(s, id));
        expect(
          state.visible,
          `${text}: answered shown but no pop-up is visible`,
        );
        expect(
          hasHead(state, id),
          `${text}: the pop-up does not show ${WORDS[id].heads.join(" or ")} (it shows ${JSON.stringify(state.text?.slice(0, 80))})`,
        );
        if (id === "taberu") {
          const opacity = await contract("opacity('line-quiet')");
          expect(
            opacity === "0",
            `the line held at opacity 0 is at ${opacity} after its lookup`,
          );
        }
        notes.push(`${word}=${result.length} ${ms}ms`);
        await dismissed();
      }
      return notes.join(", ");
    });

    await check("consecutive lookups", async () => {
      const order = ["kyou", "otona", "hashiru"];
      const notes = [];
      for (const [index, id] of order.entries()) {
        const { result, ms, text, word } = await lookup(id);
        expect(result?.shown === true, `${text}: ${JSON.stringify(result)}`);
        const state = await popupUntil(
          (s) => s.visible && hasHead(s, id),
          1500,
        );
        expect(
          hasHead(state, id),
          `${text}: the pop-up shows ${JSON.stringify(state.text?.slice(0, 80))}, not its own headword`,
        );
        const previous = order[index - 1];
        if (previous)
          expect(
            !hasHead(state, previous),
            `${text}: the pop-up still shows the previous word's ${WORDS[previous].heads[0]}`,
          );
        notes.push(`${word} ${result.length ?? "?"} ${ms}ms`);
      }
      return notes.join(" → ");
    });

    if (engine === "hachidori") {
      // Read along empties the pop-up as the next word's answer arrives (host/ext/content.js
      // lookupText), through the patched `kimochiClear`, which answers whether Hachidori will
      // still draw that lookup; Kimochi calls it from a reply listener, where a failure would
      // only be logged.
      await check("clear before draw", async () => {
        // With nothing in flight it is no lookup's to clear: it says so and leaves the pop-up.
        await lookup("otona");
        await popupUntil((s) => s.visible && hasHead(s, "otona"), 1500);
        const { error, cleared } = await contract("clear()");
        expect(error === null, `kimochiClear threw: ${error}`);
        expect(cleared === false, `kimochiClear with no lookup in flight answered ${cleared}, not false`);
        const state = await contract("popup()");
        expect(state.visible && hasHead(state, "otona"), "kimochiClear emptied a pop-up no lookup was replacing");
        // In flight, read along's next lookup clears through it and draws (consecutive lookups).
        const { result } = await lookup("hashiru");
        expect(result?.shown === true, `走る after it: ${JSON.stringify(result)}`);
        const after = await popupUntil((s) => s.visible && hasHead(s, "hashiru"), 1500);
        expect(hasHead(after, "hashiru"), "the next word did not show");
        return "left alone with nothing in flight; the next word drew";
      });
    }

    if (engine === "hachidori") {
      // Hachidori gives a lookup in flight up when the window blurs (content.js `onWindowBlur`);
      // read along asks for that word again rather than leave it showing nothing.
      await check("blur during a lookup", async () => {
        await lookup("otona");
        await popupUntil((s) => s.visible && hasHead(s, "otona"), 1500);
        const { result, ms, text } = await contract(`lookupBlurred(${JSON.stringify("kyou")})`);
        expect(result?.shown === true, `${text}: ${JSON.stringify(result)}`);
        const state = await popupUntil((s) => s.visible && hasHead(s, "kyou"), 1500);
        expect(hasHead(state, "kyou"), `the pop-up shows ${JSON.stringify(state.text?.slice(0, 80))}, not 今日`);
        return `${ms}ms`;
      });
    }

    for (const miss of MISSES.filter((m) => m.engines.includes(engine))) {
      await check(miss.name, async () => {
        const shown = await lookup("hashiru");
        await popupUntil((s) => s.visible && hasHead(s, "hashiru"));
        expect(
          shown.result?.shown === true,
          `走る before the miss: ${JSON.stringify(shown.result)}`,
        );
        const { result, ms, text } = await lookup(miss.id);
        expect(result !== null, `${text}: lookupText answered null`);
        expect(ms < MISS_MS, `${text}: took ${ms} ms (limit ${MISS_MS})`);
        const state = await popupUntil((s) => !s.visible, 1000);
        expect(
          !state.visible,
          `${text}: answered ${JSON.stringify(result)} but the previous word's pop-up (走る) is still showing`,
        );
        expect(
          result.shown === false && result.length === 0,
          `${text}: expected {shown:false,length:0}, got ${JSON.stringify(result)}`,
        );
        return `${ms}ms, pop-up hidden`;
      });
    }

    await check("selection and opacity", async () => {
      const selection = await contract("selection()");
      expect(
        selection.rangeCount === 0 || selection.collapsed,
        `a selection is left on the page (${selection.rangeCount} range(s))`,
      );
      const opacity = await contract("opacity('line-quiet')");
      expect(opacity === "0", `the line held at opacity 0 is at ${opacity}`);
      return `rangeCount ${selection.rangeCount}, hidden line at 0`;
    });

    await check("placed pop-up", async () => {
      await contract(`place(${JSON.stringify(PLACE)})`);
      try {
        const { result, text } = await lookup("kirei");
        expect(result?.shown === true, `${text}: ${JSON.stringify(result)}`);
        const state = await popupUntil(
          (s) => s.rect && edgeDelta(s.rect, PLACE) <= PLACE_SLACK,
        );
        expect(state.rect, "no pop-up");
        const delta = edgeDelta(state.rect, PLACE);
        expect(
          delta <= PLACE_SLACK,
          `the pop-up is at ${fmt(state.rect)}, not over ${fmt(PLACE)} (off by ${Math.round(delta)} px)`,
        );
        return `${fmt(state.rect)}, within ${delta.toFixed(1)} px`;
      } finally {
        await contract("place(null)");
        await dismissed();
        // The extensions give placing back once the filled pop-up has closed (content.js `place`).
        await sleep(150);
      }
    });

    await check("pop-up beside the word", async () => {
      const { result, text } = await lookup("hashiru");
      expect(result?.shown === true, `${text}: ${JSON.stringify(result)}`);
      const state = await popupUntil((s) => s.visible && hasHead(s, "hashiru"));
      expect(state.rect, "no pop-up");
      const word = await contract("wordRect('hashiru')");
      const distance = gap(state.rect, word);
      expect(
        distance <= NEAR_WORD,
        `the pop-up ${fmt(state.rect)} is ${Math.round(distance)} px from the word ${fmt(word)}`,
      );
      expect(
        edgeDelta(state.rect, PLACE) > PLACE_SLACK,
        `the pop-up is still over the full-screen rectangle ${fmt(PLACE)} after place(null)`,
      );
      await dismissed();
      return `${fmt(state.rect)}, ${Math.round(distance)} px from ${fmt(word)}`;
    });

    if (engine === "tenten") {
      await check("beside the word with an iframe", async () => {
        const first = await lookup("otona");
        expect(
          first.result?.shown === true,
          `without the iframe: ${JSON.stringify(first.result)}`,
        );
        const before = await popupUntil(
          (s) => s.visible && hasHead(s, "otona"),
        );
        await dismissed();
        const frame = await contract("stray(true)");
        try {
          const second = await lookup("otona");
          expect(
            second.result?.shown === true,
            `with the iframe: ${JSON.stringify(second.result)}`,
          );
          const after = await popupUntil(
            (s) => s.visible && hasHead(s, "otona"),
          );
          expect(after.rect, "no pop-up with the iframe on the page");
          const word = await contract("wordRect('otona')");
          const moved = edgeDelta(after.rect, before.rect);
          expect(
            moved <= PLACE_SLACK && gap(after.rect, word) <= NEAR_WORD,
            `with an iframe at ${fmt(frame)} the pop-up is at ${fmt(after.rect)}, without it ${fmt(before.rect)} (word ${fmt(word)})`,
          );
          return `${fmt(after.rect)} with the iframe at ${fmt(frame)}, moved ${moved.toFixed(1)} px`;
        } finally {
          await dismissed();
          await contract("stray(false)");
        }
      });
    }

    await check("dismiss", async () => {
      const { result } = await lookup("kirei");
      expect(result?.shown === true, `綺麗: ${JSON.stringify(result)}`);
      await popupUntil((s) => s.visible);
      const state = await dismissed();
      expect(
        !state.visible,
        "the pop-up is still visible 1.5 s after dismiss()",
      );
      return "hidden";
    });
  } catch (error) {
    results.push({
      engine,
      name: "run",
      pass: false,
      detail: `error: ${error.message}`,
    });
  } finally {
    if (results.some((r) => !r.pass)) {
      const reports = await evaluate(
        page,
        "window.__harness?.log.slice(-15) ?? []",
      ).catch(() => []);
      const shot = await page
        .send("Page.captureScreenshot", { format: "png" })
        .catch(() => null);
      const notes = [];
      if (shot) {
        const file = path.join(
          os.tmpdir(),
          `kimochi-engine-contract-${engine}.png`,
        );
        await writeFile(file, Buffer.from(shot.data, "base64"));
        notes.push(`screenshot: ${file}`);
      }
      if (reports.length)
        notes.push(`last reports:\n      ${reports.join("\n      ")}`);
      results.diagnostics = notes;
    }
    if (!opts.headed)
      await browser
        .send("Target.closeTarget", { targetId: page.targetId })
        .catch(() => {});
  }
  return results;
}

// ---------------------------------------------------------------- main

function printTable(rows, versions) {
  const width = (key) =>
    Math.max(...rows.map((row) => String(row[key]).length));
  const nameWidth = Math.max(width("name"), 5);
  console.log("");
  console.log(
    `Engines: ${Object.entries(versions)
      .map(([id, version]) => `${id} ${version}`)
      .join(", ")}`,
  );
  console.log("");
  let engine = null;
  for (const row of rows) {
    if (row.engine !== engine) {
      engine = row.engine;
      console.log(`${engine} ${versions[engine]}`);
    }
    console.log(
      `  ${row.pass ? "PASS" : "FAIL"}  ${row.name.padEnd(nameWidth)}  ${row.detail}`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(
      "npm run test:engines -- [--engine yomitan,hachidori,tenten] [--headed] [--dicts <dir>] [--port <n>] [--tenten-wait <s>]",
    );
    return;
  }
  const opts = options(argv);
  const versions = {};
  for (const id of opts.engines) {
    await ensureExtension(id, { log });
    versions[id] = await versionOf(id);
  }

  const data = { dictionaries: [] };
  const temp = await mkdtemp(path.join(os.tmpdir(), "kimochi-engines-"));
  const cleanup = [];
  const rows = [];
  const diagnostics = [];
  try {
    if (opts.engines.some((engine) => engine !== "tenten")) {
      const zips = await excerpts(opts.dicts, sceneTerms());
      if (!zips) {
        console.error(
          `No JMdict dictionary for Yomitan and Hachidori: ${opts.dicts} holds no Yomitan JMdict zip.\n` +
            "Neither engine ships a dictionary; the suite cuts a small excerpt from your own JMdict\n" +
            '(the Yomitan-format zip, e.g. "[Bilingual] JMdict (Recommended).zip"). Put it in that folder,\n' +
            "or point KIMOCHI_YOMITAN_DICTS (or --dicts) at the folder that has it.\n" +
            "To run 10ten alone, which needs none: npm run test:engines -- --engine tenten",
        );
        process.exitCode = 2;
        return;
      }
      const server = await serveFiles(
        new Map(zips.map((zip) => [zip.name, zip.zip])),
      );
      cleanup.push(server.close);
      for (const zip of zips) {
        const file = path.join(temp, zip.name);
        await writeFile(file, zip.zip);
        data.dictionaries.push({ ...zip, file, url: server.url(zip.name) });
        log(`excerpt of ${zip.title} (${zip.source}): ${zip.zip.length} bytes`);
      }
    }

    const servers = await startServers(opts.port, { preview: false });
    cleanup.push(servers.close);
    log(`dev server ${servers.origins.app}`);
    const browser = await launchChrome({
      headless: !opts.headed,
      args: [
        "--disable-popup-blocking",
        "--lang=en-US",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    cleanup.push(browser.close);
    for (const engine of opts.engines) {
      log(`${engine} ${versions[engine]}…`);
      const results = await runEngine(browser, engine, {
        origins: servers.origins,
        data,
        opts,
      });
      rows.push(...results);
      if (results.diagnostics)
        diagnostics.push({ engine, notes: results.diagnostics });
    }
    if (opts.headed) {
      log("--headed: Chrome stays open; press Ctrl+C to end.");
      await new Promise((resolve) => process.once("SIGINT", resolve));
    }
  } finally {
    for (const close of cleanup.reverse())
      await close().catch((error) => log(`cleanup: ${error.message}`));
    await rm(temp, { recursive: true, force: true });
  }

  printTable(rows, versions);
  for (const { engine, notes } of diagnostics) {
    console.log("");
    console.log(`${engine} diagnostics:`);
    for (const note of notes) console.log(`    ${note}`);
  }
  const failed = rows.filter((row) => !row.pass);
  console.log("");
  console.log(
    failed.length
      ? `${failed.length} of ${rows.length} checks FAILED`
      : `All ${rows.length} checks passed`,
  );
  if (failed.length) process.exitCode = 1;
}

await main();
