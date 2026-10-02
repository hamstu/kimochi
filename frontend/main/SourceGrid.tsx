/**
 * Every window and display that can be read, as a scrolling grid of live thumbnails: the
 * "Window or screen" submenu of the sidebar's Change source menu. Choosing a tile selects that
 * source, keeping the region saved for it.
 *
 * Thumbnails are requested only as tiles scroll into view, at most two at a time, and a capture
 * that is momentarily `busy:` behind a scan is retried rather than shown as missing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { AppWindow, Monitor } from 'lucide-react'
import { Spinner } from '@kit'
import { invoke } from '@tauri-apps/api/core'
import { nativeError } from '../bridge/tauri'

export interface CatalogSource {
  id: string
  kind: string
  name: string
  app?: string | null
  icon?: string | null
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
  onChoose
}: {
  source: CatalogSource
  current: boolean
  root: HTMLElement | null
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
  }, [source.id, source.app, root])
  const Icon = isDisplay(source) ? Monitor : AppWindow
  const detail = source.app ? source.name || 'Untitled window' : null
  return (
    <MenuPrimitive.Item
      ref={ref}
      className="sg-tile"
      data-current={current ? '' : undefined}
      title={[source.app, source.name].filter(Boolean).join(' — ')}
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
            {failed && <span>No preview</span>}
          </span>
        )}
        {current && <span className="sg-current">Current</span>}
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

export function SourceGrid({
  currentId,
  onChoose
}: {
  currentId: string | null
  onChoose: (source: CatalogSource) => void
}): ReactNode {
  const [sources, setSources] = useState<CatalogSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)

  // A fresh list each time the submenu opens: windows come and go.
  useEffect(() => {
    let live = true
    invoke<CatalogSource[]>('source_catalog').then(
      (catalog) => {
        if (live) setSources(catalog)
      },
      (caught: unknown) => {
        if (live) setError(nativeError(caught).message)
      }
    )
    return () => {
      live = false
    }
  }, [])

  const tile = (source: CatalogSource): ReactNode => (
    <Tile
      key={source.id}
      source={source}
      current={source.id === currentId}
      root={root}
      onChoose={() => onChoose(source)}
    />
  )
  const displays = sources?.filter(isDisplay) ?? []
  const windows = sources?.filter((source) => !isDisplay(source)) ?? []

  return (
    <div className="sg-scroll" ref={setRoot}>
      {error && <div className="sg-status sg-error">{error}</div>}
      {!sources && !error && (
        <div className="sg-status" role="status">
          <Spinner label="Finding sources" />
          Finding windows…
        </div>
      )}
      {sources && sources.length === 0 && (
        <div className="sg-status">
          No windows to read. Enable Screen Recording for Kimochi in System Settings.
        </div>
      )}
      {root && displays.length > 0 && (
        <section className="sg-section" aria-label="Screens">
          <h3 className="sg-section-title">Screens</h3>
          <div className="sg-grid">{displays.map(tile)}</div>
        </section>
      )}
      {root && windows.length > 0 && (
        <section className="sg-section" aria-label="App windows">
          <h3 className="sg-section-title">
            App windows <span className="k-num">{windows.length}</span>
          </h3>
          <div className="sg-grid">{windows.map(tile)}</div>
        </section>
      )}
    </div>
  )
}
