/**
 * Which art the guide's portrait uses: `files`, the faces the site ships (public/guide/*.webp, made
 * from Sutemo's "Anime Girl Sprite V2"); `sutemo`, a character put together live from that PSD's
 * layers (public/guide/sutemo/, with its manifest.json); or `original`, the first, AI-made faces
 * (public/guide/original/). Only the dev server offers the choice (dev/ArtSwitcher.tsx), kept per
 * browser; a production build always shows `files`.
 */
import { useSyncExternalStore } from 'react'
import type { Face } from './Guide'

export const SUTEMO = '/guide/sutemo'

export interface ArtConfig {
  art: 'files' | 'sutemo' | 'original'
  back: string
  front: string
  hair: string
  ahoge: boolean
  eyes: string
  costume: string
  accessories: string[]
  blush: string
  /** The expression shown for each of the guide's faces. */
  faces: Record<Face, string>
}

export const DEFAULT_ART: ArtConfig = {
  art: 'files',
  // What the shipped faces were made from.
  back: 'long-curl',
  front: 'long',
  hair: 'pink',
  ahoge: false,
  eyes: 'blue',
  costume: 'pe-uniform',
  accessories: ['band3'],
  blush: '1',
  faces: {
    happy: 'smile-2',
    excited: 'delighted',
    surprised: 'shocked',
    thinking: 'o',
    wink: 'laugh',
    sad: 'sad',
    proud: 'smug'
  }
}

const KEY = 'kd-guide-art'
const SHIPPED: ArtConfig = DEFAULT_ART

function read(): ArtConfig {
  if (!import.meta.env.DEV) return SHIPPED
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ArtConfig> | null
    return saved
      ? {
          ...DEFAULT_ART,
          ...saved,
          faces: { ...DEFAULT_ART.faces, ...saved.faces }
        }
      : DEFAULT_ART
  } catch {
    return DEFAULT_ART
  }
}

let state: ArtConfig | null = null
const listeners = new Set<() => void>()

export function getArt(): ArtConfig {
  state ??= typeof window === 'undefined' ? SHIPPED : read()
  return state
}

export function setArt(next: Partial<ArtConfig>): void {
  state = { ...getArt(), ...next }
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* per-browser nicety only */
  }
  for (const l of listeners) l()
}

export function useArt(): ArtConfig {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getArt,
    () => SHIPPED
  )
}

/** The layer images, bottom to top, for one expression. */
export function layers(c: ArtConfig, expression: string): string[] {
  const src = (p: string): string => `${SUTEMO}/${p}.webp`
  return [
    src(`back/${c.back}/${c.hair}`),
    src('body'),
    ...(c.blush ? [src(`blush/${c.blush}`)] : []),
    src(`costume/${c.costume}`),
    src(`front/${c.front}/${c.hair}`),
    src(`expression/${expression}/${c.eyes}`),
    ...c.accessories.map((a) => src(`accessory/${a}`)),
    ...(c.ahoge ? [src(`ahoge/${c.hair}`)] : [])
  ]
}
