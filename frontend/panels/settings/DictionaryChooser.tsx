/**
 * Settings → Dictionary → Engine: a list of the dictionary engines beside a panel about one of
 * them, in the shape of the OCR engine chooser (`EngineChooser.tsx`), whose class names and
 * keyboard model it shares.
 *
 * - The ACTIVE engine is the one lookups use (`yomitanSettings.popupType`): the filled radio dot
 *   and "Active" in the panel. It is shown as active from the click, not from the saved setting,
 *   so the panel does not flash "Use this engine" during the write.
 * - The VIEWED engine is the one the panel describes. It starts as, and follows, the active one.
 *
 * A click views and chooses at once; the keyboard looks without choosing (arrows, Home/End move
 * the highlight and the panel, Enter or Space chooses). A viewed engine that is not active offers
 * "Use this engine". Choosing is the caller's (`onChoose`): it saves, mirrors and reloads the
 * reader windows. Each engine's own settings come from `renderSettings`.
 *
 * No engine is bundled: each is downloaded from its pinned upstream release when first chosen
 * (EXTENSION_DOWNLOADS.md). A viewed engine that is not downloaded offers "Download · 15 MB"
 * instead of "Use this engine"; the caller asks first, downloads, and switches only once the
 * download is ready (`pending` is the engine waiting for its download). The download's progress
 * block sits in the panel, and the overflow menu removes a downloaded engine that is not in use.
 *
 * Copy comes from `DICTIONARY_ENGINES` in `ui/settings.ts`.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Cloud, Download, Ellipsis, ExternalLink, Monitor, Trash2 } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import {
  Badge,
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Tooltip
} from '@kit'
import { DICTIONARY_ENGINES, type DictionaryEngine } from '../../bridge/dictionaryEngine'
import { useExtensionControls, useExtensionStatus, type ExtensionControls } from '../../bridge/extensions'
import {
  canRemoveExtension,
  downloadButtonLabel,
  downloadEngineFor,
  removePrompt,
  type ExtensionEngine
} from '@ui/extension-download'
import { ModelDownload } from './ModelDownload'
import './engine-chooser.css'
import './dictionary-chooser.css'

const ENGINES = Object.keys(DICTIONARY_ENGINES) as DictionaryEngine[]

/** Where the engine runs, as an icon: this computer, or a server across the network. */
function RunsIcon({ engine }: { engine: DictionaryEngine }): ReactNode {
  const local = DICTIONARY_ENGINES[engine].runs === 'local'
  return (
    <span className="engine-runs" title={local ? 'Runs on this computer' : 'Uses a server'}>
      {local ? <Monitor aria-label="On this computer" /> : <Cloud aria-label="Uses a server" />}
    </span>
  )
}

function ExperimentalBadge({ engine }: { engine: DictionaryEngine }): ReactNode {
  return DICTIONARY_ENGINES[engine].experimental ? <Badge tone="warn">Experimental</Badge> : null
}

function DictionaryItem({
  engine,
  id,
  viewed,
  active,
  onFocus,
  onPick
}: {
  engine: DictionaryEngine
  id: string
  viewed: boolean
  active: boolean
  onFocus: () => void
  onPick: () => void
}): ReactNode {
  const info = DICTIONARY_ENGINES[engine]
  const status = useExtensionStatus(engine === 'custom-api' ? null : engine)
  const missing = status !== null && status.state !== 'ready'
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={viewed ? 0 : -1}
      className="engine-item"
      data-viewed={viewed ? '' : undefined}
      data-active={active ? '' : undefined}
      onFocus={onFocus}
      // As in the OCR chooser: act on release only, so a press does not move the view first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.currentTarget.focus()
        onPick()
      }}
    >
      <span className="engine-item-radio" aria-hidden />
      <span className="engine-item-text">
        <span className="engine-item-name">
          {info.name}
          <RunsIcon engine={engine} />
          {missing && (
            <span className="engine-runs" title="Not downloaded yet">
              <Download aria-label="Not downloaded yet" />
            </span>
          )}
        </span>
        <span className="engine-item-tagline">{info.tagline}</span>
      </span>
    </div>
  )
}

