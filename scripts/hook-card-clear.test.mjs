/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The Text Hooker's card takes plain clicks once it is clear of the game window (#187).
 *
 * With click-through on, the card is a Shift-only region: a click without the lookup key goes to
 * whatever is under it. Over the game that is the point (the card covers the game's own buttons),
 * but a card dragged off the game passed the click to the desktop or another app, which took the
 * focus, so the game went behind and the card hid. ui/overlay.js `hitRects` now publishes the card
 * as an ordinary region when `clearOfGame` says no part of it is over the game, and keeps it
 * Shift-only otherwise, including whenever the game's rectangle is unknown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from './load.mjs'

const { clearOfGame, overlaps } = await load('regions.ts')

const game = { x: 100, y: 100, width: 800, height: 600 }
const card = (x, y, width = 200, height = 60) => ({ x, y, width, height })

test('a card wholly inside the game is not clear', () => {
  assert.equal(clearOfGame(card(300, 500), game), false)
})

test('a card partly over the game is not clear, on any side', () => {
  assert.equal(clearOfGame(card(0, 300), game), false) // left edge
  assert.equal(clearOfGame(card(850, 300), game), false) // right edge
  assert.equal(clearOfGame(card(300, 80), game), false) // top edge
  assert.equal(clearOfGame(card(300, 690), game), false) // bottom edge
  assert.equal(clearOfGame(card(899, 699, 10, 10), game), false) // one pixel in the corner
})

test('a card wholly outside the game is clear, touching edges included', () => {
  assert.equal(clearOfGame(card(1000, 300), game), true)
  assert.equal(clearOfGame(card(300, 800), game), true)
  assert.equal(clearOfGame(card(-100, 300, 200), game), true) // ends exactly at the game's left edge
  assert.equal(clearOfGame(card(900, 700), game), true) // starts exactly at its bottom-right corner
  assert.equal(clearOfGame(card(300, 40), game), true) // ends exactly at its top
})

test('a card covering the whole game is not clear', () => {
  assert.equal(clearOfGame(card(0, 0, 2000, 2000), game), false)
})

test('an unknown or degenerate game window keeps click-through', () => {
  assert.equal(clearOfGame(card(1000, 300), null), false)
  assert.equal(clearOfGame(card(1000, 300), undefined), false)
  assert.equal(clearOfGame(card(1000, 300), { x: 0, y: 0, width: 0, height: 0 }), false)
  assert.equal(clearOfGame(card(1000, 300), { x: NaN, y: 0, width: 10, height: 10 }), false)
})

test('an unknown card is not clear', () => {
  assert.equal(clearOfGame(null, game), false)
  assert.equal(clearOfGame(card(1000, 300, 0, 0), game), false)
})

test('overlaps is symmetric', () => {
  const a = card(0, 0, 10, 10)
  const b = card(5, 5, 10, 10)
  assert.equal(overlaps(a, b), true)
  assert.equal(overlaps(b, a), true)
  assert.equal(overlaps(a, card(10, 0, 10, 10)), false)
})

test('the overlay publishes the card gated only while it is over the game', () => {
  const overlay = readFileSync(new URL('../ui/overlay.js', import.meta.url), 'utf8')
  // Gated by the card's own click-through (always on while its look is Transparent).
  assert.match(overlay, /if \(card\) add\(card, false, clickThrough\('card'\) && !hookCardClear\(\)\)/)
  // The card's own controls light up and take presses without the key while it is clear.
  assert.match(overlay, /const cardArmed = !clickThrough\('card'\) \|\| gateOpen \|\| hookCardClear\(\)/)
  assert.match(overlay, /hook\.card\?\.pointer\(local\.x, local\.y, Boolean\(payload\.down\), cardArmed\)/)
})
