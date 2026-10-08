/**
 * ADAPTED from `src/renderer/src/hooks/useSetting.ts`.
 * Deltas: `window.settings.get/set/onChange` -> the Tauri settings client. Semantics are unchanged:
 * load once on mount, live updates from other windows, optimistic local set, revert on failure, and
 * the "don't clobber my own write" guard.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSetting, onSettingsChange, setSetting } from './settings'

/**
 * The last value seen for each key in this window, from a load, a write or another window's
 * change. A hook mounting later starts from it instead of its default, so a view that opens
 * after the value is known (Settings → OCR & Overlay, after the sidebar loaded `ocrMode`) renders
 * the real value on its first frame rather than the default for one frame and the real one next.
 */
const known = new Map<string, unknown>()

function remember<T>(key: string, value: T): T {
  known.set(key, value)
  return value
}

export function useSetting<T>(key: string, defaultValue: T): [T, (value: T) => Promise<void>] {
  const [value, setValue] = useState<T>(() => (known.has(key) ? (known.get(key) as T) : defaultValue))
  const defaultValueRef = useRef<T>(defaultValue)
  const isSettingRef = useRef(false)

  // The original assigned this during render; doing it in an effect is equivalent here (the load
  // effect below runs after this one) and keeps the ref out of the render pass.
  useEffect(() => {
    defaultValueRef.current = defaultValue
  })

  useEffect(() => {
    let mounted = true
    getSetting<T>(key, defaultValueRef.current)
      .then((loaded) => {
        if (mounted)
          setValue(
            remember(key, loaded !== undefined && loaded !== null ? loaded : defaultValueRef.current)
          )
      })
      .catch((error) => {
        console.error(`Failed to load setting "${key}":`, error)
        if (mounted) setValue(defaultValueRef.current)
      })
    return () => {
      mounted = false
    }
  }, [key])

  useEffect(() => {
    return onSettingsChange((changedKey, newValue) => {
      if (changedKey !== key || isSettingRef.current) return
      setValue(
        remember(
          key,
          newValue !== undefined && newValue !== null ? (newValue as T) : defaultValueRef.current
        )
      )
    })
  }, [key])

  const setSettingValue = useCallback(
    async (newValue: T): Promise<void> => {
      try {
        isSettingRef.current = true
        setValue(remember(key, newValue))
        await setSetting(key, newValue)
      } catch (error) {
        console.error(`Failed to save setting "${key}":`, error)
        const current = await getSetting<T>(key, defaultValueRef.current).catch(
          () => defaultValueRef.current
        )
        setValue(
          remember(key, current !== undefined && current !== null ? current : defaultValueRef.current)
        )
      } finally {
        setTimeout(() => {
          isSettingRef.current = false
        }, 100)
      }
    },
    [key]
  )

  return [value, setSettingValue]
}
