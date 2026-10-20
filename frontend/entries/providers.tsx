/**
 * The provider stack every Kimochi window uses: the shared appearance controller (theme and
 * interface scale from settings) around a Radix Themes root with the slate + indigo scales, and
 * the window's click sounds.
 */
import { type JSX, type ReactNode } from 'react'
import { AppearanceProvider } from '@kit/appearance'
import { useInteractionSounds } from '../shell/useInteractionSounds'

export default function Providers({
  children,
  transparent = false
}: {
  children: ReactNode
  transparent?: boolean
}): JSX.Element {
  useInteractionSounds()
  return <AppearanceProvider transparent={transparent}>{children}</AppearanceProvider>
}
