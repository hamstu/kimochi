import { spawn } from "node:child_process";
import { open, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { acquireDesktop } from "./desktop-lock.mjs";
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
const count = Number(process.argv[2] || 20);
if (!Number.isInteger(count) || count < 1)
  throw Error("quit count must be a positive integer");
const desktopLease = await acquireDesktop();
const exe =
  process.env.KIMOCHI_E2E_EXE ||
  (() => {
    throw Error("Set KIMOCHI_E2E_EXE to an identifier-isolated debug build");
  })();
const results = [];
for (let i = 0; i < count; i++) {
  const dir = path.join(root, "evidence", `quit-${Date.now()}-${i}`);
  await mkdir(dir, { recursive: true });
  const log = await open(path.join(dir, "app.log"), "w");
  const start = Date.now();
  const child = spawn(exe, [], {
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19333",
    },
  });
  let exit = null;
  child.on("exit", (code, signal) => (exit = { code, signal, at: Date.now() }));
  let p;
  try {
    for (let n = 0; n < 100; n++) {
      try {
        if (
          !JSON.parse(desktop("windows")).some(
            (w) => w.pid === child.pid && w.title === "Kimochi",
          )
        ) {
          await sleep(100);
          continue;
        }
        p = await page("panel.html");
        await p
          .eval(
            `Array.from(document.querySelectorAll('button')).some(e=>e.ariaLabel==='Quit Kimochi')`,
          )
          .then((v) => {
            if (!v) throw Error("not ready");
          });
        break;
      } catch {
        p?.close();
        p = null;
        await sleep(100);
      }
    }
    if (!p) throw Error("Startup not ready");
    await verifyIsolation(p);
    // Show normal main window, then physically click its own Quit control.
    const main = JSON.parse(desktop("windows")).find(
      (w) => w.pid === child.pid && w.title === "Kimochi",
    );
    if (!main) throw Error("Native main HWND missing");
    desktop("show", main.hwnd, 5);
    desktop("focus", main.hwnd);
    const cap = await invoke(p, "platform_capabilities");
    if (!cap.ownPids.includes(child.pid))
      throw Error("Stale CDP target belongs to another process");
    await sleep(150);
    await writeFile(path.join(dir, "before-windows.json"), desktop("windows"));
    const ready = Date.now();
    await click(p, 'button[aria-label="Quit Kimochi"]');
    p.close();
    p = null;
    for (let n = 0; n < 100 && !exit; n++) await sleep(50);
    const leftover = JSON.parse(desktop("windows")).filter(
      (w) => w.pid === child.pid,
    );
    const r = {
      i,
      pid: child.pid,
      method: "main-window-real-click",
      startupMs: ready - start,
      quitMs: exit ? exit.at - ready : null,
      exit,
      leftover,
      pass: Boolean(exit && exit.code === 0 && leftover.length === 0),
      dir,
    };
    results.push(r);
    console.log(JSON.stringify(r));
    if (!r.pass) break;
  } catch (error) {
    results.push({ i, pid: child.pid, pass: false, error: String(error), dir });
    console.log(String(error));
    break;
  } finally {
    p?.close();
    closeAll();
    await log.close();
    child.unref();
  }
  await sleep(250);
}
await writeFile(
  path.join(root, "evidence", "quit-results.json"),
  JSON.stringify(results, null, 2),
);
if (results.length !== count || results.some((r) => !r.pass))
  process.exitCode = 1;
desktopLease.close();
