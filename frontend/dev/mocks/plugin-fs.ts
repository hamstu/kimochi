/* eslint-disable @typescript-eslint/no-unused-vars -- signatures mirror the real plugin */
/**
 * DEV-ONLY stand-in for `@tauri-apps/plugin-fs` (aliased by `vite.preview.config.ts`).
 *
 * An in-memory filesystem: every base directory shares one namespace keyed by the relative path,
 * which is all the texthooker core modules need. `frontend/dev/demo-data.ts` seeds it before the
 * app entry is imported.
 */
export { BaseDirectory } from '@tauri-apps/api/path'

type Data = string | Uint8Array

interface BaseDirOption {
  baseDir?: number
}
export type WriteFileOptions = BaseDirOption & { append?: boolean; create?: boolean }
export type ReadFileOptions = BaseDirOption
export type ExistsOptions = BaseDirOption
export type MkdirOptions = BaseDirOption & { recursive?: boolean }
export type RemoveOptions = BaseDirOption & { recursive?: boolean }
export type RenameOptions = { oldPathBaseDir?: number; newPathBaseDir?: number }
export type ReadDirOptions = BaseDirOption
export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

const files = new Map<string, Data>()
const dirs = new Set<string>([''])

const norm = (path: string | URL): string =>
  String(path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')

function addParents(path: string): void {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Direct access for the seeder and for debugging from the console (`__previewFs`). */
export const previewFs = {
  files,
  dirs,
  put(path: string, data: Data): void {
    const p = norm(path)
    addParents(p)
    files.set(p, data)
  },
  dump(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of files) out[k] = typeof v === 'string' ? v : `<${v.byteLength} bytes>`
    return out
  }
}
;(globalThis as Record<string, unknown>).__previewFs = previewFs

const missing = (path: string): string => `failed to open file at path: ${path} (No such file or directory)`

export async function exists(path: string | URL, _options?: ExistsOptions): Promise<boolean> {
  const p = norm(path)
  return files.has(p) || dirs.has(p)
}

export async function mkdir(path: string | URL, _options?: MkdirOptions): Promise<void> {
  const p = norm(path)
  addParents(p)
  dirs.add(p)
}

export async function readTextFile(path: string | URL, _options?: ReadFileOptions): Promise<string> {
  const p = norm(path)
  const data = files.get(p)
  if (data === undefined) throw missing(p)
  return typeof data === 'string' ? data : decoder.decode(data)
}

export async function readFile(
  path: string | URL,
  _options?: ReadFileOptions
): Promise<Uint8Array<ArrayBuffer>> {
  const p = norm(path)
  const data = files.get(p)
  if (data === undefined) throw missing(p)
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

export async function writeTextFile(
  path: string | URL,
  data: string,
  options?: WriteFileOptions
): Promise<void> {
  const p = norm(path)
  addParents(p)
  const prior = options?.append ? await readTextFile(p).catch(() => '') : ''
  files.set(p, prior + data)
}

export async function writeFile(
  path: string | URL,
  data: Uint8Array | ReadableStream<Uint8Array>,
  _options?: WriteFileOptions
): Promise<void> {
  const p = norm(path)
  addParents(p)
  if (data instanceof Uint8Array) {
    files.set(p, data.slice())
    return
  }
  const chunks: Uint8Array[] = []
  const reader = data.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  files.set(p, out)
}

export async function rename(
  oldPath: string | URL,
  newPath: string | URL,
  _options?: RenameOptions
): Promise<void> {
  const from = norm(oldPath)
  const to = norm(newPath)
  const data = files.get(from)
  if (data === undefined) throw missing(from)
  files.delete(from)
  addParents(to)
  files.set(to, data)
}

export async function remove(path: string | URL, _options?: RemoveOptions): Promise<void> {
  const p = norm(path)
  files.delete(p)
  dirs.delete(p)
  const prefix = `${p}/`
  for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k)
  for (const k of [...dirs]) if (k.startsWith(prefix)) dirs.delete(k)
}

export async function readDir(path: string | URL, _options?: ReadDirOptions): Promise<DirEntry[]> {
  const p = norm(path)
  const prefix = p ? `${p}/` : ''
  const names = new Map<string, boolean>()
  for (const k of files.keys())
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      names.set(k.slice(prefix.length), false)
  for (const k of dirs)
    if (k && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      names.set(k.slice(prefix.length), true)
  return [...names].map(([name, isDirectory]) => ({
    name,
    isDirectory,
    isFile: !isDirectory,
    isSymlink: false
  }))
}

export async function copyFile(from: string | URL, to: string | URL): Promise<void> {
  const data = files.get(norm(from))
  if (data === undefined) throw missing(norm(from))
  previewFs.put(norm(to), data)
}

export async function size(path: string | URL): Promise<number> {
  const data = files.get(norm(path))
  if (data === undefined) throw missing(norm(path))
  return typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength
}

export async function watch(): Promise<() => void> {
  return () => undefined
}
export const watchImmediate = watch
