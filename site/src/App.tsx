import { useEffect } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { Privacy } from './pages/Privacy'
import { Terms } from './pages/Terms'
import { Compare } from './pages/Compare'
import { NotFound } from './pages/NotFound'

/** Per-route document titles. Add an entry when you add a route. */
const TITLES: Record<string, string> = {
  '/': 'Kimochi',
  '/privacy': 'Privacy · Kimochi',
  '/terms': 'Terms · Kimochi',
  '/compare': 'Compare · Kimochi'
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
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="terms" element={<Terms />} />
        <Route path="compare" element={<Compare />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
