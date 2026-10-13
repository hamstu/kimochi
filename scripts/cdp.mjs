/**
 * A small Chrome DevTools Protocol client for local, headless browser automation (the dictionary
 * preview capture, `scripts/capture-dictionary-previews.mjs`). No dependency: Chrome is launched
 * with `--remote-debugging-port=0` and a throwaway profile, and spoken to over Node's own
 * WebSocket. Only what the scripts need: flat sessions per target, commands, and events.
 *
 * Chrome is found at `$CHROME` or the usual install paths for this OS (Google Chrome, Chromium,
 * Edge). The process is the caller's to close (`browser.close()`), which also removes the profile.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
};

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const found = (CANDIDATES[process.platform] ?? []).find(
    (file) => file && existsSync(file),
  );
  if (!found)
    throw Error(
      "No Chrome found: set CHROME to a Chrome or Chromium executable.",
    );
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Launches headless Chrome on a fresh profile and connects to its browser target. */
export async function launchChrome({ args = [], headless = true } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "kimochi-cdp-"));
  const child = spawn(
    findChrome(),
    [
      ...(headless ? ["--headless=new"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--hide-scrollbars",
      "--mute-audio",
      ...args,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  child.once("exit", () => (exited = true));
  const portFile = path.join(profile, "DevToolsActivePort");
  let endpoint = null;
  for (let i = 0; i < 200 && !endpoint && !exited; i++) {
    const text = await readFile(portFile, "utf8").catch(() => "");
    const [port, browserPath] = text.split("\n");
    if (port && browserPath)
      endpoint = `ws://127.0.0.1:${port.trim()}${browserPath.trim()}`;
    else await sleep(50);
  }
  if (!endpoint) {
    child.kill();
    await rm(profile, { recursive: true, force: true });
    throw Error("Chrome did not start its DevTools endpoint");
  }
  const connection = await connect(endpoint);
  return {
    ...connection,
    async close() {
      connection.close();
      if (!exited) {
        child.kill();
        await new Promise((resolve) => {
          child.once("exit", resolve);
          setTimeout(resolve, 3000);
        });
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => {},
      );
    },
  };
}

/** One WebSocket to the browser; `session(id)` scopes commands and events to a target. */
export async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(Error(`Could not connect to ${endpoint}`)),
      { once: true },
    );
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const on = (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  const session = (sessionId) => ({
    id: sessionId,
    send: (method, params) => send(method, params, sessionId),
    on: (method, callback) =>
      on(
        (message) =>
          message.sessionId === sessionId &&
          message.method === method &&
          callback(message.params),
      ),
    /** The next `method` event (optionally one `predicate` accepts), or an error after `timeout` ms. */
    once: (method, { predicate = () => true, timeout = 30000 } = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(Error(`Timed out waiting for ${method}`));
        }, timeout);
        const off = on((message) => {
          if (
            message.sessionId !== sessionId ||
            message.method !== method ||
            !predicate(message.params)
          )
            return;
          clearTimeout(timer);
          off();
          resolve(message.params);
        });
      }),
  });
  return {
    send,
    on,
    session,
    /** Opens a page target and attaches a flat session to it. */
    async newPage(url = "about:blank") {
      const { targetId } = await send("Target.createTarget", { url });
      const { sessionId } = await send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      return { targetId, ...session(sessionId) };
    },
    close() {
      for (const { reject, method } of pending.values())
        reject(Error(`${method}: connection closed`));
      pending.clear();
      socket.close();
    },
  };
}

/** Evaluates `expression` in the page (awaiting a promise) and returns its JSON value. */
export async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw Error(
      `evaluate: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
    );
  }
  return result.value;
}

/** Polls `expression` until it is truthy; returns that value. */
export async function waitFor(
  page,
  expression,
  { timeout = 30000, interval = 100, label = expression } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await evaluate(page, expression).catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}
