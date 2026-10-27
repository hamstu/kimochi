/**
 * The Anki tab: the cards made in the open session (Kimochi's own pop-up's and the dictionary
 * extensions'), newest first, each opening in Anki's browser. A card Kimochi gave audio afterwards
 * (sentence audio) is marked. Nothing here edits a card or adds one: cards are made from the
 * pop-ups. The record lives with the session (`ankiCardsStore`); the list shows while AnkiConnect
 * answers, since every row leads into Anki.
 *
 * Each row's ⋯ menu (and the same menu on a right-click): Open in Anki; Add sentence audio, for a card without it (its line's kept clip,
 * `sentence_audio_add_to_note`); and Delete…, which asks whether to delete the note from Anki too.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { AudioLines, ExternalLink, Image as ImageIcon, Layers, MoreHorizontal, Search, SearchX, Settings2, Trash2, Unplug, X } from 'lucide-react'
import {
  Bar,
  BarSpacer,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  ContextMenu,
  ContextMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Row,
  Spinner,
  Tooltip,
  isComposing
} from '@kit'
import { DEFAULT_ANKI_CONNECT_URL, describeAnkiStatus, nextCheckMs, type AnkiConnectStatus } from '@ui/anki-connect'
import { checkAnkiConnect, openInAnkiBrowser } from '@texthooker/lib/ankiconnect'
import { useRowHotkeys } from '@texthooker/hooks/useRowHotkeys'
import { getSettings } from '@texthooker/lib/settings'
import {
  browseQuery,
  cardMatches,
  cardStats,
  enhancementLabel,
  hasAudio,
  type AnkiCardRecord
} from '@texthooker/lib/ankiCards'
import { openSettings } from '../bridge/tauri'
import { showSettingsTab } from '../panels/settings/showSettingsTab'
import { showAnkiTab } from '../panels/settings/ankiPageTab'
import { SessionMenu } from './SessionMenu'
import { addScreenshot, addSentenceAudio, deleteAnkiCard, reloadAnkiCards, useAnkiCards } from './ankiCardsStore'
import '@texthooker/notebook.css'
import './anki-panel.css'

/** Settings → Anki, on its AnkiConnect tab. */
function openAnkiConnectSettings(): void {
  showAnkiTab('connect')
  showSettingsTab('anki')
  void openSettings()
}

/** The AnkiConnect check, again while the tab is open: often while it fails, now and then once
    it answers, and when the window comes back to the front. `null` while the first is on its way. */
function useAnkiConnection(): [AnkiConnectStatus | null, () => void] {
  const [status, setStatus] = useState<AnkiConnectStatus | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      clearTimeout(timer)
      void checkAnkiConnect()
        .catch((error: unknown): AnkiConnectStatus => ({ state: 'error', url: '', message: String(error) }))
        .then((next) => {
          if (stopped) return
          setStatus(next)
          timer = setTimeout(check, nextCheckMs(next))
        })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('focus', check)
    }
  }, [round])
  return [status, useCallback(() => setRound((n) => n + 1), [])]
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** "14:03" today, "Oct 25, 14:03" before. */
function addedLabel(at: number, now = new Date()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === now.toDateString()) return time
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
  return `${day}, ${time}`
}

