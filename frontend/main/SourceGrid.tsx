/**
 * Every window and display that can be read, as a scrolling grid of live thumbnails: the
 * "Window or screen" submenu of the sidebar's Change source menu. Choosing a tile selects that
 * source, keeping the region saved for it.
 *
 * Thumbnails are requested only as tiles scroll into view, at most two at a time, and a capture
 * that is momentarily `busy:` behind a scan is retried rather than shown as missing.
 *
 * Where the system chooses what is shared (`capture.pickerRequired`, the Wayland portal) there is
 * no list to show: the grid becomes one "Choose in system picker" button, and the pick's progress
 * lives in a per-window store so it outlives the menu that started it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { AppWindow, Monitor, ScreenShare, ShieldAlert } from 'lucide-react'
import { Button, Callout, Spinner } from '@kit'
import { invoke } from '@tauri-apps/api/core'
import {
  nativeError,
  openScreenCapturePreferences,
  startSystemPick,
  useSystemPick,
  type NativeError
} from '../bridge/tauri'
import { isGamingMode, useCapabilities } from '../bridge/capabilities'

export interface CatalogSource {
  id: string
  kind: string
  name: string
  app?: string | null
  icon?: string | null
  /** Where an off-screen window is open: "Full screen", "Desktop 2". */
  space?: string | null
}

const isDisplay = (source: CatalogSource): boolean =>
  source.kind === 'display' || source.kind === 'screen'
const sourceTitle = (source: CatalogSource): string =>
  source.app || source.name || 'Untitled window'

// Limit simultaneous native thumbnail work; tiles request only as they approach view.
let thumbnailJobs = 0
const thumbnailQueue: (() => void)[] = []
function thumbnail(id: string, live: () => boolean): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const run = (): void => {
      thumbnailJobs++
      const load = async (): Promise<{ url: string }> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!live()) return { url: '' }
          try {
            return await invoke<{ url: string }>('source_thumbnail', { sourceId: id })
          } catch (error) {
            if (!nativeError(error).message.startsWith('busy:') || attempt === 3) throw error
            await new Promise((done) => setTimeout(done, 250 * (attempt + 1)))
          }
        }
        return { url: '' }
      }
      load()
        .then(resolve, reject)
        .finally(() => {
          thumbnailJobs--
          thumbnailQueue.shift()?.()
        })
    }
    if (thumbnailJobs < 2) run()
    else thumbnailQueue.push(run)
  })
}

function Tile({
  source,
  current,
  root,
  noPreview = false,
  onChoose
}: {
  source: CatalogSource
  current: boolean
  root: HTMLElement | null
  /** Shown without a thumbnail (Gaming Mode's screen, which is Kimochi itself right now). */
  noPreview?: boolean
  onChoose: () => void
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [icon, setIcon] = useState(source.icon)
  useEffect(() => {
    let live = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        if (source.app)
          void invoke<{ icon: string | null }>('source_icon', { appName: source.app }).then(
            (result) => {
              if (live) setIcon(result.icon)
            },
            () => {}
          )
        // On another Space or desktop: nothing is drawn there to preview from here.
        if (source.space || noPreview) return
        void thumbnail(source.id, () => live).then(
          (result) => {
            if (live) setUrl(result.url || null)
            if (live && !result.url) setFailed(true)
          },
          () => {
            if (live) setFailed(true)
          }
        )
      },
      { root, rootMargin: '120px' }
    )
    if (ref.current) observer.observe(ref.current)
    return () => {
      live = false
      observer.disconnect()
    }
  }, [source.id, source.app, source.space, noPreview, root])
  const Icon = isDisplay(source) ? Monitor : AppWindow
  const detail = noPreview
    ? 'Whatever is in front'
    : source.app && source.name !== source.app
      ? source.name || 'Untitled window'
      : null
  return (
    <MenuPrimitive.Item
      ref={ref}
      className="sg-tile"
      data-current={current ? '' : undefined}
      title={[source.app, source.name, source.space].filter(Boolean).join(' — ')}
      onSelect={onChoose}
    >
      <span className="sg-thumb">
        {url ? (
          <img
            src={url}
            alt=""
            draggable={false}
            onError={() => {
              setUrl(null)
              setFailed(true)
            }}
          />
        ) : (
          <span className="sg-thumb-placeholder">
            <Icon />
            {source.space ? (
              <span>Previews once it is showing</span>
            ) : noPreview ? (
              <span>The app in front</span>
            ) : (
              failed && <span>No preview</span>
            )}
          </span>
        )}
        {current && <span className="sg-current">Current</span>}
        {source.space && <span className="sg-space">{source.space}</span>}
      </span>
      <span className="sg-caption">
        {icon ? (
          <img className="sg-app-icon" src={icon} alt="" />
        ) : (
          <Icon className="sg-app-icon" />
        )}
        <span className="sg-caption-text">
          <span className="sg-caption-title">{sourceTitle(source)}</span>
          {detail && <span className="sg-caption-detail">{detail}</span>}
        </span>
      </span>
    </MenuPrimitive.Item>
  )
}

// ---------------------------------------------------------------------------- system picker

/**
 * The "Choose in system picker" button with a line on what happens next, a spinner while the
 * dialog is up, and the reason the last pick (or the shared source, via `message`) failed.
 */
