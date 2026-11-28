import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const prelude = await readFile(new URL('../src-tauri/src/text_hook/agent/prelude.js', import.meta.url), 'utf8')
function host(platform, root, files, arch = 'arm64') {
  const context = vm.createContext({
    __kimochi: { dir: root, mission: `${root}/game.js`, maxChars: 2000 },
    Process: { platform, arch },
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

test('Windows UNC roots stay confined and keep their leading double backslash', () => {
  const ask = host(
    'windows',
    '\\\\nas\\share\\Scripts',
    new Map([
      ['\\\\nas\\share\\Scripts\\game.js', 'unc-game'],
      ['\\\\nas\\share\\Other\\secret.js', 'outside']
    ])
  )
  assert.equal(ask('fs_readFileSync', ['./game.js']), 'unc-game')
  assert.equal(ask('path_dirname', ['\\\\nas\\share\\Scripts\\game.js']), '\\\\nas\\share\\Scripts')
  assert.equal(ask('fs_readFileSync', ['..\\Other\\secret.js']), null)
  assert.equal(ask('fs_readFileSync', ['\\\\nas\\share\\Other\\secret.js']), null)
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

// On the native Unity 5 Mono runtime, Frida may enumerate an export that its named
// lookup misses. Exercise the loaded library, not just the replacement's spelling.
test('native Mono resolves an exact enumerated export when named lookup misses it', () => {
  const source = 'function resolve(name) { const address = _mod.findExportByName(name); return address; }'
  for (const arch of ['x64', 'arm64']) {
    const files = new Map([
      ['/scripts/libMono.js', source],
      ['/scripts/game.js', source]
    ])
    const ask = host('darwin', '/scripts', files, arch)
    const loaded = ask('fs_readFileSync', ['libMono.js'])
    let enumerated = 0
    const context = vm.createContext({
      _mod: {
        findExportByName: (name) => (name === 'present' ? 11 : null),
        enumerateExports: () => {
          enumerated++
          return [
            { name: 'mono_domain_get_extra', address: 22 },
            { name: 'mono_domain_get', address: 33 }
          ]
        }
      }
    })
    vm.runInContext(loaded, context)
    assert.equal(context.resolve('present'), 11)
    assert.equal(enumerated, 0)
    assert.equal(context.resolve('mono_domain_get'), 33)
    assert.equal(context.resolve('missing'), null)
    assert.equal(ask('fs_readFileSync', ['game.js']), source)
    assert.equal(files.get('/scripts/libMono.js'), source)
  }
  for (const platform of ['windows', 'linux']) {
    const ask = host(
      platform,
      platform === 'windows' ? 'C:/scripts' : '/scripts',
      new Map([[platform === 'windows' ? 'C:\\scripts\\libMono.js' : '/scripts/libMono.js', source]]),
      'x64'
    )
    assert.equal(ask('fs_readFileSync', ['libMono.js']), source)
  }
})

test('Gadget output uses flushed ASCII protocol lines without Unity stdout', () => {
  const writes = []
  let flushed = 0
  const context = vm.createContext({
    __kimochi: { dir: '/scripts', mission: '/scripts/game.js', maxChars: 2000, outputFile: '/private/events.jsonl' },
    Process: { platform: 'darwin', arch: 'x64' },
    console: {
      error() {
        throw Error('must not use Unity stderr')
      },
      log() {},
      info() {},
      warn() {},
      debug() {}
    },
    send() {},
    recv() {},
    File: class {
      constructor(path, mode) {
        assert.equal(path, '/private/events.jsonl')
        assert.equal(mode, 'a')
      }
      write(line) {
        writes.push(line)
      }
      flush() {
        flushed++
      }
    }
  })
  vm.runInContext(prelude, context)
  context.__kimochi.ready()
  context.__kimochi.send({ cmd: 'copy', text: '本当の台詞。' })
  assert.equal(flushed, 2)
  assert.ok(writes.every((line) => line.endsWith('\n') && [...line].every((c) => c.charCodeAt(0) < 128)))
  assert.deepEqual(
    writes.map((line) => JSON.parse(line.slice(3))),
    [{ cmd: 'ready' }, { cmd: 'copy', text: '本当の台詞。' }]
  )
})

test('Rosetta Gadget preserves writable Mono JIT ranges through attach and dispose', () => {
  const protectedRanges = []
  let pendingPatch = false
  let protection = 'rwx'
  let detached = 0
  const context = vm.createContext({
    __kimochi: { dir: '/scripts', mission: '/scripts/game.js', maxChars: 2000 },
    Process: { platform: 'darwin', arch: 'x64', findRangeByAddress: () => ({ base: 'jit', size: 65536, protection }) },
    console: { error() {}, log() {}, info() {}, warn() {}, debug() {} },
    send() {},
    recv() {},
    Memory: {
      protect(base, size, original) {
        protectedRanges.push([base, size, original])
        protection = original
        return true
      }
    },
    Interceptor: {
      attach() {
        pendingPatch = true
        return {
          detach() {
            detached++
            pendingPatch = true
          }
        }
      },
      flush() {
        if (pendingPatch) protection = 'r-x'
        pendingPatch = false
      }
    }
  })
  vm.runInContext(prelude, context)
  context.__kimochi.monoAttach('jit-method', {})
  assert.equal(protection, 'rwx', 'lazy JIT writes must remain possible after hook commit')
  context.__kimochi.dispose()
  assert.equal(detached, 1)
  assert.equal(protection, 'rwx', 'unloading must preserve the original writable allocation')
  assert.deepEqual(protectedRanges, [
    ['jit', 65536, 'rwx'],
    ['jit', 65536, 'rwx']
  ])
  context.__kimochi.dispose()
  assert.equal(detached, 1)
})

test('Mono hook wrapper never grants write access to originally read-only code', () => {
  let protectedCount = 0
  const context = vm.createContext({
    __kimochi: { dir: '/scripts', mission: '/scripts/game.js', maxChars: 2000 },
    Process: {
      platform: 'darwin',
      arch: 'x64',
      findRangeByAddress: () => ({ base: 'native', size: 4096, protection: 'r-x' })
    },
    console: { error() {}, log() {}, info() {}, warn() {}, debug() {} },
    send() {},
    recv() {},
    Memory: {
      protect() {
        protectedCount++
        return true
      }
    },
    Interceptor: {
      attach() {
        return { detach() {} }
      },
      flush() {}
    }
  })
  vm.runInContext(prelude, context)
  context.__kimochi.monoAttach('native-method', {}).detach()
  context.__kimochi.dispose()
  assert.equal(protectedCount, 0)
})

test('storage preserves structured values, null-prototype objects, and missing-key defaults', () => {
  const context = vm.createContext({
    __kimochi: { dir: 'C:\\scripts', mission: 'C:\\scripts\\game.js', maxChars: 2000 },
    Process: { platform: 'windows', arch: 'x64' },
    console: { error() {}, log() {}, info() {}, warn() {}, debug() {} },
    send() {},
    recv() {},
    File: class {}
  })
  vm.runInContext(prelude, context)
  let id = 0
  const call = (cmd, args) => {
    const key = String(++id)
    let result
    context.__kimochi.send({ cmd, args, key })
    context.__kimochi
      .recv(key, (reply) => {
        result = reply.result
      })
      .wait()
    return result
  }

  // libLoader always passes [key, defaultValue] — missing keys must return null, not undefined.
  assert.equal(call('sessionStorage_getItem', ['missing', undefined]), null)
  assert.equal(call('sessionStorage_getItem', ['missing', 'fallback']), 'fallback')
  assert.equal(call('sessionStorage_getItem', ['missing', false]), false)
  assert.equal(call('sessionStorage_getItem', ['missing', 0]), 0)

  // Emulator libraries (libPCSX2, libYuzu, libPPSSPP, etc.) store null-prototype maps, objects, booleans, and numbers.
  const nullProto = Object.assign(Object.create(null), { baseBlocksNew: '0x140001000', eeMem: '0x140002000' })
  call('sessionStorage_setItem', ['PCSX2_ADDRESSES', nullProto])
  assert.equal(call('sessionStorage_getItem', ['PCSX2_ADDRESSES', undefined]), nullProto)

  const initParams = { codeAddress: '123456', titleId: '0100A3A00CC7E000' }
  call('sessionStorage_setItem', ['Initialize_Params', initParams])
  assert.deepEqual(call('sessionStorage_getItem', ['Initialize_Params', undefined]), initParams)

  call('sessionStorage_setItem', ['NCE', true])
  assert.equal(call('sessionStorage_getItem', ['NCE', undefined]), true)

  call('sessionStorage_setItem', ['ASLR_Offset', 4096])
  assert.equal(call('sessionStorage_getItem', ['ASLR_Offset', undefined]), 4096)

  assert.deepEqual(Array.from(call('sessionStorage_keys', [])), [
    'PCSX2_ADDRESSES',
    'Initialize_Params',
    'NCE',
    'ASLR_Offset'
  ])
  assert.equal(call('sessionStorage_length', []), 4)
  assert.equal(call('sessionStorage_key', [1]), 'Initialize_Params')
  call('sessionStorage_removeItem', ['NCE'])
  assert.equal(call('sessionStorage_getItem', ['NCE', undefined]), null)
  call('sessionStorage_clear', [])
  assert.equal(call('sessionStorage_length', []), 0)
})
