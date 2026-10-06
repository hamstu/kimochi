/* eslint @typescript-eslint/explicit-function-return-type: "off" */
/** Wayland layer surfaces keep keyboard=NONE. Only an explicitly bound portal
 * shortcut supplies their Shift state; ordinary panels also use local key events.
 * A stationary pointer needs a move on press, not a lookup on release. */
export async function installLinuxScanInput(win = window, { passive = false } = {}) {
  const host = win.top ?? win
  if ((win.__KIMOCHI_PLATFORM__ ?? host.__KIMOCHI_PLATFORM__)?.os !== 'linux' || win.__linuxScanInputInstalled) return
  win.__linuxScanInputInstalled = true
  const keys = new Set()
  let portalHeld = host.__linuxDictionaryShiftHeld === true
  let portalKnown = typeof host.__linuxDictionaryShiftHeld === 'boolean'
  let point = null
  let held = portalHeld
  let known = portalKnown
  let forwarding = false
  const editable = target => target?.closest?.('input,textarea,[contenteditable="true"]')
  const scan = () => {
    if (!passive && !host.document.hasFocus()) return
    if (!point || !held || editable(win.document.activeElement)) return
    const target = win.document.elementFromPoint(point.clientX, point.clientY)
    if (!target || editable(target)) return
    forwarding = true
    try {
      target.dispatchEvent(new win.PointerEvent('pointermove', {
        ...point, bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, shiftKey: true
      }))
    } finally { forwarding = false }
  }
  const update = () => {
    const down = portalHeld || keys.size > 0
    const changed = held !== down
    held = down
    if (changed && held) scan()
  }
  win.addEventListener('pointermove', e => {
    if (forwarding || e.pointerType !== 'mouse' || !e.isPrimary) return
    point = { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      buttons: e.buttons, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey }
    // WebKit's pointer modifiers can lag its keyboard/portal modifier event.
    // Never let an old Shift=true mouse move initiate a lookup after release.
    if (known && e.shiftKey !== held) {
      e.stopImmediatePropagation()
      forwarding = true
      try { e.target.dispatchEvent(new win.PointerEvent('pointermove', {
        ...point, bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, shiftKey: held
      })) } finally { forwarding = false }
    }
  }, true)
  win.addEventListener('pointerout', e => { if (!e.relatedTarget) point = null }, true)
  const side = e => e.code === 'ShiftRight' || e.location === 2 ? 'right' : 'left'
  win.addEventListener('keydown', e => {
    if (e.key !== 'Shift') return
    keys.add(side(e)); known = true; update()
  }, true)
  win.addEventListener('keyup', e => {
    if (e.key !== 'Shift') return
    // GTK may still report Shift in the release event's modifier flags. The
    // event's edge, not that flag, decides whether this physical key is held.
    keys.delete(side(e)); known = true; update()
  }, true)
  win.addEventListener('blur', () => {
    keys.clear(); known = portalKnown; update()
  })
  const stop = await (win.__TAURI__ ?? host.__TAURI__).event.listen('linux-dictionary-modifier', ({ payload }) => {
    portalHeld = !!payload.shift; host.__linuxDictionaryShiftHeld = portalHeld
    portalKnown = true; known = true; update()
  })
  win.addEventListener('pagehide', () => stop?.(), { once: true })
}
