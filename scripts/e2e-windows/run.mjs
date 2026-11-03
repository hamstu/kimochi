import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  root,
  page,
  invoke,
  click,
  desktop,
  sleep,
  closeAll,
  verifyIsolation,
} from "./app.mjs";
import { alignmentMetrics } from "../overlay-alignment-metrics.mjs";
import { acquireDesktop } from "./desktop-lock.mjs";
const [
  scenario = "scan",
  source = "window",
  renderer = "gdi",
  mode = "windowed",
] = process.argv.slice(2);
assert(
  ["scan", "hover", "auto", "windows", "quickshot", "focus", "keys", "alt", "selfocr", "hook"].includes(scenario),
  "known scenario",
);
assert(
  ["window", "display"].includes(source),
  "source must be window or display",
);
assert(
  scenario !== "windows" || source === "window",
  "window lifecycle requires a window source",
);
assert(
  scenario !== "selfocr" || source === "display",
  "selfocr checks a display source",
);
assert(
  scenario !== "hook" || source === "window",
  "the Text Hooker hooks a window's game",
);
// The hook scenario runs the game as a real x64 (default) or x86 process: KIMOCHI_E2E_HOOK_BITS.
const hookBits = process.env.KIMOCHI_E2E_HOOK_BITS === "32" ? "x86" : "x64";
if (renderer !== "gdi" || !["windowed", "borderless"].includes(mode))
  throw Error(
    "This harness currently supports GDI windowed/borderless only; DXGI prototype remains external",
  );
const desktopLease = await acquireDesktop();
const stamp = `${scenario}-${source}-${renderer}-${mode}-${Date.now()}`;
const out = path.join(root, "evidence", stamp);
await mkdir(out, { recursive: true });
const result = {
  scenario,
  source,
  renderer,
  mode,
  started: Date.now(),
  checks: [],
  out,
};
let app, overlay;
async function check(name, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    result.checks.push({ name, pass: true, ms: Date.now() - start, value });
    return value;
  } catch (error) {
    result.checks.push({
      name,
      pass: false,
      ms: Date.now() - start,
      error: String(error),
    });
    throw error;
  }
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw Error("Condition timed out: " + JSON.stringify(last));
}
const command = async (text) => {
  await writeFile(path.join(root, "game/command.txt"), text);
  await sleep(350);
};
const truth = async () =>
  JSON.parse(await readFile(path.join(root, "game/truth.json"), "utf8"));
const state = () => invoke(overlay, "snapshot");
async function clearUiSource(p) {
  const r = await p.eval(
    `(()=>{const e=document.querySelector('button.src-card');if(!e)return null;const r=e.getBoundingClientRect();return {x:(screenX*${SCREEN_SCALE}+r.x+20)*devicePixelRatio,y:(screenY*${SCREEN_SCALE}+r.y+20)*devicePixelRatio}})()`,
  );
  if (r) {
    desktop("mouse", Math.round(r.x), Math.round(r.y));
    await sleep(150);
  }
  await click(p, 'button[aria-label="Clear source"]');
  await until(
    () =>
      p.eval(
        `Boolean(document.querySelector('button[aria-label="Choose a source"]'))`,
      ),
    3000,
  );
}
async function activateMain() {
  let w = JSON.parse(desktop("windows")).find(
    (w) => w.pid === app && w.title === "Kimochi",
  );
  assert(w, "main HWND exists");
  desktop("show", w.hwnd, 5);
  if (w.rect.width < 480) {
    let p = await page("panel.html");
    try {
      await click(p, 'button[aria-label="Expand Kimochi"]');
    } finally {
      p.close();
    }
    await sleep(200);
    w = JSON.parse(desktop("windows")).find((x) => x.hwnd === w.hwnd);
  }
  desktop("focus", w.hwnd);
  await sleep(100);
  desktop("mouse", w.rect.x + w.rect.width - 180, w.rect.y + 15, "click");
  await sleep(150);
}
async function chooseSource() {
  await activateMain();
  let p = await page("panel.html");
  try {
    let clear = await p.eval(
      `Boolean(document.querySelector('button[aria-label="Clear source"]'))`,
    );
    if (clear) {
      await clearUiSource(p);
    }
    if (
      await p.eval(
        `Boolean(document.querySelector('button[aria-label="Choose a source"]'))`,
      )
    )
      await click(p, 'button[aria-label="Choose a source"]');
    else await click(p, "button.src-card");
    await sleep(100);
    await click(p, '[role="menuitem"]', "Window or screen");
    await sleep(350);
    await click(
      p,
      '[role="menuitem"]',
      source === "window" ? "Kimochi E2E Fake Game" : "Display 1",
    );
    await sleep(300);
    if (
      await p.eval(
        `document.querySelector('button[aria-label="Show overlay"]')?.getAttribute('aria-checked')==='false'`,
      )
    ) {
      await click(p, 'button[aria-label="Show overlay"]');
      await sleep(200);
    }
  } finally {
    p.close();
  }
}
async function scan() {
  let prior;
  let p = await page("panel.html");
  try {
    await activateMain();
    if (
      await p.eval(
        `document.querySelector('button[aria-label="Show overlay"]')?.getAttribute('aria-checked')==='false'`,
      )
    ) {
      await click(p, 'button[aria-label="Show overlay"]');
      await sleep(150);
    }
    await until(
      () =>
        p.eval(
          `Boolean(document.querySelector('button.src-scan:not(:disabled)'))`,
        ),
      30000,
    );
    const registration = await invoke(p, "hotkeys_save", {
      hotkeys: {
        triggerScan: { accelerator: "Shift+F8", enabled: true },
        openControllerMenu: { accelerator: "Shift+F9", enabled: true },
      },
    });
    assert.equal(registration.failed.length, 0, "isolated shortcuts register");
    prior = (await state()).scan?.id;
  } finally {
    p.close();
  }
  await focusGame();
  if (mode !== "windowed") {
    await command(mode);
    await focusGame();
  }
  desktop("chord", 16, 119);
  return await until(async () => {
    let s = await state();
    if (s.scan?.id !== prior && s.scan?.ocr?.fullText)
      return { id: s.scan.id, text: s.scan.ocr.fullText, status: s.status };
    return false;
  }, 30000);
}
async function focusGame() {
  const t = await truth();
  const g = JSON.parse(desktop("windows")).find((w) => w.hwnd === t.hwnd);
  if (g.iconic) desktop("show", t.hwnd, 9);
  desktop("focus", t.hwnd);
  await sleep(100);
  desktop("mouse", t.client.x + 300, t.client.y + 220, "click");
  await sleep(180);
  const w = JSON.parse(desktop("windows")).find((w) => w.hwnd === t.hwnd);
  assert(w.foreground, "game is foreground");
}
// Desktop points from a page's screen coordinates. Chromium's screenX/Y are at WebView2's own
// device scale, which Windows Text size raises above the display's (the page's CSS pixels are
// zoomed back, screenX is not); native reports the factor (COMMANDS.md, "Webview scale"),
// 1 wherever nothing is off. A physical point is (screenX * this + x) * devicePixelRatio.
const SCREEN_SCALE = "(window.__KIMOCHI_PLATFORM__?.screenScale||1)";
async function rendered() {
  return overlay.eval(
    `({x:screenX*${SCREEN_SCALE},y:screenY*${SCREEN_SCALE},dpr:devicePixelRatio,words:[...document.querySelectorAll('.ocr-word')].map(e=>({text:e.querySelector('.ocr-word-current')?.textContent,rect:e.getBoundingClientRect().toJSON(),vertical:e.classList.contains('ocr-vertical')}))})`,
  );
}
/** The Log's lines, oldest first, as the main window shows them (its newest 100). */
async function logEntries() {
  const p = await page("panel.html");
  try {
    return await p.eval(
      `[...document.querySelectorAll('[data-line-text]')].map(e=>({id:e.dataset.lineId,text:e.dataset.lineText}))`,
    );
  } finally {
    p.close();
  }
}
const logLines = async () => (await logEntries()).map((e) => e.text);
/** The texts of lines added since `seen` (a set of line ids). */
const newLines = async (seen) =>
  (await logEntries()).filter((e) => !seen.has(e.id)).map((e) => e.text);
