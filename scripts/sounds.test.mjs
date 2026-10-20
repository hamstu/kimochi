import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { load } from './load.mjs'

const {
  AUTO_ERROR_INTERVAL_MS,
  POOL_SIZE,
  SOUND_NAMES,
  SOUND_VOLUME,
  controlSound,
  createAudioPlayer,
  installInteractionSounds,
  pressSound,
  readControl,
  createSoundPlayer,
  errorMayRing,
  outcomeSound,
  playAudio
} = await load('sounds.ts')
const scanActivity = await load('scan-activity.ts')
const { SETTINGS_DEFAULTS } = await load('settings.ts')

/** A player with a fake clock that records what it would have played. */
function player({ enabled = () => true } = {}) {
  const played = []
  const clock = { now: 0 }
  const play = createSoundPlayer({ enabled, play: (name) => played.push(name), now: () => clock.now })
  return { play, played, clock }
}

test('sound effects are on by default', () => {
  assert.equal(SETTINGS_DEFAULTS.soundEffects, true)
})

test('every sound has its file beside the overlay modules', async () => {
  for (const name of SOUND_NAMES) await access(new URL(`../ui/sounds/${name}.mp3`, import.meta.url))
  await access(new URL('../ui/sounds/LICENSE.txt', import.meta.url))
})

test('the setting gates every sound, and is read at each one', () => {
  let setting
  const { play, played } = player({ enabled: () => setting })
  setting = false
  assert.equal(play('scan-start'), false)
  assert.equal(play('scan-error'), false)
  // A store from before the key existed has no value: that is the default, on.
  setting = undefined
  assert.equal(play('scan-start'), true)
  setting = true
  assert.equal(play('scan-done'), true)
  assert.deepEqual(played, ['scan-start', 'scan-done'])
  assert.equal(play(null), false)
})

test('lines added chime; repeats, empty readings and discards are quiet', () => {
  assert.equal(outcomeSound(scanActivity.scanOutcome({ lines: 2, duplicate: false })), 'scan-done')
  assert.equal(
    outcomeSound(scanActivity.scanOutcome({ lines: 1, duplicate: false }, { auto: true }), {
      auto: true
    }),
    'scan-done'
  )
  assert.equal(outcomeSound(scanActivity.scanOutcome({ lines: 0, duplicate: true })), null)
  assert.equal(outcomeSound(scanActivity.scanOutcome(null)), null)
  assert.equal(outcomeSound(scanActivity.scanOutcome(null, { auto: true }), { auto: true }), null)
  assert.equal(outcomeSound(scanActivity.nothingRecognised()), null)
  assert.equal(outcomeSound(scanActivity.sourceChanged()), null)
  for (const reason of ['stale-generation', 'superseded', 'held', 'unpinned', 'empty-result'])
    assert.equal(outcomeSound(scanActivity.autoScanSkipped(reason), { auto: true }), null, reason)
  // Progress is not an outcome.
  assert.equal(outcomeSound(scanActivity.scanStarted()), null)
  assert.equal(outcomeSound(scanActivity.scanBusy()), null)
  assert.equal(outcomeSound(null), null)
})

test('failures buzz: OCR, capture, publication, and an engine that cannot run', () => {
  const failed = (error, stage, mode = 'meikiocr') =>
    outcomeSound(scanActivity.scanFailed(new Error(error), stage, mode))
  assert.equal(failed('connection refused', 'recognise'), 'scan-error')
  assert.equal(failed('native: stream stopped', 'capture'), 'scan-error')
  assert.equal(failed('permission: denied', 'capture'), 'scan-error')
  assert.equal(failed('history is locked', 'publish'), 'scan-error')
  assert.equal(failed('MeikiOCR is not ready: Downloading model… 42%', 'recognise'), 'scan-error')
  assert.equal(failed('MeikiOCR is not ready: something else', 'recognise'), 'scan-error')
  assert.equal(failed('OneOCR is available on Windows only.', 'recognise', 'oneocr'), 'scan-error')
  // A capture already running, or a frame that was replaced, is not a failure.
  assert.equal(failed('busy: capture in progress', 'capture'), null)
  assert.equal(failed('gone: frame evicted', 'recognise'), null)
  assert.equal(outcomeSound({ text: 'Quick Shot failed: nope', tone: 'error' }), 'scan-error')
})

test('no source buzzes for a scan the reader asked for, not for the automatic loop', () => {
  assert.equal(outcomeSound(scanActivity.noSource()), 'scan-error')
  assert.equal(outcomeSound(scanActivity.noSource(), { auto: true }), null)
  const captured = scanActivity.scanFailed('No source selected', 'capture', 'cloud')
  assert.equal(outcomeSound(captured, { auto: true }), null)
})

