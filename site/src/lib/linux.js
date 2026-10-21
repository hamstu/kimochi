// @ts-check
/**
 * Pure helpers for the Linux install guide (/download/linux, src/pages/DownloadLinux.tsx): which
 * section a URL hash means, the one-line installer commands, and picking the .deb or AppImage for
 * a CPU. Plain JS + JSDoc so `node --test` can import it (site/test/linux.test.mjs).
 */
import { DEFAULT_ARCH, classifyAsset } from './assets.js'

/** @typedef {import('./assets.js').Arch} Arch */
/** @typedef {import('./assets.js').OS} OS */
/** @typedef {import('./assets.js').ReleaseAsset} ReleaseAsset */
/** @typedef {'steam-deck' | 'debian' | 'other'} LinuxSection */

/** The guide's route. Linux visitors' download button goes here instead of to a file. */
export const LINUX_GUIDE_PATH = '/download/linux'

/** The guide's sections, in chooser order. Each is also the panel's id (`#steam-deck`, ...). */
/** @type {readonly LinuxSection[]} */
export const LINUX_SECTIONS = ['steam-deck', 'debian', 'other']

/** Friendlier hashes people might type or link, mapped to a section. */
/** @type {Record<string, LinuxSection>} */
const HASH_ALIASES = {
  'steam-deck': 'steam-deck',
  steamdeck: 'steam-deck',
  deck: 'steam-deck',
  steamos: 'steam-deck',
  debian: 'debian',
  ubuntu: 'debian',
  mint: 'debian',
  'pop-os': 'debian',
  popos: 'debian',
  deb: 'debian',
  other: 'other',
  fedora: 'other',
  arch: 'other',
  opensuse: 'other',
  appimage: 'other'
}

/**
 * The section a location hash names ("#steam-deck", "#ubuntu", ...), or null.
 * @param {string | null | undefined} hash
 * @returns {LinuxSection | null}
 */
export function linuxSectionFromHash(hash) {
  const key = decodeURIComponentSafe(String(hash ?? '').replace(/^#/, ''))
    .trim()
    .toLowerCase()
  return Object.hasOwn(HASH_ALIASES, key) ? HASH_ALIASES[key] : null
}

/** @param {string} s */
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * The one-line installer, served by this site at `<origin>/install.sh`. The origin comes from
 * `window.location.origin` at runtime, so the command is right on any domain.
 * @param {string} origin  e.g. "https://kimochi.app"
 * The script's flags (site/public/install.sh): --uninstall (keeps settings and dictionaries),
 * --no-launch (or KIMOCHI_NO_LAUNCH=1), --nightly, --appimage <file>, --help.
 * @param {{ uninstall?: boolean, noLaunch?: boolean }} [options]
 */
export function installCommand(origin, options = {}) {
  const base = `curl -fsSL ${String(origin).replace(/\/+$/, '')}/install.sh | sh`
  const flags = [options.uninstall ? '--uninstall' : '', options.noLaunch ? '--no-launch' : ''].filter(Boolean)
  return flags.length ? `${base} -s -- ${flags.join(' ')}` : base
}

/** File names that are safe to paste into a shell unquoted. */
const SHELL_SAFE = /^[A-Za-z0-9._+-]+$/

/**
 * `sudo apt install ./<file>` for a downloaded .deb (run from the folder it was saved to).
 * Without a known, shell-safe file name it uses a glob.
 * @param {string | null | undefined} fileName
 */
export function aptInstallCommand(fileName) {
  const file = fileName && SHELL_SAFE.test(fileName) ? fileName : '[Kk]imochi_*.deb'
  return `sudo apt install ./${file}`
}

/**
 * Make a downloaded AppImage executable and start it.
 * @param {string | null | undefined} fileName
 */
export function appImageRunCommand(fileName) {
  const file = fileName && SHELL_SAFE.test(fileName) ? fileName : '[Kk]imochi_*.AppImage'
  return `chmod +x ./${file} && ./${file}`
}

/**
 * The release's .deb or AppImage for a CPU (x64 when unknown), preferring the generic build over
 * a distro-specific one (the `-arch` Arch Linux build). Null when there is none.
 * @template {ReleaseAsset} T
 * @param {readonly T[]} assets
 * @param {'deb' | 'AppImage'} format
 * @param {Arch} arch
 * @returns {T | null}
 */
export function linuxAsset(assets, format, arch) {
  const want = arch === 'unknown' ? DEFAULT_ARCH.linux : arch
  /** @type {T | null} */
  let best = null
  let bestScore = Infinity
  for (const asset of assets) {
    const info = classifyAsset(asset.name)
    if (!info || info.os !== 'linux' || info.format !== format) continue
    if (info.arch !== 'unknown' && info.arch !== want) continue
    const score = (info.arch === want ? 0 : 10) + (info.variant ? 5 : 0)
    if (score < bestScore) {
      best = asset
      bestScore = score
    }
  }
  return best
}

/**
 * Where the main download button goes: Linux visitors get the install guide (there are several
 * ways to install, and the right one depends on their system); everyone else the file for their
 * platform, or `fallback` (the release or releases page) when there is none.
 * @param {OS} os
 * @param {string | null | undefined} assetUrl
 * @param {string} fallback
 */
export function primaryDownloadHref(os, assetUrl, fallback) {
  if (os === 'linux') return LINUX_GUIDE_PATH
  return assetUrl || fallback
}
