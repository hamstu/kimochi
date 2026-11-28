import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  fileName,
  MIRRORED_HOSTS,
  mirrorPath,
  pinnedFiles,
  releaseDocument,
  retention,
  worktree
} from './download-mirror.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const HASH = '69753a221e8cf472cf1a7e17ff51133c471511638934ef4414a102e9d4c0252d'

test('mirror paths match the app’s (download_mirror.rs)', async () => {
  assert.equal(
    mirrorPath(
      'https://github.com/birchill/10ten-ja-reader/releases/download/v1.29.0/10ten-ja-reader-1.29.0-chrome.zip',
      HASH
    ),
    `files/sha256/${HASH}/10ten-ja-reader-1.29.0-chrome.zip`
  )
  assert.equal(
    mirrorPath('https://huggingface.co/a/b/resolve/abc/model%20v1.onnx?download=true', HASH),
    `files/sha256/${HASH}/model_20v1.onnx`
  )
  assert.equal(mirrorPath('https://chrome-infra-packages.appspot.com/dl/x/+/y', HASH), null)
  assert.equal(mirrorPath('https://github.com/a/b.zip', 'abc'), null)
  assert.equal(mirrorPath('http://github.com/a/b.zip', HASH), null)
  assert.equal(fileName('https://github.com/a/..'), 'file')
  // The same hosts on both sides.
  const rust = await readFile(`${root}src-tauri/src/download_mirror.rs`, 'utf8')
  const hosts = /MIRRORED_HOSTS: &\[&str\] = &\[([^\]]+)\]/
    .exec(rust)[1]
    .match(/"([^"]+)"/g)
    .map((h) => h.slice(1, -1))
  assert.deepEqual(hosts, MIRRORED_HOSTS)
})

test('the inventory covers every pinned download the app makes', async () => {
  const files = await pinnedFiles(worktree)
  const artifacts = new Set(files.map((f) => f.artifact.split('/')[0]))
  assert.deepEqual([...artifacts].sort(), ['extensions', 'models', 'texthook', 'yomitan-host'])
  for (const id of ['yomitan', 'hachidori', 'tenten']) {
    const pin = JSON.parse(await readFile(`${root}extensions/${id}.source.json`, 'utf8'))
    const entry = files.find((f) => f.artifact === `extensions/${id}`)
    assert.equal(entry.path, mirrorPath(pin.asset.url, pin.asset.sha256))
  }
  // Screen AI is Google's: fetched from Google only.
  assert.ok(!files.some((f) => f.artifact.startsWith('models/screenai')))
  for (const f of files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.artifact)
    assert.match(f.path, /^(files\/sha256\/[0-9a-f]{64}\/[\w.-]+|texthook\/[\w./-]+)$/, f.path)
  }
  assert.equal(new Set(files.map((f) => f.path)).size, files.length, 'one entry per path')
  const helper = files.filter((f) => f.artifact.startsWith('yomitan-host/'))
  assert.ok(helper.length >= 6, 'the Yomitan API helper pins parse')
  // A file pinned compressed is mirrored compressed: the entry is the xz stream's size and hash.
  const manifest = JSON.parse(await readFile(`${root}src-tauri/texthook-manifest.json`, 'utf8'))
  for (const [id, engine] of Object.entries(manifest.engines)) {
    for (const file of engine.files.filter((f) => f.xz)) {
      const entry = files.find((f) => f.artifact === `texthook/${id}/${file.name}`)
      assert.ok(entry.path.endsWith(`/${file.name}.xz`), entry.path)
      assert.equal(entry.sha256, file.xz.sha256)
      assert.equal(entry.size, file.xz.size)
    }
  }
})

