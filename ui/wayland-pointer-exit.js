/** A layer surface receives no global pointer feed outside its input regions.
 * Release its last text hover on exit, but allow crossing the transparent gap
 * into a dictionary iframe before dismissing the lookup.
 */
export function installWaylandPointerExit(win, { leave, enter = () => {}, dismiss, delay = 400 }) {
  const root = win.document.documentElement
  let timer = null
  let nativeInside = null
  let sampledInside = null
  const cancel = () => {
    if (timer !== null) win.clearTimeout(timer)
    timer = null
  }
  const exit = () => {
    leave()
    if (timer !== null) return
    timer = win.setTimeout(() => {
      timer = null
      dismiss()
    }, delay)
  }
  const domEnter = () => {
    // WebKit can deliver queued/synthetic moves after the native surface exit.
    if (nativeInside === false || sampledInside === false) return
    enter()
    cancel()
  }
  root.addEventListener('mouseleave', exit)
  root.addEventListener('mouseenter', domEnter)
  // A move received in this document also proves the layer has the pointer.
  win.addEventListener('pointermove', domEnter, true)
  const stop = () => {
    cancel()
    root.removeEventListener('mouseleave', exit)
    root.removeEventListener('mouseenter', domEnter)
    win.removeEventListener('pointermove', domEnter, true)
  }
  stop.enter = () => {
    nativeInside = true
    if (sampledInside === false) return
    enter()
    cancel()
  }
  stop.leave = () => {
    nativeInside = false
    if (sampledInside !== null) return
    exit()
  }
  stop.sample = inside => {
    sampledInside = inside
    if (inside) { enter(); cancel() }
    else exit()
  }
  stop.outside = () => sampledInside === false || sampledInside === null && nativeInside === false
  win.addEventListener('pagehide', stop, { once: true })
  return stop
}
