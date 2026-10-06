/* eslint @typescript-eslint/explicit-function-return-type: "off" */
/** Called only by the Linux Wayland branch. Portal consent replaces pointer/display discovery. */
export async function runWaylandQuickShot({ available, catalog, pick, edit, scan, status, log }) {
  if (!available) {
    status('Quick Shot needs native overlay support on this Wayland desktop.')
    log({ check: 'quick-shot-skipped', reason: 'native Wayland overlay unavailable' })
    return
  }
  let source = (await catalog()).find((item) => item.id?.startsWith('portal:display:'))
  if (!source) {
    status('Choose an entire screen in the system picker for Quick Shot.')
    const result = await pick()
    if (!result?.picked) {
      status(result?.message ?? 'Quick Shot cancelled: no screen shared.')
      log({ check: 'quick-shot-cancelled', reason: result?.reason ?? 'cancelled' })
      return
    }
    source = result.source
  }
  if (!source?.id?.startsWith('portal:display:')) {
    status('Quick Shot needs an entire screen. Try again and choose a screen in the system picker.')
    log({ check: 'quick-shot-skipped', reason: 'portal window selected instead of screen' })
    return
  }
  const crop = await edit(source.id)
  if (!crop) {
    status('Quick Shot cancelled.')
    log({ check: 'quick-shot-cancelled' })
    return
  }
  await scan(source.id, crop)
}
