/**
 * Inside the Text hooking box under a game's card, while it is on: the hooked text, as a select
 * like the OCR model's and the Dictionary's (the box's own switch row is its heading).
 *
 * A hooked game produces several threads (the dialogue, a nameplate, menus, engine noise). The
 * dialogue is chosen automatically, by the thread remembered for this game or by matching each
 * thread's text against what is on screen. The select shows the chosen thread's latest line; its
 * menu lists the live threads with their latest text, so a wrong choice is one click to correct,
 * and that choice is remembered for the game. The menu keeps its rows in place as text arrives
 * (native orders them by when the hooker found them), and lists only threads that have carried
 * Japanese: the rest (engine names, file paths, numbers) are behind "Show all". Automatic choice
 * still considers every thread, since a slot that holds other text now may hold the dialogue later. While the hook starts, or waits for text, the select
 * says so in place, so nothing moves when the text arrives.
 */
import { useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronsUpDown, MessageSquareText, Sparkles } from 'lucide-react'
import {
  Callout,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Spinner
} from '@kit'
import { texthookSelect, type HookStatus, type HookThread } from '../bridge/textHook'
import { SidebarNotice } from './SidebarNotice'
import { useLanguage } from '../bridge/useLanguage'
import { useTextLang } from '../bridge/useTextLang'

const AUTO = '__auto__'

/** One line of a thread's text, for a menu row. */
const firstLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function threadLabel(thread: HookThread): string {
  return firstLine(thread.preview) || thread.name
}

/**
 * The game took the hook, but the hooker could not patch some of the code its text may go through,
 * and no dialogue has been found since. Unlike a game that cannot be hooked at all (the session
 * fails), this is often a matter of the game's memory in this run: restarting the game helps. Not
 * for a Unity game whose text Kimochi reads itself: its threads come without the hooker.
 */
function couldNotHook(status: HookStatus): boolean {
  return (
    status.phase === 'hooked' &&
    !status.unityText &&
    !status.threads.some((t) => t.selected) &&
    (status.hookFailures?.length ?? 0) > 0
  )
}

/** What the select shows, and whether it is still working on it. */
function shown(status: HookStatus, selected: HookThread | null): { busy: boolean; warn?: boolean; text: string } {
  const engine = status.engine?.name ?? 'the hooker'
  switch (status.phase) {
    case 'starting':
      return { busy: true, text: 'Starting…' }
    case 'downloading': {
      const d = status.download
      const percent = d && d.total > 0 ? Math.floor((d.done / d.total) * 100) : 0
      return { busy: true, text: `Downloading ${engine}… ${percent}%` }
    }
    case 'attaching':
      return { busy: true, text: 'Hooking…' }
    default:
      break
  }
  if (selected) return { busy: false, text: threadLabel(selected) }
  if (status.threads.length === 0)
    return couldNotHook(status)
      ? { busy: false, warn: true, text: 'No text hooked' }
      : { busy: true, text: 'Waiting for text…' }
  // Nothing matched the screen yet: the reader can choose.
  if (status.pickNote) return { busy: false, warn: true, text: 'Choose the text…' }
  return { busy: true, text: 'Finding the dialogue…' }
}

export function HookControls({ status, onManage }: { status: HookStatus; onManage: () => void }): ReactNode {
  const selected = status.threads.find((thread) => thread.selected) ?? null
  const failed = status.phase === 'failed' || status.phase === 'ended'
  const view = shown(status, selected)
  const [showAll, setShowAll] = useState(false)
  // `japanese`: some of the thread's text has read as the language being read.
  const [language] = useLanguage()
  // The hooked line is the learner's text.
  const textLang = useTextLang()
  const listed = showAll ? status.threads : status.threads.filter((thread) => thread.japanese || thread.selected)
  const hidden = status.threads.length - status.threads.filter((thread) => thread.japanese || thread.selected).length
  const how =
    status.selectedBy === 'saved'
      ? 'Remembered for this game'
      : status.selectedBy === 'auto'
        ? 'Matched to the screen'
        : status.pickNote
          ? 'Nothing matches the screen yet'
          : undefined
  return (
    <div className="src-hook">
      {failed && status.detail && (
        <SidebarNotice action="Open Text Hooker settings" onAction={onManage}>
          {status.detail}
        </SidebarNotice>
      )}
      {couldNotHook(status) && (
        <Callout tone="warn" className="src-notice">
          <span title={status.hookFailures?.join('\n')}>
            Kimochi reached the game but couldn&apos;t hook some of its text. If the dialogue doesn&apos;t show up,
            restart the game while Kimochi is open.
          </span>
        </Callout>
      )}
      {status.fallback && status.phase === 'hooked' && (
        <div className="src-hook-status">
          <AlertTriangle aria-hidden />
          <span>
            {status.fallback}. Using {status.engine?.name ?? 'another hooker'}.
          </span>
        </div>
      )}
      {!failed && status.phase !== 'idle' && (
        <Menu>
          <MenuTrigger asChild disabled={status.threads.length === 0}>
            <button
              type="button"
              className="k-select-trigger sb-select src-hook-select"
              aria-label="Hooked text"
              data-placeholder={selected ? undefined : ''}
              title={status.pickNote ?? undefined}
            >
              <span className="src-hook-select-value">
                {view.busy ? (
                  <Spinner label={view.text} />
                ) : view.warn ? (
                  <AlertTriangle aria-hidden />
                ) : (
                  <MessageSquareText aria-hidden />
                )}
                <span className="src-hook-select-text" lang={selected ? textLang : undefined}>
                  {view.text}
                </span>
              </span>
              <ChevronsUpDown className="k-select-trigger-icon" aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="src-hook-menu">
            <MenuLabel>Hooked text</MenuLabel>
            <MenuRadioGroup
              value={status.selectedBy === 'manual' && selected ? selected.key : AUTO}
              onValueChange={(value) => void texthookSelect(value === AUTO ? null : value).catch(() => {})}
            >
              <MenuRadioItem value={AUTO} icon={<Sparkles />} detail={status.selectedBy === 'manual' ? undefined : how}>
                Choose automatically
              </MenuRadioItem>
              <MenuSeparator />
              {listed.map((thread) => (
                <MenuRadioItem
                  key={thread.key}
                  value={thread.key}
                  className="src-hook-item"
                  data-current={thread.selected ? '' : undefined}
                  detail={thread.name}
                  title={thread.hookcode}
                >
                  {threadLabel(thread)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {hidden > 0 && (
              <>
                <MenuSeparator />
                <MenuCheckboxItem
                  checked={showAll}
                  // Stays open: the reader is looking through the list.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => setShowAll(checked === true)}
                >
                  Show all ({hidden} without {language.name})
                </MenuCheckboxItem>
              </>
            )}
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}
