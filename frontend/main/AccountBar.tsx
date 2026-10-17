/**
 * The sidebar's account switcher, between the update notice and Settings: who Kimochi is being used
 * as (an account's avatar or initial, name and email; or "Local", not signed in). Clicking opens a
 * menu of the accounts signed in to on this computer, the active one checked, with Add account…,
 * Account settings and Sign out. Each account has its own Log, notebook and preferences, so
 * choosing one switches everything (native reloads the windows once it is in place). It follows
 * `account-changed`, and shows a dot when Sync needs attention (offline, an error, conflicts).
 */
import { useState, type JSX } from 'react'
import { ChevronsUpDown, LogOut, Settings2, UserPlus } from 'lucide-react'
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
import { accountLines, activeAccount, type AccountSummary } from '@ui/account'
import { accountLinkStart, accountSignOut, accountSwitch, useAccount } from '../bridge/account'
import { useSync } from '../bridge/sync'
import { AccountAvatar } from '../components/AccountAvatar'

const LOCAL = 'local'

function detail(account: AccountSummary): string | undefined {
  const parts = [account.server?.mode === 'local' ? 'Local server' : null, account.signedIn ? null : 'Signed out']
  const text = parts.filter(Boolean).join(' · ')
  return text || undefined
}

export function AccountBar({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const account = useAccount()
  const sync = useSync()
  const [busy, setBusy] = useState(false)
  const accounts = account.accounts ?? []
  const active = activeAccount(account)
  const { primary, secondary } = active
    ? accountLines(active.user)
    : { primary: 'Local', secondary: accounts.length ? 'Not signed in' : 'Sign in to sync' }
  const attention =
    active && (sync.state === 'error' || sync.state === 'offline' || sync.conflicts.length > 0 || !active.signedIn)
  const label = `Account: ${secondary ? `${primary}, ${secondary}` : primary}`

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
    <div className="sb-account">
      <Menu>
        <MenuTrigger asChild disabled={busy || account.switching}>
          <Row
            className="sb-account-row"
            icon={<AccountAvatar user={active?.user} local={!active} className="sb-account-avatar" />}
            trailing={
              <span className="sb-account-trailing">
                {attention && <StatusDot tone={sync.state === 'error' || !active?.signedIn ? 'danger' : 'warn'} />}
                <ChevronsUpDown className="sb-account-chevron" />
              </span>
            }
            aria-label={label}
            title={secondary ? `${primary}\n${secondary}` : primary}
          >
            <span className="sb-account-name">{primary}</span>
            {secondary && <span className="sb-account-email">{secondary}</span>}
          </Row>
        </MenuTrigger>
        <MenuContent side="top" align="start" className="sb-account-menu">
          <MenuLabel>Use Kimochi as</MenuLabel>
          <MenuRadioGroup value={active?.key ?? LOCAL} onValueChange={choose}>
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
          <MenuItem icon={<Settings2 />} onSelect={onOpen}>
            Account settings
          </MenuItem>
          {active?.signedIn && (
            <MenuItem icon={<LogOut />} onSelect={() => run(() => accountSignOut(active.key))}>
              Sign out
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
    </div>
  )
}
