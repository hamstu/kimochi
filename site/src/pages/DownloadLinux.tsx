import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { Download } from 'lucide-react'
import { CopyCommand } from '../components/CopyCommand'
import { Button } from '../components/Button'
import { DeckMark, LinuxMark } from '../components/PlatformMarks'
import { GITHUB_URL } from '../components/Layout'
import {
  RELEASES_URL,
  detectPlatform,
  detectPlatformSync,
  fetchLatestRelease,
  formatBytes,
  type Platform,
  type Release
} from '../lib/releases'
import {
  LINUX_SECTIONS,
  aptInstallCommand,
  appImageRunCommand,
  installCommand,
  linuxAsset,
  linuxSectionFromHash,
  type LinuxSection
} from '../lib/linux.js'

type Arch = 'x64' | 'arm64'

const ARCH_LABEL: Record<Arch, string> = { x64: 'x64', arm64: 'ARM64' }

const TABS: Record<LinuxSection, { title: string; detail: string; mark: ReactNode }> = {
  'steam-deck': {
    title: 'Steam Deck',
    detail: 'SteamOS',
    mark: <DeckMark className="size-5" />
  },
  debian: {
    title: 'Ubuntu & Debian',
    detail: 'Mint, Pop!_OS',
    mark: <LinuxMark className="size-5" />
  },
  other: {
    title: 'Everything else',
    detail: 'Fedora, Arch, openSUSE',
    mark: <LinuxMark className="size-5" />
  }
}

/** The site's origin, read at runtime: the install script lives at `<origin>/install.sh`. */
function useOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

function useRelease(): { release: Release | null; settled: boolean } {
  const [state, setState] = useState<{
    release: Release | null
    settled: boolean
  }>({ release: null, settled: false })
  useEffect(() => {
    const ctrl = new AbortController()
    fetchLatestRelease(ctrl.signal)
      .then((release) => setState({ release, settled: true }))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setState({ release: null, settled: true })
      })
    return () => ctrl.abort()
  }, [])
  return state
}

function usePlatform(): Platform {
  const [platform, setPlatform] = useState<Platform>(detectPlatformSync)
  useEffect(() => {
    let alive = true
    detectPlatform().then((p) => alive && setPlatform(p))
    return () => {
      alive = false
    }
  }, [])
  return platform
}

/** The chosen section follows the URL hash (`#steam-deck`, `#debian`, `#other`, or an alias). */
function useSection(): [LinuxSection, (next: LinuxSection) => void] {
  const { hash } = useLocation()
  const [section, setSection] = useState<LinuxSection>(() => linuxSectionFromHash(hash) ?? 'steam-deck')
  useEffect(() => {
    const fromHash = linuxSectionFromHash(hash)
    if (fromHash) setSection(fromHash)
  }, [hash])
  const choose = (next: LinuxSection): void => {
    setSection(next)
    // Keep the link shareable without a router navigation (which would scroll the page).
    try {
      window.history.replaceState(window.history.state, '', `#${next}`)
    } catch {
      // ignore
    }
  }
  return [section, choose]
}

