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
  ["scan", "hover", "auto", "windows", "quickshot", "focus", "keys", "alt", "selfocr"].includes(scenario),
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
    if (!g) {
      spawn(path.join(root, "Desktop.exe"), ["game", path.join(root, "game")], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      g = await until(async () =>
        JSON.parse(desktop("windows")).find((w) =>
          w.title.includes("E2E Fake"),
        ),
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
  await check("pick-source-in-real-ui", chooseSource);
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
