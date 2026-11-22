import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const prelude = await readFile(new URL('../src-tauri/src/text_hook/agent/prelude.js', import.meta.url), 'utf8')
function host(platform, root, files) {
  const context = vm.createContext({
    __kimochi: { dir: root, mission: `${root}/game.js`, maxChars: 2000 },
    Process: { platform, arch: 'arm64' },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    send() {},
    recv() {},
    File: class {
      constructor(path) {
        if (!files.has(path)) throw Error('not found')
      }
      close() {}
      static readAllText(path) {
        if (!files.has(path)) throw Error('not found')
        return files.get(path)
      }
    }
  })
  vm.runInContext(prelude, context)
  let key = 0
  return (func, args) => {
    let result
    const id = String(++key)
    context.__kimochi.send({ cmd: 'eval', key: id, func, args })
    context.__kimochi
      .recv(id, (reply) => {
        result = reply.result
      })
      .wait()
    return result
  }
}

test('native Agent files use POSIX paths with case-sensitive collection confinement', () => {
  const ask = host(
    'darwin',
    '/scripts/Collection',
    new Map([
      ['/scripts/Collection/game.js', 'hello'],
      ['/scripts/collection/secret.js', 'outside'],
      ['/scripts/Collection/libCitra.js', "const e = Process.findModuleByName('libcitra-android.so');"]
    ])
  )
  assert.equal(ask('path_dirname', ['/scripts/Collection/game.js']), '/scripts/Collection')
  assert.equal(ask('path_dirname', ['/game.js']), '/')
  assert.equal(ask('fs_readFileSync', ['./game.js']), 'hello')
  assert.equal(ask('fs_readFileSync', ['../collection/secret.js']), null)
  assert.equal(ask('fs_readFileSync', ['/scripts/collection/secret.js']), null)
  assert.equal(ask('fs_readFileSync', ['libCitra.js']), 'const e = Process.mainModule;')
})

test('Wine keeps Windows paths and the original emulator library', () => {
  const source = "const e = Process.findModuleByName('libcitra-android.so');"
  const ask = host('windows', 'Z:\\Scripts', new Map([['Z:\\Scripts\\libCitra.js', source]]))
  assert.equal(ask('fs_readFileSync', ['./libCitra.js']), source)
  assert.equal(ask('path_dirname', ['Z:\\Scripts\\game.js']), 'Z:\\Scripts')
  assert.equal(ask('fs_readFileSync', ['..\\private.js']), null)
})

test('the Switch ARM64 overlay resolves macOS libc++ symbols without altering other modules', () => {
  const source = "addresses = [__e.getExportByName('_ZN6KernelNSt6__ndk14spanTest')];"
  const ask = host(
    'darwin',
    '/scripts',
    new Map([
      ['/scripts/libYuzu.js', source],
      ['/scripts/game.js', source]
    ])
  )
  assert.equal(
    ask('fs_readFileSync', ['libYuzu.js']),
    "addresses = DebugSymbol.findFunctionsNamed('_ZN6KernelNSt3__14spanTest');"
  )
  assert.equal(ask('fs_readFileSync', ['game.js']), source)
})
