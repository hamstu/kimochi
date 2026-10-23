/**
 * Settings → Dictionary → Engine: a list of the dictionary engines beside a panel about one of
 * them, in the shape of the OCR engine chooser (`EngineChooser.tsx`), whose class names and
 * keyboard model it shares.
 *
 * - The VIEWED engine is the one the panel describes (highlighted in the list, and the listbox's
 *   selected option). Clicking a row, or moving to it with the keyboard, only views it: its
 *   description, pop-up picture, download and settings, with nothing changed.
 * - The ACTIVE engine is the one lookups use (`yomitanSettings.popupType`). Its row carries a
 *   green check (announced as "In use", and `aria-current`), and its panel says "Active". An
 *   engine is made active only from its panel's header, "Use <name>"; it is shown as active from
 *   the click, not from the saved setting, so the panel does not flash the button back during the
 *   write. Choosing is the caller's (`onChoose`): it saves, mirrors and reloads the reader
 *   windows, and for the Yomitan API opens its setup wizard.
 *
 * The viewed engine starts as, and follows, the active one. The list is one tab stop: the arrow
 * keys and Home/End move the highlight and the panel with it; Enter and Space on a row only view
 * it. Tab moves on to the panel, whose button chooses; once used, focus goes back to the row.
 *
 * No engine is bundled: each is downloaded from its pinned upstream release when first chosen
 * (EXTENSION_DOWNLOADS.md). A viewed engine that is not downloaded offers its download in place
 * of "Use <name>" ("Download · 15 MB", or "Use when downloaded" for one under way); the caller
 * asks first, downloads, and switches only once the download is ready (`pending` is the engine
 * waiting for its download, "Switching when ready"). The download's progress block sits in the
 * panel, and the overflow menu removes a downloaded engine that is not in use. After an app update
 * moved an engine's pin, its new release downloads in the background while the earlier one stays
 * in use; that update has its own progress block ("Updating to …").
 *
 * Each row leads with the engine's picture (`DictionaryEngineIcon`). Copy comes from
 * `DICTIONARY_ENGINES` in `ui/settings.ts`; the pop-up picture beside the description from
 * frontend/assets/dictionary-previews/ (`DictionaryPreview`). The decisions are
 * `ui/engine-chooser.ts`.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Download, Ellipsis, ExternalLink, Trash2 } from 'lucide-react'
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
  updateActions,
  updateDownload,
  updateLine,
  type ExtensionEngine
} from '@ui/extension-download'
import { dictionaryUseAction, listKeyTarget, activateLabel } from '@ui/engine-chooser'
import { ModelDownload } from './ModelDownload'
import { InUseCheck } from './EngineChooser'
import { DictionaryPreview } from '../../components/DictionaryPreview'
import { DictionaryEngineIcon, DictionaryRunsIcon } from '../../components/EngineIcon'
import './engine-chooser.css'
import './dictionary-chooser.css'
import { useDictionaryReadiness } from '../../bridge/dictionaryReadiness'

const ENGINES = Object.keys(DICTIONARY_ENGINES) as DictionaryEngine[]

function DictionaryItem({
  engine,
  id,
  viewed,
  inUse,
  recommended,
  onView
}: {
  engine: DictionaryEngine
  id: string
  /** The panel shows this engine: the listbox's selected option. */
  viewed: boolean
  /** Lookups use this engine (or the pick being saved): the check mark. */
  inUse: boolean
  /** Badged "Recommended" (onboarding's step). */
  recommended: boolean
  onView: () => void
}): ReactNode {
  const info = DICTIONARY_ENGINES[engine]
  const status = useExtensionStatus(engine === 'custom-api' ? null : engine)
  const missing = status !== null && status.state !== 'ready'
  return (
    <div
      id={id}
      role="option"
      aria-selected={viewed}
      aria-current={inUse ? 'true' : undefined}
      tabIndex={viewed ? 0 : -1}
      className="engine-item"
      data-viewed={viewed ? '' : undefined}
      data-in-use={inUse ? '' : undefined}
      // Focus views (the arrow keys, a click); nothing here makes the engine active.
      onFocus={onView}
      onClick={(event) => event.currentTarget.focus()}
    >
      <DictionaryEngineIcon engine={engine} className="engine-item-icon" />
      <span className="engine-item-text">
        <span className="engine-item-name">
          {info.name}
          <DictionaryRunsIcon engine={engine} />
          {missing && (
            <span className="engine-runs" title="Not downloaded yet">
              <Download aria-label="Not downloaded yet" />
            </span>
          )}
        </span>
        <span className="engine-item-tagline">{info.tagline}</span>
        {recommended && (
          <Badge tone="accent" className="engine-item-badge">
            Recommended
          </Badge>
        )}
      </span>
      {inUse && <InUseCheck />}
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
  /** The download the saved engine needs (none for the Yomitan API): it cannot be removed from here. */
  selectedDownload: ExtensionEngine | null
  onUse: () => void
  children: ReactNode
}): ReactNode {
  const info = DICTIONARY_ENGINES[engine]
  const headingId = `${id}-heading`
  const runtime = useDictionaryReadiness(engine)
  const needs = downloadEngineFor(engine)
  const download = useExtensionControls(needs)
  const status = download.status
  // Unknown (an older backend, the preview) counts as ready: nothing to download then.
  const ready = status === null || status.state === 'ready'
  const action = dictionaryUseAction({ inUse, pending, download: status?.state ?? null })
  const [confirmRemove, setConfirmRemove] = useState(false)
  const update = updateDownload(status)
  const version = status?.update?.from || status?.version || info.version
  const removable = canRemoveExtension(status) && needs !== selectedDownload && download.pending === null
  const showMenu = engine !== 'custom-api' && status !== null && status.source !== 'development'
  return (
    <section id={id} className="engine-detail" aria-labelledby={headingId}>
      <header className="engine-detail-header">
        <h3 id={headingId} className="k-heading engine-detail-name">
          {info.name}
          <DictionaryRunsIcon engine={engine} />
        </h3>
        {action === 'active' ? (
          <Badge tone={runtime.phase === 'ready' ? 'accent' : 'warn'}>{runtime.phase === 'ready' ? 'Active' : 'Setting up'}</Badge>
        ) : action === 'pending' ? (
          <Badge>Switching when ready</Badge>
        ) : action === 'use' ? (
          <Button size="sm" variant="primary" onClick={onUse}>
            {activateLabel(info.name)}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onUse}>
            <Download aria-hidden />
            {action === 'download' ? downloadButtonLabel(status) : 'Use when downloaded'}
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
      {/* The pop-up's picture is a thumbnail beside the words (it opens full size), so the
          panel's download progress stays in view. */}
      <div className="dictionary-detail-intro">
        <div className="dictionary-detail-words">
          <p className="engine-detail-description">{info.description}</p>
          <ul className="engine-strengths">
            {info.strengths.map((strength) => (
              <li key={strength}>
                <Check aria-hidden />
                <span>{strength}</span>
              </li>
            ))}
          </ul>
        </div>
        <DictionaryPreview engine={engine} />
      </div>
      <p className="k-description">{info.requirements}</p>
      <p className="dictionary-detail-meta k-num">
        {/* The release in use: during an app update's background download, still the earlier one. */}
        {version && <span>Version {version}</span>}
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
      <div className="engine-detail-settings">
        {/* While it is not downloaded (or a download is under way), its progress and actions. */}
        {status && (!ready || pending) && (
          <ModelDownload controls={download} emphasis={inUse || pending} label="Download" />
        )}
        {/* An app update's new release, downloading while the earlier one stays in use. */}
        {status && update && (
          <ModelDownload
            controls={{ ...download, status: update }}
            emphasis={false}
            label="Update"
            line={updateLine(status)}
            actions={updateActions(status)}
            labelFor={(action) => (action === 'download' ? 'Update' : null)}
          />
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
  status,
  recommended = null
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
  /** An engine to badge "Recommended" in the list. */
  recommended?: DictionaryEngine | null
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

  const focusEngine = (engine: DictionaryEngine): void => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(itemId(engine))}`)?.focus()
  }

  // "Use <name>" (or its download): the only way an engine becomes active here.
  const use = (engine: DictionaryEngine): void => {
    if (engine === active) return
    // The button gives way to "Active" (or a dialog), so the keyboard goes back to the engine's
    // row rather than falling to the page; a dialog hands focus back there too.
    focusEngine(engine)
    onChoose(engine)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Enter and Space only view the row, which is viewed already; Space must not scroll the page.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      return
    }
    const next = listKeyTarget(event.key, ENGINES.indexOf(viewed), ENGINES.length)
    if (next === null) return
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
              inUse={engine === active}
              recommended={engine === recommended}
              onView={() => setViewed(engine)}
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
          onUse={() => use(viewed)}
        >
          {renderSettings(viewed, viewed === active)}
        </DictionaryDetail>
      </div>
      {status && <div className="dictionary-chooser-status">{status}</div>}
    </div>
  )
}
