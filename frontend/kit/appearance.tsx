/** Theme root for every Kimochi window; state lives in `appearance-state.ts`. */
import { useEffect, type ReactNode } from 'react'
import { Theme } from '@radix-ui/themes'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { NATIVE_BACKGROUND, applyToDocument, usePrefs, writeCache } from './appearance-state'

/**
 * Theme root for a window. `transparent` windows (dictionary popups, onboarding) keep their own
 * see-through ground and never repaint the native window background.
 */
export function AppearanceProvider({
  children,
  transparent = false
}: {
  children: ReactNode
  transparent?: boolean
}): ReactNode {
  const { appearance, interfaceScale, resolved } = usePrefs()

  useEffect(() => {
    applyToDocument(resolved, interfaceScale)
    writeCache({ appearance, interfaceScale })
  }, [appearance, interfaceScale, resolved])

  useEffect(() => {
    if (transparent) return
    try {
      void getCurrentWindow()
        .setBackgroundColor(NATIVE_BACKGROUND[resolved])
        .catch(() => undefined)
    } catch {
      /* Not inside Tauri (preview harness). */
    }
  }, [resolved, transparent])

  return (
    <Theme
      appearance={resolved}
      accentColor="indigo"
      grayColor="slate"
      radius="medium"
      panelBackground="solid"
      hasBackground={!transparent}
      style={transparent ? { background: 'transparent' } : undefined}
    >
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        {children}
      </TooltipProvider>
    </Theme>
  )
}
