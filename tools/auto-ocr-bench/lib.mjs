// Shared harness plumbing: the fake game's pipe, the Win32 helper, and DevTools for Kimochi's
// WebView2 windows (launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
// The checkout this folder sits in, unless KIMOCHI_REPO says otherwise.
export const REPO = process.env.KIMOCHI_REPO ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = path.join(HERE, "fakegame", "target", "debug");
export const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const { connect, evaluate } = await import(pathToFileURL(path.join(REPO, "scripts", "cdp.mjs")).href);
export { evaluate };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- evidence ----------
export function runDir(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(HERE, "runs", `${stamp}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function save(dir, file, data) {
  writeFileSync(path.join(dir, file), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
export function note(dir, line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  appendFileSync(path.join(dir, "log.txt"), text + "\n");
}

// ---------- Win32 ----------
export function w32(...args) {
  const out = execFileSync(path.join(BIN, "w32.exe"), args.map(String), { encoding: "utf8", timeout: 20000 });
  return JSON.parse(out);
}
export const windowsOf = (pid) => w32("windows", "--pid", pid);
export function kimochiPids() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    "Get-Process kimochi* -ErrorAction SilentlyContinue | % { \"$($_.Id) $($_.Threads.Count) $($_.Path)\" }; exit 0"], { encoding: "utf8" });
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, threads, ...p] = l.split(" ");
    return { pid: Number(pid), threads: Number(threads), path: p.join(" ") };
  });
}
export function kimochiWindows() {
  const all = w32("windows", "--all");
  return all.filter((w) => /^kimochi(-[a-z0-9-]+)?.exe$/i.test(w.exe) && !/oneocr/i.test(w.exe));
}

// ---------- fake game ----------
export function startGame(name, out, extra = []) {
  mkdirSync(out, { recursive: true });
  const child = spawn(path.join(BIN, "fakegame.exe"), ["--name", name, "--out", out, ...extra], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}
export function game(name, cmd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(`\\\\.\\pipe\\fakegame-${name}`, () => sock.write(cmd));
    let data = "";
    const timer = setTimeout(() => { sock.destroy(); reject(Error(`game ${cmd}: timeout`)); }, timeout);
    sock.on("data", (d) => {
      data += d;
      if (data.endsWith("\n")) { clearTimeout(timer); sock.destroy(); resolve(data.trim()); }
    });
    sock.on("error", (e) => { clearTimeout(timer); if (data.endsWith("\n")) resolve(data.trim()); else reject(e); });
  });
}
export async function waitGame(name, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if ((await game(name, "ping", 1000)) === "pong") return; } catch {}
    if (Date.now() > end) throw Error(`game ${name} did not start`);
    await sleep(100);
  }
}
export async function truth(name) {
  return JSON.parse(await game(name, "truth"));
}
export function readInputLog(out) {
  const file = path.join(out, "input.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- DevTools ----------
let browser = null;
const sessions = new Map();
export async function cdp() {
  if (browser) return browser;
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  browser = await connect(version.webSocketDebuggerUrl);
  return browser;
}
export function closeCdp() {
  browser?.close();
  browser = null;
  sessions.clear();
}
export async function targets() {
  return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
}

/** A flat session on the page whose url contains `match` (e.g. "overlay.html", "panel.html"). */
export async function page(match) {
  const b = await cdp();
  const list = await targets();
  const t = list.find((x) => x.type === "page" && (x.url.includes(match) || x.title === match));
  if (!t) throw Error(`no page matching ${match}: ${list.filter((x) => x.type === "page").map((x) => x.url).join(", ")}`);
  if (sessions.has(t.id)) return sessions.get(t.id);
  const { sessionId } = await b.send("Target.attachToTarget", { targetId: t.id, flatten: true });
  const s = b.session(sessionId);
  await s.send("Runtime.enable").catch(() => {});
  sessions.set(t.id, s);
  return s;
}
export async function js(match, expression, timeout = 8000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`js(${match}) timed out`)), timeout); });
  try {
    return await Promise.race([(async () => evaluate(await page(match), expression))(), limit]);
  } finally { clearTimeout(timer); }
}
/** Calls a native command from a page, as the UI does. */
export async function invoke(command, args = {}, where = "panel.html") {
  return js(where, `window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

// ---------- geometry ----------
/** A DOM element's rect in physical screen pixels, from the page's window position. */
export async function screenRect(match, selector) {
  return js(match, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: Math.round((window.screenX + r.left) * dpr), y: Math.round((window.screenY + r.top) * dpr),
      w: Math.round(r.width * dpr), h: Math.round(r.height * dpr), dpr };
  })()`);
}
export function center(r) {
  return [Math.round(r[0] + (r[2] - r[0]) / 2), Math.round(r[1] + (r[3] - r[1]) / 2)];
}
export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter || 1);
}
export function union(rects) {
  return rects.reduce((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])]);
}

/** Clicks the first visible button/link/radio whose text contains `text` (DOM click). */
export async function clickText(match, text, selector = "button, a, [role=radio], [role=option], [role=button], label") {
  return js(match, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.offsetParent !== null);
    const el = els.find((e) => e.innerText.trim().includes(${JSON.stringify(text)}));
    if (!el) return { clicked: false, options: els.map((e) => e.innerText.trim().slice(0, 40)).filter(Boolean) };
    el.click();
    return { clicked: true, text: el.innerText.trim().slice(0, 60) };
  })()`);
}
export async function bodyText(match, n = 2000) {
  return js(match, `document.body.innerText.slice(0, ${n})`);
}

