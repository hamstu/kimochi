import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AppWindow, ArrowLeft, Check, Crop as CropIcon, Monitor, RefreshCw, X } from 'lucide-react'
import { cropFromDrag, scaleCrop, type Crop, type Point } from './crop'
import { useNativeHover } from '../shell/useNativeHover'
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

function SourceCard({
  source,
  selected,
  onSelect
}: {
  source: Source
  selected: boolean
  onSelect: () => void
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
  return (
    <button
      ref={ref}
      className={`source-card${selected ? ' selected' : ''}`}
      onClick={onSelect}
      title={[source.app, source.name].filter(Boolean).join(' — ')}
    >
      <span className="source-thumbnail">
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
          <span className="source-placeholder">
            <Icon size={28} />
            <span>{failed ? 'Preview unavailable' : 'Loading preview…'}</span>
          </span>
        )}
        {selected && (
          <span className="source-current">
            <Check size={13} />
            Current
          </span>
        )}
      </span>
      <span className="source-caption">
        {icon ? <img className="source-icon" src={icon} alt="" /> : <Icon size={18} />}
        <span>
          <strong>{source.app || source.name || 'Untitled window'}</strong>
          {source.app && <small>{source.name || 'Untitled window'}</small>}
        </span>
      </span>
    </button>
  )
}

export default function SourcePicker(): JSX.Element {
  const [active, setActive] = useState(false)
  useNativeHover(active)
  const [sources, setSources] = useState<Source[]>([])
  const [selected, setSelected] = useState<Source | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
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
        setLoading(false)
        const source = catalog.find((item) => item.id === state.sourceId)
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
      const scale = Math.min(el.clientWidth / preview.width, el.clientHeight / preview.height)
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
      if (event.key !== 'Escape' || saving) return
      if (selected) back()
      else void close()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [selected, saving, back])

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
  const displays = sources.filter(isDisplay)
  const windows = sources.filter((source) => !isDisplay(source))

  if (!active) return <section className="source-picker" />

  return (
    <section className="source-picker">
      <header className="source-picker-header">
        {selected && (
          <button
            className="source-icon-button"
            title="Choose another source"
            disabled={saving}
            onClick={back}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <div>
          <h1>{selected ? selected.app || selected.name : 'Select a source'}</h1>
          <p>
            {selected
              ? 'Drag to crop, or continue with the full source.'
              : 'Choose a screen or an app window.'}
          </p>
        </div>
        <button
          className="source-icon-button"
          title="Close source picker"
          disabled={saving}
          onClick={() => void close()}
        >
          <X size={18} />
        </button>
      </header>
      {error && (
        <div className="source-error" role="alert">
          {error}
          {errorKind !== 'crop' && (
            <button
              onClick={() => {
                if (errorKind === 'save') void save()
                else if (errorKind === 'close')
                  void close().catch((e: unknown) =>
                    setError(
                      `Source and crop saved. Could not close the picker: ${describeError(e)}`
                    )
                  )
                else if (errorKind === 'preview' && selected)
                  void choose(selected, savedCrop.current)
                else refresh()
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {!selected ? (
        <div className="source-picker-scroll">
          {loading && (
            <p className="source-empty" role="status">
              Finding available sources…
            </p>
          )}
          {displays.length > 0 && (
            <>
              <h2>Screens</h2>
              <div className="source-grid screens">
                {displays.map((source) => (
                  <SourceCard
                    key={`${generation}-${source.id}`}
                    source={source}
                    selected={source.id === currentId}
                    onSelect={() => void choose(source)}
                  />
                ))}
              </div>
            </>
          )}
          {windows.length > 0 && (
            <>
              <h2>
                App windows <span>{windows.length}</span>
              </h2>
              <div className="source-grid">
                {windows.map((source) => (
                  <SourceCard
                    key={`${generation}-${source.id}`}
                    source={source}
                    selected={source.id === currentId}
                    onSelect={() => void choose(source)}
                  />
                ))}
              </div>
            </>
          )}
          {!loading && !error && sources.length === 0 && (
            <p className="source-empty">
              No sources available. Enable Screen Recording for Kimochi, then refresh.
            </p>
          )}
        </div>
      ) : (
        <div className="source-crop-viewport" ref={viewport}>
          {loading && <p role="status">Loading full preview…</p>}
          {preview && (
            <div
              className="source-crop-surface"
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
                  className="source-crop-rect"
                  style={{
                    left: `${(100 * crop.x) / preview.width}%`,
                    top: `${(100 * crop.y) / preview.height}%`,
                    width: `${(100 * crop.width) / preview.width}%`,
                    height: `${(100 * crop.height) / preview.height}%`
                  }}
                >
                  <span>
                    {crop.width} × {crop.height}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <footer className="source-picker-footer">
        {selected ? (
          <>
            <button
              className="source-secondary"
              disabled={(!crop && !cropInvalid) || saving}
              onClick={() => {
                setCrop(null)
                setCropEdited(true)
                setCropInvalid(false)
                setError(null)
              }}
            >
              <CropIcon size={15} />
              Full source
            </button>
            <span>
              {crop
                ? `${crop.width} × ${crop.height} px crop`
                : preview
                  ? `${preview.width} × ${preview.height} px`
                  : ''}
            </span>
            <button
              className="source-primary"
              disabled={!preview || saving || cropInvalid}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : crop ? 'Save crop' : 'Continue'}
              <Check size={15} />
            </button>
          </>
        ) : (
          <>
            <span>Previews stay on this device.</span>
            <button className="source-secondary" disabled={loading} onClick={refresh}>
              <RefreshCw size={14} />
              Refresh
            </button>
          </>
        )}
      </footer>
    </section>
  )
}
