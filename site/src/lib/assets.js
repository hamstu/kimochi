// @ts-check
/**
 * Pure release-asset logic: platform detection from a user-agent string, classification of
 * GitHub release asset names, and picking the best asset for a platform. Plain JS + JSDoc so
 * `node --test` can import it directly (see site/test/assets.test.mjs); TypeScript checks it via
 * `checkJs`.
 *
 * CI (.github/workflows/ci.yml, "Upload to release") publishes tauri's bundle names to GitHub
 * Releases. A tagged release (`/releases/latest`) keeps the version:
 *   Kimochi_<ver>_aarch64.app.zip                              macOS (Apple silicon)
 *   Kimochi_<ver>_x64-setup.exe, Kimochi_<ver>_arm64-setup.exe  Windows
 *   kimochi_<ver>_amd64.deb, kimochi_<ver>_arm64.deb           Linux
 *   kimochi_<ver>_amd64.AppImage, kimochi_<ver>_aarch64.AppImage
 * The rolling `nightly` pre-release drops `_<ver>` (Kimochi_aarch64.app.zip, Kimochi_x64-setup.exe,
 * ...). A build from the Arch Linux runner adds `-arch` before the extension
 * (kimochi_<ver>_aarch64-arch.AppImage) and is ranked after every generic build.
 * Matching is by extension plus architecture tokens anywhere in the name, so older
 * `<rust-target>-<bundle>` names and a future .dmg also work.
 */

/** @typedef {'macos' | 'windows' | 'linux' | 'unknown'} OS */
/** @typedef {'x64' | 'arm64' | 'unknown'} Arch */
/** @typedef {{ os: OS, arch: Arch }} Platform */
/** @typedef {{ name: string, size: number, browser_download_url: string }} ReleaseAsset */
/**
 * @typedef {{
 *   os: Exclude<OS, 'unknown'>,
 *   arch: Arch,
 *   format: string,
 *   rank: number,
 *   variant: string | null
 * }} AssetInfo
 */

/** Install formats in order of preference per OS (lower rank wins). */
const FORMATS = /** @type {const} */ ([
  { os: 'macos', format: 'dmg', test: /\.dmg$/i, rank: 0 },
  { os: 'macos', format: 'app.zip', test: /\.app\.zip$/i, rank: 1 },
  { os: 'windows', format: 'exe', test: /-setup\.exe$/i, rank: 0 },
  { os: 'windows', format: 'msi', test: /\.msi$/i, rank: 1 },
  { os: 'linux', format: 'AppImage', test: /\.AppImage$/i, rank: 0 },
  { os: 'linux', format: 'deb', test: /\.deb$/i, rank: 1 },
  { os: 'linux', format: 'rpm', test: /\.rpm$/i, rank: 2 }
])

/**
 * Classify an asset name, or null for files that are not installers (signatures, updater
 * archives, checksums, ...).
 * @param {string} name
 * @returns {AssetInfo | null}
 */
export function classifyAsset(name) {
  const fmt = FORMATS.find((f) => f.test.test(name))
  if (!fmt) return null
  /** @type {Arch} */
  let arch = 'unknown'
  if (/(aarch64|arm64)/i.test(name)) arch = 'arm64'
  else if (/(x86_64|x64|amd64)/i.test(name)) arch = 'x64'
  // A distro-specific build such as the "-arch" (Arch Linux) one. `aarch64` must not count.
  const variant = /(^|[^a-z0-9])arch([^a-z0-9]|$)/i.test(name) ? 'arch' : null
  return { os: fmt.os, arch, format: fmt.format, rank: fmt.rank, variant }
}

/** The architecture assumed when it cannot be detected. Safari on Apple silicon reports Intel. */
/** @type {Record<Exclude<OS, 'unknown'>, Exclude<Arch, 'unknown'>>} */
export const DEFAULT_ARCH = { macos: 'arm64', windows: 'x64', linux: 'x64' }

/**
 * Pick the best installer for a platform. Returns null when the OS is unknown or there is no
 * build for it (or none for its detected architecture). An asset without an architecture token
 * (e.g. a universal dmg) matches any architecture.
 * @template {ReleaseAsset} T
 * @param {readonly T[]} assets
 * @param {Platform} platform
 * @returns {T | null}
 */
