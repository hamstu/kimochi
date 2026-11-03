/**
 * How the Text Hooker's card is placed on the game, per game (`textHookerGames`, read by
 * ui/overlay.js): aligned with the game's text by OCR (Auto align), or where the reader put it.
 */
import { updateHookGame, useHookDefaults, useHookSettings, withSetting } from './hookGames'

/**
 * Auto align for the hooked game: whether it is on, and the switch. Null with no game. The switch
 * changes this game's own setting (Settings → Text Hooker → the game), and the same value as the
 * default is no change, so the game follows the default again. The reader's own place for the
 * card is kept apart from Auto align's, so turning it off puts the card back where they left it.
 */
export function useHookPlacement(exe: string | null | undefined): { on: boolean; toggle: () => void } | null {
  const { autoAlign: on } = useHookSettings(exe)
  const [defaults] = useHookDefaults()
  if (!exe) return null
  const toggle = (): void => {
    void updateHookGame(exe, (game) => {
      const next = withSetting(game, 'autoAlign', !on, defaults)
      if (on) return next
      // Back on, it aligns afresh: what it learned before (and the reader's text size, which
      // replaced it) is forgotten. The reader's own place stays, for when they turn it off again.
      for (const learned of ['text', 'leading', 'ocrBox', 'surface'] as const) delete next[learned]
      return next
    })
  }
  return { on, toggle }
}
