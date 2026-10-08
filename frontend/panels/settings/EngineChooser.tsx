/**
 * Settings → OCR & Overlay → Engine: a list of the OCR engines beside a panel about one of them.
 *
 * Two ideas, kept apart:
 * - The ACTIVE engine is the one scans use (`ocrMode`). It is marked by the filled radio dot in
 *   the list and "In use" in the panel. Choosing goes through `useEngineSelection`, as the
 *   sidebar's picker does, so a local engine whose model was never downloaded asks first
 *   (`DownloadConfirmDialog`); while it asks, the item shows as pending, and Cancel puts the dot
 *   back where it was.
 * - The VIEWED engine is the one the panel on the right describes (highlighted in the list).
 *   It starts as, and follows, the active engine.
 *
 * Clicking an item views it and makes it active. The keyboard can look without choosing: the list
 * is one tab stop, the arrow keys (and Home/End) move the highlight and the panel with it, and
 * Enter or Space makes the highlighted engine active. When the panel shows an engine that is not
 * in use (moved to by keyboard, or left there by a cancelled download), its header offers "Use
 * this engine". An engine this computer cannot run can be viewed, to read why, but not chosen.
 *
 * Engines and their copy come from `OCR_MODES`; per-engine settings go in `EngineSettings`, and
 * per-engine overflow actions in `engineMenu` below.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Ellipsis, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Callout,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Tooltip
} from '@kit'
import { canRemoveModel, isModelEngine } from '@ui/model-download'
import {
  acceleratorLabel,
  engineHint,
  engineSelectable,
  type EngineHint
} from '@ui/ocr-engines'
import { OCR_MODES, type OcrMode } from '../../bridge/settings'
import { useCapabilities, type PlatformCapabilities } from '../../bridge/capabilities'
import { useModelControls, useModelStatus } from '../../bridge/models'
import { useEngineSelection } from '../../bridge/useEngineSelection'
import { DownloadConfirmDialog } from './DownloadConfirmDialog'
import { RemoveModelDialog } from './ModelDownload'
import { EngineSettings } from './EngineSettings'
import './engine-chooser.css'

type Engines = PlatformCapabilities['ocrEngines']

const MODES = Object.keys(OCR_MODES) as OcrMode[]

function EngineItem({
  mode,
  id,
  engines,
  viewed,
  active,
  pending,
  onFocus,
  onPick
}: {
  mode: OcrMode
  id: string
  engines: Engines
  viewed: boolean
  /** Shown as chosen: the saved engine, or the pick awaiting confirmation. */
  active: boolean
  pending: boolean
  onFocus: () => void
  onPick: () => void
}): ReactNode {
  const info = OCR_MODES[mode]
  const status = useModelStatus(isModelEngine(mode) ? mode : null)
  const capability = engines[mode]
  const hint: EngineHint | null = pending
    ? { text: 'Confirming…', tone: 'progress' }
    : engineHint(capability, status)
  const selectable = engineSelectable(capability)
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={selectable ? undefined : true}
      tabIndex={viewed ? 0 : -1}
      className="engine-item"
      data-viewed={viewed ? '' : undefined}
      data-active={active ? '' : undefined}
      data-pending={pending ? '' : undefined}
      onFocus={onFocus}
      onClick={(event) => {
        // A click views the engine as well as choosing it, so the keyboard carries on from here.
        event.currentTarget.focus()
        onPick()
      }}
    >
      <span className="engine-item-radio" aria-hidden />
      <span className="engine-item-text">
        <span className="engine-item-name">{info.name}</span>
        <span className="engine-item-tagline">{info.tagline}</span>
        {hint && (
          <Tooltip content={hint.reason}>
            <span className="engine-item-hint k-num" data-tone={hint.tone}>
              {hint.text}
            </span>
          </Tooltip>
        )}
      </span>
    </div>
  )
}

