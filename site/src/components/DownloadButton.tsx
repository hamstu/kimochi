import { useEffect, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { Button } from './Button'
import {
  RELEASES_URL,
  ReleaseFetchError,
  assetLabel,
  classifyAsset,
  detectPlatform,
  detectPlatformSync,
  fetchLatestRelease,
  formatBytes,
  osLabel,
  pickAsset,
  type Platform,
  type Release
} from '../lib/releases'

export interface DownloadButtonProps {
  /** Alignment of the button and its meta line. Default "start". */
  align?: 'start' | 'center'
  /** Show the "Other platforms" disclosure listing every installer. Default true. */
  showAll?: boolean
  className?: string
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; release: Release }
  | { status: 'error'; message: string }

function archLabel(p: Platform): string {
  if (p.os === 'macos') return p.arch === 'x64' ? 'Intel' : 'Apple silicon'
  if (p.arch === 'arm64') return 'ARM64'
  if (p.arch === 'x64') return 'x64'
  return ''
}

/**
 * How the release is named in the meta line: its tag ("v0.2.0"), or "Development build" plus the
 * build date for the rolling nightly pre-release.
 */
function releaseLabel(release: Release): string {
  if (release.channel !== 'nightly') return release.tag
  const date = release.publishedAt ? new Date(release.publishedAt) : null
  const when =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : ''
  return when ? `Development build · ${when}` : 'Development build'
}

/**
 * Resolves the latest GitHub release (or, before the first tagged release, the nightly
 * development build) at runtime and offers the installer for the visitor's OS
 * and CPU. Falls back to the GitHub releases page when the API is unreachable, rate-limited, or
 * there is no build for this platform.
 */
export function DownloadButton({ align = 'start', showAll = true, className = '' }: DownloadButtonProps) {
  const [platform, setPlatform] = useState<Platform>(detectPlatformSync)
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    detectPlatform().then((p) => alive && setPlatform(p))
    const ctrl = new AbortController()
    fetchLatestRelease(ctrl.signal)
      .then((release) => alive && setState({ status: 'ready', release }))
      .catch((err: unknown) => {
        if (!alive) return
        const kind = err instanceof ReleaseFetchError ? err.kind : 'network'
        const message =
          kind === 'rate-limited'
            ? 'GitHub is rate-limiting requests right now.'
            : kind === 'no-release'
              ? 'No build has been published yet.'
              : 'Could not reach GitHub.'
        setState({ status: 'error', message })
      })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [])

  const center = align === 'center'
  const wrap = `flex flex-col gap-3 ${center ? 'items-center text-center' : 'items-start'} ${className}`

  if (state.status !== 'ready') {
    return (
      <div className={wrap}>
        <Button
          href={RELEASES_URL}
          size="lg"
          icon={<Download size={18} aria-hidden />}
          aria-busy={state.status === 'loading'}
        >
          Download
        </Button>
        {/* No release to offer (none published yet, or GitHub unreachable): the button just goes to
            the releases page, without a note about why. */}
        {state.status === 'loading' && (
          <p className="min-h-5 text-meta text-ink-3" aria-live="polite">
            Finding the latest release…
          </p>
        )}
      </div>
    )
  }

  const { release } = state
  const asset = pickAsset(release.assets, platform)
  const installers = release.assets.filter((a) => classifyAsset(a.name))
  const arch = archLabel(platform)
  const label = releaseLabel(release)
  const platformName = platform.os === 'unknown' ? null : `${osLabel(platform.os)}${arch ? ` (${arch})` : ''}`

  return (
    <div className={wrap}>
      {asset ? (
        <Button href={asset.browser_download_url} size="lg" icon={<Download size={18} aria-hidden />}>
          Download for {osLabel(platform.os)}
        </Button>
      ) : (
        <Button href={release.url} size="lg" icon={<ExternalLink size={18} aria-hidden />}>
          View all downloads
        </Button>
      )}
      <p className="text-meta text-ink-3 tnum">
        {asset ? (
          <>
            {label} · {platformName} · {formatBytes(asset.size)}
          </>
        ) : platformName ? (
          <>
            {label} · No build for {platformName} yet
          </>
        ) : (
          <>{label} · Kimochi runs on macOS, Windows and Linux</>
        )}
      </p>
      {showAll && installers.length > 0 && (
        <details className={`group text-small w-full max-w-md`}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1 text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
            Other platforms
            <span aria-hidden className="transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <ul className="mt-2 divide-y divide-hairline border-y border-hairline text-left">
            {installers.map((a) => (
              <li key={a.name}>
                <a
                  href={a.browser_download_url}
                  className="flex items-center justify-between gap-4 px-1 py-2 no-underline hover:bg-hover"
                >
                  <span className="min-w-0 truncate text-ink">{assetLabel(a.name)}</span>
                  <span className="shrink-0 text-meta text-ink-3 tnum">{formatBytes(a.size)}</span>
                </a>
              </li>
            ))}
          </ul>
          <a href={release.url} className="mt-2 inline-block px-1 text-meta text-accent-ink">
            {release.channel === 'nightly' ? 'Build notes and all files' : 'Release notes and all files'}
          </a>
        </details>
      )}
    </div>
  )
}
