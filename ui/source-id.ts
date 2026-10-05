/**
 * Reading a source id, the JavaScript mirror of `capture-core/src/ids.rs`.
 *
 * Ids are minted natively and are opaque on the wire: this module only *reads*
 * them, for the few decisions that depend on what kind of source is selected.
 * Nothing in the overlay may build one by concatenating a platform name.
 *
 *     {platform}:display:{handle}
 *     {platform}:window:{handle}[:{pid}]
 */

export type SourcePlatform = 'macos' | 'windows' | 'x11' | 'portal'
export type SourceKind = 'display' | 'window'

export interface ParsedSourceId {
  platform: SourcePlatform
  kind: SourceKind
  /** A string: handles are pointer-sized on Windows and must not pass through a number. */
  handle: string
  /** The owning process of a window, when the id carries one. */
  pid: number | null
}

const PLATFORMS = new Set<string>(['macos', 'windows', 'x11', 'portal'])

/** The parts of `id`, or null for anything that is not a well-formed id (never "a display"). */
export function parseSourceId(id: unknown): ParsedSourceId | null {
  if (typeof id !== 'string') return null
  // `splitn(4, ':')`: anything after the third colon belongs to the pid.
  const parts = id.split(':')
  const [platform, kind, handle] = parts
  const rest = parts.length > 3 ? parts.slice(3).join(':') : undefined
  if (!PLATFORMS.has(platform) || !handle) return null
  if (kind === 'display') {
    if (rest !== undefined) return null
    return { platform: platform as SourcePlatform, kind, handle, pid: null }
  }
  if (kind === 'window') {
    let pid: number | null = null
    if (rest !== undefined) {
      // Rust parses a u32: digits only, in range.
      if (!/^\+?\d+$/.test(rest)) return null
      pid = Number(rest)
      if (!Number.isSafeInteger(pid) || pid > 0xffffffff) return null
    }
    return { platform: platform as SourcePlatform, kind, handle, pid }
  }
  return null
}

/** Whether `id` names a window (as opposed to a display, or nothing recognisable). */
export const isWindowSourceId = (id: unknown): boolean => parseSourceId(id)?.kind === 'window'

/** Whether `id` names a display. */
export const isDisplaySourceId = (id: unknown): boolean => parseSourceId(id)?.kind === 'display'
