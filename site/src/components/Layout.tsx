import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Menu, X } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { AccountNavLink } from './AccountNavLink'
import { DiscordMark, GithubMark } from './PlatformMarks'
import { LINUX_GUIDE_PATH } from '../lib/linux.js'
import { DOCS_URL } from '../lib/docs.js'

export const GITHUB_URL = 'https://github.com/hamstu/kimochi-tauri'
/** Kimochi's Discord server (an invite that doesn't expire). */
export const DISCORD_URL = 'https://discord.gg/vdMge6TBZQ'

/**
 * The home page's sections, in the order they appear there (Home.tsx): the header nav and the
 * footer's first column. Each links to a section id on the home page.
 */
export const NAV_LINKS: { label: string; to: string }[] = [
  { label: 'Demo', to: '/#demo' },
  { label: 'Features', to: '/#features' },
  { label: 'How it works', to: '/#how' },
  { label: 'Pricing', to: '/#open-source' },
  { label: 'About', to: '/#about' },
  { label: 'FAQ', to: '/#faq' },
  { label: 'Download', to: '/#download' }
]

/** The footer's second column: the site's other pages (and the docs, on their own subdomain). */
const MORE_LINKS: { label: string; to: string }[] = [
  { label: 'Documentation', to: DOCS_URL },
  { label: 'All questions', to: '/faq' },
  { label: 'Compare', to: '/compare' },
  { label: 'Linux install guide', to: LINUX_GUIDE_PATH },
  { label: 'Your account', to: '/account' },
  { label: 'Discord', to: DISCORD_URL },
  { label: 'Source on GitHub', to: GITHUB_URL }
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

const footerIconClass =
  'grid size-8 place-items-center rounded-md text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink'

const footerLinkClass = 'text-ink-2 no-underline transition-colors duration-100 hover:text-ink'

/** One titled list of footer links. */
function FooterColumn({ title, links }: { title: string; links: { label: string; to: string }[] }) {
  return (
    <nav aria-label={title}>
      <p className="text-meta tracking-[0.08em] text-ink-3 uppercase">{title}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {links.map((l) => (
          <li key={l.to}>
            {l.to.startsWith('/') ? (
              <Link to={l.to} className={footerLinkClass}>
                {l.label}
              </Link>
            ) : (
              <a href={l.to} className={footerLinkClass}>
                {l.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
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
          <nav aria-label="Primary" className="ml-auto hidden items-center gap-0.5 lg:flex">
            {NAV_LINKS.map((l) => (
              <Link key={l.to} to={l.to} className={navLinkClass}>
                {l.label}
              </Link>
            ))}
            <a href={DOCS_URL} className={navLinkClass}>
              Docs
            </a>
            <AccountNavLink className={navLinkClass} />
          </nav>
          <div className="ml-auto flex items-center gap-2 lg:ml-2">
            <ThemeToggle />
            <button
              type="button"
              className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover lg:hidden"
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
          <nav id="mobile-nav" aria-label="Mobile" className="border-t border-hairline lg:hidden">
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
              <a href={DOCS_URL} className={`${navLinkClass} -mx-2.5 py-2.5`}>
                Docs
              </a>
              <AccountNavLink className={`${navLinkClass} -mx-2.5 py-2.5`} onClick={() => setOpen(false)} />
            </div>
          </nav>
        )}
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-hairline bg-bar text-small">
        <div className="container-page grid gap-10 py-12 md:grid-cols-[1fr_auto_auto] md:gap-16">
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-3 text-ink-3">Read your games in Japanese. Free and open source, for macOS, Windows and Linux.</p>
            <div className="mt-4 flex items-center gap-1">
              <a href={DISCORD_URL} aria-label="Kimochi on Discord" title="Discord" className={footerIconClass}>
                <DiscordMark className="size-[18px]" />
              </a>
              <a href={GITHUB_URL} aria-label="Kimochi on GitHub" title="GitHub" className={footerIconClass}>
                <GithubMark className="size-[18px]" />
              </a>
            </div>
          </div>
          <FooterColumn title="Kimochi" links={NAV_LINKS} />
          <FooterColumn title="More" links={MORE_LINKS} />
        </div>
        <div className="border-t border-hairline">
          <div className="container-page flex flex-col gap-3 py-5 text-ink-3 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Made with{' '}
              <span role="img" aria-label="love" className="mx-0.5">
                ❤️
              </span>{' '}
              in Canada{' '}
              <span role="img" aria-label="Canadian flag" className="ml-0.5">
                🇨🇦
              </span>
            </p>
            <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Link to="/privacy" className={footerLinkClass}>
                Privacy
              </Link>
              <Link to="/terms" className={footerLinkClass}>
                Terms
              </Link>
              <span className="tnum">© {new Date().getFullYear()} Kimochi</span>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  )
}
