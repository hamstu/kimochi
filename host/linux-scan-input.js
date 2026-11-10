/* eslint @typescript-eslint/explicit-function-return-type: "off" */
/** Wayland layer surfaces keep keyboard=NONE. Only an explicitly bound portal
 * shortcut supplies their Shift state; ordinary panels also use local key events.
 * A stationary pointer needs a move on press, not a lookup on release.
 * `hover` (a boolean, or a function asked each time): no Shift feed exists for this surface (KDE
 * Plasma with Legacy X11 App Support off: nothing else can read Shift without taking it from the
 * game), so the pointer over the overlay's text looks up as if Shift were held. */
export async function installLinuxScanInput(win = window, { passive = false, hover = false } = {}) {
  const host = win.top ?? win
  if ((win.__KIMOCHI_PLATFORM__ ?? host.__KIMOCHI_PLATFORM__)?.os !== 'linux' || win.__linuxScanInputInstalled) return
  win.__linuxScanInputInstalled = true
  // Keyboard focus may move into a popup iframe during a hold. Its key-up
  // must release the same state that the parent received on key-down.
  const state = host.__linuxDictionaryScanState ??= {
    keys: new Set(), portalHeld: false, portalKnown: false, known: false, listeners: new Set()
  }
  const hovering = typeof hover === 'function' ? hover : () => hover
  const down = () => hovering() || state.portalHeld || state.keys.size > 0
  const known = () => hovering() || state.known
  let point = null
  let held = down()
  let forwarding = false
  const editable = target => target?.closest?.('input,textarea,[contenteditable="true"]')
  // Each engine listens for its own move: Yomitan and 10ten `pointermove`, Hachidori `mousemove`
  // (the extension descriptor says which, as in ui/overlay.js).
  const moveTypes = () => host.__kimochiExtensionHost?.descriptor?.pointerEvents ?? ['pointermove']
  const move = (type, init) => type === 'mousemove'
    ? new win.MouseEvent(type, init)
    : new win.PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true })
  const scan = () => {
    if (passive && host.__linuxLayerPointerInside === false) return
    if (!passive && !host.document.hasFocus()) return
    if (!point || !held || editable(win.document.activeElement)) return
    const target = win.document.elementFromPoint(point.clientX, point.clientY)
    if (!target || editable(target)) return
    forwarding = true
    try {
      for (const type of moveTypes()) {
        // 10ten takes WebKitGTK for Safari and drops a move that only adds a modifier where the
        // last one was (a Safari bug it works around): a plain move a pixel off makes this a move.
        target.dispatchEvent(move(type, { ...point, clientX: point.clientX + 1, screenX: point.screenX + 1,
          bubbles: true, cancelable: true, shiftKey: false, kimochiPrime: true }))
        target.dispatchEvent(move(type, { ...point, bubbles: true, cancelable: true, shiftKey: true }))
      }
    } finally { forwarding = false }
  }
  const update = () => {
    const now = down()
    const changed = held !== now
    held = now
    if (changed && held) scan()
  }
  state.listeners.add(update)
  const notify = () => { for (const listener of state.listeners) listener() }
  win.addEventListener('pointermove', e => {
    if (forwarding || e.pointerType !== 'mouse' || !e.isPrimary) return
    if (passive && host.__linuxLayerPointerInside === false) { point = null; return }
    point = { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      buttons: e.buttons, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey }
    held = down()
    // WebKit's pointer modifiers can lag its keyboard/portal modifier event.
    // Never let an old Shift=true mouse move initiate a lookup after release.
    if (known() && e.shiftKey !== held) {
      e.stopImmediatePropagation()
      forwarding = true
      try { e.target.dispatchEvent(new win.PointerEvent('pointermove', {
        ...point, bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, shiftKey: held
      })) } finally { forwarding = false }
    }
  }, true)
  // The same correction for an engine that reads `mousemove` (Hachidori).
  win.addEventListener('mousemove', e => {
    if (forwarding || !moveTypes().includes('mousemove')) return
    if (passive && host.__linuxLayerPointerInside === false) return
    held = down()
    if (known() && e.shiftKey !== held) {
      e.stopImmediatePropagation()
      forwarding = true
      try { e.target.dispatchEvent(move('mousemove', {
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, buttons: e.buttons,
        ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true, shiftKey: held
      })) } finally { forwarding = false }
    }
  }, true)
  win.addEventListener('pointerout', e => { if (!e.relatedTarget) point = null }, true)
  const side = e => e.code === 'ShiftRight' || e.location === 2 ? 'right' : 'left'
  const isShift = e => e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight'
  win.addEventListener('keydown', e => {
    if (!isShift(e)) return
    state.keys.add(side(e)); state.known = true; notify()
  }, true)
  win.addEventListener('keyup', e => {
    if (!isShift(e)) return
    // GTK may still report Shift in the release event's modifier flags. The
    // event's edge, not that flag, decides whether this physical key is held.
    state.keys.delete(side(e)); state.known = true; notify()
  }, true)
  win.addEventListener('blur', () => {
    // A window blur also fires when a child iframe takes focus. Keep the
    // hold while the native window still owns keyboard focus.
    if (host.document.hasFocus()) return
    state.keys.clear(); state.known = true; notify()
  })
  win.addEventListener('focus', () => {
    // When returning with Shift already held, X11/ordinary GTK windows may
    // supply pointer modifiers without a fresh key-down in this document.
    if (host.document.hasFocus() && !state.portalKnown && state.keys.size === 0) state.known = false
  })
  const stop = await (win.__TAURI__ ?? host.__TAURI__).event.listen('linux-dictionary-modifier', ({ payload }) => {
    state.portalHeld = !!payload.shift; host.__linuxDictionaryShiftHeld = state.portalHeld
    state.portalKnown = true; state.known = true; notify()
  })
  const stopPointer = passive ? await (win.__TAURI__ ?? host.__TAURI__).event.listen('wayland-layer-pointer', ({ payload }) => {
    // WebKitGTK can omit DOM pointerout when leaving a shaped native layer.
    // A later Shift press in the game must not scan the old overlay position.
    if (payload === false) point = null
  }) : null
  win.addEventListener('pagehide', () => { stop?.(); stopPointer?.(); state.listeners.delete(update) }, { once: true })
}
