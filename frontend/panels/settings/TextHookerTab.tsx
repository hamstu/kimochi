/**
 * Settings → Text Hooker: the defaults every hooked game uses, and each game's own settings, where
 * any of them can be changed for that game alone (ui/hook-games.ts holds what they are).
 *
 * A resizable column beside Settings' own lists Defaults, then the games hooked so far; the page
 * shows whichever is chosen, in the same order for both: (a game's session,) the card, hooking and
 * text. A game's page has its icon and name (its Log session's name: renaming one renames the
 * other) and Delete at the top, the same settings with the ones it changed marked and a reset
 * beside each, and what only a game has: hook codes, find-and-replace rules, the thread remembered
 * for it and where the card was left. Deleting a game forgets all of that, and its session too
 * when asked.
 *
 * Which is chosen is a setting (`textHookerSettingsGame`), so the sidebar's Manage can open the
 * hooked game's.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Gamepad2, Plus, RotateCcw, SlidersHorizontal, Trash2, X } from 'lucide-react'
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  IconButton,
  Input,
  ResizeHandle,
  Segmented,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Switch
} from '@kit'
import { deleteSession, getManifest, renameSession, subscribeSessions } from '@texthooker/lib/sessions'
import type { SessionsManifest } from '@texthooker/lib/types'
import { formatReadingTime } from '@texthooker/lib/sessionSummary'
import { useSummaries } from '@texthooker/hooks/useSessionSummaries'
import { useSetting } from '../../bridge/useSetting'
import {
  texthookForget,
  texthookGame,
  texthookGameIcon,
  texthookInsert,
  texthookSelect,
  useHookStatus
} from '../../bridge/textHook'
import {
  HOOK_DEFAULTS,
  HOOK_SETTING_KEYS,
  exeFolder,
  gameKey,
  hookGameName,
  hookSettings,
  overrides,
  updateHookGame,
  useHookCardLocksAutoAlign,
  useHookDefaults,
  useHookGames,
  withSetting,
  withoutOverride,
  type HookCardShow,
  type HookGame,
  type HookReplacement,
  type HookSettings,
  type Repeats
} from '../../main/hookGames'
import { useCapabilities } from '../../bridge/capabilities'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { HookCardPreview } from './HookCardPreview'
import { HookCardLookRow } from './CardLook'
import { lookupKeyName } from './overlayPreview'
import { useLookupKey } from '../../bridge/useLookupKey'
import {
  HOOK_CARD_SECTION,
  SESSIONS_SECTION,
  requestSettingsSection,
  useSettingsTarget
} from '../../bridge/settingsTarget'
import { showSettingsTab } from './showSettingsTab'
import './text-hooker.css'

const FLUSH_OPTIONS = [100, 200, 300, 500, 800, 1200].map((ms) => ({
  value: String(ms),
  label: ms === HOOK_DEFAULTS.flushMs ? `${ms} ms (default)` : `${ms} ms`
}))
const REPEAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Undo automatically' },
  { value: 'off', label: 'Leave as sent' },
  { value: '2', label: 'Each sent twice' },
  { value: '3', label: 'Each sent 3 times' },
  { value: '4', label: 'Each sent 4 times' }
]
const OPACITY_OPTIONS = [1, 0.85, 0.7, 0.55, 0.4].map((value) => ({
  value: String(value),
  label: `${Math.round(value * 100)}%`
}))
const TEXT_SIZES = [
  { value: '0.026', label: 'Small' },
  { value: '0.034', label: 'Medium' },
  { value: '0.042', label: 'Large' },
  { value: '0.05', label: 'Larger' }
] as const

/** The preset nearest a size, when it is one of them. */
const textSizeValue = (size: number): string =>
  TEXT_SIZES.find((option) => Math.abs(Number(option.value) - size) < 0.002)?.value ?? ''

const when = (ms: number | undefined): string | null => {
  if (!ms) return null
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(ms).toLocaleDateString()
}