test('retention keeps pinned, recent and the newest versions, and never touches app/ or data/', () => {
  const now = new Date('2027-06-01T00:00:00Z')
  const at = (iso) => new Date(iso).toISOString()
  const entry = (artifact, lastReferenced) => ({ artifact, firstSeen: lastReferenced, lastReferenced })
  const ledger = {
    entries: {
      'files/sha256/a/x.zip': entry('extensions/x', at('2025-01-01')),
      'files/sha256/b/x.zip': entry('extensions/x', at('2025-02-01')),
      'files/sha256/c/x.zip': entry('extensions/x', at('2025-03-01')),
      'files/sha256/d/x.zip': entry('extensions/x', at('2026-12-01')),
      'files/sha256/e/x.zip': entry('extensions/x', at('2027-05-01')),
      'texthook/luna/1/a.dll': entry('texthook/luna/a.dll', at('2025-01-01')),
      'app/v0.1.0/x.exe': entry('app', at('2020-01-01')),
      'data/luna-hooks/1/db.json': entry('data/luna-hooks', at('2020-01-01')),
      'data/jitendex/2024.01.01.0/j.zip': { ...entry('data/jitendex', at('2025-01-01')), prunable: true },
      'data/jitendex/2027.05.01.0/j.zip': { ...entry('data/jitendex', at('2027-05-01')), prunable: true }
    }
  }
  const current = [{ path: 'files/sha256/e/x.zip' }]
  // Keep 2 versions, 12 months: a, b, c are old and outside the newest two; d is recent.
  assert.deepEqual(retention(ledger, current, { keepVersions: 2, keepMonths: 12, now }), [
    'files/sha256/a/x.zip',
    'files/sha256/b/x.zip',
    'files/sha256/c/x.zip'
  ])
  assert.deepEqual(retention(ledger, current, { keepVersions: 1, keepMonths: 12, now }), [
    'data/jitendex/2024.01.01.0/j.zip',
    'files/sha256/a/x.zip',
    'files/sha256/b/x.zip',
    'files/sha256/c/x.zip'
  ])
  // The defaults keep five versions: nothing of x goes; the lone texthook file is its newest.
  assert.deepEqual(retention(ledger, current, { now }), [])
  // Pinned now beats everything.
  assert.deepEqual(retention(ledger, [{ path: 'files/sha256/a/x.zip' }], { keepVersions: 0, keepMonths: 0, now }), [
    'data/jitendex/2024.01.01.0/j.zip',
    'data/jitendex/2027.05.01.0/j.zip',
    'files/sha256/b/x.zip',
    'files/sha256/c/x.zip',
    'files/sha256/d/x.zip',
    'files/sha256/e/x.zip',
    'texthook/luna/1/a.dll'
  ])
})

test('the sync workflow runs when a pin changes', async () => {
  const workflow = await readFile(`${root}.github/workflows/download-mirror.yml`, 'utf8')
  for (const pin of [
    'extensions/*.source.json',
    'src-tauri/ocr-models.json',
    'src-tauri/texthook-manifest.json',
    'src-tauri/src/reader/yomitan_install.rs'
  ]) {
    assert.ok(workflow.includes(`'${pin}'`), pin)
  }
  const ci = await readFile(`${root}.github/workflows/ci.yml`, 'utf8')
  const job = ci.slice(ci.indexOf('\n  mirror:'), ci.indexOf('\n  announce:'))
  assert.match(job, /continue-on-error: true/, 'the mirror never fails a release')
  assert.match(job, /needs: \[plan, manifest\]/, 'after the release is published')
})

test("the mirror's release.json is GitHub's release document with the mirror's URLs", async () => {
  const files = [
    { name: 'Kimochi_1.2.0_x64-setup.exe', size: 10 },
    { name: 'Kimochi_1.2.0_aarch64.app.zip', size: 20 },
    { name: 'latest.json', size: 1 }
  ]
  const github = {
    tagName: 'v1.2.0',
    name: 'Kimochi v1.2.0',
    url: 'https://github.com/hamstu/kimochi/releases/tag/v1.2.0',
    publishedAt: '2026-11-20T00:00:00Z'
  }
  assert.deepEqual(releaseDocument('v1.2.0', files, github), {
    tag_name: 'v1.2.0',
    name: 'Kimochi v1.2.0',
    html_url: 'https://github.com/hamstu/kimochi/releases/tag/v1.2.0',
    published_at: '2026-11-20T00:00:00Z',
    assets: [
      {
        name: 'Kimochi_1.2.0_x64-setup.exe',
        size: 10,
        browser_download_url: 'https://downloads.kimochiapp.com/app/v1.2.0/Kimochi_1.2.0_x64-setup.exe'
      },
      {
        name: 'Kimochi_1.2.0_aarch64.app.zip',
        size: 20,
        browser_download_url: 'https://downloads.kimochiapp.com/app/v1.2.0/Kimochi_1.2.0_aarch64.app.zip'
      }
    ]
  })
  assert.throws(() => releaseDocument('v1.2.0', files, { ...github, tagName: 'v1.1.0' }), /not v1.2.0/)
  // The website and the Linux installer read it from the same place.
  const site = await readFile(`${root}site/src/lib/releases.ts`, 'utf8')
  assert.match(site, /MIRROR_RELEASE = 'https:\/\/downloads\.kimochiapp\.com\/app\/release\.json'/)
  const installer = await readFile(`${root}site/public/install.sh`, 'utf8')
  assert.match(installer, /KIMOCHI_INSTALL_MIRROR:-https:\/\/downloads\.kimochiapp\.com\/app\}/)
  const ci = await readFile(`${root}.github/workflows/ci.yml`, 'utf8')
  assert.match(ci, /--github \.\.\/mirror\/github-release\.json/)
})
