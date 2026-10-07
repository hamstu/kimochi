/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux popup document adapter. */
/** Keep the original Yomitan Display; add the app's existing font faces/smoothing
 * and suppress text selection only while its original resize handle is active. */
export async function installLinuxPopupDocument(win = window) {
  if ((await win.chrome.runtime.getPlatformInfo()).os !== 'linux' || win.__linuxPopupDocumentInstalled) return
  win.__linuxPopupDocumentInstalled = true
  const d = win.document
  const link = d.createElement('link')
  link.rel = 'stylesheet'
  link.href = win.chrome.runtime.getURL('spike/linux-popup-fonts.css')
  d.head.append(link)
  const style = d.createElement('style')
  style.textContent = `
    html { font-family: "Figtree Variable", "Noto Sans JP Variable", sans-serif; }
    body { -webkit-font-smoothing: antialiased; font-synthesis: none; text-rendering: optimizeLegibility; }
    #frame-resizer-handle, #frame-resizer-handle * { -webkit-user-select: none; user-select: none; }
    html[data-is-resizing=true], html[data-is-resizing=true] * { -webkit-user-select: none !important; user-select: none !important; }
  `
  d.head.append(style)
  const { Display } = await import(win.chrome.runtime.getURL('js/display/display.js'))
  const setFontOptions = Display.prototype.setFontOptions
  Display.prototype.setFontOptions = function (fontFamily, ...rest) {
    return setFontOptions.call(this, fontFamily || '"Figtree Variable", "Noto Sans JP Variable", sans-serif', ...rest)
  }
  if (!d.documentElement.style.fontFamily) {
    d.documentElement.style.fontFamily = '"Figtree Variable", "Noto Sans JP Variable", sans-serif'
  }
  win.addEventListener('mousedown', e => {
    if (e.button === 0 && e.target.closest?.('#frame-resizer-handle')) win.getSelection()?.removeAllRanges()
  }, true)
  win.addEventListener('mouseup', () => {
    if (d.documentElement.dataset.isResizing === 'true') win.getSelection()?.removeAllRanges()
  }, true)
}