function useSessions(): SessionsManifest {
  const [manifest, setManifest] = useState(getManifest)
  useEffect(() => subscribeSessions((next) => setManifest({ ...next, sessions: [...next.sessions] })), [])
  return manifest
}

/** A game's name (ui/hook-games.ts `hookGameName`), with its session's. */
function gameName(key: string, game: HookGame, manifest: SessionsManifest): string {
  const session = game.sessionId ? manifest.sessions.find((s) => s.id === game.sessionId) : undefined
  return hookGameName(key, game, session?.name)
}

function GameIcon({ exe, large, small }: { exe: string; large?: boolean; small?: boolean }): ReactNode {
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void texthookGameIcon(exe).then(
      (found) => live && setIcon(found),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [exe])
  return (
    <span className="th-icon" data-large={large || undefined} data-small={small || undefined} aria-hidden>
      {icon ? <img src={icon} alt="" /> : <Gamepad2 />}
    </span>
  )
}

/** Marks a setting changed from its default, with the way back. */
function Changed({ onReset }: { onReset: () => void }): ReactNode {
  return (
    <span className="th-changed">
      <span className="th-changed-label">Changed</span>
      <IconButton label="Reset to default" size="sm" onClick={onReset}>
        <RotateCcw />
      </IconButton>
    </span>
  )
}

type Scope = { kind: 'defaults' } | { kind: 'game'; exe: string; game: HookGame }

