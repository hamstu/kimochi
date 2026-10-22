import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOCS_URL, docsUrl } from '../src/lib/docs.js'

test('docsUrl builds absolute docs links', () => {
  assert.equal(DOCS_URL, 'https://docs.kimochiapp.com')
  assert.equal(docsUrl(), 'https://docs.kimochiapp.com/')
  assert.equal(docsUrl('/install/linux/'), 'https://docs.kimochiapp.com/install/linux/')
  assert.equal(docsUrl('controller/'), 'https://docs.kimochiapp.com/controller/')
})