test('the automatic loop rings an error at most once per interval', () => {
  assert.equal(errorMayRing(null, 0, true), true)
  assert.equal(errorMayRing(0, AUTO_ERROR_INTERVAL_MS - 1, true), false)
  assert.equal(errorMayRing(0, AUTO_ERROR_INTERVAL_MS, true), true)
  assert.equal(errorMayRing(0, 1, false), true)

  const { play, played, clock } = player()
  assert.equal(play('scan-error', { auto: true }), true)
  clock.now = 2000
  assert.equal(play('scan-error', { auto: true }), false)
  // Other sounds are not held back by it.
  assert.equal(play('scan-done', { auto: true }), true)
  // A scan the reader asked for always answers, and restarts the interval.
  clock.now = 3000
  assert.equal(play('scan-error'), true)
  clock.now = 3000 + AUTO_ERROR_INTERVAL_MS - 1
  assert.equal(play('scan-error', { auto: true }), false)
  clock.now = 3000 + AUTO_ERROR_INTERVAL_MS
  assert.equal(play('scan-error', { auto: true }), true)
  assert.deepEqual(played, ['scan-error', 'scan-done', 'scan-error', 'scan-error'])
})

test('playing where there is no audio does nothing rather than throwing', () => {
  assert.equal(typeof Audio, 'undefined')
  assert.doesNotThrow(() => playAudio('scan-start'))
})