/** The settings every game has, for the defaults or for one game. */
function HookSettingsSections({
  scope,
  extra
}: {
  scope: Scope
  extra?: Partial<Record<'hooking' | 'text' | 'card', ReactNode>>
}): ReactNode {
  const [defaults, setDefaults] = useHookDefaults()
  // A Transparent card is always auto-aligned: its switch shows on, and cannot be turned off.
  const alignLocked = useHookCardLocksAutoAlign()
  const stored = scope.kind === 'defaults' ? defaults : hookSettings(defaults, scope.game)
  const value = alignLocked ? { ...stored, autoAlign: true } : stored
  const set = <K extends keyof HookSettings>(key: K, next: HookSettings[K]): void => {
    if (scope.kind === 'defaults') void setDefaults({ [key]: next })
    else
      void updateHookGame(scope.exe, (game) => {
        const changed = withSetting(game, key, next, defaults)
        // Auto align back on goes straight back to where it last found the game's text (`ocrBox`)
        // and measures the text again: a size set by hand goes (the overlay reads at once).
        if (key === 'autoAlign' && next) for (const learned of ['text', 'leading'] as const) delete changed[learned]
        return changed
      })
  }
  /** Several at once, in one write (a game's record is read and written whole). */
  const setMany = (change: Partial<HookSettings>): void => {
    if (scope.kind === 'defaults') void setDefaults(change)
    else
      void updateHookGame(scope.exe, (game) =>
        (Object.keys(change) as (keyof HookSettings)[]).reduce(
          (next, key) => withSetting(next, key, change[key] as HookSettings[typeof key], defaults),
          game
        )
      )
  }
  // The preview's card, used as the real one is: a drag or −/+ is the reader placing it by hand,
  // so Auto align turns off, as on the overlay.
  const cardActions = {
    onMoved: () => set('autoAlign', false),
    onTextSize: (textSize: number) => setMany({ textSize, autoAlign: false }),
    onOpacity: (opacity: number) => set('opacity', opacity)
  }
  // A game's setting that differs from the default is marked, with the way back to it. The
  // defaults are just the defaults: nothing to compare them with.
  const badge = (key: keyof HookSettings): ReactNode =>
    scope.kind === 'game' && overrides(scope.game, key, defaults) ? (
      <Changed onReset={() => void updateHookGame(scope.exe, (game) => withoutOverride(game, key))} />
    ) : null
  const id = (key: string): string => `th-${scope.kind}-${key}`
  // Opened at Card style from Settings → Overlay (rendered once the reader's settings are in).
  useSettingsTarget()
  const cardShown = value.showCard !== 'never'
  return (
    <>
      <SettingsSection title="Card" id={scope.kind === 'defaults' ? HOOK_CARD_SECTION : undefined}>
        <ShowCardRow value={value.showCard} badge={badge('showCard')} onChange={(next) => set('showCard', next)} />
        {/* Never shown: no card to preview or style, until it is shown again. */}
        {cardShown && (
          <>
            <HookCardPreview
              autoAlign={value.autoAlign}
              textSize={value.textSize}
              opacity={value.opacity}
              actions={cardActions}
            />
            <HookCardLookRow shared={scope.kind !== 'defaults'} />
          </>
        )}
        {/* A Transparent card shows nothing to style, and is always auto-aligned (the overlay keeps
            it over the game's text), so the rest of its style goes until another look is chosen. */}
        {cardShown && !alignLocked && (
          <>
            <SettingsRow
              label="Auto align"
              controlId={id('align')}
              badge={badge('autoAlign')}
              description="Finds the game's text with OCR as it changes, and keeps the card lined up with it at its size."
            >
              <Switch id={id('align')} checked={value.autoAlign} onCheckedChange={(on) => set('autoAlign', on)} />
            </SettingsRow>
            {/* Auto align sizes the text to the game's own, so the size is chosen only with it off. */}
            {!value.autoAlign && (
              <SettingsRow label="Text size" badge={badge('textSize')}>
                <Segmented
                  aria-label="Text size"
                  value={textSizeValue(value.textSize)}
                  onValueChange={(next) => set('textSize', Number(next))}
                  options={TEXT_SIZES}
                />
              </SettingsRow>
            )}
            <SettingsRow label="Background opacity" badge={badge('opacity')}>
              <Select
                aria-label="Background opacity"
                value={String(value.opacity)}
                onValueChange={(next) => set('opacity', Number(next))}
                options={OPACITY_OPTIONS}
              />
            </SettingsRow>
            {extra?.card}
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Hooking">
        <SettingsRow
          label="Hook automatically"
          controlId={id('auto-hook')}
          badge={badge('autoHook')}
          description="When the game starts, while Text hooking is on for it."
        >
          <Switch id={id('auto-hook')} checked={value.autoHook} onCheckedChange={(on) => set('autoHook', on)} />
        </SettingsRow>
        <SettingsRow
          label="Line delay"
          badge={badge('flushMs')}
          description="Raise it if lines arrive in pieces. Applies when the game is next hooked."
        >
          <Select
            aria-label="Line delay"
            value={String(value.flushMs)}
            onValueChange={(next) => set('flushMs', Number(next))}
            options={FLUSH_OPTIONS}
          />
        </SettingsRow>
        {extra?.hooking}
      </SettingsSection>
      <SettingsSection title="Text">
        <SettingsRow
          label="Separate speaker names"
          controlId={id('speakers')}
          badge={badge('speakerNames')}
          description="Tries to separate the speaker's name from their dialogue, where possible."
        >
          <Switch id={id('speakers')} checked={value.speakerNames} onCheckedChange={(on) => set('speakerNames', on)} />
        </SettingsRow>
        <SettingsRow
          label="Repeated characters"
          badge={badge('repeats')}
          description="For games that send ここここ for こ."
        >
          <Select
            aria-label="Repeated characters"
            value={String(value.repeats)}
            onValueChange={(next) => set('repeats', (/^\d$/.test(next) ? Number(next) : next) as Repeats)}
            options={REPEAT_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow
          label="Join split lines"
          controlId={id('join')}
          badge={badge('joinLines')}
          description="Tries to join lines that are split."
        >
          <Switch id={id('join')} checked={value.joinLines} onCheckedChange={(on) => set('joinLines', on)} />
        </SettingsRow>
        <SettingsRow
          label="Remove script codes"
          controlId={id('codes')}
          badge={badge('stripCodes')}
          description="Asset and label names some engines leave in their text, such as chr01chr02 or $fx_shake."
        >
          <Switch id={id('codes')} checked={value.stripCodes} onCheckedChange={(on) => set('stripCodes', on)} />
        </SettingsRow>
        {extra?.text}
      </SettingsSection>
    </>
  )
}

// ------------------------------------------------------------------------------- a game's own

function HookCodes({ exe, game, hooked }: { exe: string; game: HookGame; hooked: boolean }): ReactNode {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const codes = game.hookCodes ?? []
  const add = async (): Promise<void> => {
    const code = draft.trim()
    if (!code) return
    setError(null)
    if (!codes.includes(code)) await updateHookGame(exe, (g) => ({ ...g, hookCodes: [...(g.hookCodes ?? []), code] }))
    setDraft('')
    if (hooked) await texthookInsert(code).catch((caught: unknown) => setError(String(caught)))
  }
  return (
    <SettingsRow
      stacked
      label="Hook codes"
      description="For games nothing useful hooks in. Added each time the game is hooked."
    >
      <div className="th-list">
        {codes.map((code) => (
          <div key={code} className="th-list-row">
            <code className="th-code">{code}</code>
            <IconButton
              label="Remove hook code"
              size="sm"
              onClick={() =>
                void updateHookGame(exe, (g) => ({ ...g, hookCodes: (g.hookCodes ?? []).filter((c) => c !== code) }))
              }
            >
              <X />
            </IconButton>
          </div>
        ))}
        <form
          className="th-list-row"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <Input
            mono
            aria-label="Hook code"
            placeholder="HS-4@1234:game.exe"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
        {error && <p className="k-description th-error">{error}</p>}
      </div>
    </SettingsRow>
  )
}

function Replacements({ exe, game }: { exe: string; game: HookGame }): ReactNode {
  const rules = game.replacements ?? []
  const change = (index: number, patch: Partial<HookReplacement> | null): void =>
    void updateHookGame(exe, (g) => {
      const next = [...(g.replacements ?? [])]
      if (patch) next[index] = { ...next[index], ...patch }
      else next.splice(index, 1)
      return { ...g, replacements: next }
    })
  const invalid = (rule: HookReplacement): boolean => {
    if (!rule.regex) return false
    try {
      new RegExp(rule.find, 'u')
      return false
    } catch {
      return true
    }
  }
  return (
    <SettingsRow
      stacked
      label="Replacements"
      description="Applied to this game’s lines, in order, before they’re shown."
    >
      <div className="th-list">
        {rules.map((rule, index) => (
          <div key={index} className="th-list-row th-rule" data-off={rule.enabled === false || undefined}>
            <Switch
              aria-label="Use this rule"
              checked={rule.enabled !== false}
              onCheckedChange={(on) => change(index, { enabled: on })}
            />
            <Input
              mono
              aria-label="Find"
              placeholder="Find"
              aria-invalid={invalid(rule) || undefined}
              value={rule.find}
              onChange={(event) => change(index, { find: event.target.value })}
            />
            <Input
              mono
              aria-label="Replace with"
              placeholder="Replace with"
              value={rule.replace}
              onChange={(event) => change(index, { replace: event.target.value })}
            />
            <label className="th-regex">
              <Checkbox checked={Boolean(rule.regex)} onCheckedChange={(on) => change(index, { regex: on === true })} />
              Regex
            </label>
            <IconButton label="Remove rule" size="sm" onClick={() => change(index, null)}>
              <X />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            onClick={() =>
              void updateHookGame(exe, (g) => ({
                ...g,
                replacements: [...(g.replacements ?? []), { find: '', replace: '' }]
              }))
            }
          >
            <Plus /> Add rule
          </Button>
        </div>
      </div>
    </SettingsRow>
  )
}

function Thread({ exe, hooked }: { exe: string; hooked: boolean }): ReactNode {
  const [thread, setThread] = useState<string | null | undefined>(undefined)
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    let live = true
    void texthookGame(exe).then(
      (found) => live && setThread(found.thread),
      () => live && setThread(null)
    )
    return () => {
      live = false
    }
  }, [exe, asked])
  return (
    <SettingsRow
      label="Dialogue thread"
      description={
        thread
          ? 'Remembered for this game. Forget it to choose again from the screen.'
          : 'Chosen from the screen when the game next shows text.'
      }
    >
      {thread && (
        <>
          <code className="th-code th-code-short" title={thread}>
            {thread}
          </code>
          <Button
            size="sm"
            onClick={() =>
              void texthookForget(exe, false).then(() => {
                setAsked((n) => n + 1)
                if (hooked) void texthookSelect(null).catch(() => undefined)
              })
            }
          >
            Forget
          </Button>
        </>
      )}
    </SettingsRow>
  )
}

/** A session in brief: its reading time and lines (as Log & Sessions counts them), and its age. */
function SessionStats({
  manifest,
  id,
  createdAt
}: {
  manifest: SessionsManifest
  id: string
  createdAt: number
}): ReactNode {
  const summary = useSummaries(manifest.sessions, manifest.activeId, 0)[id]
  const started = when(createdAt)
  const parts = [
    summary && formatReadingTime(summary.readingMs),
    summary && `${summary.lines.toLocaleString()} line${summary.lines === 1 ? '' : 's'}`,
    started && `started ${started}`
  ].filter(Boolean)
  return <span className="k-num">{parts.join(' · ')}</span>
}

function SessionRow({ game, manifest }: { game: HookGame; manifest: SessionsManifest }): ReactNode {
  const session = game.sessionId ? manifest.sessions.find((s) => s.id === game.sessionId) : undefined
  if (!session)
    return (
      <SettingsRow
        label="No session yet"
        description="With Auto switch sessions on (Sources), the game gets one when it’s next hooked."
      />
    )
  const current = manifest.activeId === session.id
  return (
    <SettingsRow
      label={session.name}
      badge={current ? <span className="th-current">Current</span> : null}
      description={<SessionStats manifest={manifest} id={session.id} createdAt={session.createdAt} />}
    >
      <Button
        size="sm"
        onClick={() => {
          requestSettingsSection(SESSIONS_SECTION)
          showSettingsTab('log')
        }}
      >
        Manage sessions
      </Button>
    </SettingsRow>
  )
}

/** How many of a game's settings differ from the defaults, and the way back to all of them. */
function ChangesBanner({ exe, game }: { exe: string; game: HookGame }): ReactNode {
  const [defaults] = useHookDefaults()
  const changed = HOOK_SETTING_KEYS.filter((key) => overrides(game, key, defaults))
  if (!changed.length) return null
  return (
    <Callout tone="accent" icon={<SlidersHorizontal />} className="th-changes">
      <span className="th-changes-text">
        {changed.length === 1 ? '1 setting differs' : `${changed.length} settings differ`} from the defaults.
      </span>
      <Button
        size="sm"
        onClick={() => void updateHookGame(exe, (g) => changed.reduce((next, key) => withoutOverride(next, key), g))}
      >
        Reset to defaults
      </Button>
    </Callout>
  )
}

function GamePage({ gameId, game, onDeleted }: { gameId: string; game: HookGame; onDeleted: () => void }): ReactNode {
  const manifest = useSessions()
  const status = useHookStatus()
  const exe = game.exe ?? gameId
  const hooked = status.phase === 'hooked' && Boolean(status.exe) && gameKey(status.exe!) === gameId
  const name = gameName(gameId, game, manifest)
  // What is typed into the name, while it is being edited.
  const [draft, setDraft] = useState<string | null>(null)
  const session = game.sessionId ? manifest.sessions.find((s) => s.id === game.sessionId) : undefined
  const [deleting, setDeleting] = useState(false)
  const [withSession, setWithSession] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSession = manifest.sessions.length <= 1

  const rename = (): void => {
    const next = (draft ?? '').trim()
    setDraft(null)
    if (!next || next === name) return
    if (session) void renameSession(session.id, next).catch((caught: unknown) => setError(String(caught)))
    void updateHookGame(exe, (g) => ({ ...g, name: next, named: true }))
  }
  const remove = async (): Promise<void> => {
    setError(null)
    try {
      if (withSession && session && !lastSession) await deleteSession(session.id)
      await texthookForget(exe, true).catch(() => undefined)
      await updateHookGame(exe, () => null)
      setDeleting(false)
      onDeleted()
    } catch (caught) {
      setError(String(caught))
    }
  }

  return (
    <SettingsPage className="th-page">
      <div className="th-game-head">
        <div className="th-game-title">
          <GameIcon exe={exe} large />
          <div className="th-game-name">
            <Input
              className="th-name-input"
              aria-label="Game name"
              value={draft ?? name}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={rename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  setDraft(name)
                  event.currentTarget.blur()
                }
              }}
            />
            <p className="k-description th-game-meta">
              <span className="th-path" title={exe}>
                {exe}
              </span>
            </p>
          </div>
          <Button variant="ghost" size="sm" className="th-delete" onClick={() => setDeleting(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
        {error && <p className="k-description th-error">{error}</p>}
      </div>

      <ChangesBanner exe={exe} game={game} />

      <SettingsSection title="Session & Log">
        <SessionRow game={game} manifest={manifest} />
      </SettingsSection>

      <HookSettingsSections
        scope={{ kind: 'game', exe, game }}
        extra={{
          hooking: (
            <>
              <Thread exe={exe} hooked={hooked} />
              <HookCodes exe={exe} game={game} hooked={hooked} />
            </>
          ),
          text: <Replacements exe={exe} game={game} />,
          card: game.box ? (
            <SettingsRow label="Card position" description="Where you dragged it, used with Auto align off.">
              <Button
                size="sm"
                onClick={() =>
                  void updateHookGame(exe, (g) => {
                    const next = { ...g }
                    delete next.box
                    return next
                  })
                }
              >
                Reset
              </Button>
            </SettingsRow>
          ) : null
        }}
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        tone="danger"
        title={`Delete ${name}?`}
        description={
          <span className="th-delete-body">
            <span>Its settings and what Kimochi learned about it are removed.</span>
            {session && !lastSession && (
              <label className="th-delete-session">
                <Checkbox checked={withSession} onCheckedChange={(on) => setWithSession(on === true)} />
                Also delete its session, “{session.name}”
              </label>
            )}
          </span>
        }
        confirmLabel={withSession && session && !lastSession ? 'Delete game and session' : 'Delete game'}
        onConfirm={() => void remove()}
      />
    </SettingsPage>
  )
}

// ------------------------------------------------------------------------------- the list

/** Resizable, as Settings' own column is; the width is remembered (`textHookerListWidth`). */
const RAIL_WIDTH = { min: 150, max: 360, initial: 192 }

/** Defaults, then every game hooked so far, the latest first: what the page beside it shows. */
function GamesRail({ open, onOpen }: { open: string | null; onOpen: (key: string | null) => void }): ReactNode {
  const games = useHookGames()
  const manifest = useSessions()
  const [width, setWidth] = useSetting<number>('textHookerListWidth', RAIL_WIDTH.initial)
  const [live, setLive] = useState<number | null>(null)
  const list = Object.entries(games).sort(([, a], [, b]) => (b.hookedAt ?? 0) - (a.hookedAt ?? 0))
  const named = list.map(([key, game]) => ({
    key,
    game,
    name: gameName(key, game, manifest),
    exe: game.exe ?? key
  }))
  return (
    <nav className="th-rail" aria-label="Text Hooker games" style={{ width: live ?? width ?? RAIL_WIDTH.initial }}>
      <div className="th-rail-scroll">
        <button
          type="button"
          className="k-row th-rail-row"
          aria-current={open ? undefined : 'page'}
          onClick={() => onOpen(null)}
        >
          <SlidersHorizontal />
          <span className="k-row-label">Defaults</span>
        </button>
        <div className="th-rail-label">Games</div>
        {list.length === 0 && <p className="th-rail-empty">Games you hook show up here, each with its own settings.</p>}
        {named.map(({ key, name, exe }) => {
          // Games of the same name (two copies, or one engine's exe) show where each one is.
          const twins = named.filter((other) => other.name.toLowerCase() === name.toLowerCase())
          const folder =
            twins.length > 1
              ? exeFolder(
                  exe,
                  twins.map((other) => other.exe)
                )
              : null
          return (
            <button
              key={key}
              type="button"
              className="k-row th-rail-row"
              aria-current={open === key ? 'page' : undefined}
              title={`${name}\n${exe}`}
              onClick={() => onOpen(key)}
            >
              <GameIcon exe={exe} small />
              <span className="k-row-label">
                {name}
                {folder && <span className="th-rail-folder">{folder}</span>}
              </span>
            </button>
          )
        })}
      </div>
      <ResizeHandle
        width={live ?? width ?? RAIL_WIDTH.initial}
        min={RAIL_WIDTH.min}
        max={RAIL_WIDTH.max}
        reset={RAIL_WIDTH.initial}
        label="Resize the games list"
        onLive={setLive}
        onCommit={(next) => void setWidth(next)}
      />
    </nav>
  )
}

/**
 * When the hooked line's card is over the game (`showCard`, ui/hook-games.ts `hookCardShow`):
 * always, only while the overlay's lookup key is held, or never.
 */
function ShowCardRow({
  value,
  badge,
  onChange
}: {
  value: HookCardShow
  badge: ReactNode
  onChange: (next: HookCardShow) => void
}): ReactNode {
  const lookupKey = useLookupKey()
  const { os } = useCapabilities()
  const key = lookupKeyName(lookupKey, os === 'macos')
  const descriptions: Record<HookCardShow, string> = {
    always: 'Each hooked line shows on the card as it comes in.',
    hold: `Hidden until you hold ${key} to read or look up the line. The key is set in Shortcuts & Controls.`,
    never: 'Lines only go to the Log. Auto align doesn’t read the screen.'
  }
  return (
    <SettingsRow label="Show card" badge={badge} description={descriptions[value]}>
      <Select
        aria-label="Show card"
        value={value}
        onValueChange={(next) => onChange(next as HookCardShow)}
        options={[
          { value: 'always', label: 'Always' },
          { value: 'hold', label: `While holding ${key}` },
          { value: 'never', label: 'Never' }
        ]}
      />
    </SettingsRow>
  )
}

export function TextHookerTab(): ReactNode {
  const [open, setOpen] = useSetting<string | null>('textHookerSettingsGame', null)
  const games = useHookGames()
  const game = open ? games[open] : undefined
  const chosen = open && game ? open : null
  return (
    <WithReaderSettings>
      {() => (
        <div className="th-split">
          <GamesRail open={chosen} onOpen={(key) => void setOpen(key)} />
          {/* Its own scroller, a fresh one for each choice: it opens at the top. */}
          <div key={chosen ?? 'defaults'} className="th-pane">
            {chosen && game ? (
              <GamePage key={chosen} gameId={chosen} game={game} onDeleted={() => void setOpen(null)} />
            ) : (
              <SettingsPage
                key="defaults"
                className="th-page"
                title="Text Hooker defaults"
                description="Every game uses these unless it changes them. Choose a game to change its own."
              >
                <HookSettingsSections
                  scope={{ kind: 'defaults' }}
                  extra={{
                    text: (
                      <SettingsRow label="Replacements" description="Manage replacements in Log & Sessions.">
                        <Button size="sm" onClick={() => showSettingsTab('log')}>
                          Log & Sessions
                        </Button>
                      </SettingsRow>
                    )
                  }}
                />
              </SettingsPage>
            )}
          </div>
        </div>
      )}
    </WithReaderSettings>
  )
}
