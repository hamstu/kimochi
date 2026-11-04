/**
 * Settings → Text Hooker: the defaults every hooked game uses, and each game's own page, where any
 * of them can be changed for that game alone (ui/hook-games.ts holds what they are).
 *
 * The page opens on the games and the defaults. A game's page has its icon and name (its Log
 * session's name: renaming one renames the other), its session, the same settings with the ones it
 * changed marked and a reset beside each, and what only a game has: hook codes, find-and-replace
 * rules, the thread remembered for it and where the card was left. Deleting a game forgets all of
 * that, and its session too when asked.
 *
 * Which page shows is a setting (`textHookerSettingsGame`), so the sidebar's Manage can open the
 * hooked game's.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Gamepad2, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  IconButton,
  Input,
  Segmented,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Switch
} from '@kit'
import { deleteSession, getManifest, renameSession, subscribeSessions, switchSession } from '@texthooker/lib/sessions'
import type { SessionsManifest } from '@texthooker/lib/types'
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
  exeTitle,
  gameKey,
  hookSettings,
  overrides,
  updateHookGame,
  useHookDefaults,
  useHookGames,
  withSetting,
  withoutOverride,
  type HookGame,
  type HookReplacement,
  type HookSettings,
  type Repeats
} from '../../main/hookGames'
import { WithReaderSettings } from './ReaderSettingsProvider'
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

/** A game's name: its session's, else the one it was given, else its exe's. */
function gameName(key: string, game: HookGame, manifest: SessionsManifest): string {
  const session = game.sessionId ? manifest.sessions.find((s) => s.id === game.sessionId) : undefined
  return session?.name ?? game.name ?? exeTitle(game.exe ?? key)
}

