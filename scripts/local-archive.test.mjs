import test from 'node:test'
import assert from 'node:assert/strict'
import { importLocalZip, isLocalZipImport } from '../host/ext/local-archive.js'

test('a settings-owned ZIP is read locally and rebuilt by the offscreen upload protocol', async () => {
  const bytes = new Uint8Array(1024 * 1024 + 12).fill(91)
  const parts = [], calls = [], reports = []
  const decision = { action: 'install', identity: { title: 'Fixture' } }
  const message = { type: 'hd_import', blobUrl: 'blob:hachidori://localhost/page-only', fileName: 'fixture.zip', requestId: 'import-1', importDecision: decision }
  assert.equal(isLocalZipImport(message), true)
  const reply = await importLocalZip({
    fetch: async url => {
      assert.equal(url, message.blobUrl)
      return new Response(bytes)
    }, btoa,
  }, message, async value => {
    calls.push(value)
    assert.equal(value.target, 'hachidori-upload-store')
    assert.equal(value.relayed, true)
    if (value.type === 'hd_upload_append') {
      const part = Buffer.from(value.data, 'base64')
      assert.equal(part.length, value.byteLength)
      parts.push(part)
    } else if (value.type === 'hd_upload_import') {
      assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes))
      assert.equal(value.importDecision, decision)
      assert.equal(value.requestId, 'import-1')
      return { type: 'hd_import_result', requestId: value.requestId, ok: true }
    }
    return { ok: true }
  }, value => reports.push(value))
  assert.equal(reply.ok, true)
  assert.deepEqual(calls.map(x => x.type), ['hd_upload_append', 'hd_upload_append', 'hd_upload_import', 'hd_upload_discard'])
  assert.equal(new Set(calls.map(x => x.token)).size, 1)
  assert.equal(reports[0].bytes, bytes.length)
})

test('failed uploads discard held chunks and remote/MDX imports keep their existing path', async () => {
  for (const message of [{ type: 'hd_import', archiveUrl: 'https://example.org/a.zip' }, { type: 'hd_import', blobUrl: 'blob:local', fileName: 'a.mdx' }]) assert.equal(isLocalZipImport(message), false)
  const calls = []
  await assert.rejects(importLocalZip({ fetch: async () => new Response('zip'), btoa },
    { fileName: 'a.zip', blobUrl: 'blob:local' }, async value => {
      calls.push(value.type)
      return value.type === 'hd_upload_append' ? { ok: false, error: 'chunk refused' } : { ok: true }
    }, () => {}), /chunk refused/)
  assert.deepEqual(calls, ['hd_upload_append', 'hd_upload_discard'])
})
