import { useEffect } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { Privacy } from './pages/Privacy'
import { Terms } from './pages/Terms'
import { Compare } from './pages/Compare'
import { Faq } from './pages/Faq'
import { DownloadLinux } from './pages/DownloadLinux'
import { NotFound } from './pages/NotFound'
import { Account } from './pages/Account'
import { AccountSignIn } from './pages/AccountSignIn'
import { AccountSignUp } from './pages/AccountSignUp'
import { AccountForgot } from './pages/AccountForgot'
import { AccountReset } from './pages/AccountReset'
import { AccountVerify } from './pages/AccountVerify'
import { AccountAdmin } from './pages/AccountAdmin'
import { LinkApp } from './pages/LinkApp'
import { SessionProvider } from './lib/session'
import { canonicalUrl, routeMeta } from './lib/seo.js'

/**
 * Keep the head in step on client-side navigation. Prerendered pages already ship these tags
 * (scripts/prerender.mjs); routes and their titles live in src/lib/seo.js.
 */
function useDocumentHead() {
  const { pathname } = useLocation()
  useEffect(() => {
    const route = routeMeta(pathname)
    document.title = route.title
    setHeadTag('meta[name="description"]', 'meta', { name: 'description', content: route.description })
    setHeadTag('meta[name="robots"]', 'meta', route.index ? null : { name: 'robots', content: 'noindex' })
    setHeadTag('link[rel="canonical"]', 'link', route.index ? { rel: 'canonical', href: canonicalUrl(route.path) } : null)
  }, [pathname])
}

/** Create, update or (with null) remove one head element. */
function setHeadTag(selector: string, tag: 'meta' | 'link', attrs: Record<string, string> | null) {
  let el = document.head.querySelector(selector)
  if (!attrs) return el?.remove()
  if (!el) el = document.head.appendChild(document.createElement(tag))
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
}

export function App() {
  useDocumentHead()
  return (
    <SessionProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="terms" element={<Terms />} />
          <Route path="faq" element={<Faq />} />
          <Route path="compare" element={<Compare />} />
          <Route path="download/linux" element={<DownloadLinux />} />
          <Route path="account" element={<Account />} />
          <Route path="account/sign-in" element={<AccountSignIn />} />
          <Route path="account/sign-up" element={<AccountSignUp />} />
          <Route path="account/forgot" element={<AccountForgot />} />
          <Route path="account/reset" element={<AccountReset />} />
          <Route path="account/verify" element={<AccountVerify />} />
          <Route path="account/admin" element={<AccountAdmin />} />
          <Route path="link" element={<LinkApp />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  )
}
