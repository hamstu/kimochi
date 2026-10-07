import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWaylandQuickShot } from '../ui/linux-quick-shot.js'

function fixture(sources = []) {
  const calls = [], crop = { x: 10, y: 20, width: 100, height: 50, reference_width: 3440, reference_height: 1440 }
  const screen = { id: 'portal:display:64' }
  return { calls, crop, screen, options: {
    available: true, catalog: async () => sources,
    pick: async () => { calls.push('pick'); return { picked: true, source: screen } },
    edit: async id => { calls.push(['edit', id]); return crop },
    scan: async (id, region) => { calls.push(['scan', id, region]) },
    status: text => calls.push(['status', text]), log: value => calls.push(['log', value])
  } }
}

test('Wayland Quick Shot reuses a shared screen and scans its one-off crop', async () => {
  const f = fixture([{ id: 'portal:display:64' }]); await runWaylandQuickShot(f.options)
  assert.deepEqual(f.calls, [['edit', f.screen.id], ['scan', f.screen.id, f.crop]])
})
test('Wayland Quick Shot asks for screen consent when only a window is shared', async () => {
  const f = fixture([{ id: 'portal:window:64' }]); await runWaylandQuickShot(f.options)
  assert.equal(f.calls[1], 'pick')
  assert.deepEqual(f.calls.at(-1), ['scan', f.screen.id, f.crop])
})
test('cancelled system picker never opens the crop editor or scans', async () => {
  const f = fixture(); f.options.pick = async () => ({ picked: false, reason: 'cancelled', message: 'Sharing cancelled.' })
  await runWaylandQuickShot(f.options)
  assert.ok(f.calls.some(c => c[0] === 'status' && c[1] === 'Sharing cancelled.'))
  assert.ok(!f.calls.some(c => c[0] === 'edit' || c[0] === 'scan'))
})
test('a window selection explains the screen requirement instead of fabricating placement', async () => {
  const f = fixture(); f.options.pick = async () => ({ picked: true, source: { id: 'portal:window:64' } })
  await runWaylandQuickShot(f.options)
  assert.ok(f.calls.some(c => c[0] === 'status' && c[1].includes('entire screen')))
  assert.ok(!f.calls.some(c => c[0] === 'edit' || c[0] === 'scan'))
})
test('cancelled crop never scans', async () => {
  const f = fixture([fScreen()]); f.options.edit = async () => null
  await runWaylandQuickShot(f.options)
  assert.ok(!f.calls.some(c => c[0] === 'scan'))
})
function fScreen() { return { id: 'portal:display:64' } }

test('unsupported Wayland overlay gives a status without requesting consent', async () => {
  const f = fixture(); f.options.available = false
  await runWaylandQuickShot(f.options)
  assert.ok(!f.calls.includes('pick'))
  assert.ok(f.calls.some(c => c[0] === 'status' && c[1].includes('native overlay')))
})
