// Settle latency: the fake game types a line glyph by glyph (a slow VN typewriter); measure from
// the last glyph to the accurate result being applied, from Kimochi's own auto-OCR trace.
//   node scen-settle.mjs --engine ppocr|meikiocr [--build kimochi-base] [--lines 6] [--glyph 90]
//                        [--blink] [--label x] [--settings '{"minRequestSpacingMs":0}']
// Writes runs/<stamp>-settle-<label>/result.json. The app must be stopped; this starts and stops it.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as l from "./lib.mjs";
import * as app from "./app.mjs";
import * as o from "./overlay.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const engine = arg("--engine", "ppocr");
const build = arg("--build", "kimochi-base");
const lines = Number(arg("--lines", "6"));
const glyphMs = Number(arg("--glyph", "90"));
const blink = process.argv.includes("--blink");
const label = arg("--label", `${build}-${engine}${blink ? "-blink" : ""}`);
const extra = JSON.parse(arg("--settings", "{}"));
const dir = l.runDir(`settle-${label}`);

const ROAMING = `${process.env.APPDATA}/dev.kimochi.vmtest`;
const TRACE = `${ROAMING}/auto-ocr-trace.jsonl`;
const SETTINGS = `${ROAMING}/settings.json`;

// Engine and Auto OCR cadence, written while the app is stopped. Defaults are the shipped ones.
const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
settings.ocrMode = engine;
settings.autoOCRSettings = {
  version: 2, pollInterval: 500, adaptivePollingEnabled: true, adaptivePollMin: 250, adaptivePollMax: 500,
  observerMode: "text", watcher: "auto", stableObservations: 2, maxCandidateAgeMs: 4000,
  minRequestSpacingMs: 1200, emptyObservationsToClear: 3, boxTolerancePx: 3, errorBackoffMs: 2000,
  maxErrorBackoffMs: 30000, maxConsecutiveErrors: 5, imageHashThreshold: 5, localOCRGateEnabled: false,
  localOCRSimilarityThreshold: 0.85, ...extra,
};
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

process.env.KIMOCHI_BUILD = build;
// Any debug build left running would answer DevTools in place of the one under test.
const killDebug = () => { for (const p of l.kimochiPids()) if (p.path.toLowerCase().includes("target\\debug")) { try { process.kill(p.pid); } catch {} } };
killDebug();
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
await l.sleep(1500);
const started = await app.start();
l.note(dir, `app ${build} up in ${started.readyMs} ms; engine ${engine}, glyph ${glyphMs} ms, blink ${blink}`);
await l.sleep(2500);

const G = "settle";
l.startGame(G, `${dir}/game`, ["--skip", "off", "--rect", "200,150,1924,1004", ...(blink ? ["--blink"] : [])]);
await l.waitGame(G);
await l.game(G, "text 　|　");
await l.sleep(500);
if (!(await l.pickSource(`Fake Game [${G}]`))) throw Error("pick failed");

const P = "panel.html";
const SWITCH = `[...document.querySelectorAll('[role=switch]')].find((s) => (s.closest('label') ?? s.parentElement?.parentElement)?.innerText.includes('Auto OCR'))`;
const autoOn = () => l.js(P, `(${SWITCH})?.getAttribute('aria-checked') ?? (${SWITCH})?.dataset.state`);
for (let i = 0; i < 40 && (await autoOn()) == null; i++) await l.sleep(250);
if ((await autoOn()) !== "true") await l.realClick(P, SWITCH);
await l.sleep(800);
l.note(dir, `auto OCR: ${await autoOn()}`);
const t = await l.truth(G);
l.w32("activate", t.hwnd);

const traceFrom = statSync(TRACE).size;
const traceRows = () => {
  const text = readFileSync(TRACE, "utf8");
  return text.slice(traceFrom).trim().split("\n").filter(Boolean).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
};

const SENTENCES = [
  "今日はとても良い天気ですね。散歩に行きましょう。",
  "勇者は魂だけの存在となっても、この世に留まった。",
  "明日の朝、駅の前で待っているからね。",
  "どうしてそんなことを言うの？　信じられないよ。",
  "静かな夜だった。遠くで犬が鳴いている。",
  "お姫様の危機に駆けつけたのです。",
  "このまま時間が止まればいいのに、と思った。",
  "雨が降り出したので、急いで家に帰りました。",
];

// Warm the engines up on a first line.
await l.game(G, `text ${SENTENCES[0]}|　`);
await l.sleep(6000);

