/**
 * ADAPTED from `src/renderer/src/hooks/useSetting.ts`.
 * Deltas: `window.settings.get/set/onChange` -> the Tauri settings client. Semantics are unchanged:
 * load once on mount, live updates from other windows, optimistic local set, revert on failure, and
 * the "don't clobber my own write" guard.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSetting, onSettingsChange, setSetting } from './settings'

export function useSetting<T>(key: string, defaultValue: T): [T, (value: T) => Promise<void>] {
  const [value, setValue] = useState<T>(defaultValue)
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
        if (mounted) setValue(loaded !== undefined && loaded !== null ? loaded : defaultValueRef.current)
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
        newValue !== undefined && newValue !== null ? (newValue as T) : defaultValueRef.current
      )
    })
  }, [key])

  const setSettingValue = useCallback(
    async (newValue: T): Promise<void> => {
      try {
        isSettingRef.current = true
        setValue(newValue)
        await setSetting(key, newValue)
      } catch (error) {
        console.error(`Failed to save setting "${key}":`, error)
        const current = await getSetting<T>(key, defaultValueRef.current).catch(
          () => defaultValueRef.current
        )
        setValue(current !== undefined && current !== null ? current : defaultValueRef.current)
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