export function AnkiPanel(): JSX.Element {
  const { cards, loaded, error } = useAnkiCards()
  const [status, recheck] = useAnkiConnection()
  const [query, setQuery] = useState('')
  const [openError, setOpenError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AnkiCardRecord | null>(null)
  const [alsoAnki, setAlsoAnki] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const alsoAnkiId = useId()
  const searchRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => cards.filter((card) => cardMatches(card, query)), [cards, query])
  const stats = useMemo(() => cardStats(cards), [cards])
  const connected = status?.state === 'connected'

  // "/" or ⌘F / Ctrl+F jumps to search, as in the Notebook.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (
        (event.key === '/' && !mod && !isComposing(event) && !isTypingTarget(event.target)) ||
        (mod && event.key.toLowerCase() === 'f')
      ) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const open = (card: AnkiCardRecord): void => {
    const url = getSettings().ankiConnectUrl.trim() || DEFAULT_ANKI_CONNECT_URL
    setOpenError(null)
    openInAnkiBrowser(url, browseQuery(card)).catch((err: unknown) => {
      setOpenError(`Anki could not show “${card.term || card.noteId}”: ${String(err)}`)
      recheck()
    })
  }

  const askDelete = (card: AnkiCardRecord): void => {
    setAlsoAnki(false)
    setDeleting(card)
  }
  // The ⋯ menu's letters, for the card under the pointer.
  const pointed = (row: HTMLElement): AnkiCardRecord | undefined =>
    cards.find((card) => String(card.noteId) === row.dataset.noteId)
  useRowHotkeys('.anki-row-wrap[data-note-id]', {
    o: (row) => {
      const card = pointed(row)
      if (card) open(card)
    },
    d: (row) => {
      const card = pointed(row)
      if (card) askDelete(card)
    }
  })

  const addAudio = (card: AnkiCardRecord): void => {
    setOpenError(null)
    setNotice(null)
    addSentenceAudio(card).then(
      () => setNotice(`Added sentence audio to “${card.term || card.noteId}”, if its field was empty.`),
      (err: unknown) => setOpenError(`No audio for “${card.term || card.noteId}”: ${String(err)}`)
    )
  }

  const addPicture = (card: AnkiCardRecord): void => {
    setOpenError(null)
    setNotice(null)
    addScreenshot(card).then(
      () => setNotice(`Added the screenshot to “${card.term || card.noteId}”.`),
      (err: unknown) => setOpenError(`No screenshot for “${card.term || card.noteId}”: ${String(err)}`)
    )
  }

  const confirmDelete = (): void => {
    if (!deleting) return
    setBusy(true)
    deleteAnkiCard(deleting, alsoAnki).then(
      () => {
        setBusy(false)
        setDeleting(null)
      },
      (err: unknown) => {
        setBusy(false)
        setDeleting(null)
        setOpenError(`“${deleting.term || deleting.noteId}” was not deleted from Anki: ${String(err)}`)
      }
    )
  }

  let body: JSX.Element
  if (status === null && cards.length === 0) {
    body = (
      <div className="anki-checking">
        <Spinner label="Checking AnkiConnect" />
      </div>
    )
  } else if (status !== null && !connected) {
    body = (
      <EmptyState
        className="anki-empty"
        icon={<Unplug />}
        title="Can't connect to AnkiConnect"
        actions={
          <>
            <Button variant="primary" onClick={openAnkiConnectSettings}>
              AnkiConnect settings
            </Button>
            <Button onClick={() => { recheck(); reloadAnkiCards() }}>Try again</Button>
          </>
        }
      >
        {describeAnkiStatus(status).detail} The cards made in this session show here once Anki answers.
      </EmptyState>
    )
  } else if (loaded && cards.length === 0) {
    body = (
      <EmptyState
        className="anki-empty"
        icon={<Layers />}
        title="No cards yet this session"
        actions={<Button onClick={openAnkiConnectSettings}>Anki settings</Button>}
      >
        {error ??
          'Cards you add to Anki while reading, from Kimochi’s pop-up or your dictionary’s, are listed here with the session.'}
      </EmptyState>
    )
  } else {
    body = (
      <>
        <div className="anki-filter">
          <div className="nb-search">
            <Search />
            <Input
              ref={searchRef}
              size="sm"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(event) => {
                if (isComposing(event)) return
                if (event.key === 'Escape') {
                  if (query) {
                    event.preventDefault()
                    setQuery('')
                  } else searchRef.current?.blur()
                }
              }}
              placeholder="Search"
              aria-label="Search this session's cards"
              aria-controls="anki-list"
            />
            <span className="nb-search-end">
              {query ? (
                <IconButton
                  label="Clear search"
                  size="sm"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                >
                  <X />
                </IconButton>
              ) : (
                <Kbd>/</Kbd>
              )}
            </span>
          </div>
          <span className="nb-filter-divider" aria-hidden />
          {/* An icon when the strip is narrow, labelled when there's room (anki-panel.css). */}
          <Tooltip content="Anki settings">
            <IconButton label="Anki settings" size="sm" className="anki-settings-icon" onClick={openAnkiConnectSettings}>
              <Settings2 />
            </IconButton>
          </Tooltip>
          <Button size="sm" variant="ghost" className="anki-settings-wide" onClick={openAnkiConnectSettings}>
            <Settings2 />
            Anki settings
          </Button>
        </div>
        {openError ? (
          <Callout tone="danger" className="nb-callout">
            <span>{openError}</span>
            <Button variant="ghost" size="sm" onClick={() => setOpenError(null)}>
              Dismiss
            </Button>
          </Callout>
        ) : null}
        {notice ? (
          <Callout tone="neutral" className="nb-callout">
            <span>{notice}</span>
            <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </Callout>
        ) : null}
        {visible.length === 0 ? (
          <EmptyState
            className="anki-empty"
            icon={<SearchX />}
            title={`Nothing matches “${query.trim()}”`}
            actions={
              <Button size="sm" onClick={() => setQuery('')}>
                Clear search
              </Button>
            }
          >
            Search looks at each card&apos;s word, reading and deck.
          </EmptyState>
        ) : (
          <div id="anki-list" className="anki-list" role="list" aria-label="Anki cards made in this session">
            {visible.map((card) => (
              <CardRow
                key={card.noteId}
                card={card}
                onOpen={() => open(card)}
                onAddAudio={() => addAudio(card)}
                onAddScreenshot={() => addPicture(card)}
                onDelete={() => askDelete(card)}
              />
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="nb anki">
      <div className="nb-main">{body}</div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={deleting ? `Delete “${deleting.term || deleting.noteId}”?` : ''}
        description={
          <>
            It&apos;s removed from this session&apos;s Anki tab.
            <span className="anki-delete-choice">
              <Checkbox id={alsoAnkiId} checked={alsoAnki} onCheckedChange={(v) => setAlsoAnki(v === true)} />
              <label htmlFor={alsoAnkiId}>Also delete the card in Anki</label>
            </span>
          </>
        }
        confirmLabel={alsoAnki ? 'Delete here and in Anki' : 'Delete here'}
        tone="danger"
        busy={busy}
        onConfirm={confirmDelete}
      />
      <Bar position="bottom" className="nb-foot anki-foot">
        {cards.length > 0 ? (
          <span className="log-stats k-num">
            <span className="log-stat">
              <span className="log-stat-value">
                {visible.length === cards.length ? stats.total.toLocaleString() : `${visible.length} of ${stats.total}`}
              </span>
              <span>{stats.total === 1 ? 'card' : 'cards'}</span>
            </span>
            <span className="log-stat">
              <span className="log-stat-value">{stats.today.toLocaleString()}</span>
              <span>today</span>
            </span>
            {stats.enhanced > 0 ? (
              <span className="log-stat anki-stat-audio">
                <AudioLines aria-hidden />
                <span className="log-stat-value">{stats.enhanced.toLocaleString()}</span>
                <span>with audio</span>
              </span>
            ) : null}
            {stats.screenshots > 0 ? (
              <span className="log-stat anki-stat-audio">
                <ImageIcon aria-hidden />
                <span className="log-stat-value">{stats.screenshots.toLocaleString()}</span>
                <span>with screenshots</span>
              </span>
            ) : null}
          </span>
        ) : null}
        <BarSpacer />
        <SessionMenu />
      </Bar>
    </div>
  )
}

function CardRow({
  card,
  onOpen,
  onAddAudio,
  onAddScreenshot,
  onDelete
}: {
  card: AnkiCardRecord
  onOpen: () => void
  onAddAudio: () => void
  onAddScreenshot: () => void
  onDelete: () => void
}): JSX.Element {
  const enhanced = enhancementLabel(card.enhanced)
  const term = card.term || `Note ${card.noteId}`
  const sub = [card.deck, addedLabel(card.addedAt)].filter(Boolean).join(' · ')
  // The row stays lit while its right-click menu is open, as it does for its ⋯ menu.
  const [contextOpen, setContextOpen] = useState(false)
  const items = (
    <>
      <MenuItem icon={<ExternalLink />} shortcut="o" onSelect={onOpen}>
        Open in Anki
      </MenuItem>
      {!card.enhanced.includes('sentenceAudio') ? (
        <MenuItem icon={<AudioLines />} onSelect={onAddAudio}>
          Add sentence audio
        </MenuItem>
      ) : null}
      {!card.enhanced.includes('screenshot') ? (
        <MenuItem icon={<ImageIcon />} onSelect={onAddScreenshot}>
          Add screenshot
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={<Trash2 />} tone="danger" shortcut="d" onSelect={onDelete}>
        Delete…
      </MenuItem>
    </>
  )
  return (
    <div
      role="listitem"
      className="nb-row-wrap anki-row-wrap"
      data-note-id={card.noteId}
      data-menu-open={contextOpen ? '' : undefined}
    >
      <ContextMenu onOpenChange={setContextOpen}>
        <ContextMenuTrigger asChild>
          <Row
            className="nb-row anki-row"
            aria-label={`${term}${card.reading ? ` (${card.reading})` : ''}${enhanced ? `, ${enhanced}` : ''}. Open in Anki`}
            onClick={onOpen}
            trailing={
              enhanced ? (
                <span className="nb-trail">
                  <Tooltip content={enhanced}>
                    <span className="anki-enhanced" data-testid="anki-enhanced">
                      {hasAudio(card) ? <AudioLines aria-hidden /> : null}
                      {card.enhanced.includes('screenshot') ? <ImageIcon aria-hidden /> : null}
                    </span>
                  </Tooltip>
                </span>
              ) : null
            }
          >
            <span className="nb-row-title">
              <span className={card.term ? 'nb-name' : 'nb-name nb-name-empty'} lang="ja" translate="no">
                {term}
              </span>
              {card.reading ? (
                <span className="nb-reading" lang="ja" translate="no">
                  {card.reading}
                </span>
              ) : null}
            </span>
            <span className="nb-sub k-num">{sub}</span>
          </Row>
        </ContextMenuTrigger>
        <MenuContent>{items}</MenuContent>
      </ContextMenu>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={`Actions for ${term}`} size="sm" className="nb-row-actions" tabIndex={-1}>
            <MoreHorizontal />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">{items}</MenuContent>
      </Menu>
    </div>
  )
}
