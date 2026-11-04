/**
 * Gaming Mode: while Gamescope draws the game (or Steam) in front, the main window stays mapped
 * behind it, so WebKit calls it visible and keeps painting its animations (the preview's shimmer,
 * the Auto dot) at the display's rate for nobody. `gamescope-shown` (gamescope.rs `watch_shown`)
 * says whether Kimochi is in front; until it is again, `data-behind-game` on the root pauses every
 * animation (main.css).
 */
import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'

export function useBehindGame(gaming: boolean): void {
  useEffect(() => {
    if (!gaming) return
    const root = document.documentElement
    const stop = listen<boolean>('gamescope-shown', ({ payload }) =>
      root.toggleAttribute('data-behind-game', payload === false)
    )
    return () => {
      root.removeAttribute('data-behind-game')
      void stop.then((unlisten) => unlisten())
    }
  }, [gaming])
}
