import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { BookOpen, ChevronDown } from 'lucide-react'
import { AppleMark, LinuxMark, WindowsMark } from './PlatformMarks'
import {
  RELEASES_URL,
  assetLabel,
  classifyAsset,
  detectPlatform,
  detectPlatformSync,
  fetchLatestRelease,
  formatBytes,
  osLabel,
  pickAsset,
  type Platform,
  versionLabel,
  type Release
} from '../lib/releases'
import { LINUX_GUIDE_PATH, primaryDownloadHref } from '../lib/linux.js'

export interface DownloadButtonProps {
  /** Alignment of the button and the lines under it. Default "start". */
  align?: 'start' | 'center'
  className?: string
}

function archLabel(p: Platform): string {
  if (p.os === 'macos') return p.arch === 'x64' ? 'Intel' : 'Apple silicon'
  if (p.arch === 'arm64') return 'ARM64'
  if (p.arch === 'x64') return 'x64'
  return ''
}

function OsMark({ os, className }: { os: Platform['os']; className: string }) {
  if (os === 'macos') return <AppleMark className={className} />
  if (os === 'windows') return <WindowsMark className={className} />
  if (os === 'linux') return <LinuxMark className={className} />
  return null
}

const OTHER_OSES = ['macos', 'windows', 'linux'] as const

/**
 * The download button: the visitor's OS mark, "Download Kimochi" and the version, linking to the
 * installer for their OS and CPU, with every other installer one click away in the chevron's menu.
 * The release is resolved at runtime from GitHub (the nightly development build until the first
 * tagged release). Without one (none published yet, or GitHub unreachable) the button and the menu
 * go to the releases page, and nothing explains why. On Linux the button goes to the install guide
 * (/download/linux) instead of a file, because the right way to install depends on the system;
 * the menu still lists every file, plus a "Linux install guide" item.
 */
export function DownloadButton({ align = 'start', className = '' }: DownloadButtonProps) {
  const [platform, setPlatform] = useState<Platform>(detectPlatformSync)
  const [release, setRelease] = useState<Release | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    detectPlatform().then((p) => alive && setPlatform(p))
    const ctrl = new AbortController()
    fetchLatestRelease(ctrl.signal)
      .then((r) => alive && setRelease(r))
      .catch(() => undefined)
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const asset = release ? pickAsset(release.assets, platform) : null
  const installers = release ? release.assets.filter((a) => classifyAsset(a.name)) : []
  const href = primaryDownloadHref(platform.os, asset?.browser_download_url, release?.url ?? RELEASES_URL)
  const toGuide = href === LINUX_GUIDE_PATH
  const arch = archLabel(platform)
  const center = align === 'center'
  const mainClass =
    'inline-flex h-14 items-center gap-3 rounded-l-xl pr-5 pl-6 text-[1.0625rem] font-semibold no-underline transition-colors duration-100 hover:bg-white/10'
  const mainContent = (
    <>
      <OsMark os={platform.os} className="size-5" />
      <span>Download Kimochi</span>
      {release && (
        <span className="rounded-md bg-white/15 px-1.5 py-0.5 text-[0.8125rem] font-medium tnum">
          {versionLabel(release)}
        </span>
      )}
    </>
  )
  const menuItemClass = 'flex items-center gap-3 px-3.5 py-2 text-small text-ink no-underline hover:bg-hover'

  return (
    <div className={`flex flex-col gap-3 ${center ? 'items-center text-center' : 'items-start'} ${className}`}>
      <div
        ref={wrapRef}
        className="relative inline-flex rounded-xl bg-accent text-accent-contrast shadow-[0_8px_24px_-8px_color-mix(in_oklab,var(--k-accent)_60%,transparent)]"
      >
        {toGuide ? (
          <Link to={href} className={mainClass}>
            {mainContent}
          </Link>
        ) : (
          <a href={href} className={mainClass}>
            {mainContent}
          </a>
        )}
        <button
          type="button"
          aria-label="Other platforms"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center rounded-r-xl border-l border-white/20 px-3 transition-colors duration-100 hover:bg-white/10"
        >
          <ChevronDown
            size={16}
            aria-hidden
            className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div className="absolute top-full right-0 z-50 mt-2 min-w-[17rem] overflow-hidden rounded-lg border border-hairline bg-raised text-left shadow-pop">
            {installers.length > 0 ? (
              <ul className="py-1">
                {installers.map((a) => (
                  <li key={a.name}>
                    <a
                      href={a.browser_download_url}
                      onClick={() => setOpen(false)}
                      className="flex items-center justify-between gap-4 px-3.5 py-2 text-small text-ink no-underline hover:bg-hover"
                    >
                      <span className="min-w-0 truncate">{assetLabel(a.name)}</span>
                      <span className="shrink-0 text-meta text-ink-3 tnum">{formatBytes(a.size)}</span>
                    </a>
                  </li>
                ))}
                <li className="mt-1 border-t border-hairline pt-1">
                  <Link to={LINUX_GUIDE_PATH} onClick={() => setOpen(false)} className={menuItemClass}>
                    <BookOpen size={16} aria-hidden className="text-ink-3" />
                    Linux install guide
                  </Link>
                </li>
              </ul>
            ) : (
              <ul className="py-1">
                {OTHER_OSES.map((os) => {
                  const itemClass = `${menuItemClass} ${os === platform.os ? 'font-semibold' : ''}`
                  const label = (
                    <>
                      <span className="text-ink-3">
                        <OsMark os={os} className="size-4" />
                      </span>
                      Download for {osLabel(os)}
                    </>
                  )
                  return (
                    <li key={os}>
                      {/* Linux has several ways to install: the guide explains them. */}
                      {os === 'linux' ? (
                        <Link to={LINUX_GUIDE_PATH} onClick={() => setOpen(false)} className={itemClass}>
                          {label}
                        </Link>
                      ) : (
                        <a href={RELEASES_URL} onClick={() => setOpen(false)} className={itemClass}>
                          {label}
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>
      <p className="text-small text-ink-3 tnum">
        {toGuide ? (
          <>
            {osLabel(platform.os)}
            {arch ? ` (${arch})` : ''} · Steam Deck too ·{' '}
          </>
        ) : (
          asset && (
            <>
              {osLabel(platform.os)}
              {arch ? ` (${arch})` : ''} · {formatBytes(asset.size)} ·{' '}
            </>
          )
        )}
        <a
          href={release?.url ?? RELEASES_URL}
          className="text-ink-3 underline decoration-hairline underline-offset-4 hover:text-ink-2 hover:decoration-current"
        >
          Release notes
        </a>
      </p>
    </div>
  )
}
