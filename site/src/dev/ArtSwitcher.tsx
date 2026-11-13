/**
 * DEV ONLY: try the guide's portrait art. Loaded from main.tsx behind `import.meta.env.DEV`, so
 * production builds never include it. The pill in the bottom-right corner opens a panel that picks
 * the shipped faces, the original (AI-made) ones, or a Sutemo character built live (hair, colours, outfit, accessories, and which of the
 * PSD's expressions each of Mochiko's faces uses), kept in localStorage (guide/art.ts).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_ART, SUTEMO, layers, setArt, useArt, type ArtConfig } from '../demo/guide/art'
import type { Face } from '../demo/guide/Guide'

interface Option {
  id: string
  label: string
}
interface Manifest {
  colors: string[]
  eyes: string[]
  back: Option[]
  front: Option[]
  costume: Option[]
  accessory: Option[]
  blush: string[]
  expression: Option[]
}

const FACES: Face[] = ['happy', 'excited', 'surprised', 'thinking', 'wink', 'sad', 'proud']
const SWATCH: Record<string, string> = {
  blond: '#f1d27a',
  silver: '#cfd3dc',
  pink: '#f4a7c4',
  brown: '#8a5a3c',
  dark: '#2b2733',
  blue: '#5b9be0',
  red: '#d6455a',
  green: '#5fb27a',
  magenta: '#c0307a',
  gold: '#c79a2a',
  violet: '#7a4fd0'
}

function Stack({ config, expression, size }: { config: ArtConfig; expression: string; size: number }) {
  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg bg-white/5" style={{ width: size, height: size }}>
      {layers(config, expression).map((src) => (
        <img key={src} src={src} alt="" className="absolute inset-0 size-full" draggable={false} />
      ))}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3 py-1">
      <span className="w-24 shrink-0 text-white/60">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</span>
    </label>
  )
}

const select = 'min-w-0 flex-1 rounded-md bg-white/10 px-2 py-1 text-white outline-none [&>option]:text-black'

function Swatches({ values, value, onChange }: { values: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          title={v}
          onClick={() => onChange(v)}
          className={`size-6 rounded-full border-2 ${value === v ? 'border-white' : 'border-transparent'}`}
          style={{ background: SWATCH[v] ?? '#888' }}
        />
      ))}
    </>
  )
}

function ArtSwitcher() {
  const art = useArt()
  const [open, setOpen] = useState(false)
  const [m, setM] = useState<Manifest | null>(null)
  useEffect(() => {
    if (!open || m) return
    fetch(`${SUTEMO}/manifest.json`)
      .then((r) => r.json())
      .then(setM)
      .catch(() => {})
  }, [open, m])

  const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]
  const randomise = (): void => {
    if (!m) return
    setArt({
      art: 'sutemo',
      back: pick(m.back).id,
      front: pick(m.front).id,
      hair: pick(m.colors),
      eyes: pick(m.eyes),
      costume: pick(m.costume).id
    })
  }

  return (
    <div className="fixed right-4 bottom-4 z-[2147483000] font-sans text-[13px] text-white">
      {open && m && (
        <div className="mb-2 max-h-[80vh] w-[440px] overflow-y-auto rounded-xl bg-[#1d1b26]/95 p-4 shadow-2xl ring-1 ring-white/10 backdrop-blur">
          <div className="mb-3 flex items-center gap-2">
            <strong className="text-sm">Guide art</strong>
            <span className="ml-auto flex gap-1 rounded-lg bg-white/10 p-0.5">
              {(['files', 'sutemo', 'original'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setArt({ art: a })}
                  className={`rounded-md px-2.5 py-1 ${art.art === a ? 'bg-white/20' : 'text-white/60'}`}
                >
                  {a === 'files' ? 'Shipped' : a === 'sutemo' ? 'Builder' : 'Original (AI)'}
                </button>
              ))}
            </span>
          </div>

          {art.art === 'sutemo' && (
            <>
              <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
                {FACES.map((f) => (
                  <div key={f} className="text-center text-[11px] text-white/60">
                    <Stack config={art} expression={art.faces[f]} size={56} />
                    {f}
                  </div>
                ))}
              </div>
              <Row label="Hair (back)">
                <select className={select} value={art.back} onChange={(e) => setArt({ back: e.target.value })}>
                  {m.back.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Hair (front)">
                <select className={select} value={art.front} onChange={(e) => setArt({ front: e.target.value })}>
                  {m.front.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Hair colour">
                <Swatches values={m.colors} value={art.hair} onChange={(hair) => setArt({ hair })} />
              </Row>
              <Row label="Ahoge">
                <input type="checkbox" checked={art.ahoge} onChange={(e) => setArt({ ahoge: e.target.checked })} />
              </Row>
              <Row label="Eyes">
                <Swatches values={m.eyes} value={art.eyes} onChange={(eyes) => setArt({ eyes })} />
              </Row>
              <Row label="Outfit">
                <select className={select} value={art.costume} onChange={(e) => setArt({ costume: e.target.value })}>
                  {m.costume.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Blush">
                <select className={select} value={art.blush} onChange={(e) => setArt({ blush: e.target.value })}>
                  <option value="">None</option>
                  {m.blush.map((b) => (
                    <option key={b} value={b}>
                      Blush {b}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Accessories">
                {m.accessory.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() =>
                      setArt({
                        accessories: art.accessories.includes(o.id)
                          ? art.accessories.filter((a) => a !== o.id)
                          : [...art.accessories, o.id]
                      })
                    }
                    className={`rounded-full px-2 py-0.5 ${art.accessories.includes(o.id) ? 'bg-white/25' : 'bg-white/5 text-white/60'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </Row>
              <div className="mt-3 mb-1 text-white/60">Expression for each face</div>
              {FACES.map((f) => (
                <Row key={f} label={f}>
                  <select
                    className={select}
                    value={art.faces[f]}
                    onChange={(e) => setArt({ faces: { ...art.faces, [f]: e.target.value } })}
                  >
                    {m.expression.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Row>
              ))}
              <div className="mt-3 flex gap-2">
                <button type="button" className="rounded-md bg-white/10 px-3 py-1" onClick={randomise}>
                  Randomise
                </button>
                <button type="button" className="rounded-md bg-white/10 px-3 py-1" onClick={() => setArt(DEFAULT_ART)}>
                  Reset
                </button>
                <button
                  type="button"
                  className="ml-auto rounded-md bg-white/10 px-3 py-1"
                  onClick={() => void navigator.clipboard.writeText(JSON.stringify(art, null, 2))}
                >
                  Copy settings
                </button>
              </div>
              <p className="mt-3 text-[11px] text-white/40">
                Art: “Anime Girl Sprite V2” by Sutemo (sutemo.itch.io). Changes show in Mochiko’s box right away.
              </p>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="ml-auto block rounded-full bg-[#1d1b26]/90 px-3 py-1.5 shadow-lg ring-1 ring-white/15"
      >
        {open ? 'Close' : 'Guide art'}
      </button>
    </div>
  )
}

export function mountArtSwitcher(): void {
  const host = document.createElement('div')
  host.setAttribute('data-copy-editor', '')
  document.body.append(host)
  createRoot(host).render(<ArtSwitcher />)
}
