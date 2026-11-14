/**
 * An account's picture, or the first letter of its name when it has none (or the picture will not
 * load); the Local profile (no account) shows its picture if it has been given one, else a plain
 * person. Used by the sidebar's account switcher and Settings → Account.
 */
import { useState, type JSX } from 'react'
import { UserRound } from 'lucide-react'
import { accountInitial, type AccountUser } from '@ui/account'
import './account-avatar.css'

export function AccountAvatar({
  user,
  local,
  className
}: {
  user?: AccountUser | null
  /** The Local profile (no account): neutral, a plain person unless `user` has a picture. */
  local?: boolean
  className?: string
}): JSX.Element {
  // The picture that would not load (gone, or offline): the initial stands in until it changes.
  const [failed, setFailed] = useState<string | null>(null)
  const url = user?.avatarUrl?.trim() || null
  return (
    <span
      className={`k-account-avatar${local ? ' k-account-avatar-local' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden
    >
      {url && url !== failed ? (
        <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(url)} />
      ) : local ? (
        <UserRound />
      ) : (
        accountInitial(user)
      )}
    </span>
  )
}
