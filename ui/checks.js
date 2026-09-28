const delay = (ms) => new Promise((r) => setTimeout(r, ms))
export async function checks({ invoke, fixture, shot, status }) {
  const report = (value) => invoke('report', { value })
  await fixture()
  const displays = await invoke('desktop')
  const records = []
  // Controller and Log remain on the other monitor during each scan. No user content is uploaded.
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i],
      other = displays[(i + 1) % displays.length]
    for (const [label, dy] of [
      ['controller', 50],
      ['log', 240]
    ]) {
      const w = await invoke('panel', { label, action: 'inspect', rect: null })
      await invoke('panel', {
        label,
        action: 'place',
        rect: { ...w.bounds, x: other.x + 40, y: other.y + dy }
      })
    }
    await invoke('panel', {
      label: 'fixture',
      action: 'place',
      rect: { x: d.x + 80, y: d.y + 100, width: 640, height: 400 }
    })
    await delay(900)
    status(`Testing native capture + external OCR on display ${i + 1}…`)
    const r = await shot(true)
    await delay(1800)
    if (!r.ocr.fullText.includes('猫') || !r.ocr.fullText.includes('食べました'))
      throw Error('Real OCR missed fixture text')
    const overlay = await invoke('snapshot')
    if (!overlay.scan) throw Error('No integrated scan state')
    const record = {
      check: 'integrated-display-scan',
      display: d,
      info: r.info,
      fixture_text_recognized: true,
      overlay_origin: overlay.origin,
      controller: await invoke('panel', { label: 'controller', action: 'inspect', rect: null }),
      log: await invoke('panel', { label: 'log', action: 'inspect', rect: null })
    }
    records.push(record)
    await report(record)
  }
  const prefs = await invoke('preferences')
  const current = await invoke('snapshot'),
    info = current.scan.info
  prefs.crop = {
    x: 0,
    y: 40,
    width: Math.floor(info.full_width * 0.9),
    height: Math.floor(info.full_height * 0.8),
    reference_width: info.full_width,
    reference_height: info.full_height
  }
  await invoke('save_preferences', { prefs })
  const first = displays[0],
    other = displays[1] ?? first
  for (const [label, dy] of [
    ['controller', 50],
    ['log', 240]
  ]) {
    const w = await invoke('panel', { label, action: 'inspect', rect: null })
    await invoke('panel', {
      label,
      action: 'place',
      rect: { ...w.bounds, x: other.x + 40, y: other.y + dy }
    })
  }
  await invoke('panel', {
    label: 'fixture',
    action: 'place',
    rect: { x: first.x + 80, y: first.y + 100, width: 640, height: 400 }
  })
  await delay(900)
  const cropped = await shot(true)
  await delay(1500)
  await report({
    check: 'integrated-crop-after-display-move',
    info: cropped.info,
    reference: prefs.crop,
    recognized: cropped.ocr.fullText.includes('猫')
  })
  prefs.crop = null
  await invoke('save_preferences', { prefs })
  await shot(true)
  await report({
    check: 'integrated-fixture-checks-complete',
    display_count: displays.length,
    scans: records.length,
    physical_hover_test: 'separate required'
  })
  status('Fixture OCR/display checks complete. Physical input still needs verification.')
}
