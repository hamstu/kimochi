import test from 'node:test'
import assert from 'node:assert/strict'
import { shownForHits } from '../ui/hit-visible.js'

const shown = { visibility: 'visible', display: 'flex', opacity: '1' }

test('a visible word takes the mouse; a hidden one does not', () => {
  assert.equal(shownForHits(shown), true)
  assert.equal(shownForHits({ ...shown, visibility: 'hidden' }), false)
  assert.equal(shownForHits({ ...shown, display: 'none' }), false)
  assert.equal(shownForHits({ ...shown, opacity: '0' }), false)
})

test('a word still at the start of its entrance takes the mouse (an unmapped Wayland layer)', () => {
  const appearing = { ...shown, opacity: '0' }
  assert.equal(shownForHits(appearing, [{ animationName: 'ocr-appear' }]), true)
  assert.equal(shownForHits(appearing, [{ animationName: 'something-else' }]), false)
  assert.equal(shownForHits({ ...appearing, display: 'none' }, [{ animationName: 'ocr-appear' }]), false)
})