const results = [];
for (let n = 0; n < lines; n++) {
  const sentence = SENTENCES[(n + 1) % SENTENCES.length];
  await l.game(G, "text 　|　");
  await l.sleep(2500);
  const glyphs = [...sentence];
  const tStart = Date.now();
  for (let i = 1; i <= glyphs.length; i++) {
    await l.game(G, `text ${glyphs.slice(0, i).join("")}|　`);
    if (i < glyphs.length) await l.sleep(glyphMs);
  }
  const tEnd = Date.now();
  // Wait for the accurate pass of a frame captured after the last glyph, and its apply.
  let row = null;
  const deadline = tEnd + 12000;
  while (Date.now() < deadline) {
    await l.sleep(100);
    const rows = traceRows();
    // The accurate pass of a frame captured after the last glyph (a look that started before it
    // and finished after would carry the line without its end).
    const capturedAt = (frameId) => { const fp = rows.find((r) => r.kind === "first-pass" && r.frameId === frameId); return fp ? fp.at - (fp.roundTripMs ?? 0) : -Infinity; };
    const start = rows.find((r) => r.kind === "second-pass-start" && r.at >= tEnd && capturedAt(r.frameId) >= tEnd - 20);
    const applied = start && rows.find((r) => r.kind === "apply-end" && r.frameId === start.frameId);
    if (applied) {
      const premature = rows.filter((r) => r.kind === "second-pass-start" && r.at >= tStart && r.at < tEnd).length;
      const why = rows.filter((r) => r.kind === "decision" && r.event?.type === "request" && !r.event.queued && r.at >= tStart && r.at <= start.at + 5).map((r) => `${r.at - tEnd}:${r.event.reason}`);
      const end = rows.find((r) => r.kind === "second-pass-end" && r.frameId === start.frameId);
      const ticks = rows.filter((r) => r.kind === "first-pass" && r.at >= tEnd && r.at <= start.at);
      row = {
        line: n, chars: glyphs.length, typingMs: tEnd - tStart,
        settleMs: start.at - tEnd, secondPassMs: end?.durationMs ?? null, totalMs: applied.at - tEnd,
        ticksAfterEnd: ticks.length, premature, why,
        observerMs: ticks.map((r) => Math.round(r.observerMs ?? -1)), roundTripMs: ticks.map((r) => Math.round(r.roundTripMs ?? -1)),
        captureMs: ticks.map((r) => Math.round(r.captureMs ?? -1)),
      };
      // What the overlay now shows for the line, against what was typed.
      await l.sleep(150);
      const norm = (x) => x.replace(/[s　]/g, "");
      const shown = (await o.overlayBoxes().catch(() => [])).map((b) => norm(b.text ?? ""));
      const want = norm(sentence);
      const parts = sentence.split(/[s　]+/).map(norm).filter(Boolean);
      row.exact = shown.some((t) => t === want) || parts.every((p) => shown.includes(p)) || shown.join("").includes(want);
      if (!row.exact) {
        row.shown = shown.filter((t) => t.length > 4 && [...want].filter((c) => t.includes(c)).length > want.length / 2);
        row.shownAll = shown;
      }
      // And a moment later: a line read just before its last glyph is read again once that lands.
      await l.sleep(1500);
      const later = (await o.overlayBoxes().catch(() => [])).map((b) => norm(b.text ?? ""));
      row.eventual = later.some((t) => t === want) || parts.every((p) => later.includes(p)) || later.join("").includes(want);
      break;
    }
  }
  if (!row) row = { line: n, timedOut: true };
  results.push(row);
  l.note(dir, JSON.stringify(row));
}

const ok = results.filter((r) => !r.timedOut);
const med = (k) => { const v = ok.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const summary = { label, engine, glyphMs, blink, extra, n: ok.length, timedOut: results.length - ok.length,
  medianTotalMs: med("totalMs"), medianSettleMs: med("settleMs"), medianSecondPassMs: med("secondPassMs"),
  premature: ok.reduce((a, r) => a + r.premature, 0), exact: ok.filter((r) => r.exact).length, eventual: ok.filter((r) => r.eventual).length };
l.note(dir, `SUMMARY ${JSON.stringify(summary)}`);
l.save(dir, "result.json", { summary, results });
await app.stop().catch(() => {});
await l.sleep(1000);
killDebug();
await l.sleep(1500);
try { execFileSync("taskkill", ["/IM", `${build}.exe`, "/F"], { stdio: "ignore" }); } catch {}
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
process.exit(0);
