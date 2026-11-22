import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src-tauri/src/text_hook/agent/prelude.js', import.meta.url), 'utf8')
function host(platform, dir, files) {
  const lines = []
  const context = vm.createContext({
    __kimochi: { dir, mission: '', maxChars: 2000 },
    Process: { platform, arch: 'x64' },
    console: { error: (line) => lines.push(line) },
    send() {},
    recv() {},
    File: class {
      constructor(path) {
        if (!files.has(path)) throw Error('missing')
      }
      close() {}
      static readAllText(path) {
        if (!files.has(path)) throw Error('missing')
        return files.get(path)
      }
    }
  })
  vm.runInContext(source, context)
  const ask = (func, args) => {
    let result
    context.__kimochi.send({ cmd: 'eval', key: 'request', func, args })
    context.__kimochi
      .recv('request', (reply) => {
        result = reply.result
      })
      .wait()
    return result
  }
  return { ask, lines, context }
}

test('Linux Agent reads POSIX paths and confines reads to the case-sensitive collection', () => {
  const { ask } = host(
    'linux',
    '/scripts/Collection',
    new Map([
      ['/scripts/Collection/game.js', 'game'],
      ['/scripts/collection/secret.js', 'secret']
    ])
  )
  assert.equal(ask('fs_readFileSync', ['./game.js']), 'game')
  assert.equal(ask('path_dirname', ['/game.js']), '/')
  assert.equal(ask('fs_readFileSync', ['../collection/secret.js']), null)
  assert.equal(ask('fs_readFileSync', ['/scripts/collection/secret.js']), null)
  assert.equal(ask('fs_writeFileSync', ['game.js', 'changed']), false)
})

test('Wine paths and CJK events still work after adding the native Linux host', () => {
  const { ask, context, lines } = host('windows', 'Z:\\Scripts', new Map([['Z:\\Scripts\\game.js', 'game']]))
  assert.equal(ask('fs_readFileSync', ['./game.js']), 'game')
  assert.equal(ask('fs_readFileSync', ['..\\private.js']), null)
  const text = '日本語・𠮷・🎮'
  context.__kimochi.send({ cmd: 'copy', text })
  assert.ok([...lines[0]].every((character) => character.charCodeAt(0) <= 127))
  assert.deepEqual(JSON.parse(lines[0].slice(3)), { cmd: 'copy', text })
})
