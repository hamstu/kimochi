// Real pointer taps on Kimochi's UI, found by visible text through WebKit's inspector.
import { evaluate } from './wk.mjs'
import { rig } from './rig.mjs'

async function locate(page, text) {
  return evaluate(page, `(() => {
    const want = ${JSON.stringify(text)}
    const els = [...document.querySelectorAll('body *')].filter(e => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e)
      if (!(r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none')) return false
      if (!(e.innerText ?? '').trim().startsWith(want)) return false
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return top && (e.contains(top) || top.contains(e))
    })
    const rank = e => (e.closest('[role=menuitem],[role=option],button') ? 0 : 1)
    els.sort((a, b) => rank(a) - rank(b) || a.innerText.length - b.innerText.length)
    let el = els[0]; if (!el) return null
    el = el.closest('[role=menuitem],[role=option],button') ?? el
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: el.innerText.trim().split('\\n')[0] }
  })()`)
}

/** Tap each text in turn in the window titled `caption` (its webview matched by `page`). */
export async function tap(page, caption, ...texts) {
  for (const text of texts) {
    const p = await locate(page, text)
    if (!p) throw new Error(`"${text}" is not on screen in ${page}`)
    const [origin] = rig.windows().filter(w => w.caption === caption)
    if (!origin) throw new Error(`no window "${caption}"`)
    rig.input('move', Math.round(origin.client.x + p.x), Math.round(origin.client.y + p.y), 'sleep', 120, 'click')
    await new Promise(r => setTimeout(r, 700))
  }
}
