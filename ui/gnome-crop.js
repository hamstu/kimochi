/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux GNOME runtime. */
/**
 * Shell owns transient selection actors. The hidden OCR WebKit host stays hidden. `accent` and
 * `title` style the editor box (see RegionSelect); they ride on the open notification to the
 * crop host, so the Shell extension does not need to know them.
 */
export async function selectGnomeCrop(native, {sourceId, frame, initial = null, quick = false, theme = 'dark', accent = 'blue', title = null, onStart}) {
  const request = (payload) => native.invoke('gnome_overlay', {operation:'crop', payload})
  const id = crypto.randomUUID()
  let finish, fail, keep, pending = false
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  const stop = await native.listen('gnome-crop-result', ({payload}) => {
    if (payload?.id === id) finish(payload.crop ?? null)
  })
  try {
    await request({operation:'start', id, sourceId, width:frame.width, height:frame.height,
      initial:quick ? null : initial, label:quick ? 'Scan' : 'Save',ui:'shared',theme})
    keep = setInterval(() => {
      if (pending) return
      pending = true
      void request({operation:'keep', id}).catch(fail).finally(() => { pending = false })
    }, 1000)
    await native.panel('crop-host','show_inactive')
    // The editor runs in the crop host: a press of the shortcut that opened it is forwarded there.
    onStart?.({shortcutPressed:()=>{void window.__TAURI__.event.emit('gnome-crop-press',{id});return 'forwarded'}})
    // A new WebKit panel loads asynchronously. Repeat only the idempotent open
    // notification during this selection; the host ignores a duplicate id.
    const open=setInterval(()=>void window.__TAURI__.event.emit('gnome-crop-open',{id,accent,title}),150)
    try {
      await window.__TAURI__.event.emit('gnome-crop-open',{id,accent,title})
      return await result
    } finally { clearInterval(open) }
  } finally {
    clearInterval(keep)
    stop()
    await request({operation:'cancel', id}).catch(() => {})
    await native.panel('crop-host','hide').catch(() => {})
  }
}
