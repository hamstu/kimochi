// Where the WebView2 time goes while Auto OCR watches a still screen: a DevTools (Chromium) trace of
// the whole browser for a few seconds, summarised per process and event name.
//   node scen-trace.mjs [--seconds 8] [--no-auto]
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as l from "./lib.mjs";
import * as app from "./app.mjs";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const seconds = Number(arg("--seconds", "8"));
const auto = !process.argv.includes("--no-auto");
const build = process.env.KIMOCHI_BUILD ?? "kimochi-final";
const dir = l.runDir(`trace-${auto ? "auto" : "noauto"}`);
const SETTINGS = `${process.env.APPDATA}/dev.kimochi.vmtest/settings.json`;
const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
settings.ocrMode = "ppocr";
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
process.env.KIMOCHI_BUILD = build;
const killDebug = () => { for (const p of l.kimochiPids()) if (p.path.toLowerCase().includes("target\debug")) { try { process.kill(p.pid); } catch {} } };
killDebug();
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
await l.sleep(1500);
await app.start();
await l.sleep(2500);
const G = "trace";
l.startGame(G, `${dir}/game`, ["--skip", "off", "--rect", "200,150,1924,1004"]);
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
await l.sleep(8000);

const b = await l.cdp();
const events = [];
const off = b.on((m) => { if (m.method === "Tracing.dataCollected") events.push(...m.params.value); });
await b.send("Tracing.start", {
  categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,toplevel,cc,gpu,viz",
  transferMode: "ReportEvents",
});
await l.sleep(seconds * 1000);
const done = new Promise((r) => { const stop = b.on((m) => { if (m.method === "Tracing.tracingComplete") { stop(); r(); } }); });
await b.send("Tracing.end");
await done;
off();
l.note(dir, `${events.length} trace events in ${seconds} s`);
// Process names, then self time per (pid, name) over complete events ('X') and B/E pairs.
const names = {};
for (const e of events) if (e.ph === "M" && e.name === "process_name") names[e.pid] = e.args?.name;
const labels = {};
for (const e of events) if (e.ph === "M" && e.name === "process_labels") labels[e.pid] = e.args?.labels;
const total = {};
const add = (pid, name, dur) => { const k = `${pid}`; (total[k] ??= {})[name] = ((total[k] ?? {})[name] ?? 0) + dur; };
const open = new Map();
for (const e of events) {
  if (e.ph === "X" && typeof e.dur === "number") add(e.pid, e.name, e.dur);
  else if (e.ph === "B") open.set(`${e.pid}:${e.tid}:${e.name}`, e.ts);
  else if (e.ph === "E") { const k = `${e.pid}:${e.tid}:${e.name}`; const t0 = open.get(k); if (t0 != null) { add(e.pid, e.name, e.ts - t0); open.delete(k); } }
}
// Nested events double count (a Paint inside a Task), so report the top names per process and the
// top-level task time (toplevel category: ThreadControllerImpl::RunTask / MessageLoop::RunTask).
const summary = {};
for (const [pid, byName] of Object.entries(total)) {
  const sorted = Object.entries(byName).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([n, us]) => `${n}=${Math.round(us / 1000)}`);
  summary[pid] = { name: names[pid], labels: labels[pid], topMs: sorted };
}
for (const [pid, s] of Object.entries(summary)) l.note(dir, `${pid} ${s.name} ${s.labels ?? ""}: ${s.topMs.join(" ")}`);
l.save(dir, "trace.json", { traceEvents: events });
await app.stop().catch(() => {});
await l.sleep(1000);
killDebug();
await l.sleep(1500);
try { execFileSync("taskkill", ["/IM", `${build}.exe`, "/F"], { stdio: "ignore" }); } catch {}
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
process.exit(0);
