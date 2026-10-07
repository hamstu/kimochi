/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux runtime bridge. */
import { gnomeWordCells } from './gnome-word-cells.js'
import { measureEms } from './render.js'

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
      const screen = info?.source_id?.startsWith('portal:display:')
      const tracked = !screen && status.tracked?.sourceId === info?.source_id ? status.tracked : null
      const monitor = screen ? (status.monitors?.length === 1 ? status.monitors[0] : null) : tracked?.bounds
      if (!enabled() || !state.geometry || !monitor || (!screen && (!tracked?.visible || !info.source_bounds || Math.abs(info.source_bounds.width-monitor.width)>=2 || Math.abs(info.source_bounds.height-monitor.height)>=2))) {
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
        return width > 0 && height > 0 ? gnomeWordCells(a.description, { x, y, width, height }, a.orientation === 'vertical' || a.isVertical === true, measureEms) : []
      }).slice(0, 500)
      await gnomeRequest('present', { sourceKind: screen ? 'screen' : 'window', sourceId:info.source_id, referenceBounds:screen ? undefined : monitor, frameId: state.appliedScanId, words })
      lastError = null
    } catch (error) {
      const message = String(error)
      if (message !== lastError) log({ check: 'gnome-overlay-error', error: message })
      lastError = message
    } finally { busy = false }
  }
  // The full vendor Popup/Display runs in the dedicated native popup host. This
  // bridge publishes annotations only; it never flattens dictionary entries.
  setInterval(() => void update(), 1000)
  const pause = async () => {
    // Finish any in-flight publication before clearing its reactive word targets.
    while (busy) await new Promise(resolve => setTimeout(resolve, 20))
    busy = true
    try {
      if ((await gnomeRequest('status')).available) await gnomeRequest('clear')
    } finally { busy = false }
  }
  const flush=async()=>{while(busy)await new Promise(resolve=>setTimeout(resolve,20));await update()}
  return { update, pause, flush }
}
