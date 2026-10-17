import { useEffect } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { Privacy } from './pages/Privacy'
import { Terms } from './pages/Terms'
import { Compare } from './pages/Compare'
import { NotFound } from './pages/NotFound'
import { Account } from './pages/Account'
import { AccountSignIn } from './pages/AccountSignIn'
import { AccountSignUp } from './pages/AccountSignUp'
import { AccountForgot } from './pages/AccountForgot'
import { AccountReset } from './pages/AccountReset'
import { AccountVerify } from './pages/AccountVerify'
import { LinkApp } from './pages/LinkApp'
import { SessionProvider } from './lib/session'

/** Per-route document titles. Add an entry when you add a route. */
const TITLES: Record<string, string> = {
  '/': 'Kimochi',
  '/privacy': 'Privacy · Kimochi',
  '/terms': 'Terms · Kimochi',
  '/compare': 'Compare · Kimochi',
  '/account': 'Account · Kimochi',
  '/account/sign-in': 'Sign in · Kimochi',
  '/account/sign-up': 'Create an account · Kimochi',
  '/account/forgot': 'Reset password · Kimochi',
  '/account/reset': 'Choose a new password · Kimochi',
  '/account/verify': 'Confirm email · Kimochi',
  '/link': 'Sign in to Kimochi · Kimochi'
}

function useDocumentTitle() {
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = TITLES[pathname.replace(/\/+$/, '') || '/'] ?? 'Not found · Kimochi'
  }, [pathname])
}

export function App() {
  useDocumentTitle()
  return (
    <SessionProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="terms" element={<Terms />} />
          <Route path="compare" element={<Compare />} />
          <Route path="account" element={<Account />} />
          <Route path="account/sign-in" element={<AccountSignIn />} />
          <Route path="account/sign-up" element={<AccountSignUp />} />
          <Route path="account/forgot" element={<AccountForgot />} />
          <Route path="account/reset" element={<AccountReset />} />
          <Route path="account/verify" element={<AccountVerify />} />
          <Route path="link" element={<LinkApp />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  )
}
