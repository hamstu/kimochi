// Vendoring of the dictionary extensions (scripts/sync-extension.mjs), the extension verification
// in scripts/prepare.mjs, and the dev-only extension origins (scripts/ext-dev-server.mjs). All
// offline: zips are built in memory and `fetch` is stubbed.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  compareHashes,
  ensureExtension,
  extensionIds,
  hashTree,
  loadSource,
  readZip,
  safeEntryPath,
  sha256,
  syncExtension,
  unzipTo,
  verifyExtension
} from './sync-extension.mjs'
import { prepareExtensions, verifyExtensions } from './prepare.mjs'
import { createExtensionServer, createRelayBus, harnessInjectsYomitanShim, harnessTagFor, injectHostScript, HOST_SCRIPT_TAG, YOMITAN_SHIM_TAG } from './ext-dev-server.mjs'

/** A minimal zip writer: `[{name, data?, method?, mode?, flags?, crc?}]`, directories end in `/`. */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data ?? '')
    const method = entry.method ?? 8
    const stored = method === 8 ? zlib.deflateRawSync(data) : data
    const crc = entry.crc ?? zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, stored)
    centrals.push(central, name)
    offset += 30 + name.length + stored.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'kimochi-sync-test-'))

test('safeEntryPath accepts relative paths and rejects anything that could escape', () => {
  assert.equal(safeEntryPath('css/options.css'), 'css/options.css')
  assert.equal(safeEntryPath('./a//b/'), 'a/b')
  for (const bad of ['../x', 'a/../../x', 'a/..', '/etc/passwd', 'C:/x', 'c:x', 'a\\..\\x', 'a\0b', '']) {
    assert.throws(() => safeEntryPath(bad), undefined, JSON.stringify(bad))
  }
})

test('readZip round-trips stored and deflated entries and checks CRC, symlinks and encryption', () => {
  const entries = readZip(
    makeZip([
      { name: 'dir/' },
      { name: 'dir/a.txt', data: 'hello', method: 0 },
      { name: 'b.json', data: '{"x":1}'.repeat(100) }
    ])
  )
  assert.deepEqual(
    entries.map((e) => [e.name, e.directory, e.data?.toString()]),
    [
      ['dir', true, undefined],
      ['dir/a.txt', false, 'hello'],
      ['b.json', false, '{"x":1}'.repeat(100)]
    ]
  )
  assert.throws(() => readZip(makeZip([{ name: 'a', data: 'x', crc: 1 }])), /CRC mismatch/)
  assert.throws(() => readZip(makeZip([{ name: 'link', data: '/etc', mode: 0o120777 }])), /symlink/)
  assert.throws(() => readZip(makeZip([{ name: 'a', data: 'x', flags: 1 }])), /Encrypted/)
  assert.throws(() => readZip(makeZip([{ name: '../evil', data: 'x' }])), /escapes/)
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/)
})

