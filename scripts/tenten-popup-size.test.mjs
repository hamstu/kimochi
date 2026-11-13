import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sizeCss, tentenPopupSize, TENTEN_POPUP_SIZES } from '../host/ext/content.js'

test("10ten's pop-up size setting defaults to compact, and large leaves 10ten its own sizing", () => {
  assert.deepEqual(tentenPopupSize(undefined), TENTEN_POPUP_SIZES.compact)
  assert.deepEqual(tentenPopupSize('nonsense'), TENTEN_POPUP_SIZES.compact)
  assert.deepEqual(tentenPopupSize('compact'), { width: 400, height: 250 })
  assert.deepEqual(tentenPopupSize('medium'), { width: 480, height: 400 })
  assert.equal(tentenPopupSize('large'), null)
  assert.equal(tentenPopupSize('toString'), TENTEN_POPUP_SIZES.compact, 'only its own keys')
})

test("the cap is the smaller of 10ten's own (fitting the window) and ours, fade included", () => {
  const css = sizeCss('tenten', { width: 400, height: 250 })
  assert.match(css, /\.window \{ max-width: min\(var\(--tenten-max-width, 400px\), 400px\) !important; \}/)
  assert.match(
    css,
    /\.container:not\(\.interactive\) \{\n {2}max-height: min\(var\(--tenten-max-height, 250px\), 250px\) !important;/
  )
  assert.match(
    css,
    /mask-image: linear-gradient\(to bottom, black calc\(min\(var\(--tenten-max-height, 250px\), 250px\) - 5px\), transparent\) !important;/
  )
  assert.match(
    css,
    /\.container\.interactive \.window \{ max-height: min\(var\(--tenten-max-height, 250px\), 250px\) !important; \}/
  )
  assert.equal(sizeCss('tenten', null), '')
  assert.equal(sizeCss('hachidori', { width: 400, height: 250 }), '', 'only 10ten')
})
