const invoke = window.__TAURI__.core.invoke,
  $ = (id) => document.getElementById(id),
  label = document.body.dataset.panel
let prefs = await invoke('preferences'),
  sources = [],
  selected = null,
  last = null,
  busy = false,
  revision = -1,
  errorMessage = null
const describe = (e) => (typeof e === 'string' ? e : JSON.stringify(e))
const status = (t) => {
  if ($('status')) $('status').textContent = t
}
const save = async () => invoke('save_preferences', { prefs })
async function run(fn) {
  if (busy) return
  busy = true
  errorMessage = null
  try {
    await fn()
  } catch (e) {
    errorMessage = describe(e)
    status(errorMessage)
    console.error(e)
  } finally {
    busy = false
  }
}
const on = (id, fn) => {
  if ($(id)) $(id).onclick = () => run(fn)
}
// WKWebView may suppress :hover while inactive. Use native, occlusion-aware
// pointer coordinates for panel affordances without changing keyboard focus.
let hoverPending = false,
  hoveredButton = null
setInterval(async () => {
  if (hoverPending) return
  hoverPending = true
  try {
    const point = await invoke('panel_pointer')
    const target = point ? document.elementFromPoint(...point) : null
    const button = target?.closest('button')
    if (button !== hoveredButton) {
      hoveredButton?.classList.remove('native-hover')
      button?.classList.add('native-hover')
      hoveredButton = button
    }
    if (target) {
      const kind = button?.disabled ? 'default' : getComputedStyle(target).cursor
      await invoke('panel_cursor', { kind })
    }
  } catch {
    hoveredButton?.classList.remove('native-hover')
    hoveredButton = null
  } finally {
    hoverPending = false
  }
}, 50)
document.querySelector('header').onmousedown = (e) => {
  if (e.target.closest('button')) return
  void invoke('panel_drag', { label })
}
on('close', () => invoke('panel', { label, action: 'hide', rect: null }))
if ($('pin')) {
  const key = label + '_pin'
  $('pin').textContent = prefs[key] ? 'Pinned' : 'Pin'
  on('pin', async () => {
    prefs = await invoke('preferences')
    prefs[key] = !prefs[key]
    await save()
    $('pin').textContent = prefs[key] ? 'Pinned' : 'Pin'
  })
}
for (const name of ['sources', 'log'])
  on(name, () => invoke('panel', { label: name, action: 'show', rect: null }))
on('dictionary', () => invoke('dictionary', { open: true }))
on('clear', () => invoke('clear'))
async function refresh() {
  sources = await invoke('enumerate')
  if ($('source')) {
    const sel = $('source')
    sel.replaceChildren()
    for (const s of sources.filter((s) => s.on_screen)) {
      const o = document.createElement('option')
      o.value = s.id
      o.textContent = [s.kind, s.app, s.name].filter(Boolean).join(' · ')
      sel.append(o)
    }
    // Persist descriptive identity only. Resolve a unique current source; never reuse an OS ID.
    const candidates = sources.filter(
      (s) =>
        s.on_screen &&
        prefs.source &&
        s.kind === prefs.source.kind &&
        s.name === prefs.source.name &&
        s.app === prefs.source.app
    )
    selected = candidates.length === 1 ? candidates[0] : null
    if (selected) {
      sel.value = selected.id
      await invoke('select_source', { id: selected.id })
    } else {
      sel.selectedIndex = -1
      status('Choose a source (saved source missing or ambiguous).')
    }
  }
}
if ($('source'))
  $('source').onchange = async () => {
    selected = sources.find((s) => s.id === $('source').value)
    prefs = await invoke('preferences')
    prefs.source = { kind: selected.kind, name: selected.name, app: selected.app }
    prefs.crop = null
    await save()
    await invoke('select_source', { id: selected.id })
    last = null
  }