test('unzipTo writes the tree, strips a prefix, and writes nothing for an unsafe archive', async () => {
  const dir = await tempDir()
  try {
    await unzipTo(makeZip([{ name: 'ext/' }, { name: 'ext/manifest.json', data: '{}' }, { name: 'ext/js/a.js', data: '1' }]), dir, {
      stripPrefix: 'ext'
    })
    assert.deepEqual(Object.keys(await hashTree(dir)), ['js/a.js', 'manifest.json'])
    await assert.rejects(unzipTo(makeZip([{ name: 'other.txt', data: '' }]), path.join(dir, 'p'), { stripPrefix: 'ext/' }), /outside ext/)

    const unsafe = path.join(dir, 'unsafe')
    await assert.rejects(unzipTo(makeZip([{ name: 'ok.txt', data: 'x' }, { name: '../../escape.txt', data: 'x' }]), unsafe), /escapes/)
    // The whole central directory is validated before the first write.
    assert.deepEqual(await readdir(unsafe).catch(() => []), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hashTree sorts POSIX keys; compareHashes reports missing, changed and added files', async () => {
  const dir = await tempDir()
  try {
    await mkdir(path.join(dir, 'b'), { recursive: true })
    await writeFile(path.join(dir, 'b', 'z.txt'), 'z')
    await writeFile(path.join(dir, 'a.txt'), 'a')
    const tree = await hashTree(dir)
    assert.deepEqual(Object.keys(tree), ['a.txt', 'b/z.txt'])
    assert.equal(tree['a.txt'], sha256('a'))
    await symlink(path.join(dir, 'a.txt'), path.join(dir, 'link'))
    assert.equal((await hashTree(dir)).link, 'not-a-regular-file')
    assert.deepEqual(compareHashes(tree, tree), [])
    assert.deepEqual(compareHashes({ a: '1', b: '2' }, { a: '9', c: '3' }), ['changed: a', 'missing: b', 'added: c'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function fixtureRepo(zip, extra = {}) {
  const dir = await tempDir()
  const source = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    asset: { url: 'https://example.invalid/demo.zip', sha256: sha256(zip) },
    unpack: {},
    ...extra
  }
  await writeFile(path.join(dir, 'demo.source.json'), JSON.stringify(source))
  return dir
}

async function withFetch(zip, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return new Response(zip)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('syncExtension verifies the asset hash, unpacks, records hashes and guards a non-empty target', async () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{"manifest_version":3}' }, { name: 'js/bg.js', data: 'x' }])
  const dir = await fixtureRepo(zip)
  const quiet = () => {}
  try {
    assert.deepEqual(await extensionIds(dir), ['demo'])
    await withFetch(zip, async (calls) => {
      const files = await syncExtension('demo', { dir, log: quiet })
      assert.deepEqual(Object.keys(files), ['js/bg.js', 'manifest.json'])
      assert.deepEqual(calls, ['https://example.invalid/demo.zip'])
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'demo.sha256.json'), 'utf8')), files)
      await assert.rejects(syncExtension('demo', { dir, log: quiet }), /not empty; pass --replace/)
      assert.equal(calls.length, 1, 'refuses before downloading')
      await syncExtension('demo', { dir, log: quiet, replace: true })
    })
    await verifyExtension('demo', { dir })
    await writeFile(path.join(dir, 'demo', 'js', 'bg.js'), 'patched')
    await assert.rejects(verifyExtension('demo', { dir }), /changed: js\/bg\.js/)

    // A tampered download never touches the tree.
    await withFetch(Buffer.concat([zip, Buffer.from(' ')]), async () => {
      await assert.rejects(syncExtension('demo', { dir, log: quiet, replace: true }), /sha256 mismatch/)
    })
    assert.equal(await readFile(path.join(dir, 'demo', 'js', 'bg.js'), 'utf8'), 'patched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureExtension downloads an absent or stale tree and leaves a matching one alone', async () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{}' }, { name: 'js/bg.js', data: 'x' }])
  const dir = await fixtureRepo(zip)
  const quiet = () => {}
  try {
    await withFetch(zip, async (calls) => {
      assert.equal(await ensureExtension('demo', { dir, log: quiet }), 'synced')
      assert.equal(calls.length, 1)
      assert.equal(await ensureExtension('demo', { dir, log: quiet }), 'verified')
      assert.equal(calls.length, 1, 'a matching tree is not downloaded again')
      // Stale (a pin bump since the fetch, or a half-finished unpack) is replaced, not refused.
      await rm(path.join(dir, 'demo', 'js'), { recursive: true })
      assert.equal(await ensureExtension('demo', { dir, log: quiet }), 'synced')
      assert.equal(await readFile(path.join(dir, 'demo', 'js', 'bg.js'), 'utf8'), 'x')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prepare.mjs fetches an absent extension tree before copying it, and only then', async () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{}' }])
  const from = await fixtureRepo(zip)
  const to = path.join(await tempDir(), 'ext')
  const log = console.log
  console.log = () => {}
  try {
    const fetched = []
    const fetchMissing = async (id, { dir }) => {
      fetched.push(id)
      await withFetch(zip, () => syncExtension(id, { dir, log: () => {} }))
    }
    await prepareExtensions({ from, to, fetchMissing })
    assert.deepEqual(fetched, ['demo'])
    assert.deepEqual(Object.keys((await verifyExtensions({ from, to })).demo), ['manifest.json'])
    await prepareExtensions({ from, to, fetchMissing })
    assert.deepEqual(fetched, ['demo'], 'a present tree is copied without a fetch')
  } finally {
    console.log = log
    await rm(from, { recursive: true, force: true })
    await rm(path.dirname(to), { recursive: true, force: true })
  }
})

test('syncExtension refuses a release without a top-level manifest.json', async () => {
  const zip = makeZip([{ name: 'ext/manifest.json', data: '{}' }])
  const dir = await fixtureRepo(zip)
  try {
    await withFetch(zip, async () => {
      await assert.rejects(syncExtension('demo', { dir, log: () => {} }), /no top-level manifest\.json/)
    })
    await assert.rejects(readdir(path.join(dir, 'demo')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadSource rejects a bad id, a mismatched id, a non-https URL and a malformed hash', async () => {
  const dir = await tempDir()
  try {
    await assert.rejects(loadSource('../x', dir), /Invalid extension id/)
    const write = (source) => writeFile(path.join(dir, 'demo.source.json'), JSON.stringify(source))
    await write({ id: 'other', asset: { url: 'https://a/b.zip', sha256: 'a'.repeat(64) } })
    await assert.rejects(loadSource('demo', dir), /has id "other"/)
    await write({ id: 'demo', asset: { url: 'http://a/b.zip', sha256: 'a'.repeat(64) } })
    await assert.rejects(loadSource('demo', dir), /https/)
    await write({ id: 'demo', asset: { url: 'https://a/b.zip', sha256: 'abc' } })
    await assert.rejects(loadSource('demo', dir), /not a sha256/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("prepare.mjs copies each extension into dist/ext and its verify catches a changed, added or missing file", async () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{}' }, { name: 'data/words.idx', data: 'idx' }])
  const from = await fixtureRepo(zip)
  const to = path.join(await tempDir(), 'ext')
  const log = console.log
  console.log = () => {}
  try {
    await withFetch(zip, () => syncExtension('demo', { dir: from, log: () => {} }))
    await prepareExtensions({ from, to })
    assert.deepEqual(Object.keys((await verifyExtensions({ from, to })).demo), ['data/words.idx', 'manifest.json'])

    await writeFile(path.join(to, 'demo', 'data', 'words.idx'), 'IDX')
    await assert.rejects(verifyExtensions({ from, to }), /dist\/ext\/demo\/:\n {2}changed: data\/words\.idx/)
    await prepareExtensions({ from, to })
    await writeFile(path.join(to, 'demo', 'extra.js'), '')
    await assert.rejects(verifyExtensions({ from, to }), /added: extra\.js/)
    await prepareExtensions({ from, to })
    await rm(path.join(to, 'demo', 'manifest.json'))
    await assert.rejects(verifyExtensions({ from, to }), /missing: manifest\.json/)

    // An edit to the vendored source itself is caught too, not copied through as the new truth.
    await writeFile(path.join(from, 'demo', 'manifest.json'), '{"edited":true}')
    await prepareExtensions({ from, to })
    await assert.rejects(verifyExtensions({ from, to }), /changed: manifest\.json/)
  } finally {
    console.log = log
    await rm(from, { recursive: true, force: true })
    await rm(path.dirname(to), { recursive: true, force: true })
  }
})

test('the Yomitan harness cookie alone turns on the shim injection, first in <head>', () => {
  assert.equal(harnessInjectsYomitanShim(undefined), false)
  assert.equal(harnessInjectsYomitanShim(''), false)
  assert.equal(harnessInjectsYomitanShim('kimochi-harness-shim='), false)
  assert.equal(harnessInjectsYomitanShim('x=1; kimochi-harness-shim=yomitanx'), false)
  assert.equal(harnessInjectsYomitanShim('kimochi-harness-shim=yomitan'), true)
  assert.equal(harnessInjectsYomitanShim('a=b; kimochi-harness-shim=yomitan; c=d'), true)
  const page = '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n  </head>\n  <body><script type="module" src="/sw.js"></script></body>\n</html>'
  const served = injectHostScript(page, YOMITAN_SHIM_TAG)
  assert.ok(served.indexOf(YOMITAN_SHIM_TAG) < served.indexOf('/sw.js'))
  assert.ok(served.startsWith('<!doctype html>\n<html>\n  <head><script src="/spike/shim.js"></script>'))
})

test('injectHostScript puts the host first in <head>, never before the doctype', () => {
  const t = HOST_SCRIPT_TAG
  assert.equal(injectHostScript('<!DOCTYPE html>\n<html>\n<head>\n<meta>'), `<!DOCTYPE html>\n<html>\n<head>${t}\n<meta>`)
  assert.equal(injectHostScript('<!doctype html><html lang="en"><head data-x="1"><title>'), `<!doctype html><html lang="en"><head data-x="1">${t}<title>`)
  // A comment mentioning <head> is not the head; <header> is not <head>.
  assert.equal(
    injectHostScript('<!doctype html><!-- the <head> goes here --><html><body><header>'),
    `<!doctype html><!-- the <head> goes here --><html>${t}<body><header>`
  )
  assert.equal(injectHostScript('<!doctype html>\n<!-- c -->\n<script src="a.js"></script>'), `<!doctype html>${t}\n<!-- c -->\n<script src="a.js"></script>`)
  assert.equal(injectHostScript('<p>bare</p>'), `${t}<p>bare</p>`)
})

/** A raw request, so `..` reaches the server unnormalised (fetch would resolve it client-side). */
function rawRequest(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the dev extension origin serves the tree and /__kimochi/, injects HTML, and refuses traversal', async () => {
  const dir = await tempDir()
  const extRoot = path.join(dir, 'ext', 'demo')
  const spikeRoot = path.join(dir, 'spike')
  await mkdir(path.join(extRoot, 'data'), { recursive: true })
  await mkdir(spikeRoot, { recursive: true })
  await writeFile(path.join(extRoot, 'options.html'), '<!DOCTYPE html><html><head><title>o</title></head></html>')
  await writeFile(path.join(extRoot, 'data', 'words.idx'), 'IDX')
  await writeFile(path.join(spikeRoot, 'ext-host.js'), ';(() => {})()')
  await writeFile(path.join(dir, 'secret.txt'), 'secret')
  const server = createExtensionServer({
    extRoot,
    spikeRoot,
    mime: { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.idx': 'application/octet-stream' }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const page = await rawRequest(port, 'GET', '/options.html?x=1')
    assert.equal(page.status, 200)
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(page.headers['access-control-allow-origin'], '*')
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.equal(page.body, `<!DOCTYPE html><html><head>${HOST_SCRIPT_TAG}<title>o</title></head></html>`)

    const head = await rawRequest(port, 'HEAD', '/data/words.idx')
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-type'], 'application/octet-stream')
    assert.equal(head.headers['content-length'], '3')
    assert.equal(head.body, '')

    const host = await rawRequest(port, 'GET', '/__kimochi/ext-host.js')
    assert.equal(host.body, ';(() => {})()')
    assert.equal(host.headers['content-type'], 'text/javascript; charset=utf-8')

    for (const evil of ['/../secret.txt', '/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/__kimochi/../../secret.txt', '/__kimochi/..%2f..%2fsecret.txt', '/data', '/', '/__kimochi', '/%E0%A4%A']) {
      const res = await rawRequest(port, 'GET', evil)
      assert.equal(res.status, 404, evil)
      assert.notEqual(res.body, 'secret', evil)
    }
    assert.equal((await rawRequest(port, 'POST', '/options.html')).status, 405)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("the harness's extension window page gets the native stand-in first, and only that page", async () => {
  const script = 'http://127.0.0.1:1430/ui/dictionary-harness-native.js'
  const tag = `<script src="${script}"></script>`
  assert.equal(harnessTagFor('/__kimochi/ext-background.html', 'engine=hachidori&window=ext-hachidori', script), tag)
  assert.equal(harnessTagFor('/__kimochi/ext-background.html', 'engine=hachidori', script), null)
  assert.equal(harnessTagFor('/__kimochi/ext-background.html', 'window=overlay', script), null)
  assert.equal(harnessTagFor('/__kimochi/ext-background.html', 'window=ext-%3Cscript%3E', script), null)
  assert.equal(harnessTagFor('/options.html', 'window=ext-hachidori', script), null)
  assert.equal(harnessTagFor('/__kimochi/ext-background.html', 'window=ext-hachidori', null), null)

  const dir = await tempDir()
  const extRoot = path.join(dir, 'ext', 'demo')
  const spikeRoot = path.join(dir, 'spike')
  await mkdir(extRoot, { recursive: true })
  await mkdir(spikeRoot, { recursive: true })
  await writeFile(path.join(spikeRoot, 'ext-background.html'), '<!doctype html><html><head><script src="/__kimochi/ext-host.js"></script></head><body></body></html>')
  const bus = createRelayBus()
  const seen = []
  const server = createExtensionServer({
    extRoot,
    spikeRoot,
    mime: { '.html': 'text/html; charset=utf-8' },
    harnessScript: script,
    middleware: [(req, res, next) => { seen.push(req.url); next() }, bus.middleware]
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const page = await rawRequest(port, 'GET', '/__kimochi/ext-background.html?engine=demo&window=ext-demo')
    assert.equal(page.body, `<!doctype html><html><head>${tag}<script src="/__kimochi/ext-host.js"></script></head><body></body></html>`)
    const plain = await rawRequest(port, 'GET', '/__kimochi/ext-background.html?engine=demo')
    assert.ok(!plain.body.includes('dictionary-harness-native'))
    assert.deepEqual(seen, ['/__kimochi/ext-background.html?engine=demo&window=ext-demo', '/__kimochi/ext-background.html?engine=demo'])
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the relay bus stamps {from, to, seq} per sender, survives a reload, and reaches every listener of a channel', async () => {
  const bus = createRelayBus()
  const server = http.createServer((req, res) => bus.middleware(req, res, () => res.writeHead(404).end()))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const listen = (channel) => {
    const messages = []
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/__kimochi/relay?channel=${channel}` }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream')
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          if (block.startsWith('data: ')) messages.push(JSON.parse(block.slice(6)))
        }
      })
    })
    req.end()
    return { messages, close: () => req.destroy() }
  }
  const post = (channel, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/__kimochi/relay?channel=${channel}`, headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  const a = listen('hachidori')
  const b = listen('hachidori')
  const other = listen('tenten')
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await post('hachidori', { from: 'ext-hachidori', to: 'overlay', payload: { kind: 'ext', n: 1 } }), 204)
    assert.equal(await post('hachidori', { from: 'overlay', payload: { kind: 'ext', type: 'ready' } }), 204)
    assert.equal(await post('hachidori', { from: 'ext-hachidori', to: 'overlay', payload: { kind: 'ext', n: 2 } }), 204)
    assert.equal(await post('hachidori', 'nope'), 400)
    assert.equal(await post('hachidori', { to: 'overlay', payload: {} }), 400)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const expected = [
      { from: 'ext-hachidori', to: 'overlay', seq: 1, payload: { kind: 'ext', n: 1 } },
      { from: 'overlay', to: null, seq: 1, payload: { kind: 'ext', type: 'ready' } },
      { from: 'ext-hachidori', to: 'overlay', seq: 2, payload: { kind: 'ext', n: 2 } }
    ]
    assert.deepEqual(a.messages, expected)
    assert.deepEqual(b.messages, expected)
    assert.deepEqual(other.messages, [])
    // A page that reloads keeps its label's counter, as native's does, so nobody drops it as a resend.
    b.close()
    const again = listen('hachidori')
    await new Promise((resolve) => setTimeout(resolve, 50))
    await post('hachidori', { from: 'ext-hachidori', to: 'overlay', payload: { n: 3 } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(again.messages[0].seq, 3)
    again.close()
  } finally {
    a.close()
    other.close()
    server.closeAllConnections?.()
    server.close()
  }
})
