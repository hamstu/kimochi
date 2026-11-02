// How often the native `state` broadcast fires while Auto OCR watches a still screen, and which
// fields of it change: the panels re-render on every one.
//   node scen-state.mjs [--seconds 15]
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as l from "./lib.mjs";
import * as app from "./app.mjs";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const seconds = Number(arg("--seconds", "15"));
const build = process.env.KIMOCHI_BUILD ?? "kimochi-final";
const dir = l.runDir("state");
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
const G = "state";
l.startGame(G, `${dir}/game`, ["--skip", "off", "--rect", "200,150,1924,1004"]);
await l.waitGame(G);
await l.game(G, "text 今日はとても良い天気ですね。散歩に行きましょう。|　");
await l.sleep(500);
if (!(await l.pickSource(`Fake Game [${G}]`))) throw Error("pick failed");
const P = "panel.html";
const SWITCH = `[...document.querySelectorAll('[role=switch]')].find((s) => (s.closest('label') ?? s.parentElement?.parentElement)?.innerText.includes('Auto OCR'))`;
const autoOn = () => l.js(P, `(${SWITCH})?.getAttribute('aria-checked') ?? (${SWITCH})?.dataset.state`);
for (let i = 0; i < 40 && (await autoOn()) == null; i++) await l.sleep(250);
if ((await autoOn()) !== "true") await l.realClick(P, SWITCH);
await l.sleep(8000);
// Record every `state` event in the panel: when, and which top-level fields differ from the last.
await l.js(P, `(async () => {
  window.__states = [];
  let last = null;
  await window.__TAURI__.event.listen('state', ({ payload }) => {
    const changed = last ? Object.keys(payload).filter((k) => JSON.stringify(payload[k]) !== JSON.stringify(last[k])) : ['(first)'];
    const detail = {};
    for (const k of changed) if (k !== 'logs' && JSON.stringify(payload[k]).length < 300) detail[k] = payload[k];
    window.__states.push({ at: performance.now(), bytes: JSON.stringify(payload).length, changed, detail });
    last = payload;
  });
  return true;
})()`);
await l.sleep(seconds * 1000);
const states = await l.js(P, `window.__states`);
// Every running animation in the panel and its same-origin frames: what keeps its renderer busy.
const anims = await l.js(P, `(() => {
  const describe = (doc, where) => doc.getAnimations({ subtree: true }).map((a) => {
    const t = a.effect?.target;
    return { where, kind: a.constructor.name, name: a.animationName ?? a.transitionProperty ?? null, state: a.playState,
      target: t ? (t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(' ').join('.') : '') + (t.getAttribute?.('aria-label') ? '[' + t.getAttribute('aria-label') + ']' : '')) : null,
      text: t?.textContent?.slice(0, 40) ?? null };
  });
  let out = describe(document, 'panel');
  for (const f of document.querySelectorAll('iframe')) { try { out = out.concat(describe(f.contentDocument, f.src.split('/').pop())); } catch {} }
  return out;
})()`);
l.note(dir, `running animations (${anims.length}): ${JSON.stringify(anims)}`);
// The snapshot the panels poll: how big, how long, and whether its status changes between polls.
const snaps = await l.js(P, `(async () => {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    const v = await window.__TAURI__.core.invoke('snapshot');
    out.push({ ms: Math.round((performance.now() - t) * 10) / 10, bytes: JSON.stringify(v).length, revision: v.revision, status: v.status, scanning: v.scanning, keys: Object.keys(v), scanBytes: JSON.stringify(v.scan ?? null).length, logsBytes: JSON.stringify(v.logs ?? null).length });
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
})()`, 20000);
l.note(dir, `snapshot: ${JSON.stringify(snaps.map((s) => [s.ms, s.bytes, s.revision, s.scanning, s.status]))}`);
l.note(dir, `snapshot keys ${JSON.stringify(snaps[0].keys)} scan ${snaps[0].scanBytes} B, logs ${snaps[0].logsBytes} B`);
l.note(dir, `state events in ${seconds} s: ${states.length} (${(states.length / seconds).toFixed(1)}/s), payload ${states[0]?.bytes ?? 0} bytes`);
const counts = {};
for (const s of states) for (const k of s.changed) counts[k] = (counts[k] ?? 0) + 1;
l.note(dir, `fields changed: ${JSON.stringify(counts)}`);
for (const s of states.slice(0, 12)) l.note(dir, `  +${Math.round(s.at)} ${JSON.stringify(s.detail)}`);
l.save(dir, "result.json", { states });
await app.stop().catch(() => {});
await l.sleep(1000);
killDebug();
await l.sleep(1500);
try { execFileSync("taskkill", ["/IM", `${build}.exe`, "/F"], { stdio: "ignore" }); } catch {}
try { execFileSync("taskkill", ["/IM", "fakegame.exe", "/F"], { stdio: "ignore" }); } catch {}
process.exit(0);
