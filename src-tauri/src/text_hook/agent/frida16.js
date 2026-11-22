// The Frida 16 API the collection's scripts were written against, on Frida 17 (which moved these
// static helpers onto Module objects): looked up per call, so a module loaded later is found.
;(function () {
  'use strict'
  const define = (target, name, value) => {
    if (typeof target[name] !== 'function') {
      Object.defineProperty(target, name, { value, writable: true, configurable: true })
    }
  }
  const moduleOf = (name) => (name === null || name === undefined ? null : Process.findModuleByName(name))
  define(Module, 'findExportByName', (name, symbol) => {
    if (name === null || name === undefined) return Module.findGlobalExportByName(symbol)
    const module = moduleOf(name)
    return module === null ? null : module.findExportByName(symbol)
  })
  define(Module, 'getExportByName', (name, symbol) => {
    const found = Module.findExportByName(name, symbol)
    if (found === null) throw new Error(`unable to find export '${symbol}'`)
    return found
  })
  define(Module, 'findBaseAddress', (name) => moduleOf(name)?.base ?? null)
  define(Module, 'getBaseAddress', (name) => Process.getModuleByName(name).base)
  define(Module, 'findSymbolByName', (name, symbol) => {
    if (name === null || name === undefined) {
      const found = DebugSymbol.fromName(symbol)
      return found.address.isNull() ? null : found.address
    }
    return moduleOf(name)?.findSymbolByName(symbol) ?? null
  })
  define(Module, 'getSymbolByName', (name, symbol) => {
    const found = Module.findSymbolByName(name, symbol)
    if (found === null) throw new Error(`unable to find symbol '${symbol}'`)
    return found
  })
  define(Module, 'ensureInitialized', (name) => Process.getModuleByName(name).ensureInitialized())
  for (const list of ['enumerateExports', 'enumerateImports', 'enumerateSymbols', 'enumerateRanges']) {
    define(Module, list, (name, ...rest) => Process.getModuleByName(name)[list](...rest))
  }
  // Memory.readU8(address) and the rest: the NativePointer methods, as functions.
  for (const name of Object.getOwnPropertyNames(NativePointer.prototype)) {
    if (/^(read|write)[A-Z]/.test(name)) define(Memory, name, (address, ...rest) => ptr(address)[name](...rest))
  }
})()