const hookStatus = () => invoke(overlay, "texthook_status");
/**
 * A dialogue line no earlier run has shown (the Log drops repeats of recent lines): hiragana
 * words, one per digit of a counter, which OCR reads reliably.
 */
const WORDS = ["そら", "うみ", "やま", "かわ", "もり", "はな", "ほし", "つき", "かぜ", "あめ"];
let said = Date.now() % 100000;
const freshLine = () =>
  "きょうは" + [...String(++said).padStart(5, "0")].map((d) => WORDS[d]).join("と") + "をみます。";
const say = () => command("say " + freshLine());
async function chooseThread(text) {
  const p = await page("panel.html");
  try {
    await click(p, 'button[aria-label="Text thread"]');
    await sleep(300);
    await click(p, '[role="menuitemradio"]', text);
  } finally {
    p.close();
  }
}
/**
 * Text Hooker: pick the fake game in the real source menu, let it hook, check the dialogue
 * thread is chosen by matching the screen (not the nameplate, HUD or menu threads), that the
 * Log gets exactly the dialogue lines, and that choosing another thread by hand takes effect.
 */
async function hookScenario() {
  await check("hook-pick-in-real-ui", async () => {
    await activateMain();
    const p = await page("panel.html");
    try {
      if (
        await p.eval(
          `Boolean(document.querySelector('button[aria-label="Clear source"]'))`,
        )
      )
        await clearUiSource(p);
      if (
        await p.eval(
          `Boolean(document.querySelector('button[aria-label="Choose a source"]'))`,
        )
      )
        await click(p, 'button[aria-label="Choose a source"]');
      else await click(p, "button.src-card");
      await sleep(150);
      await click(p, '[role="menuitem"]', "Text Hooker");
      // Hookable windows come first; Kimochi's own windows are never offered.
      const tiles = await until(
        () =>
          p.eval(
            `(()=>{const t=[...document.querySelectorAll('.sg-tile')];return t.some(e=>e.innerText.includes('E2E Fake'))?t.map(e=>({text:e.innerText.replace(/\\s+/g,' '),disabled:e.hasAttribute('data-disabled')})):false})()`,
          ),
        20000,
      );
      const game = tiles.find((t) => t.text.includes("E2E Fake"));
      assert(game && !game.disabled, "the fake game can be hooked");
      assert(
        tiles.filter((t) => /^Kimochi\b/.test(t.text)).every((t) => t.disabled),
        "Kimochi's own windows are not offered",
      );
      await click(p, ".sg-tile", "Kimochi E2E Fake Game");
      await sleep(300);
      return { tiles };
    } finally {
      p.close();
    }
  });
  const hooked = await check("hook-attached", async () => {
    const { pid } = await truth();
    // This game's session: an earlier one may still report "hooked" for a moment.
    const status = await until(async () => {
      const s = await hookStatus();
      if (!s.pids?.includes(pid)) return false;
      assert.notEqual(s.phase, "failed", s.detail);
      return s.phase === "hooked" ? s : false;
    }, 90000);
    assert.equal(status.engine?.id, "luna", "LunaHook is the first engine");
    return { engine: status.engine, pids: status.pids, exe: status.exe };
  });
  // Forget a thread remembered by an earlier run, so the choice below is made by the screen.
  await invoke(overlay, "texthook_select", { key: null });
  await focusGame();
  const before = new Set((await logEntries()).map((e) => e.id));
  await say();
  const picked = await check("hook-auto-selects-dialogue", async () => {
    const status = await until(async () => {
      const s = await hookStatus();
      return s.selected ? s : false;
    }, 30000);
    const t = await truth();
    const thread = status.threads.find((x) => x.key === status.selected);
    assert.equal(status.selectedBy, "auto", "chosen by matching the screen");
    assert.equal(thread.name, "TextOutW", "the dialogue's thread, not a decoy's");
    assert.equal(thread.preview, t.dialogue);
    return {
      selected: thread,
      threads: status.threads.map((x) => ({ name: x.name, preview: x.preview })),
      hooked,
    };
  });
  await check("hook-log-receives-dialogue", async () => {
    const first = await truth();
    await until(async () => (await newLines(before)).includes(first.dialogue), 10000);
    await say();
    const second = await truth();
    assert.notEqual(second.dialogue, first.dialogue);
    const lines = await until(async () => {
      const all = await newLines(before);
      return all.at(-1) === second.dialogue ? all : false;
    }, 15000);
    // Exactly the dialogue: no nameplate, HUD or menu text, no repeats.
    assert.deepEqual(lines, [first.dialogue, second.dialogue]);
    return { lines };
  });
  await check("hook-manual-override", async () => {
    const t = await truth();
    await chooseThread(t.speaker);
    const status = await until(async () => {
      const s = await hookStatus();
      return s.selectedBy === "manual" ? s : false;
    }, 5000);
    const thread = status.threads.find((x) => x.key === status.selected);
    assert.equal(thread.preview, t.speaker);
    const lines = await until(async () => {
      const all = await logLines();
      return all.at(-1) === t.speaker ? all : false;
    }, 10000);
    // Back to choosing automatically, which also forgets the manual choice for this game.
    await chooseThread("Choose automatically");
    await focusGame();
    await say();
    const auto = await until(async () => {
      const s = await hookStatus();
      return s.selectedBy === "auto" ? s : false;
    }, 30000);
    return {
      manual: thread.name,
      logged: lines.at(-1),
      backTo: auto.threads.find((x) => x.selected)?.name,
    };
  });
  // --- the card: the hooked line over the game (ui/hook-card.js) ---------------------------------
  const status = await hookStatus();
  const key = status.exe.toLowerCase();
  const games = async () => (await invoke(overlay, "settings_get", { key: "textHookerGames" })) ?? {};
  const game = async () => (await games())[key] ?? {};
  const setGame = async (value) => {
    const all = await games();
    all[key] = value;
    await invoke(overlay, "settings_set", { key: "textHookerGames", value: all });
    await sleep(400);
  };
  // The card on screen in physical pixels: its text box, the top of its glyphs' em box, its text
  // size, and where its controls are.
  const card = () =>
    overlay.eval(`(()=>{const c=document.querySelector('.hook-card');if(!c||c.hidden)return null;const t=c.querySelector('.hook-card-text');const s=${SCREEN_SCALE},d=devicePixelRatio;const at=(e)=>{const r=e.getBoundingClientRect();return {x:(screenX*s+r.left+r.width/2)*d,y:(screenY*s+r.top+r.height/2)*d}};const r=t.getBoundingClientRect();const cs=getComputedStyle(t);const font=parseFloat(cs.fontSize),lh=parseFloat(cs.lineHeight);return {text:t.textContent,x:(screenX*s+r.left)*d,y:(screenY*s+r.top)*d,emTop:(screenY*s+r.top+(lh-font)/2)*d,font:font*d,bar:at(c.querySelector('.hook-card-bar')),smaller:at(c.querySelectorAll('.hook-card-button')[0]),larger:at(c.querySelectorAll('.hook-card-button')[1]),more:at(c.querySelector('.hook-card-more')),menu:c.querySelector('.hook-card-menu').hidden?null:[...c.querySelectorAll('.hook-card-opacity')].map(o=>({value:Number(o.dataset.opacity),...at(o)}))}})()`);
  const compact = (text) => String(text ?? "").replace(/\s/g, "");
  const shown = async (text) => {
    try {
      return await until(async () => { const c = await card(); return c && compact(c.text) === compact(text) ? c : false; }, 8000);
    } catch {
      const c = await card();
      const st = await state();
      const why = (st.logs ?? []).filter((l) => l.check === "hook-card-shown").slice(-3);
      throw Error(`the card shows ${JSON.stringify(c?.text ?? null)}, not ${JSON.stringify(text)} (focus ${JSON.stringify(st.sourceFocus)}, ${JSON.stringify(why)})`);
    }
  };
  const press = async (point) => {
    desktop("mouse", Math.round(point.x), Math.round(point.y));
    await sleep(150);
    desktop("mouse", Math.round(point.x), Math.round(point.y), "click");
    await sleep(500);
  };
  const p = await page("panel.html");
  try {
    if (await p.eval(`document.querySelector('button[aria-label="Show overlay"]')?.getAttribute('aria-checked')==='false'`))
      await click(p, 'button[aria-label="Show overlay"]');
  } finally {
    p.close();
  }

  await check("hook-card-shows-line", async () => {
    // From nothing learned: Auto align on, no size, no place.
    await setGame({ autoAlign: true });
    await focusGame();
    await say();
    const t = await truth();
    const c = await shown(t.dialogue);
    return { text: c.text, font: c.font };
  });

  await check("hook-card-auto-aligns-steadily", async () => {
    // Several lines, long and short: once aligned, the card's text sits on the game's, at the
    // game's size, and neither moves from line to line.
    await until(async () => (await game()).ocrBox, 20000);
    const seen = [];
    for (const line of [freshLine(), "はい。", freshLine(), "そうか。"]) {
      await focusGame();
      await command("say " + line);
      const t = await truth();
      await shown(t.dialogue);
      await sleep(3000);
      const c = await card();
      const first = t.lines.find((l) => l.text === line);
      seen.push({ line, x: c.x - first.x, y: c.emTop - first.y, font: c.font / first.size, at: [c.x, c.emTop] });
    }
    for (const s of seen) {
      assert(Math.abs(s.x) <= 8, `the text starts where the game's does (${s.x.toFixed(1)} px off)`);
      assert(Math.abs(s.y) <= 8, `the glyphs sit on the game's (${s.y.toFixed(1)} px off)`);
      assert(Math.abs(s.font - 1) <= 0.1, `at the game's size (${s.font.toFixed(3)})`);
    }
    const xs = seen.map((s) => s.at[0]), ys = seen.map((s) => s.at[1]);
    assert(Math.max(...xs) - Math.min(...xs) <= 2 && Math.max(...ys) - Math.min(...ys) <= 2, "the card does not move between lines");
    return seen;
  });

  await check("hook-typewriter-double-click", async () => {
    // A line typed out, skipped to its end, and the next one typed out, all in one burst: two
    // clean lines in the Log, the second on the card, nothing jumbled.
    const seen = new Set((await logEntries()).map((e) => e.id));
    const a = "「" + freshLine() + "」";
    const b = "「" + freshLine() + "」";
    await focusGame();
    await command(`type ${a}|${b}`);
    await until(async () => !(await truth()).typing, 10000);
    const lines = await until(async () => { const l = await newLines(seen); return l.includes(b) ? l : false; }, 10000);
    assert(lines.includes(a), "the first line reaches the Log whole: " + JSON.stringify(lines));
    assert(lines.every((l) => l === a || l === b), "nothing jumbled reaches the Log: " + JSON.stringify(lines));
    await shown(b);
    return lines;
  });

  await check("hook-typewriter-pause", async () => {
    // A line that holds for a second before a drawn-out "ーーー", longer than the hooker waits: it
    // arrives in two bursts, the second carrying on the first. One whole line in the Log (the
    // part before the pause replaced, never left as a fragment) and on the card.
    const seen = new Set((await logEntries()).map((e) => e.id));
    const line = "「" + freshLine() + "、ん" + "ーーーーーっ」";
    // Each webview hears a broadcast once per webview: kept once per id.
    await overlay.eval(`window.__hookLines=new Map();window.__TAURI__.event.listen("texthook-line",(e)=>window.__hookLines.set(e.payload.id,e.payload))`);
    await focusGame();
    await command(`typeout ${line.replace("、んー", "、ん‖ー")}`);
    await until(async () => !(await truth()).typing, 15000);
    const lines = await until(async () => { const l = await newLines(seen); return l.includes(line) ? l : false; }, 10000);
    const sent = await overlay.eval(`JSON.stringify([...window.__hookLines.values()])`).then(JSON.parse);
    assert(lines.length === 1, "one line in the Log, the part before the pause replaced: " + JSON.stringify({ lines, sent }));
    assert(sent.length >= 2 && sent.at(-1).replaces === sent.at(-2).id, "it came in two pieces, the second replacing the first: " + JSON.stringify(sent));
    await shown(line).catch((error) => { throw Error(error.message + " after " + JSON.stringify(sent)); });
    return lines;
  });

  await check("hook-card-drag-takes-over", async () => {
    await focusGame();
    await say();
    const before = await shown((await truth()).dialogue);
    const from = { x: Math.round(before.bar.x - 60), y: Math.round(before.bar.y) };
    desktop("mouse", from.x, from.y);
    await sleep(200);
    desktop("mouse", from.x, from.y, "down");
    await sleep(120);
    const trail = [];
    for (let i = 1; i <= 8; i++) {
      desktop("mouse", from.x - i * 20, from.y - i * 12);
      await sleep(35);
      const c = await card();
      trail.push([Math.round(c.x - before.x), Math.round(c.y - before.y)]);
    }
    desktop("mouse", from.x - 160, from.y - 96, "up");
    await sleep(600);
    const after = await card();
    const g = await game();
    for (const [i, [dx, dy]] of trail.entries())
      assert(Math.abs(dx + (i + 1) * 20) <= 3 && Math.abs(dy + (i + 1) * 12) <= 3, "the card follows the pointer: " + JSON.stringify(trail));
    assert(Math.abs(after.x - before.x + 160) <= 3 && Math.abs(after.y - before.y + 96) <= 3, "and stays where it was let go");
    assert(g.autoAlign === false && g.box, "dragging turns Auto align off and keeps the place");
    // A new line keeps the reader's place.
    await focusGame();
    await say();
    const next = await shown((await truth()).dialogue);
    assert(Math.abs(next.x - after.x) <= 2 && Math.abs(next.y - after.y) <= 2, "the next line stays there");
    return { trail, box: g.box };
  });

  await check("hook-card-text-size-and-menu", async () => {
    const before = await card();
    await press(before.larger);
    const larger = await until(async () => { const c = await card(); return c.font > before.font * 1.05 ? c : false; }, 4000);
    await press(larger.smaller);
    const back = await until(async () => { const c = await card(); return Math.abs(c.font - before.font) < 1 ? c : false; }, 4000);
    await press(back.more);
    const open = await until(async () => { const c = await card(); return c.menu ? c : false; }, 4000);
    await press(open.menu.find((o) => o.value === 0.7));
    const g = await until(async () => { const g = await game(); return g.opacity === 0.7 ? g : false; }, 4000);
    const opacity = await overlay.eval(`getComputedStyle(document.querySelector('.hook-card'),'::before').opacity`);
    assert(Math.abs(Number(opacity) - 0.7) < 0.01, "the card's background fades, not its text");
    return { font: [before.font, larger.font, back.font], opacity: g.opacity };
  });

  await check("hook-auto-align-back-on", async () => {
    // Back on from the panel, it forgets the reader's size and aligns again. The reader's size is
    // made plainly bigger than the game's first, so taking the game's again shows.
    const reader = await game();
    await setGame({ ...reader, text: (reader.text ?? 0.035) * 1.4 });
    const p = await page("panel.html");
    try {
      await until(() => p.eval(`document.querySelector('button[aria-label="Auto align"]')?.getAttribute('aria-checked')==='false'`), 4000);
      await click(p, 'button[aria-label="Auto align"]');
    } finally {
      p.close();
    }
    await until(async () => (await game()).autoAlign === true, 4000);
    await focusGame();
    await say();
    const t = await truth();
    await until(async () => (await game()).ocrBox, 20000);
    await sleep(800);
    const c = await card();
    const first = t.lines.find((l) => l.text.length > 3 && t.dialogue.startsWith(l.text));
    assert(Math.abs(c.font / first.size - 1) <= 0.1, `the game's text size again, not the reader's (${c.font} vs ${first.size})`);
    assert(Math.abs(c.x - first.x) <= 8 && Math.abs(c.emTop - first.y) <= 8, "and lines up with the game's text again");
    return { x: c.x - first.x, y: c.emTop - first.y, font: c.font / first.size };
  });

  // A pad button pressed and let go, as native reports the controller (src-tauri/src/gamepad.rs).
  const navEvent = (pressed, released, held) =>
    overlay.eval(
      `window.__TAURI__.event.emit('controller-nav',${JSON.stringify({ pressed, released, held, stick: { x: 0, y: 0 }, rstick: { x: 0, y: 0 } })})`,
    );
  const nav = async (buttons) => {
    await navEvent(buttons, [], buttons);
    await sleep(80);
    await navEvent([], buttons, []);
  };
  let menuSeen = null;
  const readAlong = async () => {
    await focusGame();
    // Out of the way: the menu's wedges follow the mouse, and a pad reader's is wherever it was.
    desktop("mouse", 2, 2);
    await sleep(150);
    await invoke(overlay, "trigger_action", { name: "openControllerMenu" });
    await until(() => overlay.eval(`Boolean(document.querySelector('#controller .cm-ring'))`), 4000).catch(() => null);
    await sleep(400);
    // What the menu offers and has selected, for a failure to say.
    menuSeen = await overlay.eval(`[...document.querySelectorAll("#controller .cm-item")].map((e) => (e.classList.contains("cm-selected") ? "*" : "") + e.textContent.trim())`);
    await nav([0]); // A: Read along, where the menu starts when the line is in
  };
  const leave = async () => {
    await nav([1]); // B
    await sleep(500);
    await nav([1]);
    await sleep(500);
  };

  await check("hook-read-along", async () => {
    // Read along as the pop-up style, over the text (Settings → Game Mode).
    const view = (await invoke(overlay, "settings_get", { key: "gameModeSettings" })) ?? {};
    await invoke(overlay, "settings_set", { key: "gameModeSettings", value: { ...view, dictionaryView: "popup" } });
    await focusGame();
    await say();
    const t = await truth();
    await shown(t.dialogue);
    await readAlong();
    // Stepping through the card's words: the lit word is on the card, which stays up although the
    // game no longer has the focus.
    let miss = null;
    const lit = await until(
      async () => {
        const v = await overlay.eval(`(()=>{const w=document.querySelector('#controller .cm-word');const c=document.querySelector('.hook-card');if(!w||!c||c.hidden)return {miss:{word:Boolean(w),card:c?!c.hidden:null,controller:document.querySelector('#controller')?.innerText.slice(0,80)}};const a=w.getBoundingClientRect(),b=c.querySelector('.hook-card-text').getBoundingClientRect();return a.left>=b.left-4&&a.right<=b.right+4&&a.top>=b.top-4&&a.bottom<=b.bottom+4?{word:a.toJSON(),card:b.toJSON()}:{miss:{word:a.toJSON(),card:b.toJSON()}}})()`);
        if (!v?.miss) return v;
        miss = { ...v.miss, foreground: JSON.parse(desktop("windows")).find((w) => w.foreground)?.title };
        return false;
      },
      8000,
    ).catch((error) => {
      throw Error(`no lit word on the card: ${JSON.stringify(miss)}, menu ${JSON.stringify(menuSeen)} (${error})`);
    });
    await leave();
    return lit;
  });

  await check("hook-read-along-full-screen", async () => {
    const before = (await invoke(overlay, "settings_get", { key: "gameModeSettings" })) ?? {};
    await invoke(overlay, "settings_set", { key: "gameModeSettings", value: { ...before, dictionaryView: "fullscreen" } });
    await sleep(300);
    try {
      const t = await truth();
      await readAlong();
      const text = await until(
        () => overlay.eval(`(()=>{const e=document.querySelector('.gd-root');return e?[...e.querySelectorAll('.gd-line')].map(x=>x.textContent).join(''):null})()`),
        8000,
      );
      assert(compact(text) === compact(t.dialogue), "the hooked line across the top: " + text);
      await leave();
      return text;
    } finally {
      await invoke(overlay, "settings_set", { key: "gameModeSettings", value: before });
    }
  });
  await evidence("hook");
  return picked;
}
async function evidence(name) {
  const s = await state();
  await writeFile(
    path.join(out, name + "-state.json"),
    JSON.stringify(s, null, 2),
  );
  await writeFile(
    path.join(out, name + "-dom.json"),
    JSON.stringify(await rendered(), null, 2),
  );
  await writeFile(
    path.join(out, name + "-truth.json"),
    JSON.stringify(await truth(), null, 2),
  );
  await writeFile(path.join(out, name + "-windows.json"), desktop("windows"));
}
try {
  await check("app-ready-and-isolated", async () => {
    try {
      overlay = await page("overlay.html");
    } catch {
      const log = await open(path.join(out, "app.log"), "w");
      const child = spawn(
        process.env.KIMOCHI_E2E_EXE ||
          (() => {
            throw Error(
              "Set KIMOCHI_E2E_EXE to an identifier-isolated debug build",
            );
          })(),
        [],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
              "--remote-debugging-port=19333" +
              (process.env.KIMOCHI_E2E_DISABLE_GPU ? " --disable-gpu" : ""),
          },
        },
      );
      child.unref();
      await log.close();
      await until(async () => {
        try {
          overlay = await page("overlay.html");
          return true;
        } catch {
          return false;
        }
      });
    }
    let main = await page("panel.html");
    let paths;
    try {
      paths = await verifyIsolation(main);
    } finally {
      main.close();
    }
    const caps = await invoke(overlay, "platform_capabilities");
    if (scenario === "hover") {
      const engine = await invoke(overlay, "dictionary_engine_effective");
      assert.equal(
        engine.effective,
        "tenten",
        "hover oracle requires downloaded, active 10ten; select it in Settings first",
      );
      const readiness = await until(async () => {
        const status = await invoke(overlay, "dictionary_runtime_status", {
          engine: "tenten",
        });
        return status.phase === "starting" ? false : status;
      }, 15000);
      assert(
        readiness.phase === "ready" && readiness.lookups === true,
        `10ten dictionary data must finish loading before hover tests: ${readiness.message}`,
      );
    }
    app = caps.ownPids[0];
    assert(app);
    return {
      pid: app,
      paths,
      observer: caps.observer,
      engines: caps.ocrEngines,
      displays: await invoke(overlay, "displays"),
    };
  });
  await check("game-ready", async () => {
    let g = JSON.parse(desktop("windows")).find((w) =>
      w.title.includes("E2E Fake"),
    );
    // The hook scenario needs the hookable game of the chosen bitness; any other copy goes.
    if (g && scenario === "hook") {
      const t = await truth().catch(() => null);
      if (!t?.hookable || t.bits !== (hookBits === "x86" ? 32 : 64)) {
        await command("close");
        await until(async () => !JSON.parse(desktop("windows")).some((w) => w.hwnd === g.hwnd), 10000);
        g = null;
      }
    }
    if (!g) {
      const [exe, extra] =
        scenario === "hook" ? [`Desktop-${hookBits}.exe`, ["", "hookable"]] : ["Desktop.exe", []];
      spawn(path.join(root, exe), ["game", path.join(root, "game"), ...extra], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      g = await until(
        async () =>
          JSON.parse(desktop("windows")).find((w) =>
            w.title.includes("E2E Fake"),
          ),
        // An emulated x86 .NET game starts slowly on ARM64.
        30000,
      );
    }
    desktop("show", g.hwnd, 5);
    const ownedTruth = await until(async () => {
      try {
        const value = await truth();
        return value.hwnd === g.hwnd ? value : false;
      } catch {
        return false;
      }
    }, 3000);
    assert.equal(
      ownedTruth.hwnd,
      g.hwnd,
      "fake game belongs to this run directory; close other fake games first",
    );
    await command("windowed");
    return await truth();
  });
  if (scenario === "hook") await hookScenario();
  else await check("pick-source-in-real-ui", chooseSource);
  if (
    scenario === "scan" ||
    scenario === "hover" ||
    scenario === "auto" ||
    scenario === "windows"
  ) {
    await check("manual-scan", scan);
    await focusGame();
    await sleep(300);
    await check("overlay-lines", async () => {
      const d = await rendered();
      assert(d.words.length > 2);
      return {
        words: d.words.length,
        text: d.words.map((w) => w.text).join("|"),
      };
    });
    const measureAlignment = async (filename = "alignment.json") => {
      // A scan with Auto OCR on starts the overlay over (force rescan): wait for the words.
      await until(async () => (await rendered()).words.length > 2, 30000);
      const chars = await overlay.eval(
        `(()=>{const out=[];for(const root of document.querySelectorAll('.ocr-word-current')){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){let offset=0;for(const c of node.textContent){const r=document.createRange();r.setStart(node,offset);offset+=c.length;r.setEnd(node,offset);const b=r.getBoundingClientRect();const font=parseFloat(getComputedStyle(node.parentElement).fontSize);if(b.width&&b.height)out.push({c,cx:(screenX*${SCREEN_SCALE}+b.x+b.width/2)*devicePixelRatio,cy:(screenY*${SCREEN_SCALE}+b.y+b.height/2)*devicePixelRatio,fontSize:font*devicePixelRatio});}}}return out})()`,
      );
      const t = await truth();
      const metrics = alignmentMetrics(t, chars);
      const lines = t.lines.map((line) => {
        const m = alignmentMetrics({ lines: [line] }, chars);
        return {
          text: line.text,
          ...m,
          alongMeanPixels: m.alongMean * line.size,
          acrossMeanPixels: m.acrossMean * line.size,
        };
      });
      await writeFile(
        path.join(out, filename),
        JSON.stringify({ metrics, lines, chars }, null, 2),
      );
      assert(metrics.coverage > 0.5, "at least half truth glyphs render");
      assert(
        metrics.alongMean < 0.5 && metrics.acrossMean < 0.5,
        "mean cell center error below half glyph",
      );
      return { metrics, lines };
    };
    await check("alignment-physical-pixels", () => measureAlignment());
    await evidence("scan");
    if (scenario === "hover") {
      const d = await rendered();
      const w =
        d.words.find((w) => w.text.includes("回想")) ||
        d.words.find((w) => w.text.includes("猫")) ||
        d.words.find((w) => /日本/.test(w.text));
      assert(w, "lookup candidate");
      const popupState = () =>
        overlay.eval(
          `(()=>{const h=document.querySelector('#tenten-ja-window'),k=h?.shadowRoot?.querySelector('.container:not(.hidden)'),e=k?.querySelector('.window');if(!e)return null;const r=e.getBoundingClientRect();return {text:e.innerText,html:h.shadowRoot.innerHTML,rect:r.toJSON(),ghost:k.classList.contains('ghost'),x:screenX*${SCREEN_SCALE},y:screenY*${SCREEN_SCALE},dpr:devicePixelRatio,viewport:{width:innerWidth,height:innerHeight}}})()`,
        );
      const popup = await check("hover-opens-dictionary", async () => {
        desktop("key", 16, "down");
        const wx = Math.round((d.x + w.rect.x + Math.min(12, w.rect.width / 2)) * d.dpr);
        const wy = Math.round((d.y + w.rect.y + w.rect.height / 2) * d.dpr);
        // A hand arrives in more than one step. Landing on the word in one jump from far away
        // opened 10ten only one time in four on the Arcade PC (the replayed and the real move
        // then reach it within the same instant); a short second move, which a real approach
        // ends with anyway, opened it every time.
        desktop("mouse", wx - 2, wy - 1);
        await sleep(120);
        desktop("mouse", wx, wy);
        const pop = await until(popupState, 5000);
        assert(
          pop.text.includes("回想") ||
            pop.text.includes("猫") ||
            pop.text.includes("日本"),
          "lookup matches hovered text",
        );
        assert(pop.x + pop.rect.x >= 0 && pop.y + pop.rect.y >= 0); // CSS pixels: on screen
        assert(
          pop.rect.right <= pop.viewport.width &&
            pop.rect.bottom <= pop.viewport.height,
          "popup fits the overlay viewport",
        );
        return { lookupWord: w.text, ...pop };
      });
      await evidence("hover");
      await check("enter-popup-keeps-it-open", async () => {
        // 10ten opens its pop-up as a "ghost": no pointer events, so a pointer moving into it
        // falls through to the page and the lookup under it clears. It becomes hoverable 400 ms
        // later, or, with hold-to-show keys set, when the key is released. Release Shift (the
        // leave check below does not need it held) and wait for the interactive pop-up, as a
        // reader does, before moving in.
        desktop("key", 16, "up");
        await until(async () => {
          const p = await popupState();
          return p && !p.ghost;
        }, 3000);
        desktop(
          "mouse",
          Math.round((popup.x + popup.rect.x + 18) * popup.dpr),
          Math.round((popup.y + popup.rect.y + 8) * popup.dpr),
        );
        await sleep(80);
        desktop(
          "mouse",
          Math.round(
            (popup.x + popup.rect.x + popup.rect.width / 2) * popup.dpr,
          ),
          Math.round(
            (popup.y + popup.rect.y + popup.rect.height / 2) * popup.dpr,
          ),
        );
        await sleep(600);
        assert(await popupState());
        return true;
      });
      await check("leave-clears-popup", async () => {
        // Shift is already up. Clear of the pop-up and the word, wherever they are at this scale.
        desktop(
          "mouse",
          Math.round((popup.x + popup.rect.right) * popup.dpr + 200),
          Math.round((popup.y + popup.rect.top) * popup.dpr),
        );
        await until(async () => !(await popupState()), 5000);
        return true;
      });
    }
    if (scenario === "auto" || scenario === "windows") {
      await activateMain();
      let p = await page("panel.html");
      await click(p, 'button[aria-label="Auto OCR"]');
      p.close();
      await until(async () => (await state()).autoOcrEnabled);
      await focusGame();
      await check("auto-text-change", async () => {
        const before = (await state()).scan?.id;
        desktop("chord", 32);
        await sleep(150);
        const expected = (await truth()).lines
          .find((l) => l.text.startsWith("今日") || l.text.startsWith("明日"))
          .text.slice(0, 2);
        await until(async () => {
          let s = await state();
          return (
            s.scan?.id !== before && s.scan?.ocr.fullText.includes(expected)
          );
        }, 30000);
        return { expected };
      });
      await evidence("auto");
      if (scenario === "windows") {
        await check("move-and-resize", async () => {
          await command("move 190 130 1127 809");
          await sleep(1000);
          let s = await state();
          return {
            sourceWindow: await invoke(overlay, "source_window_state"),
            origin: s.origin,
            truth: await truth(),
          };
        });
        await check("fresh-alignment-after-move", async () => {
          await scan();
          await sleep(300);
          return measureAlignment("moved-alignment.json");
        });
        await evidence("moved");
        await check("minimize-waits", async () => {
          await command("minimize");
          await sleep(Number(process.env.KIMOCHI_E2E_HIDDEN_MS || 4500));
          let s = await state();
          assert(s.autoOcrEnabled, "Auto OCR stays enabled");
          assert(
            !/suspended/i.test(s.status),
            "scanner has not silently suspended",
          );
          assert(
            !s.logs.some(
              (log) => log.reason === "suspended" || log.state === "suspended",
            ),
            "no suspension in recent scanner logs",
          );
          return { enabled: s.autoOcrEnabled, status: s.status };
        });
        await evidence("minimized");
        await check("restore-resumes", async () => {
          await command("restore");
          await focusGame();
          const old = (await state()).scan?.id;
          await command("advance");
          await until(async () => (await state()).scan?.id !== old, 30000);
          return true;
        });
        await evidence("restored");
        await check("close-stops-auto", async () => {
          await command("close");
          await until(async () => !(await state()).autoOcrEnabled, 10000);
          return true;
        });
      }
    }
  } else if (scenario === "focus") {
    // A hover leaves the game in front: keys after a lookup reach it, and a game that
    // reads the keyboard while it believes it is active is told when the reader leaves (#27).
    await check("manual-scan", scan);
    await command("skip active");
    const d = await rendered();
    const w = d.words.find((w) => /今日|明日|青い/.test(w.text)) ?? d.words[0];
    const t = await truth();
    const empty = [t.client.x + 300, t.client.y + 220];
    const game = () => JSON.parse(desktop("windows")).find((x) => x.hwnd === t.hwnd);
    await check("hover-keeps-game-in-front", async () => {
      await focusGame();
      desktop("key", 16, "down");
      desktop(
        "mouse",
        Math.round((d.x + w.rect.x + w.rect.width / 3) * d.dpr),
        Math.round((d.y + w.rect.y + w.rect.height / 2) * d.dpr),
      );
      await sleep(900);
      const during = game().foreground;
      desktop("key", 16, "up");
      desktop("mouse", ...empty);
      await sleep(1200);
      assert(game().foreground, "game is in front after the hover");
      return { word: w.text, inFrontDuringHover: during };
    });
    await check("keys-after-hover-reach-the-game", async () => {
      const before = (await truth()).page;
      desktop("chord", 32);
      await sleep(500);
      assert.equal((await truth()).page, before + 1, "Space advanced the game");
      return true;
    });
    const chatDir = path.join(root, "chat");
    await check("keys-typed-into-another-app-do-not-reach-the-game", async () => {
      spawn(path.join(root, "Desktop.exe"), ["game", chatDir, "Kimochi E2E Chat"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      const chat = await until(async () =>
        JSON.parse(desktop("windows")).find((x) => x.title === "Kimochi E2E Chat"),
      );
      desktop("move", chat.hwnd, t.client.x + t.client.width + 80, t.client.y, 700, 500);
      await sleep(300);
      desktop("mouse", t.client.x + t.client.width + 300, t.client.y + 250, "click");
      await sleep(400);
      const before = await truth();
      desktop("key", 17, "down");
      await sleep(700);
      desktop("key", 17, "up");
      desktop("chord", 32);
      await sleep(400);
      const after = await truth();
      assert.equal(after.page, before.page, "the game ignored Ctrl/Space typed into the chat window");
      return { gameBelievedActive: before.believesActive };
    });
    await writeFile(path.join(chatDir, "command.txt"), "close").catch(() => {});
    await command("skip off");
  } else if (scenario === "keys") {
    // What a game sees of Kimochi's shortcut (#16, #19).
    await check("manual-scan", scan);
    await command("skip focused");
    await focusGame();
    const input = path.join(root, "game/input.jsonl");
    const lines = async () => (await readFile(input, "utf8")).trim().split(/\r?\n/);
    const since = async (n) => (await lines()).slice(n).map((line) => JSON.parse(line));
    await check("bound-shortcut-key-down-never-reaches-the-game", async () => {
      const n = (await lines()).length;
      const prior = (await state()).scan?.id;
      desktop("chord", 16, 119);
      await until(async () => (await state()).scan?.id !== prior, 30000);
      const seen = await since(n);
      const keyDowns = seen.filter((e) => e.kind === "message" && e.msg === 0x100).map((e) => e.wparam);
      assert(!keyDowns.includes(119), "F8's key-down is Kimochi's");
      return { keyDowns, keyUps: seen.filter((e) => e.kind === "message" && e.msg === 0x101).map((e) => e.wparam) };
    });
    await check("a-ctrl-chord-would-skip-text", async () => {
      // Informational for #16: Ctrl+Shift+8 (unbound here) as a VN sees it.
      const before = (await truth()).page;
      desktop("chord", 17, 16, 56);
      await sleep(700);
      return { pagesSkipped: (await truth()).page - before };
    });
    await command("skip off");
  } else if (scenario === "alt") {
    await activateMain();
    await check("a-lone-alt-does-not-freeze-the-main-window", async () => {
      desktop("key", 18, "down");
      desktop("key", 18, "up");
      await sleep(400);
      const gui = JSON.parse(desktop("guiinfo"));
      const start = Date.now();
      await fetch("http://127.0.0.1:19333/json/version", { signal: AbortSignal.timeout(6000) }).catch(() => {});
      const devtoolsMs = Date.now() - start;
      desktop("chord", 27);
      assert(!(gui.flags & 4), "no menu loop after a lone Alt (GUI_INMENUMODE)");
      assert(devtoolsMs < 3000, "WebView2 still answers");
      return { flags: gui.flags, devtoolsMs };
    });
  } else if (scenario === "selfocr") {
    await check("manual-scan", scan);
    await check("a-display-scan-skips-kimochis-windows", async () => {
      const main = JSON.parse(desktop("windows")).find((w) => w.pid === app && w.title === "Kimochi" && w.visible);
      assert(main, "main window on screen");
      const d = await rendered();
      const over = d.words.filter((w) => {
        const x = (d.x + w.rect.x + w.rect.width / 2) * d.dpr;
        const y = (d.y + w.rect.y + w.rect.height / 2) * d.dpr;
        return x >= main.rect.x && x < main.rect.x + main.rect.width && y >= main.rect.y && y < main.rect.y + main.rect.height;
      });
      assert.equal(over.length, 0, "no overlay text drawn over Kimochi's own window");
      return { words: d.words.length, overMainWindow: over.length };
    });
  } else if (scenario === "quickshot") {
    await activateMain();
    let p = await page("panel.html");
    try {
      await clearUiSource(p);
      await click(p, 'button[aria-label="Choose a source"]');
      await sleep(100);
      await click(p, '[role="menuitem"]', "Quick Shot");
      await invoke(p, "hotkeys_save", {
        hotkeys: {
          triggerScan: { accelerator: "Shift+F8", enabled: true },
          openControllerMenu: { accelerator: "Shift+F9", enabled: true },
        },
      });
    } finally {
      p.close();
    }
    const selecting = () =>
      overlay.eval(`window.__kimochiOverlayState().regionSelecting`);
    await focusGame();
    await check("quickshot-open", async () => {
      desktop("chord", 16, 119);
      return until(selecting, 5000);
    });
    await check("quickshot-escape", async () => {
      desktop("chord", 27);
      await until(async () => !(await selecting()), 5000);
      return true;
    });
    await evidence("quickshot-escape");
    await check("quickshot-second-press-closes", async () => {
      desktop("chord", 16, 119);
      await until(selecting, 5000);
      // Pressed again before a box is drawn, the shortcut closes the editor like Esc (0.3.0;
      // before that it was ignored, #25).
      desktop("chord", 16, 119);
      await until(async () => !(await selecting()), 5000);
      return true;
    });
    await check("quickshot-draw-and-scan", async () => {
      const prior = (await state()).scan?.id;
      await focusGame();
      const t = await truth();
      desktop("chord", 16, 119);
      await until(selecting, 5000);
      desktop(
        "mouse",
        t.client.x + 25,
        t.client.y + t.client.height - 205,
        "down",
      );
      desktop("mouse", t.client.x + 650, t.client.y + t.client.height - 30);
      desktop(
        "mouse",
        t.client.x + 650,
        t.client.y + t.client.height - 30,
        "up",
      );
      await sleep(250);
      desktop("chord", 13);
      await until(async () => !(await selecting()), 5000);
      const s = await until(async () => {
        const s = await state();
        return s.scan?.id !== prior && s.scan?.ocr.fullText ? s : false;
      }, 30000);
      assert(/今日|明日|青/.test(s.scan.ocr.fullText));
      const expected = t.lines
        .filter((line) => !line.vertical && line.size === 28)
        .map((line) => line.text);
      const compact = (text) => text.replace(/\s+/g, "");
      for (const line of expected)
        assert(
          compact(s.scan.ocr.fullText).includes(compact(line)),
          "current selected dialogue is recognised",
        );
      assert(
        !/Scanning|\blines\b|\bchars\b|Kimochi/i.test(s.scan.ocr.fullText),
        "selected game region contains no Kimochi UI",
      );
      return { text: s.scan.ocr.fullText, expected };
    });
    await evidence("quickshot-scanned");
  }
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.error = String(error);
  try {
    await evidence("failure");
  } catch (e) {
    result.evidenceError = String(e);
  }
} finally {
  desktop("key", 16, "up");
  overlay?.close();
  closeAll();
  desktopLease.close();
  result.ms = Date.now() - result.started;
  await writeFile(
    path.join(out, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      scenario,
      source,
      mode,
      pass: result.pass,
      ms: result.ms,
      error: result.error,
      checks: result.checks.map((c) => ({
        name: c.name,
        pass: c.pass,
        ms: c.ms,
      })),
      out,
    }),
  );
}
if (!result.pass) process.exitCode = 1;
