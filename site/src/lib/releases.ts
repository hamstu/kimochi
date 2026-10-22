import { useEffect, useState } from 'react'
import { detectPlatformFromUA, platformFromClientHints } from './assets.js'
import { useClientValue } from './client'
import type { Platform, ReleaseAsset } from './assets.js'

export type { Platform, ReleaseAsset }
export { pickAsset, assetLabel, formatBytes, osLabel, classifyAsset } from './assets.js'

export const REPO = 'hamstu/kimochi-tauri'
export const RELEASES_URL = `https://github.com/${REPO}/releases`
const API = `https://api.github.com/repos/${REPO}/releases`
const LATEST_API = `${API}/latest`
/** The rolling pre-release CI refreshes on every push to main. */
export const NIGHTLY_TAG = 'nightly'
const NIGHTLY_API = `${API}/tags/${NIGHTLY_TAG}`
const CACHE_KEY = 'kimochi-site-release-v2'
const CACHE_MS = 10 * 60 * 1000

/** "stable" = the latest tagged release; "nightly" = the rolling development build. */
export type ReleaseChannel = 'stable' | 'nightly'

export interface Release {
  channel: ReleaseChannel
  tag: string
  name: string
  url: string
  publishedAt: string | null
  assets: ReleaseAsset[]
}

export type ReleaseError = 'rate-limited' | 'no-release' | 'network'

export class ReleaseFetchError extends Error {
  constructor(readonly kind: ReleaseError) {
    super(kind)
  }
}

interface GitHubRelease {
  tag_name: string
  name: string | null
  html_url: string
  published_at: string | null
  assets: { name: string; size: number; browser_download_url: string }[]
}

function readCache(): Release | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { at, release } = JSON.parse(raw) as { at: number; release: Release }
    return Date.now() - at < CACHE_MS ? release : null
  } catch {
    return null
  }
}

function writeCache(release: Release): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }))
  } catch {
    // ignore
  }
}

async function fetchRelease(url: string, signal?: AbortSignal): Promise<GitHubRelease> {
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ReleaseFetchError('network')
  }
  if (res.status === 404) throw new ReleaseFetchError('no-release')
  if (res.status === 403 || res.status === 429) throw new ReleaseFetchError('rate-limited')
  if (!res.ok) throw new ReleaseFetchError('network')
  return (await res.json()) as GitHubRelease
}

/**
 * The release to offer: the latest published tagged release, or, when none is published yet
 * (`/releases/latest` 404s; it never returns drafts or prereleases), the rolling `nightly`
 * pre-release, marked `channel: 'nightly'`. Unauthenticated: 60 requests/hour per IP, so the
 * result is cached in sessionStorage for 10 min. Throws ReleaseFetchError; callers fall back to
 * RELEASES_URL.
 */
/** The release's version to show: its tag ("v0.2.0"), or "Nightly" for the development build. */
export function versionLabel(release: Release): string {
  return release.channel === 'nightly' ? 'Nightly' : release.tag
}

export async function fetchLatestRelease(signal?: AbortSignal): Promise<Release> {
  const cached = readCache()
  if (cached) return cached
  let channel: ReleaseChannel = 'stable'
  let data: GitHubRelease
  try {
    data = await fetchRelease(LATEST_API, signal)
  } catch (err) {
    if (!(err instanceof ReleaseFetchError) || err.kind !== 'no-release') throw err
    channel = 'nightly'
    data = await fetchRelease(NIGHTLY_API, signal)
  }
  const release: Release = {
    channel,
    tag: data.tag_name,
    name: data.name || data.tag_name,
    url: data.html_url,
    publishedAt: data.published_at,
    assets: (data.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      browser_download_url: a.browser_download_url
    }))
  }
  writeCache(release)
  return release
}

interface UADataLike {
  platform?: string
  mobile?: boolean
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string; platform?: string }>
}

/** Synchronous best guess (user agent heuristics). */
export function detectPlatformSync(): Platform {
  if (typeof navigator === 'undefined') return { os: 'unknown', arch: 'unknown' }
  const guess = detectPlatformFromUA(navigator.userAgent, navigator.platform)
  // iPadOS reports a Mac user agent; a touch "Mac" is an iPad.
  if (guess.os === 'macos' && navigator.maxTouchPoints > 1) return { os: 'unknown', arch: 'unknown' }
  return guess
}

/**
 * Platform with the CPU architecture from User-Agent Client Hints where supported (Chromium),
 * falling back to the user agent string.
 */
export async function detectPlatform(): Promise<Platform> {
  const fallback = detectPlatformSync()
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData
  if (!uaData) return fallback
  if (uaData.mobile) return { os: 'unknown', arch: 'unknown' }
  try {
    const hints = await uaData.getHighEntropyValues?.(['architecture', 'bitness'])
    const fromHints = platformFromClientHints(hints?.platform ?? uaData.platform, hints?.architecture, hints?.bitness)
    return {
      os: fromHints.os !== 'unknown' ? fromHints.os : fallback.os,
      arch: fromHints.arch !== 'unknown' ? fromHints.arch : fallback.arch
    }
  } catch {
    const os = platformFromClientHints(uaData.platform, undefined).os
    return { os: os !== 'unknown' ? os : fallback.os, arch: fallback.arch }
  }
}

/** The user-agent guess as "os/arch", a primitive for useClientValue. */
function readPlatformKey(): string {
  const p = detectPlatformSync()
  return `${p.os}/${p.arch}`
}

/**
 * The visitor's platform: the user-agent guess at once (unknown in prerendered HTML), then the
 * Client Hints answer when it arrives.
 */
export function useDetectedPlatform(): Platform {
  const [os, arch] = useClientValue(readPlatformKey, 'unknown/unknown').split('/')
  const [hinted, setHinted] = useState<Platform | null>(null)
  useEffect(() => {
    let alive = true
    detectPlatform().then((p) => alive && setHinted(p))
    return () => {
      alive = false
    }
  }, [])
  return hinted ?? ({ os, arch } as Platform)
}