/** "Remove Hachidori?", from the panel's overflow menu. */
function RemoveEngineDialog({
  controls,
  open,
  onOpenChange
}: {
  controls: ExtensionControls
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const { status, run } = controls
  const [last, setLast] = useState(status)
  if (status && status !== last) setLast(status)
  const shown = status ?? last
  const prompt = shown ? removePrompt(shown) : null
  return (
    <ConfirmDialog
      open={open && shown !== null}
      onOpenChange={onOpenChange}
      title={prompt?.title ?? ''}
      description={prompt?.description}
      confirmLabel="Remove"
      tone="danger"
      onConfirm={() => {
        onOpenChange(false)
        run('delete')
      }}
    />
  )
}

function DictionaryDetail({
  engine,
  id,
  inUse,
  pending,
  selectedDownload,
  onUse,
  children
}: {
  engine: DictionaryEngine
  id: string
  inUse: boolean
  /** A switch to this engine is waiting for its download. */
  pending: boolean
  /** The download the saved engine needs: it cannot be removed from here. */
  selectedDownload: ExtensionEngine
  onUse: () => void
  children: ReactNode
}): ReactNode {
  const info = DICTIONARY_ENGINES[engine]
  const headingId = `${id}-heading`
  const needs = downloadEngineFor(engine)
  const download = useExtensionControls(needs)
  const status = download.status
  // Unknown (an older backend, the preview) counts as ready: nothing to download then.
  const ready = status === null || status.state === 'ready'
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removable = canRemoveExtension(status) && needs !== selectedDownload && download.pending === null
  const showMenu = engine !== 'custom-api' && status !== null && status.source !== 'development'
  return (
    <section id={id} className="engine-detail" aria-labelledby={headingId}>
      <header className="engine-detail-header">
        <h3 id={headingId} className="k-heading engine-detail-name">
          {info.name}
          <RunsIcon engine={engine} />
          <ExperimentalBadge engine={engine} />
        </h3>
        {inUse ? (
          <Badge tone="accent">Active</Badge>
        ) : pending ? (
          <Badge>Switching when ready</Badge>
        ) : ready ? (
          <Button size="sm" variant="primary" onClick={onUse}>
            Use this engine
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onUse}>
            <Download aria-hidden />
            {status?.state === 'absent' ? downloadButtonLabel(status) : 'Use when downloaded'}
          </Button>
        )}
        {showMenu && (
          <Menu>
            <Tooltip content="More">
              <MenuTrigger asChild>
                <IconButton label={`More ${info.name} actions`} size="sm">
                  <Ellipsis />
                </IconButton>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end">
              <MenuItem
                icon={<Trash2 />}
                tone="danger"
                disabled={!removable}
                onSelect={() => setConfirmRemove(true)}
              >
                {needs === selectedDownload && canRemoveExtension(status)
                  ? 'Remove downloaded engine… (switch to another engine first)'
                  : 'Remove downloaded engine…'}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </header>
      <p className="engine-detail-description">{info.description}</p>
      <ul className="engine-strengths">
        {info.strengths.map((strength) => (
          <li key={strength}>
            <Check aria-hidden />
            <span>{strength}</span>
          </li>
        ))}
      </ul>
      <p className="k-description">{info.requirements}</p>
      <p className="dictionary-detail-meta k-num">
        {info.version && <span>Version {info.version}</span>}
        <span>{info.licence}</span>
        <button
          type="button"
          className="k-link dictionary-detail-upstream"
          onClick={() =>
            void openUrl(info.upstream).catch((error: unknown) =>
              console.error('Open upstream page failed:', error)
            )
          }
        >
          {info.upstreamLabel ?? 'Upstream'}
          <ExternalLink aria-hidden />
        </button>
      </p>
      {status && !ready && (
        <p className="k-description">
          {engine === 'custom-api'
            ? `Kimochi's pop-up runs over Yomitan, which is not downloaded yet.`
            : `${info.name} is not part of Kimochi's download: it is fetched from its official release when you choose it.`}
        </p>
      )}
      <div className="engine-detail-settings">
        {/* While it is not downloaded (or a download is under way), its progress and actions. */}
        {status && (!ready || pending) && (
          <ModelDownload controls={download} emphasis={inUse || pending} label="Download" />
        )}
        {children}
      </div>
      <RemoveEngineDialog controls={download} open={confirmRemove} onOpenChange={setConfirmRemove} />
    </section>
  )
}

export function DictionaryChooser({
  active,
  pending = null,
  onChoose,
  renderSettings,
  status
}: {
  /** The engine shown as chosen: the caller's pick, ahead of the saved setting. */
  active: DictionaryEngine
  /** An engine whose switch waits for its download. */
  pending?: DictionaryEngine | null
  onChoose: (engine: DictionaryEngine) => void
  /** The viewed engine's own settings, under the panel's hairline. */
  renderSettings: (engine: DictionaryEngine, inUse: boolean) => ReactNode
  /** A line under the frame: the reload note, or an error. */
  status?: ReactNode
}): ReactNode {
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  // The viewed engine follows the active one whenever that changes (including the first load).
  const [viewed, setViewed] = useState<DictionaryEngine>(active)
  const [followed, setFollowed] = useState<DictionaryEngine>(active)
  if (followed !== active) {
    setFollowed(active)
    setViewed(active)
  }

  const itemId = (engine: DictionaryEngine): string => `${baseId}-dictionary-${engine}`
  const detailId = `${baseId}-detail`

  const pick = (engine: DictionaryEngine): void => {
    setViewed(engine)
    if (engine !== active) onChoose(engine)
  }

  const focusEngine = (engine: DictionaryEngine): void => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(itemId(engine))}`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = ENGINES.indexOf(viewed)
    let next: number
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, ENGINES.length - 1)
        break
      case 'ArrowUp':
        next = Math.max(index - 1, 0)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = ENGINES.length - 1
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        pick(viewed)
        return
      default:
        return
    }
    event.preventDefault()
    focusEngine(ENGINES[next])
  }

  return (
    <div className="engine-chooser">
      <div className="engine-chooser-frame">
        <div
          ref={listRef}
          role="listbox"
          aria-label="Dictionary engine"
          aria-controls={detailId}
          className="engine-list"
          onKeyDown={onKeyDown}
        >
          {ENGINES.map((engine) => (
            <DictionaryItem
              key={engine}
              engine={engine}
              id={itemId(engine)}
              viewed={engine === viewed}
              active={engine === active}
              onFocus={() => setViewed(engine)}
              onPick={() => pick(engine)}
            />
          ))}
        </div>
        <DictionaryDetail
          key={viewed}
          engine={viewed}
          id={detailId}
          inUse={viewed === active}
          pending={viewed === pending}
          selectedDownload={downloadEngineFor(active)}
          onUse={() => pick(viewed)}
        >
          {renderSettings(viewed, viewed === active)}
        </DictionaryDetail>
      </div>
      {status && <div className="dictionary-chooser-status">{status}</div>}
    </div>
  )
}
