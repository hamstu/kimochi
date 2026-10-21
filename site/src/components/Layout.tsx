import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { Menu, X } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { AccountNavLink } from './AccountNavLink'

// TODO(hamish): private repo, so this and the Source on GitHub links 404 for visitors.
export const GITHUB_URL = 'https://github.com/hamstu/kimochi-tauri'

/** Header nav. Hash links target sections on the home page (Section id="features" etc.). */
export const NAV_LINKS: { label: string; to: string }[] = [
  { label: 'Features', to: '/#features' },
  { label: 'Demo', to: '/#demo' },
  { label: 'Compare', to: '/compare' },
  { label: 'Download', to: '/#download' }
]

/** Scroll to the hash target after navigation, or to the top on a plain route change. */
function useScrollOnNavigate() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (hash) {
      const id = decodeURIComponent(hash.slice(1))
      // Wait a frame so the target page has rendered.
      const raf = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView())
      return () => cancelAnimationFrame(raf)
    }
    window.scrollTo(0, 0)
  }, [pathname, hash])
}

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-ink no-underline" aria-label="Kimochi home">
      <img src="/favicon.svg" alt="" width={22} height={22} className="rounded-[5px]" />
      <span className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Kimochi</span>
    </Link>
  )
}

const navLinkClass =
  'rounded-md px-2.5 py-1.5 text-small font-medium text-ink-2 no-underline transition-colors duration-100 hover:bg-hover hover:text-ink'

export function Layout() {
  useScrollOnNavigate()
  const [open, setOpen] = useState(false)

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:shadow-pop"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-hairline bg-ground/85 backdrop-blur-md supports-[not(backdrop-filter:blur(0))]:bg-ground">
        <div className="container-page flex h-[var(--k-header-h)] items-center gap-4">
          <Wordmark />
          <nav aria-label="Primary" className="ml-auto hidden items-center gap-0.5 md:flex">
            {NAV_LINKS.map((l) =>
              l.to.includes('#') ? (
                <Link key={l.to} to={l.to} className={navLinkClass}>
                  {l.label}
                </Link>
              ) : (
                <NavLink
                  key={l.to}
                  to={l.to}
                  className={({ isActive }) => `${navLinkClass} ${isActive ? 'text-ink' : ''}`}
                >
                  {l.label}
                </NavLink>
              )
            )}
            <AccountNavLink className={navLinkClass} />
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-2">
            <ThemeToggle />
            <button
              type="button"
              className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover md:hidden"
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="mobile-nav"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
            </button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label="Mobile" className="border-t border-hairline md:hidden">
            <div className="container-page flex flex-col py-2">
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  onClick={() => setOpen(false)}
                  className={`${navLinkClass} -mx-2.5 py-2.5`}
                >
                  {l.label}
                </Link>
              ))}
              <AccountNavLink className={`${navLinkClass} -mx-2.5 py-2.5`} onClick={() => setOpen(false)} />
            </div>
          </nav>
        )}
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-hairline bg-bar">
        <div className="container-page flex flex-col gap-4 py-8 text-small text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
            <Link to="/faq" className="no-underline hover:text-ink">
              FAQ
            </Link>
            <Link to="/compare" className="no-underline hover:text-ink">
              Compare
            </Link>
            <Link to="/privacy" className="no-underline hover:text-ink">
              Privacy
            </Link>
            <Link to="/terms" className="no-underline hover:text-ink">
              Terms
            </Link>
            <a href={GITHUB_URL} className="no-underline hover:text-ink">
              Source on GitHub
            </a>
          </nav>
          <p className="text-ink-3 tnum">© {new Date().getFullYear()} Kimochi</p>
        </div>
      </footer>
    </div>
  )
}
