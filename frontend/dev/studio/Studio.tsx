/**
 * DEV-ONLY: the UI studio (`npm run studio`). Every Kimochi surface in one place, each as the real
 * preview page (frontend/dev/*.html, the app's own code against a mocked Tauri runtime) in a frame
 * on a desktop: the windows movable and resizable, the overlay and Gaming Mode on a screen of their
 * own. The top bar picks the surface and the appearance and platform; the side panel changes the
 * state the page starts in (its URL parameters, and JSON for anything bigger) for wherever the
 * reader has clicked to inside it, and collects copy edits made in place.
 *
 * State lives in localStorage, so a reload or a hot update comes back to the same place.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Theme } from '@radix-ui/themes'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { Check, ExternalLink, Link2, Maximize, PencilLine, RotateCw, SlidersHorizontal } from 'lucide-react'
import { IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Select, cn } from '@kit'
import KimochiLogo from '../../components/KimochiLogo'
import { APP_SURFACES, GLOBAL_CONTROLS } from './surfaces'
import { activeAxes, controlValue, frameUrl, impliedParams, storedValue, type Values } from './params'
import { Stage, type Placement } from './Stage'
import { CopyPanel, StatePanel } from './Inspector'
import { installCopyEdit, type CopyChange } from './copyEdit'
import type { StudioState } from './bridge'
import type { StudioContext, Surface } from './types'

// The overlay and Gaming Mode surfaces, and any other catalogue added beside this one.
const EXTRA = import.meta.glob<{ [name: string]: unknown }>('./surfaces-*.ts', { eager: true })
const SURFACES: readonly Surface[] = [
  ...APP_SURFACES,
  ...Object.values(EXTRA).flatMap((module) =>
    Object.values(module).filter((v): v is Surface[] => Array.isArray(v)).flat()
  )
]

const STORE = 'kimochi-studio:v1'

interface Saved {
  surface: string
  globals: Values
  values: Record<string, Values>
  json: Record<string, Record<string, string>>
  contexts: Record<string, StudioContext>
  placements: Record<string, Placement>
  zoom: 'fit' | number
  panel: 'state' | 'copy'
  copyEditing: boolean
  changes: CopyChange[]
}

const EMPTY: Saved = {
  surface: 'main',
  globals: {},
  values: {},
  json: {},
  contexts: {},
  placements: {},
  zoom: 'fit',
  panel: 'state',
  copyEditing: false,
  changes: []
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORE)
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Saved>) } : EMPTY
  } catch {
    return EMPTY
  }
}

function save(saved: Saved): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(saved))
  } catch {
    // Storage blocked: the studio still works for this visit.
  }
}

/** The JSON state handed to the frame (bridge.ts): parsed, skipping anything that does not parse. */
function parsedJson(texts: Record<string, string> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, text] of Object.entries(texts ?? {})) {
    try {
      out[key] = JSON.parse(text)
    } catch {
      // Never applied: the editor only applies JSON that parses.
    }
  }
  return out
}

const sameContext = (a: StudioContext, b: StudioContext): boolean =>
  Object.keys({ ...a, ...b }).every((k) => a[k] === b[k])

function sizePresets(surface: Surface): { label: string; width: number; height: number }[] {
  const { width, height, minWidth, minHeight } = surface.size
  if (surface.frameless)
    return [
      { label: 'Steam Deck', width: 1280, height: 800 },
      { label: 'MacBook Air', width: 1470, height: 956 },
      { label: '1080p display', width: 1920, height: 1080 },
      { label: '720p window', width: 1280, height: 720 }
    ]
  return [
    { label: 'Its usual size', width, height },
    ...(minWidth && minHeight ? [{ label: 'Smallest', width: minWidth, height: minHeight }] : []),
    { label: 'Steam Deck screen', width: 1280, height: 800 },
    { label: 'Large', width: Math.round(width * 1.5), height: Math.round(height * 1.4) }
  ]
}

