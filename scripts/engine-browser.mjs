/**
 * What the headless-Chrome scripts that run the real dictionary engines share: the dictionary
 * preview capture (scripts/capture-dictionary-previews.mjs) and the engine contract suite
 * (scripts/engine-contract.mjs). Both start the dev server in this process with Hachidori and 10ten
 * on their own origins, cut a JMdict excerpt from the owner's Yomitan zips for Yomitan and
 * Hachidori (neither ships a dictionary), and import it into Hachidori through its settings page.
 */
import { createServer as createHttpServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./cdp.mjs";
import {
  buildExcerpt,
  dictionaryTitle,
  lookupTerms,
  writeZip,
} from "./dictionary-previews.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the owner's Yomitan dictionary zips are: `--dicts`, $KIMOCHI_YOMITAN_DICTS, or beside the repository. */
export const defaultDictsDir = () =>
  process.env.KIMOCHI_YOMITAN_DICTS ?? path.join(root, "..", "yomitan-dicts");

// ---------------------------------------------------------------- servers

/**
 * The dev server (vite.dev.config.ts) on `port`, with the extension origins at +10 and +11, and
 * with `preview` the browser preview (vite.preview.config.ts) on +4000 too. In this process, as
 * vite's own CLI runs them; `close()` stops both.
 */
export async function startServers(port, { preview: withPreview = true } = {}) {
  process.env.KIMOCHI_DEV_PORT = String(port);
  process.env.PREVIEW_PORT = String(port + 4000);
  const { createServer } = await import("vite");
  const quiet = { logLevel: "warn", clearScreen: false };
  const dev = await createServer({
    configFile: path.join(root, "vite.dev.config.ts"),
    ...quiet,
  });
  await dev.listen();
  // Its own dependency cache: two servers over one root would otherwise re-optimise each other's
  // dependencies and answer "504 Outdated Optimize Dep".
  const preview = withPreview
    ? await createServer({
        configFile: path.join(root, "vite.preview.config.ts"),
        cacheDir: path.join(root, "node_modules/.vite-dictionary-previews"),
        ...quiet,
      })
    : null;
  await preview?.listen();
  const origins = {
    app: `http://127.0.0.1:${port}`,
    hachidori: `http://127.0.0.1:${port + 10}`,
    tenten: `http://127.0.0.1:${port + 11}`,
    preview: withPreview ? `http://localhost:${port + 4000}` : null,
  };
  // The extension origins listen a moment after the dev server.
  for (const origin of [origins.hachidori, origins.tenten]) {
    for (let i = 0; ; i++) {
      const ok = await fetch(`${origin}/manifest.json`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      if (i > 100) throw Error(`${origin} did not come up`);
      await sleep(100);
    }
  }
  return {
    origins,
    async close() {
      await preview?.close();
      await dev.close();
    },
  };
}

/** Serves the dictionary excerpts to the scene page (Yomitan fetches its `?dictionary=` URLs). */
export async function serveFiles(files) {
  const server = createHttpServer((req, res) => {
    const data = files.get(
      decodeURIComponent((req.url ?? "").split("?")[0].slice(1)),
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!data) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.end(data);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------- data

/**
 * The JMdict (and CC100, if present) excerpts as zips, from the owner's Yomitan dictionaries in
 * `dir`, holding only the entries for `terms`. Null when `dir` has no JMdict zip.
 */
export async function excerpts(dir, terms = lookupTerms()) {
  const names = (await readdir(dir).catch(() => []))
    .filter((name) => name.endsWith(".zip"))
    .sort();
  const found = new Map();
  for (const name of names) {
    const buffer = await readFile(path.join(dir, name));
    const title = dictionaryTitle(buffer) ?? "";
    const kind = /^JMdict\b/.test(title)
      ? "jmdict"
      : title === "CC100"
        ? "cc100"
        : null;
    if (!kind || found.has(kind)) continue;
    const files = buildExcerpt(buffer, terms);
    if (files)
      found.set(kind, {
        name: `${kind}-excerpt.zip`,
        title,
        source: name,
        zip: writeZip(files),
      });
  }
  if (!found.has("jmdict")) return null;
  return [...found.values()];
}

// ---------------------------------------------------------------- browser

/** Runs `expression` in the frame whose URL starts with `prefix` (Hachidori's settings page). */
export async function inFrame(
  page,
  prefix,
  expression,
  { byValue = false } = {},
) {
  const { frameTree } = await page.send("Page.getFrameTree");
  const frames = [];
  const walk = (node) => {
    frames.push(node.frame);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  const frame = frames.find((f) => f.url.startsWith(prefix));
  if (!frame) return null;
  const { executionContextId } = await page.send("Page.createIsolatedWorld", {
    frameId: frame.id,
    worldName: "kimochi-capture",
  });
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression,
    contextId: executionContextId,
    awaitPromise: true,
    returnByValue: byValue,
  });
  if (exceptionDetails)
    throw Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  return result;
}

/**
 * Imports the excerpt zips (`files`, paths on disk) into Hachidori through its settings page's
 * file input, in the scene's `#options` frame (the harness opens extension pages there).
 */
export async function importIntoHachidori(page, origins, files) {
  const settings = `${origins.hachidori}/settings.html`;
  // A fresh Hachidori opens its first-run page in the options frame as it starts; let that land
  // first, or it replaces the settings page mid-import.
  await waitFor(
    page,
    "document.getElementById('options').src.includes('/startup.html')",
    { timeout: 15000 },
  ).catch(() => {});
  await sleep(500);
  await page.send("Runtime.evaluate", {
    expression: `document.getElementById('options').src = ${JSON.stringify(settings)}`,
  });
  let input = null;
  for (let i = 0; i < 100 && !input?.objectId; i++) {
    input = await inFrame(
      page,
      settings,
      "document.getElementById('import-file')",
    ).catch(() => null);
    if (!input?.objectId) await sleep(150);
  }
  if (!input?.objectId)
    throw Error("Hachidori's settings page has no #import-file input");
  await page.send("DOM.enable");
  // The harness's report count now, to find the readiness report the import leads to.
  const reported = await waitFor(
    page,
    "window.__harness?.log.length + 1",
  ).catch(() => 1);
  await page.send("DOM.setFileInputFiles", { objectId: input.objectId, files });
  const deadline = Date.now() + 120000;
  for (;;) {
    const state = await inFrame(
      page,
      settings,
      "document.getElementById('import-state')?.textContent ?? ''",
      { byValue: true },
    );
    const text = String(state?.value ?? "");
    if (/Finished/.test(text)) {
      if (!/ 0 failed/.test(text))
        throw Error(`Hachidori import: ${text.trim()}`);
      // The host lets lookups through once it reports the engine ready, a moment after the
      // settings page says the import finished; a hover before then shows nothing.
      await waitFor(
        page,
        `window.__harness.log.slice(${reported - 1}).some((line) => line.includes('"check":"dictionary-readiness"') && line.includes('"phase":"ready"'))`,
        { timeout: 30000, label: "Hachidori to report ready after the import" },
      ).catch(() => {});
      return text.trim();
    }
    if (Date.now() > deadline)
      throw Error(`Hachidori import did not finish: ${text.trim()}`);
    await sleep(250);
  }
}

/** The visible text of 10ten's pop-up, which lives in a shadow root (its styles left out). */
export const TENTEN_TEXT = `(() => {
  const root = document.getElementById('tenten-ja-window')?.shadowRoot
  if (!root) return null
  return [...root.children].filter((child) => child.tagName !== 'STYLE').map((child) => child.innerText ?? '').join(' ')
})()`;
