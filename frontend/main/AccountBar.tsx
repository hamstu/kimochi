/**
 * The sidebar's account switcher, in the foot of the sidebar in place of the Settings row while an
 * account is in use: one row, the account's avatar (or initial) and name (or the email before
 * "@"). Clicking opens a menu of the accounts signed in to on this computer, the active one
 * checked, with Add account…, Settings, Account settings and Sign out. Each account has its own
 * Log, notebook and preferences, so choosing one switches everything (native reloads the windows
 * once it is in place). Without an account in use the sidebar shows the plain Settings row instead
 * (MainSidebar). It follows `account-changed`, and shows a dot when Sync needs attention
 * (offline, an error, conflicts).
 */
import { useState, type JSX } from 'react'
import { ChevronsUpDown, LogOut, Settings, UserCog, UserPlus } from 'lucide-react'
import {
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
import { accountBarName, accountLines, activeAccount, type AccountSummary } from '@ui/account'
import { accountLinkStart, accountSignOut, accountSwitch, useAccount } from '../bridge/account'
import { useSync } from '../bridge/sync'
import { AccountAvatar } from '../components/AccountAvatar'

const LOCAL = 'local'

function detail(account: AccountSummary): string | undefined {
  const parts = [account.server?.mode === 'local' ? 'Local server' : null, account.signedIn ? null : 'Signed out']
  const text = parts.filter(Boolean).join(' · ')
  return text || undefined
}

export function AccountBar({
  onOpen,
  onSettings
}: {
  /** Settings → Account. */
  onOpen: () => void
  /** Settings, on the page it was last on. */
  onSettings: () => void
}): JSX.Element | null {
  const account = useAccount()
  const sync = useSync()
  const [busy, setBusy] = useState(false)
  const accounts = account.accounts ?? []
  const active = activeAccount(account)
  if (!active) return null
  const name = accountBarName(active.user)
  const email = active.user?.email?.trim() || null
  const attention =
    sync.state === 'error' || sync.state === 'offline' || sync.conflicts.length > 0 || !active.signedIn
  const label = `Account: ${email && email !== name ? `${name}, ${email}` : name}`

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
    if (key === active.key) return
    run(() => accountSwitch(key))
  }

  return (
    <Menu>
      <MenuTrigger asChild disabled={busy || account.switching}>
        <Row
          className="sb-account-row"
          icon={<AccountAvatar user={active.user} className="sb-account-avatar" />}
          trailing={
            <span className="sb-account-trailing">
              {attention && <StatusDot tone={sync.state === 'error' || !active.signedIn ? 'danger' : 'warn'} />}
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
        <MenuLabel>Use Kimochi as</MenuLabel>
        <MenuRadioGroup value={active.key} onValueChange={choose}>
          {accounts.map((a) => {
            const lines = accountLines(a.user)
            return (
              <MenuRadioItem
                key={a.key}
                value={a.key}
                disabled={!a.available}
                icon={<AccountAvatar user={a.user} className="sb-account-menu-avatar" />}
                detail={detail(a)}
              >
                {lines.secondary ? `${lines.primary} (${lines.secondary})` : lines.primary}
              </MenuRadioItem>
            )
          })}
          <MenuRadioItem value={LOCAL} icon={<AccountAvatar local className="sb-account-menu-avatar" />} detail="Not signed in">
            Local
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem
          icon={<UserPlus />}
          onSelect={() => {
            onOpen()
            run(() => accountLinkStart())
          }}
        >
          Add account…
        </MenuItem>
        <MenuItem icon={<Settings />} onSelect={onSettings}>
          Settings
        </MenuItem>
        <MenuItem icon={<UserCog />} onSelect={onOpen}>
          Account settings
        </MenuItem>
        {active.signedIn && (
          <MenuItem icon={<LogOut />} onSelect={() => run(() => accountSignOut(active.key))}>
            Sign out
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  )
}
