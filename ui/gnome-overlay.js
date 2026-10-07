/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux runtime bridge. */
/** GNOME Shell owns these actors; the hidden WebKit window only runs OCR/Yomitan. */
export async function installGnomeOverlay(native, state, enabled, log) {
  if (window.__KIMOCHI_PLATFORM__?.os !== 'linux') return null
  const gnomeRequest = (operation, payload = null) => window.__TAURI__.core.invoke('gnome_overlay', { operation, payload })
  let busy = false
  let lastError = null
  const update = async () => {
    if (busy) return
    busy = true
    try {
      const status = await gnomeRequest('status')
      if (!status.available) return
      const info = state.info
      const monitor = status.monitors?.length === 1 ? status.monitors[0] : null
      if (!enabled() || !state.geometry || !info?.source_id?.startsWith('portal:display:') || !monitor) {
        await gnomeRequest('clear')
        return
      }
      const sx = monitor.width / info.full_width
      const sy = monitor.height / info.full_height
      const [cx, cy] = info.crop_pixels ?? [0, 0]
      const words = state.annotations.filter(a => a.granularity !== 'aggregate' && a.description && a.boundingPoly?.vertices?.length).slice(0, 500).flatMap(a => {
        const xs = a.boundingPoly.vertices.map(p => p.x)
        const ys = a.boundingPoly.vertices.map(p => p.y)
        const x = monitor.x + (cx + Math.min(...xs)) * sx
        const y = monitor.y + (cy + Math.min(...ys)) * sy
        const width = (Math.max(...xs) - Math.min(...xs)) * sx
        const height = (Math.max(...ys) - Math.min(...ys)) * sy
        return width > 0 && height > 0 ? [{ text: a.description, x, y, width, height }] : []
      })
      await gnomeRequest('present', { sourceKind: 'screen', frameId: state.appliedScanId, words })
      lastError = null
    } catch (error) {
      const message = String(error)
      if (message !== lastError) log({ check: 'gnome-overlay-error', error: message })
      lastError = message
    } finally { busy = false }
  }
  const flatten = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(flatten).filter(Boolean).join('; ') : value && typeof value === 'object' ? flatten(value.content) : ''
  let lookupGeneration = 0
  await native.listen('gnome-overlay-lookup', async ({ payload }) => {
    const generation = ++lookupGeneration
    if (!enabled() || !payload?.text) return
    try {
      const { API } = await import('/js/comm/api.js')
      const { WebExtension } = await import('/js/extension/web-extension.js')
      const result = await new API(new WebExtension()).termsFind(payload.text, {}, { url: location.href, depth: 0 })
      if (generation !== lookupGeneration) return
      const entry = result.dictionaryEntries?.[0]
      await gnomeRequest('definition', {
        serial: payload.serial,
        text: entry?.headwords?.[0]?.term ?? payload.text,
        reading: entry?.headwords?.[0]?.reading ?? '',
        definition: entry ? entry.definitions.slice(0, 8).map(d => flatten(d.entries)).join('\n').slice(0, 4000) : 'No dictionary entry found.',
        x: payload.x, y: payload.y
      })
    } catch (error) { log({ check: 'gnome-dictionary-error', error: String(error) }) }
  })
  setInterval(() => void update(), 1000)
  return { update }
}
