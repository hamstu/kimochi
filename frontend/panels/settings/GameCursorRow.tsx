/**
 * Settings → Overlay → "Keep the mouse cursor visible in games" (src-tauri/src/game_cursor.rs,
 * Windows): many games hide the system cursor, so you cannot see where the pointer is for a
 * hover lookup. The row says when the hook could not be loaded into the selected game.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { SettingsRow, Switch } from '@kit'
import { useSetting } from '../../bridge/useSetting'

interface GameCursorStatus {
  supported: boolean
  active: number | null
  error: string | null
}

export function GameCursorRow(): ReactNode {
  const [enabled, setEnabled] = useSetting<boolean>('showGameCursor', false)
  const [status, setStatus] = useState<GameCursorStatus | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      invoke<GameCursorStatus>('game_cursor_status')
        .then((next) => live && setStatus(next))
        .catch(() => undefined)
    }
    read()
    // The native side follows the selected window once a second.
    const timer = enabled ? window.setInterval(read, 2000) : undefined
    return () => {
      live = false
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [enabled])
  if (status && !status.supported) return null
  const description =
    enabled && status?.error
      ? status.error
      : 'For games that hide the pointer even while it moves: loads a small helper into the selected game window. Avoid it with online games that use anti-cheat.'
  return (
    <SettingsRow label="Keep the mouse cursor visible in games" controlId="game-cursor" description={description}>
      <Switch id="game-cursor" checked={enabled} onCheckedChange={(checked) => void setEnabled(checked)} />
    </SettingsRow>
  )
}
