// Kimochi browser extension: the page-world hook that says when a canvas is drawn on.
//
// A canvas changes without telling the DOM, so content.js can't see a reader paint its next page.
// This runs in the page's own world (background.js injects it next to content.js), wraps the few
// calls that put a picture on a canvas, and fires `kimochi-ext-drawn` on the canvas, at most once
// per burst of drawing. It reads no pixels and costs one WeakSet lookup per call.
;(() => {
  if (window.__kimochiDraws) return
  window.__kimochiDraws = true

  const pending = new WeakSet()
  function drawn(canvas) {
    if (!(canvas instanceof HTMLCanvasElement) || pending.has(canvas)) return
    pending.add(canvas)
    setTimeout(() => {
      pending.delete(canvas)
      canvas.dispatchEvent(new Event('kimochi-ext-drawn'))
    }, 100)
  }

  function wrap(proto, name) {
    const original = proto?.[name]
    if (typeof original !== 'function') return
    proto[name] = function (...args) {
      drawn(this.canvas)
      return original.apply(this, args)
    }
  }

  wrap(window.CanvasRenderingContext2D?.prototype, 'drawImage')
  wrap(window.CanvasRenderingContext2D?.prototype, 'putImageData')
  wrap(window.ImageBitmapRenderingContext?.prototype, 'transferFromImageBitmap')
  // WebGL readers: only when a picture is uploaded, not on every frame drawn.
  wrap(window.WebGLRenderingContext?.prototype, 'texImage2D')
  wrap(window.WebGL2RenderingContext?.prototype, 'texImage2D')
})()
