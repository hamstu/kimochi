import { connect, evaluate } from "../cdp.mjs";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolatedPaths } from "./profile.mjs";
export const root = process.env.KIMOCHI_E2E_DIR;
if (!root)
  throw Error(
    "Set KIMOCHI_E2E_DIR to the external harness run directory first",
  );
if (process.platform !== "win32" || !path.isAbsolute(root))
  throw Error("This harness requires Windows and an absolute KIMOCHI_E2E_DIR");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function verifyIsolation(p) {
  const roaming = await invoke(p, "plugin:path|resolve_directory", {
    directory: 14,
    path: "",
  });
  const local = await invoke(p, "plugin:path|resolve_directory", {
    directory: 15,
    path: "",
  });
  assertIsolatedPaths(roaming, local);
  return { roaming, local };
}
export function desktop(...args) {
  return execFileSync(path.join(root, "Desktop.exe"), args.map(String), {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
export async function targets() {
  return await (
    await fetch("http://127.0.0.1:19333/json/list", {
      signal: AbortSignal.timeout(2000),
    })
  ).json();
}
const connections = new Set();
export function closeAll() {
  for (const c of connections) c.close();
  connections.clear();
}
export async function page(match) {
  const all = await targets();
  const t = all.find(
    (t) =>
      t.type === "page" && (t.url.includes(match) || t.title.includes(match)),
  );
  if (!t) throw Error(`No target ${match}: ${all.map((t) => t.url)}`);
  const c = await connect(t.webSocketDebuggerUrl);
  connections.add(c);
  return {
    ...c,
    close() {
      connections.delete(c);
      c.close();
    },
    target: t,
    eval: async (expression) => {
      let timer;
      try {
        return await Promise.race([
          evaluate(c, expression),
          new Promise(
            (_, reject) =>
              (timer = setTimeout(
                () => reject(Error("CDP evaluation timed out")),
                15000,
              )),
          ),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export async function invoke(p, cmd, args = {}) {
  const key = `__e2e_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await p.eval(
    `void window.__TAURI__.core.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)}).then(value=>window[${JSON.stringify(key)}]={ok:true,value},error=>window[${JSON.stringify(key)}]={ok:false,error:String(error)})`,
  );
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const r = await p.eval(`window[${JSON.stringify(key)}]`);
    if (r) {
      await p.eval(`delete window[${JSON.stringify(key)}]`);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }
    await sleep(50);
  }
  throw Error(`Native ${cmd} timed out`);
}
export async function dump(label) {
  const out = path.join(root, "evidence", label);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "windows.json"), desktop("windows"));
  for (const t of await targets()) {
    if (t.type !== "page") continue;
    const c = await connect(t.webSocketDebuggerUrl);
    try {
      const data = await evaluate(
        c,
        `({url:location.href,title:document.title,text:document.body.innerText,html:document.documentElement.outerHTML,screen:{x:screenX,y:screenY,w:innerWidth,h:innerHeight,dpr:devicePixelRatio},words:[...document.querySelectorAll('[data-ocr-word-box]')].map(e=>({text:e.querySelector('.ocr-word-current')?.textContent,rect:e.getBoundingClientRect().toJSON(),class:e.className})),hover:[...document.querySelectorAll(':hover')].map(e=>e.className)})`,
      );
      await writeFile(
        path.join(out, `${t.id}.json`),
        JSON.stringify(data, null, 2),
      );
    } finally {
      c.close();
    }
  }
  await writeFile(
    path.join(out, "truth.json"),
    await readFile(path.join(root, "game/truth.json")),
  );
  desktop("screenshot", path.join(out, "desktop.png"));
  return out;
}
// Desktop points from a page's screen coordinates (see SCREEN_SCALE in run.mjs): Chromium's
// screenX/Y stay at WebView2's own device scale when Windows Text size raises it above the
// display's, so a click computed from them alone lands short of the element.
const SCREEN_SCALE = "(window.__KIMOCHI_PLATFORM__?.screenScale||1)";
export async function click(p, selector, text) {
  const r = await p.eval(
    `(()=>{const es=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=es.find(e=>${text === undefined ? "true" : `(e.innerText||e.getAttribute('aria-label')||e.title||'').includes(${JSON.stringify(text)})`}&&e.getBoundingClientRect().width>0);if(!e)throw Error('Missing element: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();for(const fx of [.5,.2,.8,.05,.95]){const x=r.x+r.width*fx,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(h===e||e.contains(h))return {x:(screenX*${SCREEN_SCALE}+x)*devicePixelRatio,y:(screenY*${SCREEN_SCALE}+y)*devicePixelRatio,label:e.innerText,screenX,screenY,dpr:devicePixelRatio};}throw Error('Element is occluded: '+${JSON.stringify(selector)})})()`,
  );
  desktop("mouse", Math.round(r.x), Math.round(r.y), "click");
  return r;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  if (cmd !== "list") {
    const main = await page("panel.html");
    try {
      await verifyIsolation(main);
    } finally {
      main.close();
    }
  }
  if (cmd === "list") console.log(JSON.stringify(await targets(), null, 2));
  else if (cmd === "dump") console.log(await dump(arg));
  else {
    const p = await page(arg);
    try {
      if (cmd === "eval")
        console.log(JSON.stringify(await p.eval(rest.join(" ")), null, 2));
      if (cmd === "invoke")
        console.log(
          JSON.stringify(
            await invoke(p, rest[0], JSON.parse(rest[1] || "{}")),
            null,
            2,
          ),
        );
      if (cmd === "click") console.log(await click(p, rest[0], rest[1]));
    } finally {
      p.close();
    }
  }
}
