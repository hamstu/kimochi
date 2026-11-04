import test from 'node:test'
import assert from 'node:assert/strict'
import { stepValue, nextLook, hookSummary, threadChoices } from '../ui/controller-card.js'
import { ControllerInput } from '../ui/controller-input.js'

test('the card panel steps through values, held at the ends, and looks go round', () => {
  const levels = [0.4, 0.55, 0.7, 0.85, 1]
  assert.equal(stepValue(levels, 0.7, 1), 0.85)
  assert.equal(stepValue(levels, 1, 1), 1)
  assert.equal(stepValue(levels, 0.4, -1), 0.4)
  assert.equal(stepValue(levels, 0.6, 1), 0.55, 'an unknown value starts from the first')
  assert.equal(nextLook('app', 1), 'light')
  assert.equal(nextLook('blend', 1), 'app')
  assert.equal(nextLook('app', -1), 'blend')
  assert.equal(nextLook('unknown', 1), 'light')
})

test('the right stick is reported whole, for sizing the card, as well as its scroll', () => {
  const commands = []
  const controls = new ControllerInput((command) => commands.push(command), { setTimeout: () => 0, clearTimeout: () => {} })
  const nav = (rstick) => controls.nav({ pressed: [], released: [], held: [], stick: { x: 0, y: 0 }, rstick })
  nav({ x: 0.8, y: 0 })
  nav({ x: 0.8, y: -0.5 })
  assert.deepEqual(
    commands.filter((c) => c.type === 'rstick'),
    [
      { type: 'rstick', x: 0.8, y: 0 },
      { type: 'rstick', x: 0.8, y: -0.5 }
    ]
  )
  assert.deepEqual(commands.filter((c) => c.type === 'scroll'), [{ type: 'scroll', y: -0.5 }])
})

test('the hooked text says what the hook is doing, as the sidebar does', () => {
  assert.deepEqual(
    [
      hookSummary(null),
      hookSummary({ phase: 'starting', threads: [] }),
      hookSummary({ phase: 'downloading', engine: { name: 'LunaHook' }, download: { done: 1, total: 4 }, threads: [] }),
      hookSummary({ phase: 'attaching', threads: [] }),
      hookSummary({ phase: 'hooked', threads: [] }),
      hookSummary({ phase: 'hooked', threads: [], hookFailures: ['X'] }),
      hookSummary({ phase: 'hooked', threads: [{ key: 'a', preview: 'x', selected: false }] }),
      hookSummary({ phase: 'hooked', pickNote: 'no match', threads: [{ key: 'a', preview: 'x', selected: false }] }),
      hookSummary({ phase: 'ended', threads: [] })
    ].map((s) => [s.text, s.busy, s.warn, s.enabled]),
    [
      ['Not hooked', false, true, false],
      ['Starting…', true, false, false],
      ['Downloading LunaHook… 25%', true, false, false],
      ['Hooking…', true, false, false],
      ['Waiting for text…', true, false, false],
      ['No text hooked', false, true, false],
      ['Finding the dialogue…', true, false, true],
      ['Choose the text…', false, true, true],
      ['The game has closed.', false, true, false]
    ]
  )
  const chosen = hookSummary({ phase: 'hooked', selectedBy: 'saved', threads: [{ key: 'a', name: 'N', preview: ' 吾輩は\n猫 ', selected: true }] })
  assert.deepEqual([chosen.text, chosen.ja, chosen.how], ['吾輩は 猫', true, 'Remembered for this game'])
})

test('the list of threads marks automatic, or the thread chosen by hand', () => {
  const threads = [
    { key: 'a', name: 'TextRender', preview: 'あ', selected: true },
    { key: 'b', name: 'KiriKiriZ', preview: '', selected: false }
  ]
  const auto = threadChoices({ selectedBy: 'auto', threads })
  assert.deepEqual(
    auto.map((c) => [c.key, c.label, c.current, c.live]),
    [
      [null, 'Choose automatically', true, false],
      ['a', 'あ', false, true],
      ['b', 'KiriKiriZ', false, false]
    ]
  )
  assert.equal(auto[0].detail, 'Matched to the screen')
  const manual = threadChoices({ selectedBy: 'manual', threads })
  assert.deepEqual(manual.map((c) => c.current), [false, true, false])
})