/** Screen rect (physical px) of the first visible element `finder` (a JS expression returning an element). */
export async function screenRectOf(match, finder) {
  return js(match, `(() => {
    const el = (${finder});
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: Math.round((window.screenX + r.left) * dpr), y: Math.round((window.screenY + r.top) * dpr),
      w: Math.round(r.width * dpr), h: Math.round(r.height * dpr), dpr, sx: window.screenX, sy: window.screenY };
  })()`);
}
export const byText = (text, selector = "button, a, [role=radio], [role=option], [role=button], [role=tab], label, li") =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null && e.innerText.trim().startsWith(${JSON.stringify(text)}))`;
/** Real mouse: glide to the element's centre and click it. */
export async function realClick(match, finder, { glide = 150 } = {}) {
  const r = await screenRectOf(match, finder);
  if (!r) throw Error(`realClick: nothing for ${finder}`);
  const [cx, cy] = [r.x + Math.round(r.w / 2), r.y + Math.round(r.h / 2)];
  const [px, py] = w32("pos");
  w32("path", px, py, cx, cy, glide);
  w32("click", "left");
  return { x: cx, y: cy };
}

/** Screenshot a screen rect [l,t,r,b] to a PNG (downscaled by k). Capture-excluded windows don't appear. */
export function shot(rect, file, k = 2) {
  execFileSync("node", [path.join(HERE, "shot.mjs"), rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1], file, String(k)]);
  return file;
}

/** Picks a source in the main window's sidebar like a user: source menu → Window or screen → tile. */
export async function pickSource(titlePart, attempts = 3) {
  const P = "panel.html";
  // A display source's overlay can cover the main window's own buttons (its text is OCR'd):
  // drop the scan on screen first, as a user would have to by moving the window.
  await invoke("clear").catch(() => {});
  const tile = `[...document.querySelectorAll("[role=menuitem]")].filter(e=>e.offsetParent&&e.innerText.includes(${JSON.stringify(titlePart)})).sort((a,b)=>a.innerText.length-b.innerText.length)[0]`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let main = kimochiWindows().find((w) => w.title === "Kimochi" && w.visible);
    // A fresh start can leave the main window in the tray.
    if (!main) { await invoke("panel", { label: "log", action: "show" }).catch(() => {}); await sleep(800); main = kimochiWindows().find((w) => w.title === "Kimochi" && w.visible); }
    if (main) w32("activate", main.hwnd);
    await sleep(250);
    // With Quick Shot selected the button reads "Quick Shot"; its label still says "Change source".
    const opener = byText("Change source", "button") + " ?? " + byText("Choose a source", "button,[role=button],[role=combobox]") + ` ?? document.querySelector("button[aria-label*=\\"Change source\\"]")`;
    await realClick(P, opener).catch(() => {});
    await sleep(600);
    if (await js(P, `!!${byText("Window or", "[role=menuitem]")}`)) { await realClick(P, byText("Window or", "[role=menuitem]")); }
    // The list fills in as windows are enumerated.
    for (let i = 0; i < 20 && !(await js(P, `!!(${tile})`)); i++) await sleep(200);
    if (await js(P, `!!(${tile})`)) {
      await realClick(P, tile);
      await sleep(1500);
      if (await js(P, `document.body.innerText.includes(${JSON.stringify(titlePart)})`)) return true;
    }
    w32("key", "esc");
    await sleep(500);
  }
  return false;
}

/** Frames of a page (from Page.getFrameTree), flattened: [{id, url}]. */
export async function frames(match) {
  const s = await page(match);
  const { frameTree } = await s.send("Page.getFrameTree");
  const out = [];
  const walk = (n) => { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames ?? []).forEach(walk); };
  walk(frameTree);
  return out;
}
/** Evaluates in a child frame whose url contains `urlPart` (an isolated world: DOM access only). */
export async function frameJs(match, urlPart, expression) {
  const s = await page(match);
  const f = (await frames(match)).find((x) => x.url.includes(urlPart));
  if (!f) return undefined;
  const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId: f.id, worldName: "e2e" });
  const { result, exceptionDetails } = await s.send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/** The on-screen box (physical px) of the iframe hosting a child frame, or null when not rendered. */
export async function frameOwnerRect(match, urlPart) {
  const s = await page(match);
  const f = (await frames(match)).find((x) => x.url.includes(urlPart));
  if (!f) return null;
  try {
    const { backendNodeId } = await s.send("DOM.getFrameOwner", { frameId: f.id });
    const { model } = await s.send("DOM.getBoxModel", { backendNodeId });
    const desc = await s.send("DOM.describeNode", { backendNodeId });
    const attrs = desc.node.attributes ?? [];
    const style = attrs[attrs.indexOf("style") + 1] ?? "";
    const win = await js(match, `[window.screenX, window.screenY, window.devicePixelRatio]`);
    const q = model.border;
    const r = [Math.min(q[0], q[6]), Math.min(q[1], q[3]), Math.max(q[2], q[4]), Math.max(q[5], q[7])];
    return { rect: r.map((v, i) => Math.round((v + (i % 2 ? win[1] : win[0])) * win[2])), hidden: /visibility:\s*hidden|display:\s*none|opacity:\s*0[;\s]/.test(style), style: style.slice(0, 160) };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}
