// Idle cost: with Auto OCR watching a source that shows a finished line, how much CPU does Kimochi
// (the app and its WebView2 processes) use while nothing changes, and while a small element blinks.
//   node scen-idle.mjs --engine ppocr|meikiocr|oneocr [--build kimochi-final] [--blink] [--seconds 30]
// Writes runs/<stamp>-idle-<label>/result.json. Starts and stops the app like scen-settle.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as l from "./lib.mjs";
import * as app from "./app.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const engine = arg("--engine", "ppocr");
const build = arg("--build", "kimochi-final");
const seconds = Number(arg("--seconds", "30"));
const blink = process.argv.includes("--blink");
// `--no-auto`: pick the source but leave Auto OCR off, for the cost of the app alone.
const auto = !process.argv.includes("--no-auto");
// `--no-source`: no fake game and no source picked (implies no Auto OCR): the app at rest.
const source = !process.argv.includes("--no-source");
// `--no-anim`: every CSS animation and transition in the panel window switched off, to measure what
// its running animations cost.
const noAnim = process.argv.includes("--no-anim");
const label = arg("--label", `${build}-${engine}${blink ? "-blink" : ""}${auto ? "" : "-noauto"}${source ? "" : "-nosource"}${noAnim ? "-noanim" : ""}`);
const dir = l.runDir(`idle-${label}`);
const ROAMING = `${process.env.APPDATA}/dev.kimochi.vmtest`;
const SETTINGS = `${ROAMING}/settings.json`;
const EVIDENCE = `${ROAMING}/evidence.jsonl`;

const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
settings.ocrMode = engine;
settings.autoOCRSettings = {
  version: 2, pollInterval: 500, adaptivePollingEnabled: true, adaptivePollMin: 250, adaptivePollMax: 500,
  observerMode: "text", watcher: "auto", stableObservations: 2, maxCandidateAgeMs: 4000,
  minRequestSpacingMs: 1200, emptyObservationsToClear: 3, boxTolerancePx: 3, errorBackoffMs: 2000,
  maxErrorBackoffMs: 30000, maxConsecutiveErrors: 5, imageHashThreshold: 5, localOCRGateEnabled: false,
  localOCRSimilarityThreshold: 0.85,
};
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

process.env.KIMOCHI_BUILD = build;
const killDebug = () => { for (const p of l.kimochiPids()) if (p.path.toLowerCase().includes("target\debug")) { try { process.kill(p.pid); } catch {} } };
killDebug();
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
await l.sleep(1500);
const started = await app.start();
l.note(dir, `app ${build} up in ${started.readyMs} ms; engine ${engine}, blink ${blink}, ${seconds} s`);
await l.sleep(2500);

const G = "idle";
if (source) {
  l.startGame(G, `${dir}/game`, ["--skip", "off", "--rect", "200,150,1924,1004", ...(blink ? ["--blink"] : [])]);
  await l.waitGame(G);
  await l.game(G, "text 今日はとても良い天気ですね。散歩に行きましょう。|　");
  await l.sleep(500);
  if (!(await l.pickSource(`Fake Game [${G}]`))) throw Error("pick failed");
  const P = "panel.html";
  const SWITCH = `[...document.querySelectorAll('[role=switch]')].find((s) => (s.closest('label') ?? s.parentElement?.parentElement)?.innerText.includes('Auto OCR'))`;
  const autoOn = () => l.js(P, `(${SWITCH})?.getAttribute('aria-checked') ?? (${SWITCH})?.dataset.state`);
  for (let i = 0; i < 40 && (await autoOn()) == null; i++) await l.sleep(250);
  if ((await autoOn()) !== String(auto)) await l.realClick(P, SWITCH);
  await l.sleep(800);
  l.note(dir, `auto OCR: ${await autoOn()}`);
  const t = await l.truth(G);
  l.w32("activate", t.hwnd);
}
if (noAnim) {
  await l.js("panel.html", `(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.appendChild(s); return true; })()`);
  l.note(dir, "panel animations off");
}
// Let the line settle and the scheduler ease off before sampling.
await l.sleep(8000);