export function SystemPickerButton({ message = null }: { message?: string | null }): ReactNode {
  const linuxPortal = useCapabilities().os === 'linux'
  const { waiting, error } = useSystemPick()
  const problem = waiting ? null : (error ?? message)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--k-space-2)' }}>
      {problem && <Callout tone="warn">{problem}</Callout>}
      <Button
        variant="primary"
        disabled={waiting}
        aria-busy={waiting || undefined}
        onClick={() => void startSystemPick()}
      >
        {waiting ? <Spinner label="Waiting for the system picker" /> : <ScreenShare />}
        {waiting ? 'Waiting for the system picker…' : linuxPortal ? 'Choose New Source…' : 'Choose in system picker'}
      </Button>
      <span style={{ color: 'var(--k-text-2)', fontSize: 'var(--k-text-sm)' }}>
        {waiting
          ? 'Choose a screen or window in the dialog your desktop opened.'
          : 'Your desktop opens its own dialog to choose the screen or window Kimochi reads.'}
      </span>
    </div>
  )
}

/** The grid, or on a system-picker platform the one button that stands in for it. */
export function SourceGrid({
  currentId,
  onChoose
}: {
  currentId: string | null
  onChoose: (source: CatalogSource) => void
}): ReactNode {
  const capabilities = useCapabilities()
  if (capabilities.capture.pickerRequired) {
    return (
      <div className="sg-scroll">
        <div className="sg-status">
          <SystemPickerButton />
        </div>
      </div>
    )
  }
  return <WindowGrid currentId={currentId} onChoose={onChoose} />
}

/**
 * Missing capture permission, as something to click rather than a red line: opens the system's
 * screen recording settings, as the first-run guide's button does.
 */
function GrantCaptureItem({ os }: { os: string }): ReactNode {
  return (
    <MenuPrimitive.Item
      className="sg-permission"
      onSelect={() => void openScreenCapturePreferences()}
    >
      <ShieldAlert className="sg-permission-icon" />
      <span className="sg-caption-text">
        <span className="sg-caption-title">
          {os === 'macos' ? 'Allow Screen Recording…' : 'Allow screen capture…'}
        </span>
        <span className="sg-caption-detail">
          {os === 'macos'
            ? 'Kimochi needs it to see your windows. Opens System Settings: turn on Kimochi, and reopen Kimochi if macOS asks.'
            : 'Kimochi needs it to see your windows. Opens your system settings.'}
        </span>
      </span>
    </MenuPrimitive.Item>
  )
}

function WindowGrid({
  currentId,
  onChoose
}: {
  currentId: string | null
  onChoose: (source: CatalogSource) => void
}): ReactNode {
  const [sources, setSources] = useState<CatalogSource[] | null>(null)
  const [error, setError] = useState<NativeError | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const capabilities = useCapabilities()
  // Only a platform with a settings page to send the user to gets told to go there.
  const emptyHint = isGamingMode(capabilities)
    ? 'Nothing is running. Start a game from Steam, then choose it here.'
    : !capabilities.capture.canOpenSettings
    ? 'No windows to read.'
    : capabilities.os === 'macos'
      ? 'No windows to read. Enable Screen Recording for Kimochi in System Settings.'
      : 'No windows to read. Allow screen capture for Kimochi in your system settings.'

  // A fresh list each time the submenu opens: windows come and go.
  useEffect(() => {
    let live = true
    invoke<CatalogSource[]>('source_catalog').then(
      (catalog) => {
        if (live) setSources(catalog)
      },
      (caught: unknown) => {
        if (live) setError(nativeError(caught))
      }
    )
    return () => {
      live = false
    }
  }, [])

  // Gaming Mode lists games first, and its screen has no thumbnail: only one app shows at a
  // time, and while this menu is open that app is Kimochi.
  const gaming = isGamingMode(capabilities)
  const tile = (source: CatalogSource): ReactNode => (
    <Tile
      key={source.id}
      source={source}
      current={source.id === currentId}
      root={root}
      noPreview={gaming && isDisplay(source)}
      onChoose={() => onChoose(source)}
    />
  )
  const displays = sources?.filter(isDisplay) ?? []
  const windows = sources?.filter((source) => !isDisplay(source)) ?? []
  const screens = root && displays.length > 0 && (
    <section className="sg-section" aria-label="Screens">
      <h3 className="sg-section-title">{gaming ? 'Screen' : 'Screens'}</h3>
      <div className="sg-grid">{displays.map(tile)}</div>
    </section>
  )

  return (
    <div className="sg-scroll" ref={setRoot}>
      {error &&
        (error.kind === 'permission' && capabilities.capture.canOpenSettings ? (
          <GrantCaptureItem os={capabilities.os} />
        ) : (
          <div className="sg-status sg-error">{error.message}</div>
        ))}
      {!sources && !error && (
        <div className="sg-status" role="status">
          <Spinner label="Finding sources" />
          Finding windows…
        </div>
      )}
      {sources && sources.length === 0 && (
        <div className="sg-status">{emptyHint}</div>
      )}
      {!gaming && screens}
      {root && windows.length > 0 && (
        <section className="sg-section" aria-label={gaming ? 'Games and apps' : 'App windows'}>
          <h3 className="sg-section-title">
            {gaming ? 'Games and apps' : 'App windows'} <span className="k-num">{windows.length}</span>
          </h3>
          <div className="sg-grid">{windows.map(tile)}</div>
        </section>
      )}
      {gaming && screens}
    </div>
  )
}
