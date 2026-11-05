/** Help → Report a bug: the form's checks before it sends (ui/bug-report.ts). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { draftProblem, EMPTY_DRAFT } = await load('bug-report.ts')
const good = { ...EMPTY_DRAFT, name: 'Aki', email: 'aki@example.com', description: 'The overlay vanished after a scan.' }

test('a complete draft can be sent', () => {
  assert.equal(draftProblem(good), null)
  assert.equal(draftProblem({ ...good, name: '  Aki ', email: ' aki@example.com ' }), null)
})

test('each missing or wrong field is named, first one first', () => {
  assert.match(draftProblem({ ...good, name: '  ' }), /name/)
  assert.match(draftProblem({ ...good, email: '' }), /email/)
  assert.match(draftProblem({ ...good, email: 'aki@example' }), /doesn’t look right/)
  assert.match(draftProblem({ ...good, email: 'a b@example.com' }), /doesn’t look right/)
  assert.match(draftProblem({ ...good, description: ' broken   ' }), /more detail/)
  assert.match(draftProblem({ ...good, description: 'x'.repeat(5001) }), /5,000/)
  assert.match(draftProblem({ ...EMPTY_DRAFT }), /name/)
})

test('debug data is attached unless turned off', () => {
  assert.equal(EMPTY_DRAFT.attachDebug, true)
})
