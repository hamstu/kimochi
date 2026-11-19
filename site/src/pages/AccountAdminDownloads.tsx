import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate } from 'react-router'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '../components/Button'
import { Notice } from '../components/account/Notice'
import { AccountSection } from '../components/account/parts'
import { api, ApiError, type AdminDownloads, type DownloadsGithubRelease } from '../lib/api'
import { formatStorage, messageForCode } from '../lib/account.js'
import { useSession } from '../lib/session'

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : messageForCode('internal'))
const num = (n: number) => n.toLocaleString('en-US')

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' }
]

const PLATFORM_LABELS: Record<string, string> = {
  'windows-x64': 'Windows x64',
  'windows-arm64': 'Windows Arm',
  'macos-arm64': 'macOS Apple silicon',
  'macos-x64': 'macOS Intel',
  'linux-x64-appimage': 'Linux x64 · AppImage',
  'linux-x64-deb': 'Linux x64 · deb',
  'linux-x64-rpm': 'Linux x64 · rpm',
  'linux-arm64-appimage': 'Linux Arm · AppImage',
  'linux-arm64-deb': 'Linux Arm · deb',
  'linux-arm64-rpm': 'Linux Arm · rpm'
}
const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? (p || 'Unknown')

/** "Nov 19" (UTC days, so no time-zone shift). */
const shortDay = (day: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`)
  )
const longDay = (day: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${day}T00:00:00Z`))
function ago(iso: string | null) {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** The owner's download stats: installs and updates from the download mirror and GitHub Releases. */
export function AccountAdminDownloads() {
  const { status, user } = useSession()
  if (status === 'loading') {
    return (
      <section className="container-page py-14" aria-busy="true">
        <p className="text-ink-3" role="status">
          Loading…
        </p>
      </section>
    )
  }
  if (status === 'signed-out') return <Navigate to="/account/sign-in?returnTo=%2Faccount%2Fadmin%2Fdownloads" replace />
  if (user?.plan !== 'owner') return <Navigate to="/account" replace />
  return <Downloads />
}

function Downloads() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<AdminDownloads | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let live = true
    setError(null)
    api.adminDownloads(days).then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(e)
    )
    return () => {
      live = false
    }
  }, [days])

  async function refresh() {
    setRefreshing(true)
    setError(null)
    try {
      setData(await api.adminRefreshDownloads(days))
    } catch (e) {
      setError(e)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="container-page py-14 md:py-20">
      <div className="mx-auto max-w-[64rem]">
        <Link to="/account/admin" className="inline-flex items-center gap-1.5 text-small text-ink-3 hover:text-ink">
          <ArrowLeft size={14} aria-hidden /> Admin
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4 pb-8">
          <div>
            <h1 className="text-title text-ink">Downloads</h1>
            <p className="mt-1.5 text-small text-ink-2">
              Installs and updates from Kimochi's download mirror and GitHub Releases.
              {data && <> Updated {ago(data.mirror.refreshedAt ?? data.github.refreshedAt)}, and every hour.</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <RangePicker days={days} onChange={setDays} />
            <Button
              variant="secondary"
              onClick={refresh}
              disabled={refreshing}
              icon={<RefreshCw size={15} aria-hidden className={refreshing ? 'animate-spin' : ''} />}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
        {error ? <Notice tone="danger">{errorText(error)}</Notice> : null}
        {!data ? (
          !error && <p className="text-small text-ink-3">Loading…</p>
        ) : (
          <>
            <MirrorSection data={data} />
            <GithubSection data={data} />
            <AboutSection />
          </>
        )}
      </div>
    </div>
  )
}

function RangePicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex rounded-md bg-field p-0.5 shadow-[inset_0_0_0_1px_var(--k-line-strong)]"
    >
      {RANGES.map((r) => (
        <button
          key={r.days}
          type="button"
          role="radio"
          aria-checked={days === r.days}
          onClick={() => onChange(r.days)}
          className={`h-8 rounded-[5px] px-3 text-small transition-colors duration-100 ${
            days === r.days ? 'bg-raised text-ink shadow-[0_0_0_1px_var(--k-line-strong)]' : 'text-ink-3 hover:text-ink'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- pieces

function Stat({ label, value, hint, swatch }: { label: string; value: string; hint?: string; swatch?: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-raised px-4 py-3">
      <p className="flex items-center gap-1.5 text-meta text-ink-3">
        {swatch && <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: swatch }} />}
        {label}
      </p>
      <p className="mt-1 text-heading text-ink tnum">{value}</p>
      {hint && <p className="mt-0.5 text-meta text-ink-3">{hint}</p>}
    </div>
  )
}

function Table({ head, rows, empty }: { head: ReactNode[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="rounded-lg border border-hairline px-4 py-3 text-small text-ink-3">{empty}</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full border-collapse text-small">
        <thead>
          <tr className="text-left text-ink-3">
            {head.map((h, i) => (
              <th key={i} className={`px-4 py-2 font-medium ${i ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-hairline">
              {r.map((cell, j) => (
                <td key={j} className={`px-4 py-2 ${j ? 'whitespace-nowrap text-right text-ink-2 tnum' : 'text-ink'}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- chart

interface Series {
  key: string
  label: string
  color: string
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    setWidth(Math.floor(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** Round, readable gridline steps: 1, 2, 5 × 10ⁿ. */
function niceMax(max: number) {
  if (max <= 4) return { top: Math.max(max, 1) <= 2 ? 2 : 4, step: max <= 2 ? 1 : 2 }
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!
  return { top: Math.ceil(max / step) * step, step }
}

/**
 * Daily stacked bars, one per UTC day, with a hover tooltip. Days with `null` (no data yet) draw
 * nothing and say so in the tooltip.
 */
function DailyChart({
  rows,
  series,
  label,
  missingLabel
}: {
  rows: ({ day: string } & Record<string, number | null | string>)[]
  series: Series[]
  label: string
  missingLabel: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const height = 200
  const pad = { top: 8, right: 4, bottom: 22, left: 34 }
  const innerW = Math.max(0, width - pad.left - pad.right)
  const innerH = height - pad.top - pad.bottom
  const values = rows.map((r) => series.reduce((n, s) => n + (Number(r[s.key]) || 0), 0))
  const { top, step } = niceMax(Math.max(0, ...values))
  const slot = rows.length ? innerW / rows.length : 0
  const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0
  const barW = Math.max(1, slot - gap)
  const y = (v: number) => pad.top + innerH - (v / top) * innerH
  const ticks: number[] = []
  for (let v = 0; v <= top; v += step) ticks.push(v)
  const xLabels = rows.length <= 1 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1]
  const h = hover === null ? null : rows[hover]

  return (
    <div ref={ref} className="relative min-w-0 overflow-hidden" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--k-line)" strokeWidth={1} />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[11px] tnum">
                {num(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = pad.left + i * slot + gap / 2
            let base = 0
            const filled = series.filter((s) => (Number(r[s.key]) || 0) > 0)
            return (
              <g key={r.day}>
                {hover === i && (
                  <rect x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} fill="var(--k-hover)" />
                )}
                {filled.map((s, j) => {
                  const v = Number(r[s.key])
                  const y0 = y(base)
                  base += v
                  const y1 = y(base)
                  // A 2px surface gap between stacked segments; the top segment gets the rounded end.
                  const hgt = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0))
                  const radius = j === filled.length - 1 ? Math.min(4, barW / 2, hgt) : 0
                  return <path key={s.key} d={barPath(x, y1, barW, hgt, radius)} fill={s.color} />
                })}
              </g>
            )
          })}
          {xLabels.map((i) => (
            <text
              key={i}
              x={pad.left + i * slot + slot / 2}
              y={height - 6}
              textAnchor={
                i === 0 && rows.length > 1 ? 'start' : i === rows.length - 1 && rows.length > 1 ? 'end' : 'middle'
              }
              className="fill-ink-3 text-[11px]"
            >
              {rows[i] && shortDay(rows[i].day)}
            </text>
          ))}
          {/* Hit targets: the whole column, wider than the bar. */}
          {rows.map((r, i) => (
            <rect
              key={r.day}
              x={pad.left + i * slot}
              y={pad.top}
              width={slot}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onTouchStart={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      {h && hover !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 min-w-[10rem] rounded-md border border-hairline bg-raised px-3 py-2 text-meta shadow-[var(--k-shadow-pop)]"
          style={{
            left: Math.min(Math.max(0, pad.left + hover * slot + slot / 2 - 80), Math.max(0, width - 170))
          }}
        >
          <p className="font-medium text-ink">{longDay(h.day)}</p>
          {series.every((s) => h[s.key] === null) ? (
            <p className="mt-1 text-ink-3">{missingLabel}</p>
          ) : (
            <ul className="mt-1 grid gap-0.5">
              {series.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="text-ink tnum">{num(Number(h[s.key]) || 0)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** A bar anchored to the baseline with only its top corners rounded. */
function barPath(x: number, y: number, w: number, h: number, r: number) {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function DailyTable({
  rows,
  series
}: {
  rows: ({ day: string } & Record<string, number | null | string>)[]
  series: Series[]
}) {
  return (
    <details className="text-small">
      <summary className="cursor-pointer text-ink-3 hover:text-ink">Daily numbers</summary>
      <div className="mt-3">
        <Table
          head={['Day', ...series.map((s) => s.label)]}
          rows={[...rows]
            .reverse()
            .map((r) => [longDay(r.day), ...series.map((s) => (r[s.key] === null ? '–' : num(Number(r[s.key]))))])}
          empty="No days."
        />
      </div>
    </details>
  )
}

// ---------------------------------------------------------------- mirror

const INSTALLS: Series = { key: 'install', label: 'New installs', color: 'var(--k-series-1)' }
const UPDATES: Series = { key: 'update', label: 'Updates', color: 'var(--k-series-2)' }

function MirrorSection({ data }: { data: AdminDownloads }) {
  const m = data.mirror
  const startsBefore = m.since && m.since > data.range.from
  const rows = m.daily.map((d) => ({
    ...d,
    install: m.since && d.day < m.since ? null : d.install,
    update: m.since && d.day < m.since ? null : d.update
  }))
  return (
    <AccountSection
      id="mirror"
      title="Download mirror"
      description={
        <>
          <p>downloads.kimochiapp.com, where Kimochi 1.1 and later download from first.</p>
          {m.since && <p className="mt-2 text-ink-3">Counted since {shortDay(m.since)}.</p>}
        </>
      }
    >
      <div className="grid gap-6">
        {m.error && (
          <Notice tone="danger">
            <span className="break-words">Couldn't read Cloudflare's analytics: {m.error}</span>
          </Notice>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="New installs" value={num(m.totals.install)} swatch="var(--k-series-1)" />
          <Stat label="Updates" value={num(m.totals.update)} swatch="var(--k-series-2)" />
          <Stat label="Update checks" value={num(m.totals.update_check)} hint="App launches, roughly" />
          <Stat
            label="Engine & model files"
            value={num(m.totals.component)}
            hint={`${formatStorage(m.totals.bytes)} served in all`}
          />
        </div>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-small font-medium text-ink">Each day</p>
            <Legend items={[INSTALLS, UPDATES]} />
          </div>
          <DailyChart
            rows={rows}
            series={[INSTALLS, UPDATES]}
            label={`New installs and updates from the download mirror each day, ${shortDay(data.range.from)} to ${shortDay(data.range.to)}`}
            missingLabel="Before the mirror was counted"
          />
          {startsBefore && (
            <p className="text-meta text-ink-3">
              Days before {shortDay(m.since!)} have no mirror numbers (Cloudflare keeps 31 days).
            </p>
          )}
          <DailyTable
            rows={rows}
            series={[INSTALLS, UPDATES, { key: 'update_check', label: 'Update checks', color: '' }]}
          />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="grid content-start gap-3">
            <p className="text-small font-medium text-ink">By platform</p>
            <Table
              head={['Platform', 'Installs', 'Updates']}
              rows={m.byPlatform.map((p) => [platformLabel(p.platform), num(p.install), num(p.update)])}
              empty="No installs or updates in this range."
            />
          </div>
          <div className="grid content-start gap-3">
            <p className="text-small font-medium text-ink">By release</p>
            <Table
              head={['Release', 'Installs', 'Updates']}
              rows={m.byVersion.map((v) => [v.version || 'Unknown', num(v.install), num(v.update)])}
              empty="No installs or updates in this range."
            />
          </div>
        </div>
        <div className="grid gap-3">
          <p className="text-small font-medium text-ink">Engine, model and dictionary files</p>
          <Table
            head={['File', 'Downloads', 'Served']}
            rows={m.components.map((c) => [
              <span className="break-all">{c.item}</span>,
              num(c.count),
              formatStorage(c.bytes)
            ])}
            empty="The app hasn't downloaded any engines or models from the mirror in this range."
          />
        </div>
      </div>
    </AccountSection>
  )
}

// ---------------------------------------------------------------- GitHub

const GITHUB_DOWNLOADS: Series = { key: 'downloads', label: 'Downloads', color: 'var(--k-series-1)' }

function sumPlatforms(r: DownloadsGithubRelease, os: 'windows' | 'macos' | 'linux') {
  return Object.entries(r.platforms)
    .filter(([p]) => p.startsWith(os))
    .reduce((n, [, c]) => n + c, 0)
}

function GithubSection({ data }: { data: AdminDownloads }) {
  const g = data.github
  const allTime = g.totals.install + g.totals.update + g.totals.install_or_update
  const inRange = g.daily.reduce((n, d) => n + (d.downloads ?? 0), 0)
  const rangeKnown = g.daily.some((d) => d.downloads !== null)
  return (
    <AccountSection
      id="github"
      title="GitHub Releases"
      description={
        <>
          <p>The fallback, and the only update source for Kimochi 1.0 and earlier.</p>
          <p className="mt-2 text-ink-3">
            GitHub keeps one all-time count per file; daily numbers come from the server's daily snapshot
            {g.since ? `, taken since ${shortDay(g.since)}` : ''}.
          </p>
        </>
      }
    >
      <div className="grid gap-6">
        {g.error && (
          <Notice tone={g.snapshotDay ? 'warn' : 'danger'}>
            <span className="break-words">
              The last refresh couldn't read GitHub: {g.error}
              {g.snapshotDay && ` Showing the snapshot from ${shortDay(g.snapshotDay)}.`}
            </span>
          </Notice>
        )}
        {!g.snapshotDay ? (
          <p className="text-small text-ink-3">No snapshot yet. Refresh to take the first one.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label={`Downloads, last ${data.range.days} days`}
                value={rangeKnown ? num(inRange) : '–'}
                hint={rangeKnown ? undefined : 'Needs two daily snapshots'}
              />
              <Stat label="Downloads, all time" value={num(allTime)} hint="Installs and updates" />
              <Stat
                label="macOS installs / updates"
                value={`${num(g.totals.install)} / ${num(g.totals.update)}`}
                hint="The only split GitHub shows"
              />
              <Stat label="Update checks, all time" value={num(g.totals.update_check)} />
            </div>
            <div className="grid gap-3">
              <p className="text-small font-medium text-ink">Downloads each day</p>
              <DailyChart
                rows={g.daily}
                series={[GITHUB_DOWNLOADS]}
                label={`Downloads from GitHub Releases each day, ${shortDay(data.range.from)} to ${shortDay(data.range.to)}`}
                missingLabel="No earlier snapshot to compare with"
              />
              <DailyTable
                rows={g.daily}
                series={[GITHUB_DOWNLOADS, { key: 'update_check', label: 'Update checks', color: '' }]}
              />
            </div>
            <div className="grid gap-3">
              <p className="text-small font-medium text-ink">By release, all time</p>
              <Table
                head={['Release', 'Windows', 'macOS', 'Linux', 'Total', 'Update checks']}
                rows={g.releases.map((r) => [
                  r.tag,
                  num(sumPlatforms(r, 'windows')),
                  num(sumPlatforms(r, 'macos')),
                  num(sumPlatforms(r, 'linux')),
                  <span className="text-ink">{num(r.install + r.update + r.install_or_update)}</span>,
                  num(r.update_check)
                ])}
                empty="No releases."
              />
            </div>
            <div className="grid gap-3">
              <p className="text-small font-medium text-ink">By platform, all time</p>
              <Table
                head={['Platform', 'Downloads']}
                rows={g.byPlatform.map((p) => [platformLabel(p.platform), num(p.count)])}
                empty="No downloads."
              />
            </div>
          </>
        )}
      </div>
    </AccountSection>
  )
}

function AboutSection() {
  return (
    <AccountSection id="about" title="What counts">
      <ul className="grid list-disc gap-2 pl-5 text-small text-ink-2">
        <li>
          <span className="text-ink">New installs</span>: an installer downloaded from the mirror by a browser or
          install.sh.
        </li>
        <li>
          <span className="text-ink">Updates</span>: the app's updater downloading a new version. An update check is the
          updater asking whether there is one, shortly after launch and every six hours, so it tracks how often the app
          runs, not people.
        </li>
        <li>
          <span className="text-ink">GitHub</span> can't tell installs from updates on Windows and Linux: the updater
          downloads the same file a new user does. Kimochi 1.0 and earlier update only from GitHub, so their updates
          show up there.
        </li>
        <li>Crawlers, certificate checks and the mirror's own upload script are left out. Days are UTC.</li>
      </ul>
    </AccountSection>
  )
}