async function resolve() {
  const id = await invoke('selected_source')
  if (id) return { id }
  prefs = await invoke('preferences')
  const catalog = await invoke('enumerate')
  const match = catalog.filter(
    (s) =>
      s.on_screen &&
      prefs.source &&
      s.kind === prefs.source.kind &&
      s.name === prefs.source.name &&
      s.app === prefs.source.app
  )
  if (match.length !== 1) throw Error('Select a unique current source in Source.')
  return match[0]
}
async function shot(ocr = true) {
  const source = selected ?? (await resolve())
  prefs = await invoke('preferences')
  const r = await invoke('scan', { request: { source_id: source.id, crop: prefs.crop }, ocr })
  last = r
  return r
}
on('scan', () => shot(true))
on('preview-button', () => shot(false))
on('refresh', refresh)
on('permission', async () => {
  await invoke('permission')
  await refresh()
})
async function fixture() {
  await invoke('panel', { label: 'fixture', action: 'show', rect: null })
  await new Promise((r) => setTimeout(r, 850))
  await refresh()
  selected = sources.find((s) => s.name === 'Kimochi Japanese Fixture' && s.on_screen)
  if (!selected) throw Error('Fixture missing; grant Screen Recording and relaunch.')
  $('source').value = selected.id
  prefs = await invoke('preferences')
  prefs.source = { kind: selected.kind, name: selected.name, app: selected.app }
  prefs.crop = null
  await save()
  await invoke('select_source', { id: selected.id })
}
on('fixture', fixture)
on('crop', async () => {
  if (!last || last.info.source_id !== selected?.id) throw Error('Preview this source first')
  prefs = await invoke('preferences')
  prefs.crop = {
    x: Number($('x').value),
    y: Number($('y').value),
    width: Number($('width').value),
    height: Number($('height').value),
    reference_width: last.info.full_width,
    reference_height: last.info.full_height
  }
  await save()
  status('Crop saved; preview or scan to apply.')
})
on('uncrop', async () => {
  prefs = await invoke('preferences')
  prefs.crop = null
  await save()
  status('Crop cleared.')
})
if ($('endpoint')) $('endpoint').value = prefs.endpoint
on('save-endpoint', async () => {
  prefs = await invoke('preferences')
  prefs.endpoint = $('endpoint').value
  await save()
  status('OCR endpoint saved.')
})
if ($('debug'))
  $('debug').onchange = () => localStorage.setItem('debug', String($('debug').checked))
setInterval(() => {
  if ($('periodic')?.checked && !busy) void run(() => shot(true))
}, 2000)
setInterval(async () => {
  try {
    const v = await invoke('snapshot')
    if (!busy && !errorMessage) status(v.status)
    if (v.revision === revision) return
    revision = v.revision
    if (v.scan) {
      last = v.scan
      if ($('preview')) {
        $('preview').src = window.__TAURI__.core.convertFileSrc(v.scan.id.toString(), 'capture')
        $('preview').hidden = false
      }
      if (label === 'log' && v.scan.ocr) {
        const e = document.createElement('div')
        e.className = 'entry'
        const t = document.createElement('div')
        t.className = 'text'
        t.textContent = v.scan.ocr.fullText || '(No text recognized)'
        const meta = document.createElement('small')
        meta.textContent = `${new Date().toLocaleTimeString()} · ${v.scan.info.width} × ${v.scan.info.height} px`
        e.append(meta, t)
        $('entries').prepend(e)
        while ($('entries').children.length > 30) $('entries').lastChild.remove()
      }
    } else if ($('preview')) {
      $('preview').hidden = true
      $('preview').removeAttribute('src')
    }
  } catch (e) {
    status(describe(e))
  }
}, 250)
if (label === 'sources') run(refresh)
// Resize compact controller to rendered content, retaining its native desktop position.
if (label === 'controller') {
  const b = (await invoke('panel', { label, action: 'inspect', rect: null })).bounds
  await invoke('panel', {
    label,
    action: 'place',
    rect: { ...b, height: document.body.scrollHeight + 12 }
  })
}
on('checks', async () => {
  const { checks } = await import('./checks.js')
  await checks({ invoke, fixture, shot, setSource: (s) => (selected = s), status })
})

on('inspect', async () => {
  const windows = []
  for (const label of ['controller', 'log', 'overlay', 'fixture'])
    windows.push(await invoke('panel', { label, action: 'inspect', rect: null }))
  const v = await invoke('snapshot')
  await invoke('report', {
    value: {
      check: 'native-window-inspection',
      windows,
      regions: v.regions,
      interactive: v.interactive
    }
  })
  status(JSON.stringify(windows))
  errorMessage = 'inspection'
})