/** A segmented chooser (ARIA tabs: arrow keys, Home and End move between them). */
function Chooser({ value, onChange }: { value: LinuxSection; onChange: (s: LinuxSection) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const i = LINUX_SECTIONS.indexOf(value)
    let next = -1
    if (event.key === 'ArrowRight') next = (i + 1) % LINUX_SECTIONS.length
    else if (event.key === 'ArrowLeft') next = (i - 1 + LINUX_SECTIONS.length) % LINUX_SECTIONS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = LINUX_SECTIONS.length - 1
    if (next < 0) return
    event.preventDefault()
    const id = LINUX_SECTIONS[next]
    onChange(id)
    refs.current[id]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label="Your system"
      onKeyDown={onKeyDown}
      className="grid grid-cols-3 gap-1 rounded-xl border border-hairline bg-bar p-1"
    >
      {LINUX_SECTIONS.map((id) => {
        const tab = TABS[id]
        const selected = id === value
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={selected}
            aria-controls={id}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={`flex min-w-0 flex-col items-center gap-1 rounded-lg px-2 py-2.5 text-center transition-colors duration-100 sm:flex-row sm:gap-3 sm:px-3.5 sm:text-left ${
              selected
                ? 'bg-raised text-ink shadow-pop ring-1 ring-line-strong'
                : 'text-ink-2 hover:bg-hover hover:text-ink'
            }`}
          >
            <span className={selected ? 'text-accent-ink' : 'text-ink-3'}>{tab.mark}</span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-small font-medium text-balance">{tab.title}</span>
              <span className="hidden truncate text-meta font-normal text-ink-3 sm:block">{tab.detail}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Panel({ id, active, children }: { id: LinuxSection; active: boolean; children: ReactNode }) {
  return (
    <section
      id={id}
      role="tabpanel"
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      // Leave room for the chooser above when arriving by anchor.
      className="scroll-mt-[calc(var(--k-header-h)+6.5rem)] pt-10 md:pt-12"
    >
      {children}
    </section>
  )
}

function PanelHeader({ heading, children }: { heading: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-8 max-w-[60ch]">
      <h2 className="text-title text-ink">{heading}</h2>
      {children && <p className="mt-3 text-lede text-ink-2">{children}</p>}
    </header>
  )
}

/** Numbered steps: a small indigo-wash number, a short title, then the detail. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-7">{children}</ol>
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-full bg-accent-soft text-small font-semibold text-accent-ink tnum"
      >
        {n}
      </span>
      <div className="min-w-0 pt-0.5">
        <h3 className="text-heading text-ink">{title}</h3>
        {children && <div className="mt-2 flex flex-col gap-3 text-body text-ink-2">{children}</div>}
      </div>
    </li>
  )
}

/** One way to install, inside a section: "The one-line installer" (recommended), "Or …". */
function Option({ title, recommended, children }: { title: ReactNode; recommended?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline p-5 sm:p-6">
      <h3 className="flex flex-wrap items-center gap-2.5 text-heading text-ink">
        {title}
        {recommended && (
          <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 text-meta tracking-[0.02em] text-accent-ink">
            Recommended
          </span>
        )}
      </h3>
      <div className="mt-3 flex flex-col gap-3 text-body text-ink-2">{children}</div>
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line-strong bg-field px-1.5 py-px text-[0.8125rem] whitespace-nowrap text-ink">
      {children}
    </kbd>
  )
}

const inlineLink =
  'text-accent-ink underline decoration-[color-mix(in_srgb,var(--k-accent-text)_35%,transparent)] underline-offset-[0.2em] hover:decoration-current'

/**
 * A download button for the release's .deb or AppImage for the visitor's CPU, with the other
 * architecture one link away. Without a release (none published yet, GitHub unreachable or rate
 * limited) it goes to the releases page.
 */
function FileDownload({
  release,
  settled,
  format,
  arch
}: {
  release: Release | null
  settled: boolean
  format: 'deb' | 'AppImage'
  arch: Arch
}) {
  const asset = release ? linuxAsset(release.assets, format, arch) : null
  const otherArch: Arch = arch === 'x64' ? 'arm64' : 'x64'
  const other = release ? linuxAsset(release.assets, format, otherArch) : null
  const otherIsDistinct = other && other.name !== asset?.name
  if (!asset) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button
          variant="secondary"
          size="lg"
          href={release?.url ?? RELEASES_URL}
          icon={<Download size={16} aria-hidden />}
        >
          {`Get the .${format} from GitHub`}
        </Button>
        {settled && (
          <p className="text-small text-ink-3">
            Pick the file ending in <code>.{format}</code> for your computer ({ARCH_LABEL[arch]} or{' '}
            {ARCH_LABEL[otherArch]}).
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" size="lg" href={asset.browser_download_url} icon={<Download size={16} aria-hidden />}>
        {`Download the .${format}`}
        <span className="text-ink-3 tnum">
          {ARCH_LABEL[arch]}
          {asset.size ? ` · ${formatBytes(asset.size)}` : ''}
        </span>
      </Button>
      {otherIsDistinct && (
        <p className="text-small text-ink-3">
          Not on {ARCH_LABEL[arch]}?{' '}
          <a href={other.browser_download_url} className={inlineLink}>
            Get the {ARCH_LABEL[otherArch]} build
          </a>
          .
        </p>
      )}
    </div>
  )
}

/**
 * An illustration of the tile Kimochi gets in the Steam library: a portrait capsule with the app
 * icon and name. Not a copy of Steam's interface.
 */
function LibraryTile() {
  return (
    <figure className="flex flex-col items-center gap-3">
      <div className="kd-about relative flex aspect-[2/3] w-40 flex-col items-center justify-center overflow-hidden rounded-lg shadow-frame ring-1 ring-black/10 md:w-44">
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(to_top,rgb(0_0_0/0.28),transparent)]"
        />
        <img
          src="/icon.svg"
          alt=""
          width={80}
          height={80}
          className="relative size-20 drop-shadow-[0_10px_18px_rgb(0_0_0/0.25)]"
        />
        <span className="relative mt-4 text-[1.375rem] font-semibold tracking-[-0.015em] text-white">Kimochi</span>
        <span lang="ja" className="relative mt-1 text-small text-white/75">
          気持ち
        </span>
      </div>
      <figcaption className="max-w-[12rem] text-center text-meta font-normal text-ink-3">
        Illustration: Kimochi in your Steam library, with its own artwork.
      </figcaption>
    </figure>
  )
}

export function DownloadLinux() {
  const origin = useOrigin()
  const platform = usePlatform()
  const { release, settled } = useRelease()
  const [section, setSection] = useSection()
  const arch: Arch = platform.arch === 'arm64' ? 'arm64' : 'x64'
  const install = installCommand(origin)
  const deb = release ? linuxAsset(release.assets, 'deb', arch) : null
  const appImage = release ? linuxAsset(release.assets, 'AppImage', arch) : null

  return (
    <div className="container-page max-w-4xl py-16 md:py-24">
      <header className="max-w-[60ch]">
        <p className="mb-3 text-meta uppercase tracking-[0.08em] text-accent-ink">
          <Link to="/#download" className="no-underline hover:underline">
            Download
          </Link>{' '}
          <span className="text-ink-3">/</span> Linux
        </p>
        <h1 className="text-title text-ink">Install Kimochi on Linux</h1>
        <p className="mt-4 text-lede text-ink-2">
          There are a few ways to install Kimochi on Linux, and the best one depends on your system. Pick yours below
          and follow along. It only takes a couple of minutes.
        </p>
      </header>

      <div className="mt-10">
        <Chooser value={section} onChange={setSection} />
      </div>

      {/* Steam Deck */}
      <Panel id="steam-deck" active={section === 'steam-deck'}>
        <PanelHeader heading="Steam Deck">
          Install Kimochi once from Desktop Mode. After that it lives in your Steam library, and you can open it in
          Gaming Mode right alongside your game.
        </PanelHeader>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-12 md:grid-cols-[minmax(0,1fr)_auto] md:gap-14">
          <Steps>
            <Step n={1} title="Switch to Desktop Mode">
              <p>
                Press the <strong className="font-medium text-ink">Steam</strong> button, choose{' '}
                <strong className="font-medium text-ink">Power</strong>, then{' '}
                <strong className="font-medium text-ink">Switch to Desktop</strong>.
              </p>
            </Step>
            <Step n={2} title="Open Konsole">
              <p>
                Open the app launcher in the bottom-left corner, then go to{' '}
                <strong className="font-medium text-ink">System</strong> and choose{' '}
                <strong className="font-medium text-ink">Konsole</strong>. It&rsquo;s the terminal, where you&rsquo;ll
                paste one line.
              </p>
            </Step>
            <Step n={3} title="Paste the installer and press Enter">
              <CopyCommand command={install} label="Copy the install command" />
              <p className="text-small text-ink-3">
                Easiest if you open this page on the Deck itself. To paste in Konsole, press <Kbd>Ctrl</Kbd>{' '}
                <Kbd>Shift</Kbd> <Kbd>V</Kbd>, or right-click (the left trigger) and choose Paste. <Kbd>Steam</Kbd> +{' '}
                <Kbd>X</Kbd> brings up the on-screen keyboard.
              </p>
            </Step>
            <Step n={4} title="Add Kimochi to your Steam library">
              <p>
                Kimochi opens when it&rsquo;s installed. Its welcome guide offers to add it to your Steam library, so it
                shows up in Gaming Mode with its own artwork. Say yes.
              </p>
            </Step>
            <Step n={5} title="Read in Desktop Mode or in Gaming Mode">
              <p>
                You can keep using Kimochi in Desktop Mode. Or double-click{' '}
                <strong className="font-medium text-ink">Return to Gaming Mode</strong> on the desktop and launch
                Kimochi from your library. It runs alongside your game: click both sticks to open its radial menu.
              </p>
            </Step>
          </Steps>
          <div className="md:pt-1">
            <LibraryTile />
          </div>
        </div>
      </Panel>

      {/* Ubuntu, Debian, Mint, Pop!_OS */}
      <Panel id="debian" active={section === 'debian'}>
        <PanelHeader heading="Ubuntu, Debian, Mint and Pop!_OS">
          Two good options. The one-line installer is the quickest, and Kimochi then updates itself quietly.
        </PanelHeader>
        {/* Why the installer is recommended over the .deb: both get in-app updates, but a .deb update asks for an
            admin password each time (pkexec dpkg -i), while the installer's AppImage updates silently. */}
        <div className="flex flex-col gap-5">
          <Option title="The one-line installer" recommended>
            <p>
              Open a terminal, paste this line and press Enter. It installs Kimochi in your home folder, adds it to your
              app menu, and opens it. No admin password needed.
            </p>
            <CopyCommand command={install} label="Copy the install command" />
          </Option>
          <Option title="Or install the .deb">
            <p>If you&rsquo;d rather use your package manager, download the .deb for your computer:</p>
            <FileDownload release={release} settled={settled} format="deb" arch={arch} />
            <p>Then, from the folder you saved it to (usually Downloads), install it:</p>
            <CopyCommand command={`cd ~/Downloads && ${aptInstallCommand(deb?.name)}`} label="Copy the apt command" />
            <p className="text-small text-ink-3">
              The .deb gets updates inside Kimochi too; each one asks for your password before it installs.
            </p>
          </Option>
        </div>
      </Panel>

      {/* Fedora, Arch, openSUSE, everything else */}
      <Panel id="other" active={section === 'other'}>
        <PanelHeader heading="Fedora, Arch, openSUSE and everything else">
          Kimochi runs on most other distributions as an AppImage, a single file that keeps itself up to date.
        </PanelHeader>
        <div className="flex flex-col gap-5">
          <Option title="The one-line installer" recommended>
            <p>
              Open a terminal, paste this line and press Enter. It installs the AppImage in your home folder, adds
              Kimochi to your app menu, and opens it.
            </p>
            <CopyCommand command={install} label="Copy the install command" />
          </Option>
          <Option title="Or download the AppImage yourself">
            <FileDownload release={release} settled={settled} format="AppImage" arch={arch} />
            <p>Make it executable and run it from the folder you saved it to:</p>
            <CopyCommand
              command={`cd ~/Downloads && ${appImageRunCommand(appImage?.name)}`}
              label="Copy the run command"
            />
            <p className="text-small text-ink-3">
              Nothing happens? See{' '}
              <a href="#wont-start" className={inlineLink}>
                If Kimochi won&rsquo;t start
              </a>
              .
            </p>
          </Option>
        </div>
      </Panel>

      {/* For everyone */}
      <div className="mt-16 border-t border-hairline pt-12 md:mt-20">
        <div className="flex max-w-3xl flex-col gap-12">
          <section aria-labelledby="updating-h" id="updating">
            <h2 id="updating-h" className="text-heading text-ink">
              Updating
            </h2>
            <div className="mt-3 flex flex-col gap-3 text-body text-ink-2">
              <p>
                Kimochi updates itself when a new version comes out. If you used the one-line installer, that happens
                quietly; running the installer again also brings you up to date. If you installed the .deb, Kimochi asks
                for your password before each update.
              </p>
              <p className="text-small text-ink-3">
                To install or update without Kimochi opening afterwards, add <code>--no-launch</code>:
              </p>
              <CopyCommand
                command={installCommand(origin, { noLaunch: true })}
                label="Copy the install command without launching"
              />
            </div>
          </section>

          <section aria-labelledby="uninstalling-h" id="uninstalling">
            <h2 id="uninstalling-h" className="text-heading text-ink">
              Uninstalling
            </h2>
            <div className="mt-3 flex flex-col gap-3 text-body text-ink-2">
              <p>
                If you used the one-line installer (including on a Steam Deck), run it with <code>--uninstall</code>.
                Your settings and dictionaries are kept, in case you come back.
              </p>
              <CopyCommand command={installCommand(origin, { uninstall: true })} label="Copy the uninstall command" />
              <p>If you installed the .deb:</p>
              <CopyCommand command="sudo apt remove kimochi" label="Copy the apt remove command" />
            </div>
          </section>

          <section aria-labelledby="wont-start-h" id="wont-start">
            <h2 id="wont-start-h" className="text-heading text-ink">
              If Kimochi won&rsquo;t start
            </h2>
            <div className="mt-3 flex flex-col gap-3 text-body text-ink-2">
              <p className="max-w-[65ch]">
                The AppImage needs FUSE 3, which desktop installs usually come with (the Steam Deck does). The one-line
                installer checks for it and, if it&rsquo;s missing, sets Kimochi up to run without it; it just starts a
                little slower. If you downloaded the AppImage yourself and it doesn&rsquo;t open, install FUSE 3 and try
                again:
              </p>
              <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-3 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-center">
                {FUSE.map(([system, command]) => (
                  <div key={system} className="contents">
                    <dt className="text-small font-medium text-ink">{system}</dt>
                    <dd className="min-w-0">
                      <CopyCommand command={command} label={`Copy the FUSE command for ${system}`} />
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-small text-ink-3">
                Still stuck?{' '}
                <a href={`${GITHUB_URL}/issues`} className={inlineLink}>
                  Open an issue on GitHub
                </a>{' '}
                with your distribution and what you see, and we&rsquo;ll help.
              </p>
            </div>
          </section>
        </div>
      </div>

      <p className="mt-16 text-small text-ink-3">
        On macOS or Windows?{' '}
        <Link to="/#download" className={inlineLink}>
          Download Kimochi
        </Link>{' '}
        from the home page.
      </p>
    </div>
  )
}

const FUSE: [system: string, command: string][] = [
  ['Ubuntu, Debian, Mint', 'sudo apt install fuse3'],
  ['Fedora', 'sudo dnf install fuse3'],
  ['Arch', 'sudo pacman -S fuse3'],
  ['openSUSE', 'sudo zypper install fuse3']
]