/** CPU time (ms) of the app and every descendant process (WebView2, OCR workers), by pid. */
function cpu() {
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${l.HERE}/cpu-tree.ps1`, "-Name", build], { encoding: "utf8" });
  const map = {};
  for (const line of out.trim().split(/\r?\n/).filter(Boolean)) { const [pid, name, ms] = line.split(" "); map[pid] = { name, ms: Number(ms) }; }
  return map;
}
const cores = Number(execFileSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors"], { encoding: "utf8" }).trim());
/** Renderer-side metrics of every page (DevTools Performance domain), keyed by page. */
async function pageMetrics() {
  const out = {};
  for (const t of (await l.targets()).filter((x) => x.type === "page")) {
    const name = t.url.replace(/^.*\//, "").replace(/[?#].*$/, "") || t.url;
    try {
      const s = await l.page(name);
      await s.send("Performance.enable").catch(() => {});
      const { metrics } = await s.send("Performance.getMetrics");
      out[name] = Object.fromEntries(metrics.filter((m) => /Duration|JSHeapUsedSize|Nodes$|Documents$/.test(m.name)).map((m) => [m.name, m.value]));
    } catch (e) { out[name] = { error: String(e) }; }
  }
  return out;
}
/** Start a CPU profile on a page; returns a function that stops it and summarises self time by function. */
async function profile(name) {
  const s = await l.page(name);
  await s.send("Profiler.enable");
  await s.send("Profiler.setSamplingInterval", { interval: 1000 });
  await s.send("Profiler.start");
  return async () => {
    const { profile } = await s.send("Profiler.stop");
    const self = new Map();
    const dt = profile.timeDeltas, samples = profile.samples;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < samples.length; i++) {
      const n = byId.get(samples[i]);
      const f = n.callFrame;
      const key = `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*\//, "")}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
    }
    const total = (profile.endTime - profile.startTime) / 1000;
    const top = [...self.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, us]) => ({ fn: k, ms: Math.round(us / 1000) }));
    return { totalMs: Math.round(total), busyMs: Math.round([...self.values()].reduce((x, y) => x + y, 0) / 1000), top, profile };
  };
}
const evidenceFrom = statSync(EVIDENCE).size;
const metricsBefore = await pageMetrics();
const stops = {};
for (const name of ["overlay.html", "panel.html"]) { try { stops[name] = await profile(name); } catch (e) { l.note(dir, `profile ${name}: ${e}`); } }
const a = cpu(); const t0 = Date.now();
await l.sleep(seconds * 1000);
const b = cpu(); const wall = Date.now() - t0;
const profiles = {};
for (const [name, stop] of Object.entries(stops)) { try { profiles[name] = await stop(); } catch (e) { profiles[name] = { error: String(e) }; } }
const metricsAfter = await pageMetrics();
// The Source panel's live badge, magnified, to check its look after a styling change.
try {
  const s = await l.page("panel.html");
  const box = await l.js("panel.html", `(() => { const r = document.querySelector('.src-live')?.getBoundingClientRect(); return r ? { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 } : null; })()`);
  if (box) {
    // A few phases of the live badge's pulse.
    for (let i = 0; i < 6; i++) {
      const { data } = await s.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 4 } });
      writeFileSync(`${dir}/live-badge-${i}.png`, Buffer.from(data, "base64"));
      await l.sleep(230);
    }
    const full = await s.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${dir}/panel.png`, Buffer.from(full.data, "base64"));
  }
} catch (e) { l.note(dir, `screenshot: ${e}`); }
const metricsDelta = {};
for (const [name, after] of Object.entries(metricsAfter)) {
  const before = metricsBefore[name] ?? {};
  metricsDelta[name] = Object.fromEntries(Object.entries(after).filter(([k]) => /Duration/.test(k)).map(([k, v]) => [k, Math.round((v - (before[k] ?? 0)) * 1000)]));
}
const byName = {};
let total = 0;
for (const [pid, v] of Object.entries(b)) { const d = v.ms - (a[pid]?.ms ?? 0); byName[v.name] = (byName[v.name] ?? 0) + d; total += d; }
const audit = readFileSync(EVIDENCE, "utf8").slice(evidenceFrom).split("\n").filter((x) => x.includes('"capture-audit"')).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
const med = (k) => { const v = audit.map((r) => r[k]).filter((x) => typeof x === "number").sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
const summary = {
  label, engine, blink, auto, source, noAnim, seconds: wall / 1000, cores,
  cpuMsByProcess: byName, cpuPercentOfOneCore: Math.round((total / wall) * 1000) / 10,
  looks: audit.length, looksPerSecond: Math.round((audit.length / wall) * 1000 * 10) / 10,
  medianCaptureMs: med("captureMs"), medianObserverMs: med("observerMs"), medianObserveMs: med("observeMs"), medianFingerprintMs: med("fingerprintMs"), medianCommandMs: med("commandMs"),
};
summary.pageMsByKind = metricsDelta;
summary.profileBusyMs = Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, v.busyMs ?? v.error]));
l.note(dir, `SUMMARY ${JSON.stringify(summary)}`);
for (const [name, p] of Object.entries(profiles)) { if (p.top) { l.note(dir, `PROFILE ${name}: ${p.busyMs} ms busy of ${p.totalMs}`); for (const t of p.top) l.note(dir, `   ${t.ms} ms  ${t.fn}`); } }
l.save(dir, "result.json", { summary, before: a, after: b, metricsBefore, metricsAfter, audit });
for (const [name, p] of Object.entries(profiles)) if (p.profile) l.save(dir, `profile-${name}.cpuprofile`, p.profile);
await app.stop().catch(() => {});
await l.sleep(1000);
killDebug();
await l.sleep(1500);
try { execFileSync("taskkill", ["/IM", `${build}.exe`, "/F"], { stdio: "ignore" }); } catch {}
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
process.exit(0);