/** A stand-in for HTMLAudioElement that records everything done to it. */
function fakeAudio() {
  const made = []
  class FakeAudio {
    constructor(src) {
      this.src = src
      this.volume = 1
      this.preload = 'none'
      this.ended = false
      this.plays = 0
      this.paused = true
      this.rewound = false
      made.push(this)
    }
    play() {
      this.plays++
      this.paused = false
      this.ended = false
      return Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    set currentTime(_value) {
      this.rewound = true
    }
  }
  return { FakeAudio, made }
}

test('one sound never cuts another off: overlapping plays get their own elements', () => {
  const { FakeAudio, made } = fakeAudio()
  const play = createAudioPlayer(FakeAudio, (name) => `sounds/${name}.mp3`)
  const start = play('scan-start')
  // The result arrives while the start's tail is still ringing.
  const done = play('scan-done')
  assert.notEqual(start, done)
  assert.deepEqual(
    made.map((audio) => [audio.src, audio.paused, audio.rewound, audio.plays]),
    [
      ['sounds/scan-start.mp3', false, false, 1],
      ['sounds/scan-done.mp3', false, false, 1]
    ]
  )
  assert.ok(made.every((audio) => audio.volume === SOUND_VOLUME && SOUND_VOLUME <= 0.5))

  // A quick repeat of the same sound mixes with the first rather than restarting it.
  const again = play('scan-start')
  assert.notEqual(again, start)
  assert.equal(start.plays, 1)
  assert.equal(start.rewound, false)
  assert.equal(start.paused, false)
})

test('a finished element is reused, a playing one never is', () => {
  const { FakeAudio, made } = fakeAudio()
  const play = createAudioPlayer(FakeAudio, (name) => name)
  const first = play('scan-done')
  first.ended = true
  assert.equal(play('scan-done'), first)
  assert.equal(first.plays, 2)
  assert.equal(made.length, 1)

  // A burst past the pool still plays every sound; the extras are simply not kept.
  for (let i = 0; i < POOL_SIZE + 2; i++) play('scan-error')
  assert.equal(made.filter((audio) => audio.src === 'scan-error').length, POOL_SIZE + 2)
  assert.ok(made.every((audio) => !audio.rewound))
})

test('a refused or throwing play is swallowed', async () => {
  const play = createAudioPlayer(
    class {
      play() {
        return Promise.reject(new Error('NotAllowedError'))
      }
    },
    (name) => name
  )
  assert.doesNotThrow(() => play('scan-start'))
  const broken = createAudioPlayer(
    class {
      constructor() {
        throw new Error('no audio')
      }
    },
    (name) => name
  )
  assert.equal(broken('scan-start'), null)
  // Let the rejected play() settle: an unhandled rejection would fail the run.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

test('buttons click, switches sound where they are going, closed menus open', () => {
  assert.equal(controlSound({ role: 'button' }), 'click')
  assert.equal(controlSound({ role: 'link' }), 'click')
  assert.equal(controlSound({ role: 'menuitem' }), 'click')
  // Read before the click lands: an unchecked switch is being turned on.
  assert.equal(controlSound({ role: 'switch', checked: 'false' }), 'toggle-on')
  assert.equal(controlSound({ role: 'switch', checked: 'true' }), 'toggle-off')
  assert.equal(controlSound({ role: 'checkbox', checked: 'indeterminate' }), 'toggle-on')
  assert.equal(controlSound({ role: 'menuitemcheckbox', checked: 'true' }), 'toggle-off')
  assert.equal(controlSound({ role: 'button', popup: 'menu' }), 'menu-open')
  assert.equal(controlSound({ role: 'button', popup: 'menu', expanded: true }), 'click')
  assert.equal(controlSound({ role: 'button', disabled: true }), null)
  assert.equal(controlSound(null), null)
})

test('data-sound overrides the control, and none or an unknown name is silent', () => {
  assert.equal(controlSound({ role: 'button', explicit: 'sidebar-hide' }), 'sidebar-hide')
  assert.equal(controlSound({ role: 'switch', checked: 'true', explicit: 'pin-on' }), 'pin-on')
  assert.equal(controlSound({ role: 'button', explicit: 'none' }), null)
  assert.equal(controlSound({ role: 'button', explicit: 'kaboom' }), null)
})

/** Just enough of an Element for `readControl`: attributes, a tag, a parent, and `closest`. */
function element(tag, attributes = {}, parent = null) {
  const node = {
    tagName: tag.toUpperCase(),
    parent,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    closest(selector) {
      for (let at = node; at; at = at.parent) if (selector.split(', ').some((s) => at.matches(s))) return at
      return null
    },
    matches(selector) {
      const attr = /^(\w*)\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector)
      if (!attr) return node.tagName.toLowerCase() === selector
      const [, t, name, value] = attr
      if (t && node.tagName.toLowerCase() !== t) return false
      return name in attributes && (value === undefined || attributes[name] === value)
    }
  }
  return node
}

test('a click inside a control reads the control and the nearest data-sound', () => {
  const region = element('div', { 'data-sound': 'none' })
  const button = element('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' })
  const icon = element('svg', {}, button)
  assert.deepEqual(readControl(icon), {
    explicit: undefined,
    role: 'button',
    checked: null,
    popup: 'menu',
    expanded: false,
    disabled: false
  })
  const muted = element('button', {}, region)
  assert.equal(controlSound(readControl(muted)), null)
  const toggle = element('button', { role: 'switch', 'aria-checked': 'true' })
  assert.equal(controlSound(readControl(element('span', {}, toggle))), 'toggle-off')
  // Text, a field, the window ground: not controls, no sound.
  assert.equal(readControl(element('p')), null)
  assert.equal(readControl(null), null)
})

test('interaction sounds follow the setting, except the one that turns sound on', () => {
  const listeners = new Map()
  const root = {
    addEventListener: (type, fn, capture) => listeners.set(type, { fn, capture }),
    removeEventListener: (type) => listeners.delete(type)
  }
  let on = true
  const played = []
  const uninstall = installInteractionSounds(root, { enabled: () => on, play: (name) => played.push(name) })
  // Capturing, so a switch still shows its old state when the sound is chosen.
  assert.equal(listeners.get('click').capture, true)
  const click = (target) => listeners.get('click').fn({ target })
  assert.ok(listeners.has('pointerdown') && listeners.has('keydown'))
  click(element('button'))
  on = false
  click(element('button'))
  click(element('button', { 'data-sound': 'sound-on' }))
  assert.deepEqual(played, ['click', 'sound-on'])
  uninstall()
  assert.equal(listeners.has('click'), false)
})

test('menus and selects sound on the press that opens them; other controls wait for the click', () => {
  const menu = { role: 'button', popup: 'menu' }
  const select = { role: 'combobox', popup: 'listbox' }
  assert.equal(pressSound(menu), 'menu-open')
  assert.equal(pressSound(select), 'menu-open')
  assert.equal(pressSound({ ...menu, expanded: true }), null)
  assert.equal(pressSound({ role: 'button' }), null)
  assert.equal(pressSound({ role: 'switch', checked: 'false' }), null)
  assert.equal(pressSound({ ...menu, disabled: true }), null)
  // The keys Radix opens each with.
  assert.equal(pressSound(menu, 'Enter'), 'menu-open')
  assert.equal(pressSound(menu, ' '), 'menu-open')
  assert.equal(pressSound(menu, 'ArrowDown'), 'menu-open')
  assert.equal(pressSound(menu, 'ArrowUp'), null)
  assert.equal(pressSound(select, 'ArrowUp'), 'menu-open')
  assert.equal(pressSound(select, 'a'), null)
  assert.equal(pressSound({ role: 'button', popup: 'dialog' }, 'ArrowDown'), null)
})

test('a select reads as a listbox trigger', () => {
  const select = element('button', { role: 'combobox', 'aria-expanded': 'false' })
  assert.equal(readControl(select).popup, 'listbox')
  assert.equal(readControl(element('button', { disabled: '' })).disabled, true)
})

test('a trigger that sounded on its press does not sound again on its click', () => {
  const listeners = new Map()
  const root = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {} }
  const played = []
  installInteractionSounds(root, { enabled: () => true, play: (name) => played.push(name) })
  const fire = (type, target, extra = {}) => listeners.get(type)({ target, button: 0, ctrlKey: false, ...extra })
  const user = element('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' })
  const popover = element('button', { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' })
  const plain = element('button')
  // A dropdown: the press opens it and no click follows.
  fire('pointerdown', element('svg', {}, user))
  // A popover: the press sounds, its click (which opens it) does not.
  fire('pointerdown', popover)
  fire('click', popover)
  // Enter on a popover: keydown sounds, the click Enter makes does not.
  fire('keydown', popover, { key: 'Enter' })
  fire('click', popover)
  // Ordinary buttons: nothing on the press, a click on the click; a right press is ignored.
  fire('pointerdown', plain)
  fire('pointerdown', user, { button: 2 })
  fire('click', plain)
  assert.deepEqual(played, ['menu-open', 'menu-open', 'menu-open', 'click'])
})