function EngineDetail({
  mode,
  id,
  engines,
  inUse,
  pending,
  onUse
}: {
  mode: OcrMode
  id: string
  engines: Engines
  inUse: boolean
  pending: boolean
  onUse: () => void
}): ReactNode {
  const info = OCR_MODES[mode]
  const capability = engines[mode]
  const selectable = engineSelectable(capability)
  const model = useModelControls(isModelEngine(mode) ? mode : null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const headingId = `${id}-heading`
  const runsOn = capability?.available ? acceleratorLabel(capability.accelerator) : null

  // The engine's overflow actions. Today only a downloaded model's removal; add others here.
  const engineMenu = model.engine ? (
    <MenuItem
      icon={<Trash2 />}
      tone="danger"
      disabled={!canRemoveModel(model.status) || model.pending !== null}
      onSelect={() => setConfirmRemove(true)}
    >
      Remove downloaded model…
    </MenuItem>
  ) : null

  return (
    <section id={id} className="engine-detail" aria-labelledby={headingId}>
      <header className="engine-detail-header">
        <h3 id={headingId} className="k-heading engine-detail-name">
          {info.name}
        </h3>
        {inUse ? (
          <Badge tone="accent">In use</Badge>
        ) : pending ? (
          <Badge>Confirming…</Badge>
        ) : selectable ? (
          <Button size="sm" variant="primary" onClick={onUse}>
            Use this engine
          </Button>
        ) : null}
        {engineMenu && (
          <Menu>
            <Tooltip content="More">
              <MenuTrigger asChild>
                <IconButton label={`More ${info.name} actions`} size="sm">
                  <Ellipsis />
                </IconButton>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end">{engineMenu}</MenuContent>
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
      <p className="k-description">
        {info.requirements}
        {runsOn && ` On this computer it runs on ${runsOn}.`}
      </p>
      {!selectable && (
        <Callout tone="warn">{capability?.reason || 'Not available on this computer.'}</Callout>
      )}
      <div className="engine-detail-settings">
        {/* An engine that cannot run here has nothing to set up or download. */}
        {selectable && <EngineSettings mode={mode} model={model} emphasis={inUse} />}
      </div>
      <RemoveModelDialog controls={model} open={confirmRemove} onOpenChange={setConfirmRemove} />
    </section>
  )
}

export function EngineChooser(): ReactNode {
  const { ocrMode, shown, choose, confirmation } = useEngineSelection()
  const engines = useCapabilities().ocrEngines
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  // The viewed engine follows the active one whenever that changes (including when the saved
  // setting first loads); otherwise it is wherever the user last looked.
  const [viewed, setViewed] = useState<OcrMode>(ocrMode)
  const [followed, setFollowed] = useState<OcrMode>(ocrMode)
  if (followed !== ocrMode) {
    setFollowed(ocrMode)
    setViewed(ocrMode)
  }

  const itemId = (mode: OcrMode): string => `${baseId}-engine-${mode}`
  const detailId = `${baseId}-detail`
  const pendingMode = shown !== ocrMode ? shown : null

  const pick = (mode: OcrMode): void => {
    setViewed(mode)
    if (mode === shown || !engineSelectable(engines[mode])) return
    choose(mode)
  }

  const focusMode = (mode: OcrMode): void => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(itemId(mode))}`)?.focus()
  }

  // The download question opens on its own (after the status arrives), so the dialog has no
  // trigger to hand focus back to. When it closes, put the keyboard back on the list.
  const asking = confirmation !== null
  const wasAsking = useRef(asking)
  useEffect(() => {
    const closed = wasAsking.current && !asking
    wasAsking.current = asking
    if (!closed) return
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [asking])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = MODES.indexOf(viewed)
    let next: number | null = null
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, MODES.length - 1)
        break
      case 'ArrowUp':
        next = Math.max(index - 1, 0)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = MODES.length - 1
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
    focusMode(MODES[next])
  }

  return (
    <div className="engine-chooser">
      <div className="engine-chooser-frame">
        <div
          ref={listRef}
          role="listbox"
          aria-label="OCR engine"
          aria-controls={detailId}
          className="engine-list"
          onKeyDown={onKeyDown}
        >
          {MODES.map((mode) => (
            <EngineItem
              key={mode}
              mode={mode}
              id={itemId(mode)}
              engines={engines}
              viewed={mode === viewed}
              active={mode === shown}
              pending={mode === pendingMode}
              onFocus={() => setViewed(mode)}
              onPick={() => pick(mode)}
            />
          ))}
        </div>
        <EngineDetail
          key={viewed}
          mode={viewed}
          id={detailId}
          engines={engines}
          inUse={viewed === ocrMode}
          pending={viewed === pendingMode}
          onUse={() => pick(viewed)}
        />
      </div>
      <DownloadConfirmDialog confirmation={confirmation} />
    </div>
  )
}