function GameIcon({ exe, large }: { exe: string; large?: boolean }): ReactNode {
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
    <span className="th-icon" data-large={large || undefined} aria-hidden>
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
function HookSettingsSections({ scope, extra }: { scope: Scope; extra?: Partial<Record<'hooking' | 'text' | 'card', ReactNode>> }): ReactNode {
  const [defaults, setDefaults, resetDefault] = useHookDefaults()
  const value = scope.kind === 'defaults' ? defaults : hookSettings(defaults, scope.game)
  const changed = (key: keyof HookSettings): boolean =>
    scope.kind === 'defaults' ? defaults[key] !== HOOK_DEFAULTS[key] : overrides(scope.game, key, defaults)
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
  const reset = (key: keyof HookSettings): void => {
    if (scope.kind === 'defaults') void resetDefault(key)
    else void updateHookGame(scope.exe, (game) => withoutOverride(game, key))
  }
  const badge = (key: keyof HookSettings): ReactNode => (changed(key) ? <Changed onReset={() => reset(key)} /> : null)
  const id = (key: string): string => `th-${scope.kind}-${key}`
  return (
    <>
      <SettingsSection title="Hooking">
        <SettingsRow
          label="Hook automatically"
          controlId={id('auto-hook')}
          badge={badge('autoHook')}
          description="When the game starts, while Text Hooker is your source."
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
          label="Speaker names apart"
          controlId={id('speakers')}
          badge={badge('speakerNames')}
          description="The name stays on the game's nameplate; the card shows what they say."
        >
          <Switch id={id('speakers')} checked={value.speakerNames} onCheckedChange={(on) => set('speakerNames', on)} />
        </SettingsRow>
        <SettingsRow label="Repeated characters" badge={badge('repeats')} description="For games that send ここここ for こ.">
          <Select
            aria-label="Repeated characters"
            value={String(value.repeats)}
            onValueChange={(next) => set('repeats', (/^\d$/.test(next) ? Number(next) : next) as Repeats)}
            options={REPEAT_OPTIONS}
          />
        </SettingsRow>
        {extra?.text}
      </SettingsSection>
      <SettingsSection title="Card">
        <SettingsRow
          label="Auto align"
          controlId={id('align')}
          badge={badge('autoAlign')}
          description="Lines the card up with the game's own text."
        >
          <Switch id={id('align')} checked={value.autoAlign} onCheckedChange={(on) => set('autoAlign', on)} />
        </SettingsRow>
        <SettingsRow
          label="Text size"
          badge={badge('textSize')}
          description={
            scope.kind === 'game' && value.autoAlign && scope.game.text !== undefined
              ? 'Measured from the game by Auto align.'
              : 'Until Auto align measures the game’s text, or with it off.'
          }
        >
          <Segmented
            aria-label="Text size"
            value={textSizeValue(value.textSize)}
            onValueChange={(next) => set('textSize', Number(next))}
            options={TEXT_SIZES}
          />
        </SettingsRow>
        <SettingsRow label="Background opacity" badge={badge('opacity')}>
          <Select
            aria-label="Background opacity"
            value={String(value.opacity)}
            onValueChange={(next) => set('opacity', Number(next))}
            options={OPACITY_OPTIONS}
          />
        </SettingsRow>
        {extra?.card}
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
              onClick={() => void updateHookGame(exe, (g) => ({ ...g, hookCodes: (g.hookCodes ?? []).filter((c) => c !== code) }))}
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
    <SettingsRow stacked label="Replacements" description="Applied to this game’s lines, in order, before they’re shown.">
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
              void updateHookGame(exe, (g) => ({ ...g, replacements: [...(g.replacements ?? []), { find: '', replace: '' }] }))
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
      description={`This game’s lines go here, started ${when(session.createdAt) ?? 'when it was first hooked'}. Renaming the game renames it.`}
    >
      {current ? (
        <span className="th-current">Current session</span>
      ) : (
        <Button size="sm" onClick={() => void switchSession(session.id)}>
          Switch to it
        </Button>
      )}
    </SettingsRow>
  )
}

function GamePage({ gameId, game, onBack }: { gameId: string; game: HookGame; onBack: () => void }): ReactNode {
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
    void updateHookGame(exe, (g) => ({ ...g, name: next }))
  }
  const remove = async (): Promise<void> => {
    setError(null)
    try {
      if (withSession && session && !lastSession) await deleteSession(session.id)
      await texthookForget(exe, true).catch(() => undefined)
      await updateHookGame(exe, () => null)
      setDeleting(false)
      onBack()
    } catch (caught) {
      setError(String(caught))
    }
  }

  return (
    <SettingsPage className="th-page">
      <div className="th-game-head">
        <Button variant="ghost" size="sm" className="th-back" onClick={onBack}>
          <ChevronLeft /> Text Hooker
        </Button>
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
              {hooked ? <span className="th-live">Hooked now</span> : when(game.hookedAt) && `Last hooked ${when(game.hookedAt)}`}
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

      <SettingsSection title="Session">
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
            <span>Its settings, and what Kimochi learned about it, are removed. It comes back with the defaults if you hook it again.</span>
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

function GameList({ onOpen }: { onOpen: (key: string) => void }): ReactNode {
  const games = useHookGames()
  const manifest = useSessions()
  const [defaults] = useHookDefaults()
  const status = useHookStatus()
  const hookedKey = status.phase === 'hooked' && status.exe ? gameKey(status.exe) : null
  const list = Object.entries(games).sort(([, a], [, b]) => (b.hookedAt ?? 0) - (a.hookedAt ?? 0))
  if (!list.length)
    return (
      <SettingsSection title="Games">
        <SettingsRow label="No games yet" description="Games you hook show up here, each with its own settings." />
      </SettingsSection>
    )
  return (
    <SettingsSection title="Games">
      {list.map(([key, game]) => {
        const changes = (Object.keys(HOOK_DEFAULTS) as (keyof HookSettings)[]).filter(
          (k) => overrides(game, k, defaults)
        ).length
        const detail = [
          key === hookedKey ? 'Hooked now' : when(game.hookedAt) && `Hooked ${when(game.hookedAt)}`,
          changes ? `${changes} ${changes === 1 ? 'change' : 'changes'}` : null
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <button key={key} type="button" className="th-game-row" onClick={() => onOpen(key)}>
            <GameIcon exe={game.exe ?? key} />
            <span className="th-game-row-text">
              <span className="th-game-row-name">{gameName(key, game, manifest)}</span>
              {detail && <span className="th-game-row-detail">{detail}</span>}
            </span>
            <ChevronRight className="th-chevron" aria-hidden />
          </button>
        )
      })}
    </SettingsSection>
  )
}

/** Whether the hooked line's card is shown over the game at all (`textHookerShowCard`). */
function ShowCard(): ReactNode {
  const [shown, setShown] = useSetting<boolean>('textHookerShowCard', true)
  return (
    <SettingsSection title="Card">
      <SettingsRow
        label="Show the card over the game"
        controlId="th-show-card"
        description="Off, each line still reaches the Log, and Read along shows it while you read. Auto align only reads the screen while the card is shown."
      >
        <Switch id="th-show-card" checked={shown !== false} onCheckedChange={(on) => void setShown(on)} />
      </SettingsRow>
    </SettingsSection>
  )
}

export function TextHookerTab(): ReactNode {
  const [open, setOpen] = useSetting<string | null>('textHookerSettingsGame', null)
  const games = useHookGames()
  const game = open ? games[open] : undefined
  return (
    <WithReaderSettings>
      {() =>
        open && game ? (
          <GamePage key={open} gameId={open} game={game} onBack={() => void setOpen(null)} />
        ) : (
          <SettingsPage title="Text Hooker" description="How hooked games are read and shown.">
            <ShowCard />
            <GameList onOpen={(key) => void setOpen(key)} />
            <div className="th-scope-head">
              <h2 className="k-heading">Defaults</h2>
              <p className="k-description">Every game uses these unless it changes them on its own page.</p>
            </div>
            <HookSettingsSections
              scope={{ kind: 'defaults' }}
              extra={{
                text: (
                  <SettingsRow
                    label="Replacements"
                    description="Each game has its own. Replacements for every source are in Log & Sessions."
                  >
                    <Button size="sm" onClick={() => showSettingsTab('log')}>
                      Log & Sessions
                    </Button>
                  </SettingsRow>
                )
              }}
            />
          </SettingsPage>
        )
      }
    </WithReaderSettings>
  )
}
