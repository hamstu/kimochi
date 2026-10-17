import { NavLink } from 'react-router'
import { useSession } from '../lib/session'

/**
 * Header link to the account pages: "Account" when signed in, "Sign in" otherwise. Renders
 * nothing while the session is loading so the header doesn't flicker between the two.
 */
export function AccountNavLink({ className, onClick }: { className: string; onClick?: () => void }) {
  const { status } = useSession()
  if (status === 'loading') return null
  const signedIn = status === 'signed-in'
  return (
    <NavLink
      to={signedIn ? '/account' : '/account/sign-in'}
      onClick={onClick}
      className={({ isActive }) => `${className} ${isActive ? 'text-ink' : ''}`}
    >
      {signedIn ? 'Account' : 'Sign in'}
    </NavLink>
  )
}
