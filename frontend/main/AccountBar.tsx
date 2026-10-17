/**
 * The sidebar's account bar, between the update notice and Settings: who is signed in to Kimochi
 * (their avatar, or the first letter of their name, with their name and email), opening Settings →
 * Account. Nothing shows while signed out; it follows `account-changed`, so it appears and goes as
 * the person signs in and out.
 */
import { useState, type JSX } from 'react'
import { Row } from '@kit'
import { accountInitial, accountLines } from '@ui/account'
import { useAccount } from '../bridge/account'

function Avatar({ url, initial }: { url: string | null; initial: string }): JSX.Element {
  // The picture that would not load (gone, or offline): the initial stands in until it changes.
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <span className="sb-account-avatar" aria-hidden>
      {url && url !== failed ? (
        <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(url)} />
      ) : (
        initial
      )}
    </span>
  )
}

export function AccountBar({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const account = useAccount()
  if (!account.signedIn || !account.user) return null
  const { user } = account
  const { primary, secondary } = accountLines(user)
  return (
    <div className="sb-account">
      <Row
        className="sb-account-row"
        icon={<Avatar url={user.avatarUrl?.trim() || null} initial={accountInitial(user)} />}
        aria-label={`Kimochi account: ${secondary ? `${primary}, ${secondary}` : primary}`}
        title={secondary ? `${primary}\n${secondary}` : primary}
        onClick={onOpen}
      >
        <span className="sb-account-name">{primary}</span>
        {secondary && <span className="sb-account-email">{secondary}</span>}
      </Row>
    </div>
  )
}
