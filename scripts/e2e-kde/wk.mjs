#!/usr/bin/env node
// Evaluate JS in a Kimochi webview through WebKitGTK's remote inspector (WEBKIT_INSPECTOR_HTTP_SERVER).
//   wk.mjs list
//   wk.mjs eval <url-substring> '<expression>'     (awaits promises; prints JSON)
const HOST = process.env.WK_HOST ?? '127.0.0.1:9333'
export async function targets() {
  const html = await (await fetch(`http://${HOST}/`)).text()
  return [...html.matchAll(/targetname">([^<]*)<\/div><div class="targeturl">([^<]*)<\/div>.*?socket\/(\d+)\/(\d+)\/WebPage/g)]
    .map(([, name, url, conn, page]) => ({ name, url, path: `/socket/${conn}/${page}/WebPage` }))
}
export async function evaluate(match, expression, { timeout = 15000 } = {}) {
  const t = (await targets()).find(t => t.url.includes(match) || t.name === match)
  if (!t) throw new Error(`no webview matching ${match}`)
  const ws = new WebSocket(`ws://${HOST}${t.path}`)
  // Page targets speak through the Target domain: outer messages wrap the page's own.
  let id = 0, inner = 0, targetId
  const outer = new Map(), page = new Map()
  const settle = (waiting, reply) => {
    const p = waiting.get(reply.id)
    if (!p) return
    waiting.delete(reply.id)
    if (reply.error) p.reject(new Error(reply.error.message))
    else p.resolve(reply.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; outer.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }))
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++inner; page.set(i, { resolve, reject })
    send('Target.sendMessageToTarget', { targetId, message: JSON.stringify({ id: i, method, params }) }).catch(reject)
  })
  const opened = new Promise((resolve, reject) => { ws.onerror = () => reject(new Error('websocket error')); ws.onopen = resolve })
  const attached = new Promise(resolve => {
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data)
      if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page') {
        targetId = m.params.targetInfo.targetId
        resolve()
      } else if (m.method === 'Target.dispatchMessageFromTarget') settle(page, JSON.parse(m.params.message))
      else if (m.id) settle(outer, m)
    }
  })
  let timer
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('inspector timeout')), timeout) })
  try {
    return await Promise.race([expired, (async () => {
      await opened
      await attached
      const p = await call('Runtime.evaluate', { expression: `(async () => { const v = await (${expression}); return JSON.stringify(v === undefined ? null : v) })()` })
      if (p.wasThrown) throw new Error(p.result?.description ?? 'exception')
      const r = await call('Runtime.awaitPromise', { promiseObjectId: p.result.objectId, returnByValue: true })
      if (r.wasThrown) throw new Error(r.result?.description ?? 'exception')
      return JSON.parse(r.result.value)
    })()])
  } finally { clearTimeout(timer); ws.close() }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, match, expr] = process.argv.slice(2)
  if (cmd === 'list') console.log(await targets())
  else if (cmd === 'eval') console.log(JSON.stringify(await evaluate(match, expr), null, 1))
  else { console.error('usage: wk.mjs list | eval <url-part> <expr>'); process.exit(2) }
}
