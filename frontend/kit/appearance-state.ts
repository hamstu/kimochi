/**
 * Appearance controller for every Kimochi window: light / dark / system theme and the interface
 * scale, read from the shared settings store so a change in one window reaches all of them.
 *
 * The last applied values are mirrored to localStorage (all windows share the `tauri://localhost`
 * origin) and applied synchronously at import time, so a window opens in the right theme and size
 * instead of flashing the default before the settings round trip returns.
 */
import { useEffect, useState } from 'react'
import { getSetting, onSettingsChange } from '../bridge/settings'
import {
  INTERFACE_SCALES,
  type Appearance,
  type InterfaceScale
} from '@ui/settings'

export type ResolvedAppearance = 'light' | 'dark'

const CACHE_KEY = 'kimochi.appearance.v1'
const media = window.matchMedia('(prefers-color-scheme: dark)')

interface Prefs {
  appearance: Appearance
  interfaceScale: InterfaceScale
}

function readCache(): Prefs {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>
      return {
        appearance: parsed.appearance ?? 'system',
        interfaceScale: parsed.interfaceScale ?? 'medium'
      }
    }
  } catch {
    /* Storage can be unavailable; defaults apply. */
  }
  return { appearance: 'system', interfaceScale: 'medium' }
}

export function writeCache(prefs: Prefs): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(prefs))
  } catch {
    /* Non-essential. */
  }
}

export const resolveAppearance = (appearance: Appearance): ResolvedAppearance =>
  appearance === 'system' ? (media.matches ? 'dark' : 'light') : appearance

export const scaleFactor = (scale: InterfaceScale): number => INTERFACE_SCALES[scale]?.factor ?? 1

export function applyToDocument(resolved: ResolvedAppearance, scale: InterfaceScale): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  const factor = scaleFactor(scale)
  root.style.fontSize = `${16 * factor}px`
  root.style.setProperty('--ui-scale', String(factor))
  root.dataset.scale = scale
}

// Apply the cached preferences before React renders anything.
const boot = readCache()
applyToDocument(resolveAppearance(boot.appearance), boot.interfaceScale)

/** Window background colours matching `--color-background` for slate in each appearance. */
export const NATIVE_BACKGROUND: Record<ResolvedAppearance, [number, number, number, number]> = {
  light: [255, 255, 255, 255],
  dark: [17, 17, 19, 255]
}

export function usePrefs(): Prefs & { resolved: ResolvedAppearance } {
  const [prefs, setPrefs] = useState<Prefs>(boot)
  const [systemDark, setSystemDark] = useState(media.matches)

  useEffect(() => {
    let active = true
    Promise.all([
      getSetting<Appearance>('appearance', 'system'),
      getSetting<InterfaceScale>('interfaceScale', 'medium')
    ])
      .then(([appearance, interfaceScale]) => {
        if (active) setPrefs({ appearance, interfaceScale })
      })
      .catch(() => undefined)
    const off = onSettingsChange((key, value) => {
      if (key === 'appearance' && typeof value === 'string')
        setPrefs((current) => ({ ...current, appearance: value as Appearance }))
      if (key === 'interfaceScale' && typeof value === 'string')
        setPrefs((current) => ({ ...current, interfaceScale: value as InterfaceScale }))
    })
    const onMedia = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', onMedia)
    return () => {
      active = false
      off()
      media.removeEventListener('change', onMedia)
    }
  }, [])

  const resolved: ResolvedAppearance =
    prefs.appearance === 'system' ? (systemDark ? 'dark' : 'light') : prefs.appearance
  return { ...prefs, resolved }
}

