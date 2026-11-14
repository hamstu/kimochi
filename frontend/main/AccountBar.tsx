/**
 * The sidebar's account switcher, the foot of the sidebar for everyone (Mini mode keeps the plain
 * Settings row, MainSidebar): one row, the account in use (Default too, the profile Kimochi starts
 * with) with its avatar (or initial) and name (or the email before "@"), and the language's code.
 * Clicking opens a menu of the accounts on this computer, the active one checked, the language
 * being learned (it opens Settings → Language), Manage accounts (Settings → Account, which a failed
 * switch opens too) and Settings. Each account has its own Log, notebook and preferences, so
 * choosing one switches everything (native reloads the windows once it is in place). It follows
 * `account-changed`, and shows a dot when a Kimochi account's Sync needs attention (offline, an
 * error, conflicts, signed out).
 */
import { useState, type JSX } from 'react'
import { ChevronsUpDown, Cloud, Globe, Laptop, Settings, UserCog } from 'lucide-react'
import {
  Badge,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Row,
  StatusDot
} from '@kit'
import { accountBarName, activeAccount, localProfileName, localProfileUser } from '@ui/account'
import { accountSwitch, useAccount } from '../bridge/account'
import { useSync } from '../bridge/sync'
import { useLanguage } from '../bridge/useLanguage'
import { AccountAvatar } from '../components/AccountAvatar'

const LOCAL = 'local'

/** The right of an account's row: Local or Cloud, with its icon (a Kimochi account signed out says so). */
function Kind({ local, signedOut }: { local: boolean; signedOut?: boolean }): JSX.Element {
  return (
    <span className="sb-account-kind">
      {local ? <Laptop /> : <Cloud />}
      {local ? 'Local' : signedOut ? 'Signed out' : 'Cloud'}
    </span>
  )
}

export function AccountBar({
  onOpen,
  onLanguage,
  onSettings
}: {
  /** Settings → Account. */
  onOpen: () => void
  /** Settings → Language. */
  onLanguage: () => void
  /** Settings, on the page it was last on. */
  onSettings: () => void
}): JSX.Element {
  const account = useAccount()
  const sync = useSync()
  const [language] = useLanguage()
  const [busy, setBusy] = useState(false)
  const accounts = account.accounts ?? []
  // No account in use is the Default profile, shown like any account.
  const active = activeAccount(account)
  const user = active ? active.user : localProfileUser(account)
  const name = active ? accountBarName(active.user) : localProfileName(account)
  const email = user?.email?.trim() || null
  const cloud = active?.kind === 'cloud'
  const signedOut = cloud && !active?.signedIn
  // A local account never syncs, so only a Kimochi account's Sync can need attention.
  const attention =
    cloud && (sync.state === 'error' || sync.state === 'offline' || sync.conflicts.length > 0 || signedOut)
  const label = `Account: ${email && email !== name ? `${name}, ${email}` : name}. Language: ${language.name}`

  const run = (work: () => Promise<unknown>): void => {
    setBusy(true)
    work()
      .catch((error: unknown) => {
        console.error('[account] switch failed', error)
        onOpen()
      })
      .finally(() => setBusy(false))
  }
  const choose = (value: string): void => {
    const key = value === LOCAL ? null : value
    if (key === (active?.key ?? null)) return
    run(() => accountSwitch(key))
  }

  return (
    <Menu>
      <MenuTrigger asChild disabled={busy || account.switching}>
        <Row
          className="sb-account-row"
          icon={<AccountAvatar user={user} local={!active} className="sb-account-avatar" />}
          trailing={
            <span className="sb-account-trailing">
              {attention && <StatusDot tone={sync.state === 'error' || signedOut ? 'danger' : 'warn'} />}
              <Badge className="sb-account-language">{language.code.split('-')[0].toUpperCase()}</Badge>
              <ChevronsUpDown className="sb-account-chevron" />
            </span>
          }
          aria-label={label}
          title={email && email !== name ? `${name}\n${email}` : name}
        >
          <span className="sb-account-name">{name}</span>
        </Row>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="sb-account-menu">
        <MenuLabel>Accounts</MenuLabel>
        <MenuRadioGroup value={active?.key ?? LOCAL} onValueChange={choose}>
          {accounts.map((a) => (
            <MenuRadioItem
              key={a.key}
              value={a.key}
              disabled={!a.available}
              icon={<AccountAvatar user={a.user} className="sb-account-menu-avatar" />}
              detail={<Kind local={a.kind === 'local'} signedOut={a.kind === 'cloud' && !a.signedIn} />}
              title={a.user?.email ?? undefined}
            >
              {accountBarName(a.user)}
            </MenuRadioItem>
          ))}
          <MenuRadioItem
            value={LOCAL}
            icon={<AccountAvatar user={localProfileUser(account)} local className="sb-account-menu-avatar" />}
            detail={<Kind local />}
          >
            {localProfileName(account)}
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<Globe />} onSelect={onLanguage}>
          Language: {language.name}
        </MenuItem>
        <MenuItem icon={<UserCog />} onSelect={onOpen}>
          Manage accounts
        </MenuItem>
        <MenuItem icon={<Settings />} onSelect={onSettings}>
          Settings
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
