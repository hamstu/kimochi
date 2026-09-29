/**
 * The provider stack every Kimochi window uses: the shared appearance controller (theme and
 * interface scale from settings) around a Radix Themes root with the slate + indigo scales.
 */
import { type JSX, type ReactNode } from 'react'
import { AppearanceProvider } from '@kit/appearance'

export default function Providers({
  children,
  transparent = false
}: {
  children: ReactNode
  transparent?: boolean
}): JSX.Element {
  return <AppearanceProvider transparent={transparent}>{children}</AppearanceProvider>
}
