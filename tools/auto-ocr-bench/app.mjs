// Start / stop the isolated debug Kimochi (identifier dev.kimochi.vmtest, baked in by
// `node scripts/run.mjs dev --config vmtest.conf.json`), against the Vite dev server on :1430.
//   node app.mjs start [--gpu-off]   launches target\debug\kimochi.exe with DevTools on CDP_PORT
//   node app.mjs stop                app_quit through the panel, then reports how the process ended
//   node app.mjs kill                force-kills every kimochi.exe of this build (not the zombie)
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import * as l from "./lib.mjs";

// Read at start, not at import: a scenario sets KIMOCHI_BUILD after importing this.
const exe = () => path.join(l.REPO, "src-tauri", "target", "debug", `${process.env.KIMOCHI_BUILD ?? "kimochi"}.exe`);
const DEBUG_DIR = path.join(l.REPO, "src-tauri", "target", "debug").toLowerCase();
const [cmd, ...rest] = process.argv.slice(2);

export async function start({ gpuOff = false, extraArgs = "" } = {}) {
  mkdirSync(path.join(l.HERE, "logs"), { recursive: true });
  const log = openSync(path.join(l.HERE, "logs", `app-${Date.now()}.log`), "a");
  const args = [`--remote-debugging-port=${l.CDP_PORT}`, gpuOff ? "--disable-gpu" : "", extraArgs].filter(Boolean).join(" ");
  const child = spawn(exe(), [], {
    cwd: path.join(l.REPO, "src-tauri"),
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args, RUST_LOG: process.env.RUST_LOG ?? "info" },
  });
  child.unref();
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await l.targets();
      if (list.some((t) => t.url.includes("panel.html")) && list.some((t) => t.url.includes("overlay.html"))) break;
    } catch {}
    if (Date.now() - t0 > 60000) throw Error("app did not come up");
    await l.sleep(250);
  }
  return { pid: child.pid, readyMs: Date.now() - t0 };
}

/** Quits like the tray's Quit; returns how long the process took to go, and whether it hung. */
export async function stop({ timeout = 15000 } = {}) {
  const pids = l.kimochiPids().filter((p) => p.path.toLowerCase().startsWith(DEBUG_DIR) && p.threads > 1).map((p) => p.pid);
  l.invoke("app_quit").catch(() => {});
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeout) {
    await l.sleep(100);
    last = l.kimochiPids().filter((p) => pids.includes(p.pid));
    if (!last.length) break;
  }
  l.closeCdp();
  const webview = await webviewChildren(pids);
  return { pids, exitMs: last.length ? null : Date.now() - t0, hung: last.map((p) => ({ pid: p.pid, threads: p.threads })), webviewLeft: webview };
}

async function webviewChildren(pids) {
  if (!pids.length) return 0;
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ? { @(${pids.join(",")}) -contains $_.ParentProcessId }).Count`], { encoding: "utf8" });
  return Number(out.trim() || 0);
}

export function kill() {
  for (const p of l.kimochiPids().filter((p) => p.path.toLowerCase().startsWith(DEBUG_DIR))) {
    try { process.kill(p.pid); } catch {}
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  if (cmd === "start") console.log(await start({ gpuOff: rest.includes("--gpu-off") }));
  else if (cmd === "stop") console.log(await stop());
  else if (cmd === "kill") kill();
  l.closeCdp();
}
