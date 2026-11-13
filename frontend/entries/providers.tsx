/**
 * The provider stack every Kimochi window uses: the shared appearance controller (theme and
 * interface scale from settings) around a Radix Themes root with the slate + indigo scales, and
 * the window's click sounds, and the learner's text set in the language being read's fonts.
 */
import { type JSX, type ReactNode } from 'react'
import { AppearanceProvider } from '@kit/appearance'
import { useInteractionSounds } from '../shell/useInteractionSounds'
import { useTextFont } from '../bridge/useTextLang'

export default function Providers({
  children,
  transparent = false
}: {
  children: ReactNode
  transparent?: boolean
}): JSX.Element {
  useInteractionSounds()
  // The learner's text in the language being read's fonts (`--k-font-text`).
  useTextFont()
  return <AppearanceProvider transparent={transparent}>{children}</AppearanceProvider>
}
