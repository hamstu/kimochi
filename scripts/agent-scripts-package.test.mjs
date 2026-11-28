import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { archiveUrls, indexPath, normaliseId, parseHeader, scriptEntry } from './agent-scripts-package.mjs'

const script = (lines) => ['// ==UserScript==', ...lines.map((l) => `// ${l}`), '// ==/UserScript==', 'x()'].join('\n')

test('a header is read up to its closing line, first value of each key', () => {
  const { header } = parseHeader(
    script(['@name         [01001DC01486A000] 月姫', '@version      1.0.1, 1.0.2', '@name second'])
  )
  assert.equal(header.name, '[01001DC01486A000] 月姫')
  assert.equal(header.version, '1.0.1, 1.0.2')
  assert.deepEqual(parseHeader('no header').header, {})
})

test('console scripts are matched by title id or serial, from the name and the file name', () => {
  const ns = scriptEntry(
    'NS_0100A3A00CC7E000_CLANNAD_JP.js',
    script(['@name [0100A3A00CC7E000] CLANNAD', '@author [DC]'])
  )
  assert.deepEqual(ns, {
    file: 'NS_0100A3A00CC7E000_CLANNAD_JP.js',
    title: 'CLANNAD',
    platform: 'switch',
    ids: ['0100A3A00CC7E000'],
    lang: 'ja',
    author: 'DC'
  })
  const ps2 = scriptEntry('PS2_SLPM65732_Akai_Ito.js', script(['@name [SLPM-65732] Akai Ito']))
  assert.deepEqual(ps2.ids, ['SLPM65732'])
  assert.equal(ps2.platform, 'ps2')
  const vita = scriptEntry('PSVita_Amagami.js', script(['@name         [PCSG00291] Amagami']))
  assert.deepEqual([vita.platform, vita.ids, vita.title], ['vita', ['PCSG00291'], 'Amagami'])
  const three = scriptEntry('3DS_Japan_Exstetra.js', script(['@name [00040000000C3A00] Exstetra (Japan)']))
  assert.deepEqual(three.ids, ['00040000000C3A00'])
})

test('PC scripts carry their Steam store ids; loaders and libraries are not game scripts', () => {
  const air = scriptEntry(
    'PC_Steam_Air.js',
    script(['@name         AIR', '@description  Steam', '', 'https://store.steampowered.com/app/2983250/AIR/'])
  )
  assert.deepEqual([air.platform, air.steam, air.title, air.ids], ['pc', [2983250], 'AIR', undefined])
  assert.equal(scriptEntry('PC_AIO.js', script(['@name AIO'])).generic, true)
  assert.equal(scriptEntry('libYuzu.js', script(['@name Yuzu JIT'])), null)
  assert.equal(scriptEntry('charsets/table.js', script(['@name x'])), null)
  assert.equal(scriptEntry('translate.html', ''), null)
  assert.equal(scriptEntry('PC_NoHeader.js', 'x()'), null)
  assert.equal(normaliseId('slpm_657.32'), 'SLPM65732')
})

test('multi-disc PSP serials match each disc separately', () => {
  const entry = scriptEntry(
    'PSP_ULJM06302-3_Seishun_Hajimemashita.js',
    script(['@name [ULJM06302-3] Seishun Hajimemashita!'])
  )
  assert.deepEqual(entry.ids, ['ULJM06302', 'ULJM06303'])
  assert.equal(entry.title, 'Seishun Hajimemashita!')
})

test('the committed index pins every file and lists only game scripts that exist in it', async () => {
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  assert.match(index.commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(index.archive.urls, archiveUrls(index.commit))
  assert.ok(index.archive.size > 0)
  const files = new Map(index.files.map(([name, size, sha]) => [name, { size, sha }]))
  for (const [name, { size, sha }] of files) {
    assert.ok(!name.startsWith('/') && !name.includes('..') && !name.includes('\\'), name)
    assert.ok(size >= 0)
    assert.match(sha, /^[0-9a-f]{64}$/)
  }
  // The runtime the engine injects, and the libraries the emulator scripts need.
  for (const name of ['libLoader.js', 'libYuzu.js', 'libPPSSPP.js', 'libPCSX2.js', 'libVita3k.js', 'LICENSE'])
    assert.ok(files.has(name), name)
  assert.ok(index.scripts.length > 400)
  for (const s of index.scripts) {
    assert.ok(files.has(s.file), s.file)
    assert.ok(['switch', 'psp', 'ps2', 'ps3', 'vita', '3ds', 'pc', 'pc98', 'android'].includes(s.platform))
    if (s.platform === 'switch')
      assert.ok(
        s.ids?.every((id) => /^[0-9A-F]{16}$/.test(id)),
        s.file
      )
  }
})
