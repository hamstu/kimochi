/* eslint @typescript-eslint/explicit-function-return-type: "off" */
// The Windows hook consumed these buttons before the foreground game saw them.
// Deliver them to the actual DOM target, including Yomitan's same-origin frames.
export async function installWindowsPointer(win = window, getPopups = () => []) {
  if (win.__windowsPointerInstalled) return
  win.__windowsPointerInstalled = true
  const pressed = new Map()
  await win.__TAURI__.event.listen('windows-pointer-button', ({ payload }) => {
    const first = pressed.get(payload.button)
    let doc = win.document
    let { x, y } = payload
    let target = doc.elementFromPoint(x, y)
    // Yomitan puts its frames in closed shadow roots. Use the popup objects,
    // just as hit-region publication does, rather than clicking the empty host.
    const frames = []
    for (const root of getPopups()) {
      for (let popup = root; popup?.isVisibleSync(); popup = popup.child) {
        if (popup._frame) frames.push(popup._frame)
      }
    }
    for (const frame of frames.reverse()) {
      const r = frame.getBoundingClientRect()
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
        target = frame
        break
      }
    }
    while (target) {
      if (target.shadowRoot) {
        const inner = target.shadowRoot.elementFromPoint(x, y)
        if (inner && inner !== target) { target = inner; continue }
      }
      if (target.tagName !== 'IFRAME') break
      let inner
      try { inner = target.contentDocument } catch { break }
      if (!inner) break
      const bounds = target.getBoundingClientRect()
      x -= bounds.left + target.clientLeft
      y -= bounds.top + target.clientTop
      doc = inner
      target = doc.elementFromPoint(x, y)
    }
    const releasedOn = target
    if (!payload.down) pressed.delete(payload.button)
    if (!target && first) target = first
    if (!target) return
    const view = doc.defaultView
    const { button, down } = payload
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y,
      button, buttons: down ? (button === 0 ? 1 : 2) : 0,
      pointerType: 'mouse', isPrimary: true, pointerId: 1 }
    target.dispatchEvent(new view.PointerEvent(down ? 'pointerdown' : 'pointerup', init))
    target.dispatchEvent(new view.MouseEvent(down ? 'mousedown' : 'mouseup', init))
    if (down) pressed.set(button, target)
    else {
      if (releasedOn && (first === releasedOn || first?.contains(releasedOn) || releasedOn.contains(first))) {
        target.dispatchEvent(new view.MouseEvent(button === 0 ? 'click' : 'contextmenu', init))
      }
    }
  })
}
