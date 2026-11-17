/**
 * The mark beside a locked Auto align switch (Settings → Text Hooker → Card style, and the
 * sidebar's Auto align under Show overlay): with the Text Hooker card's look Transparent, Auto
 * align stays on (ui/settings.ts `hookCardLocksAutoAlign`), and pointing at the eye says why.
 */
import type { ReactNode } from 'react'
import { EyeOff } from 'lucide-react'
import { Tooltip } from '@kit'
import './align-lock-mark.css'

const ALIGN_LOCK_NOTE =
  "The card's look is Transparent, so Auto align stays on: it keeps the hidden card over the game's own text, where you point to look words up. Choose another Card look to turn it off."

export function AlignLockMark({ className }: { className?: string }): ReactNode {
  return (
    <Tooltip content={<p className="align-lock-note">{ALIGN_LOCK_NOTE}</p>} side="bottom" delayDuration={150}>
      <button
        type="button"
        className={className ? `align-lock-mark ${className}` : 'align-lock-mark'}
        aria-label="Why Auto align is on"
      >
        <EyeOff aria-hidden />
      </button>
    </Tooltip>
  )
}
