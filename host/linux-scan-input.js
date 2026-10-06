/* eslint @typescript-eslint/explicit-function-return-type: "off" */
/** Wayland layer surfaces keep keyboard=NONE. Only an explicitly bound portal
 * shortcut supplies their Shift state; ordinary panels also use local key events.
 * A stationary pointer needs a move on press, not a lookup on release. */
export async function installLinuxScanInput(win = window, { passive = false } = {}) {
  if (win.__KIMOCHI_PLATFORM__?.os !== 'linux' || win.__linuxScanInputInstalled) return
  win.__linuxScanInputInstalled = true
  let point = null
  let held = false
  let known = false
  let forwarding = false
  const editable = target => target?.closest?.('input,textarea,[contenteditable="true"]')
  const scan = () => {
    if (!passive && !win.document.hasFocus()) return
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
  const update = down => {
    const changed = held !== down
    held = down
    known = true
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
  win.addEventListener('keydown', e => { if (e.key === 'Shift') update(true) }, true)
  win.addEventListener('keyup', e => { if (e.key === 'Shift') update(e.shiftKey) }, true)
  win.addEventListener('blur', () => { held = false; known = false })
  await win.__TAURI__.event.listen('linux-dictionary-modifier', ({ payload }) => update(!!payload.shift))
}
