import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AppWindow, ArrowLeft, Maximize, Monitor, RefreshCw, X } from 'lucide-react'
import { Badge, Bar, BarSpacer, Button, Callout, EmptyState, IconButton, Spinner } from '@kit'
import { cropFromDrag, scaleCrop, type Crop, type Point } from './crop'
import { useNativeHover } from '../shell/useNativeHover'
import '../shell/panel.css'
import './source-picker.css'

interface Source {
  id: string
  kind: string
  name: string
  app?: string | null
  icon?: string | null
}
interface Preview {
  url: string
  width: number
  height: number
}
interface PickerState {
  sourceId: string | null
  crop: Crop | null
  editCurrent: boolean
}
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)
const isDisplay = (source: Source): boolean => source.kind === 'display' || source.kind === 'screen'
const close = (): Promise<unknown> =>
  invoke('panel', { label: 'source-picker', action: 'hide', rect: null })
// The picker is undecorated; its title bar starts a native drag like every panel's does.
const startDrag = (): void => {
  void invoke('panel', { label: 'source-picker', action: 'drag', rect: null }).catch(() => undefined)
}
const sourceTitle = (source: Source): string => source.app || source.name || 'Untitled window'

async function loadPreview(sourceId: string, live: () => boolean): Promise<Preview | null> {
  // A thumbnail already in flight can briefly own the capture backend when a
  // card is clicked. Wait for it without requiring a second click from the user.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!live()) return null
    try {
      return await invoke<Preview>('source_preview', { sourceId })
    } catch (error) {
      if (!describeError(error).startsWith('busy:') || attempt === 3) throw error
      await new Promise((done) => setTimeout(done, 250 * (attempt + 1)))
    }
  }
  return null
}

// Limit simultaneous native thumbnail work; cards request only as they approach view.
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
            if (!describeError(error).startsWith('busy:') || attempt === 3) throw error
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

function SourceTile({
  source,
  picked,
  current,
  onPick,
  onOpen
}: {
  source: Source
  picked: boolean
  current: boolean
  onPick: () => void
  onOpen: () => void
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
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
            if (live) setUrl(result.url)
          },
          () => {
            if (live) setFailed(true)
          }
        )
      },
      { rootMargin: '100px' }
    )
    if (ref.current) observer.observe(ref.current)
    return () => {
      live = false
      observer.disconnect()
    }
  }, [source.id, source.app])
  const Icon = isDisplay(source) ? Monitor : AppWindow
  const detail = source.app ? source.name || 'Untitled window' : null
  return (
    <button
      ref={ref}
      type="button"
      className="sp-tile"
      aria-pressed={picked}
      onClick={onPick}
      onDoubleClick={onOpen}
      title={[source.app, source.name].filter(Boolean).join(' — ')}
    >
      <span className="sp-thumb">
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
          <span className="sp-thumb-placeholder">
            <Icon />
            <span>{failed ? 'No preview' : 'Loading…'}</span>
          </span>
        )}
        {current && <Badge className="sp-current">Current</Badge>}
      </span>
      <span className="sp-caption">
        {icon ? <img className="sp-app-icon" src={icon} alt="" /> : <Icon className="sp-app-icon" />}
        <span className="sp-caption-text">
          <span className="sp-caption-title">{sourceTitle(source)}</span>
          {detail && <span className="sp-caption-detail">{detail}</span>}
        </span>
      </span>
    </button>
  )
}

function Section({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: JSX.Element[]
}): JSX.Element {
  return (
    <section className="sp-section" aria-label={title}>
      <h2 className="sp-section-title">
        {title}
        {count !== undefined && <span className="k-num">{count}</span>}
      </h2>
      <div className="sp-grid">{children}</div>
    </section>
  )
}

