/**
 * The provider stack every Kimochi window uses, matching `src/renderer/src/windows/panel/panel.tsx`
 * and `windows/overlay/overlay.tsx`: next-themes writing a class, Radix Themes with the indigo
 * accent. Keeping this identical is what makes the copied components look the same.
 */
import { type JSX, type ReactNode } from 'react'
import { ThemeProvider } from 'next-themes'
import { Theme } from '@radix-ui/themes'

export default function Providers({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider attribute="class" forcedTheme="system">
      <Theme accentColor="indigo">{children}</Theme>
    </ThemeProvider>
  )
}
