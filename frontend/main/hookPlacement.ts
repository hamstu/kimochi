/**
 * How the Text Hooker's card is placed on the game, per game (`textHookerGames`, read by
 * ui/overlay.js): aligned with the game's text by OCR (Auto align), or where the reader put it.
 */
import { updateHookGame, useHookCardLocksAutoAlign, useHookDefaults, useHookSettings, withSetting } from './hookGames'

/**
 * Auto align for the hooked game: whether it is on, and the switch. Null with no game. The switch
 * changes this game's own setting (Settings → Text Hooker → the game), and the same value as the
 * default is no change, so the game follows the default again. The reader's own place for the
 * card is kept apart from Auto align's, so turning it off puts the card back where they left it.
 */
export function useHookPlacement(
  exe: string | null | undefined
): { on: boolean; locked: boolean; toggle: () => void } | null {
  const { autoAlign } = useHookSettings(exe)
  const [defaults] = useHookDefaults()
  // A Transparent card is always auto-aligned (ui/settings.ts `hookCardLocksAutoAlign`).
  const locked = useHookCardLocksAutoAlign()
  const on = locked || autoAlign
  if (!exe) return null
  const toggle = (): void => {
    if (locked) return
    void updateHookGame(exe, (game) => {
      const next = withSetting(game, 'autoAlign', !on, defaults)
      if (on) return next
      // Back on, it goes straight back to where it last found the game's text (`ocrBox`) and
      // measures the text again: the reader's text size, which replaced the measured one, goes, and
      // the overlay reads the screen at once. The reader's own place stays, for when they turn it
      // off again.
      for (const learned of ['text', 'leading'] as const) delete next[learned]
      return next
    })
  }
  return { on, locked, toggle }
}