export default function SourcePicker(): JSX.Element {
  const [active, setActive] = useState(false)
  useNativeHover(active)
  const [sources, setSources] = useState<Source[]>([])
  // `picked` is the highlighted tile in the list; `selected` is the source being cropped.
  const [picked, setPicked] = useState<Source | null>(null)
  const [selected, setSelected] = useState<Source | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const currentCrop = useRef<Crop | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const savedCrop = useRef<Crop | null>(null)
  const [cropEdited, setCropEdited] = useState(false)
  const [cropInvalid, setCropInvalid] = useState(false)
  const editCurrent = useRef<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<'catalog' | 'preview' | 'crop' | 'save' | 'close'>(
    'catalog'
  )
  const [generation, setGeneration] = useState(0)
  const request = useRef({ value: 0 })
  const visibilityReceived = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: Point; pointerId: number; previous: Crop | null } | null>(null)
  const [fit, setFit] = useState({ width: 0, height: 0 })

  const refresh = useCallback((): void => {
    setLoading(true)
    setError(null)
    setGeneration((value) => value + 1)
  }, [])

  useEffect(() => {
    const subscription = listen<{ editCurrent: boolean }>('source-picker-open', ({ payload }) => {
      editCurrent.current = payload.editCurrent
      visibilityReceived.current = true
      setActive(true)
      request.current.value++
      setPicked(null)
      setSelected(null)
      setPreview(null)
      setCrop(null)
      setError(null)
      setSaving(false)
      drag.current = null
      refresh()
    })
    return () => {
      void subscription.then((unlisten) => unlisten())
    }
  }, [refresh])

  useEffect(() => {
    let live = true
    const visibility = listen<{ label: string; visible: boolean }>('panel:state', ({ payload }) => {
      if (payload.label === 'source-picker') {
        visibilityReceived.current = true
        setActive(payload.visible)
      }
    })
    void getCurrentWindow()
      .isVisible()
      .then((visible) => {
        if (live && !visibilityReceived.current) setActive(visible)
      })
      .catch((error: unknown) => {
        if (live) setError(describeError(error))
      })
    return () => {
      live = false
      void visibility.then((unlisten) => unlisten())
    }
  }, [])

  const choose = useCallback(
    async (source: Source, initialCrop: Crop | null = null): Promise<void> => {
      const id = ++request.current.value
      savedCrop.current = initialCrop
      setCropEdited(false)
      setCropInvalid(false)
      drag.current = null
      setPicked(source)
      setSelected(source)
      setPreview(null)
      setCrop(null)
      setError(null)
      setLoading(true)
      try {
        const result = await loadPreview(source.id, () => id === request.current.value)
        if (!result || id !== request.current.value) return
        if (!(result.width > 0 && result.height > 0))
          throw new Error('The source returned an empty preview.')
        setPreview(result)
        const scaled = initialCrop ? scaleCrop(initialCrop, result.width, result.height) : null
        setCrop(scaled)
        if (initialCrop && !scaled) {
          setCropInvalid(true)
          setErrorKind('crop')
          setError(
            'The saved crop could not be applied. Draw a new crop or explicitly choose Full source.'
          )
        }
      } catch (e) {
        if (id === request.current.value) {
          setErrorKind('preview')
          setError(describeError(e))
        }
      } finally {
        if (id === request.current.value) setLoading(false)
      }
    },
    []
  )

  // Continuing with the source that is already in use keeps its saved crop to edit.
  const open = useCallback(
    (source: Source): void => {
      void choose(source, source.id === currentId ? currentCrop.current : null)
    },
    [choose, currentId]
  )

  useEffect(() => {
    if (!active) return
    let live = true
    const requests = request.current
    void Promise.all([
      invoke<Source[]>('source_catalog'),
      invoke<PickerState>('source_picker_state')
    ]).then(
      ([catalog, state]) => {
        if (!live) return
        setSources(catalog)
        setCurrentId(state.sourceId)
        currentCrop.current = state.crop
        setLoading(false)
        const source = catalog.find((item) => item.id === state.sourceId)
        setPicked((previous) =>
          previous && catalog.some((item) => item.id === previous.id) ? previous : (source ?? null)
        )
        if ((editCurrent.current ?? state.editCurrent) && source) void choose(source, state.crop)
      },
      (e: unknown) => {
        if (live) {
          setErrorKind('catalog')
          setError(describeError(e))
          setLoading(false)
        }
      }
    )
    return () => {
      live = false
      requests.value++
    }
  }, [active, generation, choose])

  useEffect(() => {
    const el = viewport.current
    if (!el || !preview) return
    const observer = new ResizeObserver(() => {
      // Contain within the content box, but never upscale a small window into a blur.
      const style = getComputedStyle(el)
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const height =
        el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      const scale = Math.max(0, Math.min(1, width / preview.width, height / preview.height))
      setFit({ width: preview.width * scale, height: preview.height * scale })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [preview])

  const back = useCallback((): void => {
    request.current.value++
    drag.current = null
    setSelected(null)
    setPreview(null)
    setCrop(null)
    setError(null)
    setLoading(false)
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (saving) return
      if (event.key === 'Escape') {
        if (selected) back()
        else void close()
      } else if (
        event.key === 'Enter' &&
        !selected &&
        picked &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        open(picked)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [selected, picked, saving, back, open])

  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - bounds.left) * (preview?.width ?? 0)) / bounds.width,
      y: ((event.clientY - bounds.top) * (preview?.height ?? 0)) / bounds.height
    }
  }
  const updateCrop = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId || !preview) return
    setCrop(cropFromDrag(drag.current.start, point(event), preview.width, preview.height))
  }
  const save = async (): Promise<void> => {
    if (!selected || !preview || cropInvalid || saving) return
    setSaving(true)
    setError(null)
    try {
      await invoke('commit_source', {
        sourceId: selected.id,
        // Preview rescaling is display-only. Preserve the original reference until
        // the user actually edits it, avoiding rounding drift across displays.
        crop: cropEdited ? crop : savedCrop.current
      })
    } catch (e) {
      setErrorKind('save')
      setError(describeError(e))
      setSaving(false)
      return
    }
    setSaving(false)
    try {
      await close()
    } catch (e) {
      setErrorKind('close')
      setError(`Source and crop saved. Could not close the picker: ${describeError(e)}`)
    }
  }
  const retry = (): void => {
    if (errorKind === 'save') void save()
    else if (errorKind === 'close')
      void close().catch((e: unknown) =>
        setError(`Source and crop saved. Could not close the picker: ${describeError(e)}`)
      )
    else if (errorKind === 'preview' && selected) void choose(selected, savedCrop.current)
    else refresh()
  }
  const displays = sources.filter(isDisplay)
  const windows = sources.filter((source) => !isDisplay(source))
  const tile = (source: Source): JSX.Element => (
    <SourceTile
      key={`${generation}-${source.id}`}
      source={source}
      picked={picked?.id === source.id}
      current={source.id === currentId}
      onPick={() => setPicked(source)}
      onOpen={() => open(source)}
    />
  )

  if (!active) return <div className="source-picker" />

  const title = selected ? `Crop · ${sourceTitle(selected)}` : 'Select source'
  const errorBlock = error && (
    <Callout tone="danger" className="sp-error">
      <span>{error}</span>
      {errorKind !== 'crop' && (
        <button type="button" className="k-link sp-retry" onClick={retry}>
          Try again
        </button>
      )}
    </Callout>
  )

  return (
    <div className="source-picker">
      <header
        className="native-titlebar"
        onMouseDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
          startDrag()
        }}
      >
        <span className="native-titlebar-title">{title}</span>
        <div className="native-window-actions">
          <button
            type="button"
            aria-label="Close source picker"
            title="Close"
            disabled={saving}
            onClick={() => void close()}
          >
            <X />
          </button>
        </div>
      </header>

      {!selected ? (
        <div className="sp-scroll">
          {errorBlock}
          {loading && sources.length === 0 && (
            <div className="sp-status" role="status">
              <Spinner label="Finding sources" />
              Finding available sources…
            </div>
          )}
          {displays.length > 0 && <Section title="Screens">{displays.map(tile)}</Section>}
          {windows.length > 0 && (
            <Section title="App windows" count={windows.length}>
              {windows.map(tile)}
            </Section>
          )}
          {!loading && !error && sources.length === 0 && (
            <EmptyState
              icon={<Monitor />}
              title="No sources available"
              actions={
                <Button size="sm" onClick={refresh}>
                  <RefreshCw />
                  Refresh
                </Button>
              }
            >
              Enable Screen Recording for Kimochi, then refresh.
            </EmptyState>
          )}
        </div>
      ) : (
        <div className="sp-crop">
          {errorBlock}
          <div className="sp-crop-viewport" ref={viewport}>
            {loading && (
              <div className="sp-status" role="status">
                <Spinner label="Loading preview" />
                Loading full preview…
              </div>
            )}
            {preview && (
              <div
                className="sp-crop-surface"
                style={fit}
                onPointerDown={(event) => {
                  if (event.button !== 0 || saving || drag.current) return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  drag.current = { start: point(event), pointerId: event.pointerId, previous: crop }
                  setCrop(null)
                }}
                onPointerMove={updateCrop}
                onPointerUp={(event) => {
                  if (!drag.current || drag.current.pointerId !== event.pointerId) return
                  const next = cropFromDrag(
                    drag.current.start,
                    point(event),
                    preview.width,
                    preview.height
                  )
                  setCrop(next ?? drag.current.previous)
                  if (next) {
                    setCropEdited(true)
                    setCropInvalid(false)
                    setError(null)
                  }
                  drag.current = null
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }}
                onPointerCancel={(event) => {
                  if (drag.current?.pointerId !== event.pointerId) return
                  setCrop(drag.current.previous)
                  drag.current = null
                }}
                onLostPointerCapture={(event) => {
                  if (drag.current?.pointerId !== event.pointerId) return
                  setCrop(drag.current.previous)
                  drag.current = null
                }}
              >
                <img src={preview.url} alt={`Preview of ${selected.name}`} draggable={false} />
                {crop && (
                  <div
                    className="sp-crop-rect"
                    style={{
                      left: `${(100 * crop.x) / preview.width}%`,
                      top: `${(100 * crop.y) / preview.height}%`,
                      width: `${(100 * crop.width) / preview.width}%`,
                      height: `${(100 * crop.height) / preview.height}%`
                    }}
                  >
                    <span className="k-num">
                      {crop.width} × {crop.height}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Bar position="bottom" className="sp-footer">
        {selected ? (
          <>
            <Button variant="ghost" disabled={saving} onClick={back}>
              <ArrowLeft />
              Sources
            </Button>
            <Button
              variant="ghost"
              disabled={(!crop && !cropInvalid) || saving}
              onClick={() => {
                setCrop(null)
                setCropEdited(true)
                setCropInvalid(false)
                setError(null)
              }}
            >
              <Maximize />
              Full source
            </Button>
            <span className="sp-footer-note k-num">
              {crop
                ? `${crop.width} × ${crop.height} px crop`
                : preview
                  ? `Drag to crop · ${preview.width} × ${preview.height} px`
                  : ''}
            </span>
            <BarSpacer />
            <Button
              variant="primary"
              disabled={!preview || saving || cropInvalid}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : crop ? 'Save crop' : 'Use full source'}
            </Button>
          </>
        ) : (
          <>
            <IconButton label="Refresh sources" disabled={loading} onClick={refresh}>
              <RefreshCw />
            </IconButton>
            <span className="sp-footer-note">Previews stay on this device.</span>
            <BarSpacer />
            <Button variant="ghost" onClick={() => void close()}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!picked} onClick={() => picked && open(picked)}>
              Continue
            </Button>
          </>
        )}
      </Bar>
    </div>
  )
}