export function pickAsset(assets, platform) {
  if (platform.os === 'unknown') return null
  const want = platform.arch === 'unknown' ? DEFAULT_ARCH[platform.os] : platform.arch
  /** @type {{ asset: T, score: number }[]} */
  const candidates = []
  for (const asset of assets) {
    const info = classifyAsset(asset.name)
    if (!info || info.os !== platform.os) continue
    if (info.arch !== 'unknown' && info.arch !== want) continue
    // Prefer an exact arch match, then any generic build over a distro-specific one (the
    // "-arch" Arch Linux build ranks last), then the preferred format.
    const score = (info.arch === want ? 0 : 100) + (info.variant ? 50 : 0) + info.rank * 10
    candidates.push({ asset, score })
  }
  candidates.sort((a, b) => a.score - b.score || a.asset.name.localeCompare(b.asset.name))
  return candidates[0]?.asset ?? null
}

/**
 * Best-effort platform from a user-agent string (+ optional navigator.platform). The
 * architecture is often unknowable from the UA alone (macOS always says "Intel"; Windows on ARM
 * says "Win64; x64"), so callers should prefer navigator.userAgentData when it exists.
 * @param {string} ua
 * @param {string} [navPlatform]
 * @returns {Platform}
 */
export function detectPlatformFromUA(ua, navPlatform = '') {
  const s = `${ua} ${navPlatform}`
  /** @type {OS} */
  let os = 'unknown'
  if (/iPhone|iPad|iPod|Android|CrOS/i.test(s)) os = 'unknown'
  else if (/Windows/i.test(s)) os = 'windows'
  else if (/Mac OS X|Macintosh|MacIntel/i.test(s)) os = 'macos'
  else if (/Linux|X11/i.test(s)) os = 'linux'

  /** @type {Arch} */
  let arch = 'unknown'
  if (os === 'linux' || os === 'windows') {
    if (/aarch64|arm64|armv8/i.test(s)) arch = 'arm64'
    else if (/x86_64|x64|amd64|Win64|WOW64/i.test(s)) arch = 'x64'
  }
  // macOS: the UA says "Intel" on Apple silicon too, so leave it unknown (defaults to arm64).
  return { os, arch }
}

/**
 * Normalise navigator.userAgentData values.
 * @param {string | undefined} platform  e.g. "macOS", "Windows", "Linux", "Chrome OS", "Android"
 * @param {string | undefined} architecture  e.g. "arm", "x86"
 * @param {string | undefined} [bitness]  e.g. "64"
 * @returns {Platform}
 */
export function platformFromClientHints(platform, architecture, bitness) {
  /** @type {OS} */
  let os = 'unknown'
  const p = (platform || '').toLowerCase()
  if (p === 'macos') os = 'macos'
  else if (p === 'windows') os = 'windows'
  else if (p === 'linux') os = 'linux'
  /** @type {Arch} */
  let arch = 'unknown'
  const a = (architecture || '').toLowerCase()
  if (a === 'arm' && bitness !== '32') arch = 'arm64'
  else if (a === 'x86' && bitness !== '32') arch = 'x64'
  return { os, arch }
}

/** @param {OS} os */
export function osLabel(os) {
  return os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : 'your platform'
}

/**
 * Human label for an asset, e.g. "macOS · Apple silicon · .dmg".
 * @param {string} name
 */
export function assetLabel(name) {
  const info = classifyAsset(name)
  if (!info) return name
  const arch =
    info.arch === 'unknown'
      ? info.os === 'macos'
        ? 'Universal'
        : ''
      : info.os === 'macos'
        ? info.arch === 'arm64'
          ? 'Apple silicon'
          : 'Intel'
        : info.arch === 'arm64'
          ? 'ARM64'
          : 'x64'
  const parts = [osLabel(info.os), arch, info.variant === 'arch' ? 'Arch Linux' : '', `.${info.format}`]
  return parts.filter(Boolean).join(' · ')
}

/**
 * @param {number} bytes
 * @returns {string} e.g. "48.2 MB"
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}