export function Studio(): ReactNode {
  const [saved, setSaved] = useState<Saved>(load)
  const savedRef = useRef(saved)
  useLayoutEffect(() => {
    savedRef.current = saved
  })
  useEffect(() => save(saved), [saved])
  const update = useCallback((change: (s: Saved) => Partial<Saved>) => setSaved((s) => ({ ...s, ...change(s) })), [])

  const surface = SURFACES.find((s) => s.id === saved.surface) ?? SURFACES[0]
  const values = saved.values[surface.id] ?? {}
  const json = saved.json[surface.id] ?? {}
  const context = saved.contexts[surface.id] ?? {}
  const frameRef = useRef<HTMLIFrameElement>(null)

  // The frame's URL changes only when the studio asks for a reload: wandering about inside the
  // frame updates the context without reloading it.
  const [frame, setFrame] = useState(() => {
    ;(window as unknown as { __kimochiStudio: StudioState }).__kimochiStudio = { json: parsedJson(json) }
    return { key: 0, url: frameUrl(surface, saved.globals, context, values) }
  })
  const reloadWith = useCallback(
    (next: Saved) => {
      const s = SURFACES.find((x) => x.id === next.surface) ?? SURFACES[0]
      const studio: StudioState = { json: parsedJson(next.json[s.id]) }
      ;(window as unknown as { __kimochiStudio: StudioState }).__kimochiStudio = studio
      setFrame((f) => ({
        key: f.key + 1,
        url: frameUrl(s, next.globals, next.contexts[s.id] ?? {}, next.values[s.id] ?? {})
      }))
    },
    []
  )
  /** Change state the frame starts from, and reload it with that. */
  const change = (patch: (s: Saved) => Partial<Saved>): void => {
    const next = { ...savedRef.current, ...patch(savedRef.current) }
    savedRef.current = next
    setSaved(next)
    reloadWith(next)
  }

  const setValue = (param: string, value: string | undefined): void =>
    change((s) => {
      const current = { ...(s.values[surface.id] ?? {}) }
      if (value === undefined) delete current[param]
      else current[param] = value
      return { values: { ...s.values, [surface.id]: current } }
    })
  const setGlobal = (param: string, value: string | undefined): void =>
    change((s) => {
      const globals = { ...s.globals }
      if (value === undefined) delete globals[param]
      else globals[param] = value
      return { globals }
    })
  const setJson = (key: string, text: string | undefined): void =>
    change((s) => {
      const current = { ...(s.json[surface.id] ?? {}) }
      if (text === undefined) delete current[key]
      else current[key] = text
      return { json: { ...s.json, [surface.id]: current } }
    })
  const setContext = (param: string, value: string): void =>
    change((s) => ({ contexts: { ...s.contexts, [surface.id]: { ...(s.contexts[surface.id] ?? {}), [param]: value } } }))
  const chooseSurface = (id: string): void => change(() => ({ surface: id }))
  const placement = saved.placements[surface.id]
  const setPlacement = useCallback(
    (p: Placement) => update((s) => ({ placements: { ...s.placements, [s.surface]: p } })),
    [update]
  )

  // Where the reader is inside the frame, followed as they click about.
  useEffect(() => {
    if (!surface.locate) return
    const timer = setInterval(() => {
      const win = frameRef.current?.contentWindow
      if (!win) return
      let found: StudioContext
      try {
        found = surface.locate!(win)
      } catch {
        return
      }
      update((s) => {
        const current = s.contexts[surface.id] ?? {}
        const next = { ...current, ...found }
        return sameContext(current, next) ? {} : { contexts: { ...s.contexts, [surface.id]: next } }
      })
    }, 400)
    return () => clearInterval(timer)
  }, [surface, update])

  // Copy editing, installed into each frame as it loads.
  const uninstall = useRef<(() => void) | null>(null)
  const place = [surface.label, ...activeAxes(surface, context).map(({ axis, value }) => axis.options.find((o) => o.value === value)?.label ?? value)].join(' › ')
  const placeRef = useRef(place)
  useLayoutEffect(() => {
    placeRef.current = place
  })
  const installEditing = useCallback(() => {
    uninstall.current?.()
    uninstall.current = null
    const doc = frameRef.current?.contentDocument
    if (!doc?.body || !savedRef.current.copyEditing) return
    uninstall.current = installCopyEdit(doc, {
      surface: surface.label,
      place: () => placeRef.current,
      kept: () => savedRef.current.changes.filter((c) => c.surface === surface.label && c.before),
      onChange: (c, removed) =>
        update((s) => {
          const rest = s.changes.filter((x) => x.key !== c.key)
          if (removed) return { changes: rest }
          const at = s.changes.findIndex((x) => x.key === c.key)
          if (at === -1) return { changes: [...rest, c] }
          const next = [...s.changes]
          next[at] = { ...c, note: s.changes[at].note }
          return { changes: next }
        })
    })
  }, [surface.label, update])
  useEffect(() => {
    installEditing()
  }, [saved.copyEditing, installEditing])

  // The studio's own appearance follows the one chosen for the app.
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const theme = saved.globals.theme ?? 'system'
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.classList.toggle('light', !dark)
  }, [dark])

  const groups = useMemo(() => {
    const map = new Map<string, Surface[]>()
    for (const s of SURFACES) map.set(s.group, [...(map.get(s.group) ?? []), s])
    return [...map]
  }, [])

  const [linkCopied, setLinkCopied] = useState(false)
  const absoluteUrl = new URL(frame.url, location.href).href
  const axes = activeAxes(surface, context)
  const box = placement ?? { width: surface.size.width, height: surface.size.height, x: 0, y: 0 }

  return (
    <Theme appearance={dark ? 'dark' : 'light'} accentColor="indigo" grayColor="slate" radius="medium" panelBackground="solid">
      <TooltipProvider delayDuration={500}>
        <div className="studio">
          <header className="studio-top">
            <span className="studio-brand">
              <KimochiLogo size={18} />
              <span>Kimochi studio</span>
            </span>
            <nav className="studio-nav" aria-label="Surfaces">
              {groups.map(([group, list]) =>
                list.length === 1 ? (
                  <button
                    key={group}
                    type="button"
                    className="studio-nav-item"
                    data-active={list[0].id === surface.id || undefined}
                    onClick={() => chooseSurface(list[0].id)}
                  >
                    {group}
                  </button>
                ) : (
                  <Menu key={group}>
                    <MenuTrigger asChild>
                      <button type="button" className="studio-nav-item" data-active={list.some((s) => s.id === surface.id) || undefined}>
                        {group}
                        {list.some((s) => s.id === surface.id) && <span className="studio-nav-sub">{surface.label}</span>}
                      </button>
                    </MenuTrigger>
                    <MenuContent align="start">
                      <MenuLabel>{group}</MenuLabel>
                      {list.map((s) => (
                        <MenuItem key={s.id} onSelect={() => chooseSurface(s.id)}>
                          {s.id === surface.id ? <Check /> : <span className="studio-menu-gap" />}
                          {s.label}
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                )
              )}
            </nav>
            <div className="studio-globals">
              {GLOBAL_CONTROLS.map((control) =>
                control.kind === 'select' ? (
                  <Select
                    key={control.param}
                    aria-label={control.label}
                    size="sm"
                    variant="ghost"
                    value={controlValue(control, saved.globals, impliedParams(surface, context))}
                    onValueChange={(v) => setGlobal(control.param, storedValue(control, v, impliedParams(surface, context)))}
                    options={control.options}
                  />
                ) : null
              )}
            </div>
          </header>

          <div className="studio-body">
            <main className="studio-main">
              <div className="studio-toolbar">
                <div className="studio-contexts">
                  {axes.map(({ axis, value }) => (
                    <div key={axis.param} className="studio-axis" role="tablist" aria-label={axis.label}>
                      <span className="studio-axis-label">{axis.label}</span>
                      {axis.options.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          role="tab"
                          aria-selected={o.value === value}
                          className="studio-axis-item"
                          onClick={() => setContext(axis.param, o.value)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  ))}
                  {axes.length === 0 && <span className="studio-axis-label">{surface.label}</span>}
                </div>
                <div className="studio-tools">
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" className="studio-size k-num">
                        <Maximize aria-hidden />
                        {box.width} × {box.height}
                        {' · '}
                        {saved.zoom === 'fit' ? 'Fit' : `${Math.round(saved.zoom * 100)}%`}
                      </button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuLabel>Size</MenuLabel>
                      {sizePresets(surface).map((p) => (
                        <MenuItem
                          key={p.label}
                          onSelect={() =>
                            setPlacement({
                              x: surface.frameless ? 0 : box.x,
                              y: surface.frameless ? 0 : box.y,
                              width: p.width,
                              height: p.height
                            })
                          }
                        >
                          {p.label}
                          <span className="studio-menu-meta k-num">
                            {p.width} × {p.height}
                          </span>
                        </MenuItem>
                      ))}
                      {!surface.frameless && (
                        <MenuItem onSelect={() => update((s) => { const placements = { ...s.placements }; delete placements[surface.id]; return { placements } })}>
                          Centre at its usual size
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuLabel>Zoom</MenuLabel>
                      {(['fit', 1, 0.75, 0.5] as const).map((z) => (
                        <MenuItem key={String(z)} onSelect={() => update(() => ({ zoom: z }))}>
                          {saved.zoom === z ? <Check /> : <span className="studio-menu-gap" />}
                          {z === 'fit' ? 'Fit the desk' : `${z * 100}%`}
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                  <IconButton size="sm" label="Reload the window" onClick={() => reloadWith(savedRef.current)}>
                    <RotateCw />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={linkCopied ? 'Copied' : 'Copy the page’s URL'}
                    onClick={() =>
                      void navigator.clipboard.writeText(absoluteUrl).then(() => {
                        setLinkCopied(true)
                        setTimeout(() => setLinkCopied(false), 1400)
                      })
                    }
                  >
                    {linkCopied ? <Check /> : <Link2 />}
                  </IconButton>
                  <IconButton size="sm" label="Open the page on its own" onClick={() => window.open(absoluteUrl, '_blank')}>
                    <ExternalLink />
                  </IconButton>
                </div>
              </div>
              <Stage
                surface={surface}
                url={frame.url}
                frameKey={frame.key}
                placement={placement}
                onPlacement={setPlacement}
                zoom={saved.zoom}
                frameRef={frameRef}
                onFrameLoad={installEditing}
                copyEditing={saved.copyEditing}
              />
            </main>

            <aside className="studio-panel">
              <div className="studio-panel-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={saved.panel === 'state'}
                  onClick={() => update(() => ({ panel: 'state' }))}
                >
                  <SlidersHorizontal aria-hidden /> State
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={saved.panel === 'copy'}
                  onClick={() => update(() => ({ panel: 'copy' }))}
                >
                  <PencilLine aria-hidden /> Copy
                  {saved.changes.length > 0 && <span className={cn('studio-count k-num')}>{saved.changes.length}</span>}
                </button>
              </div>
              {saved.panel === 'state' ? (
                <StatePanel
                  surface={surface}
                  context={context}
                  values={values}
                  onValue={setValue}
                  onReset={() =>
                    change((s) => {
                      const v = { ...s.values }
                      const j = { ...s.json }
                      delete v[surface.id]
                      delete j[surface.id]
                      return { values: v, json: j }
                    })
                  }
                  json={json}
                  onJson={setJson}
                />
              ) : (
                <CopyPanel
                  editing={saved.copyEditing}
                  onEditing={(on) => update(() => ({ copyEditing: on }))}
                  changes={saved.changes}
                  onChanges={(changes) => update(() => ({ changes }))}
                  place={place}
                  surface={surface}
                />
              )}
            </aside>
          </div>
        </div>
      </TooltipProvider>
    </Theme>
  )
}
