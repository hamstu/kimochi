/**
 * Settings → OCR & Overlay → Engine (and onboarding's OCR step): a list of the OCR engines beside
 * a panel about one of them.
 *
 * Two ideas, kept apart:
 * - The VIEWED engine is the one the panel on the right describes (highlighted in the list, and
 *   the listbox's selected option). Clicking a row, or moving to it with the keyboard, only views
 *   it: its description, settings and model download, with nothing changed.
 * - The ACTIVE engine is the one scans use (`ocrMode`). Its row carries a green check (announced
 *   as "In use", and `aria-current`), and its panel says "Active". An engine is made active only
 *   from its panel's header, "Use <name>", which goes through `useEngineSelection` as the
 *   sidebar's picker does: a local engine whose model was never downloaded asks first
 *   (`DownloadConfirmDialog`), and while it asks the header says "Confirming…"; Cancel leaves the
 *   engine in use as it was. A pick shows as active from the click, not from the saved setting, so
 *   the beat spent asking the model's status (and the write afterwards) does not flash the button
 *   back. An engine this computer cannot run can be viewed, to read why, but its button is
 *   disabled and points at the reason.
 *
 * The viewed engine starts as, and follows, the active one (when it changes from elsewhere, such
 * as the sidebar). The list is one tab stop: the arrow keys and Home/End move the highlight and
 * the panel with it; Enter and Space on a row only view it. Tab moves on to the panel, whose
 * "Use <name>" button chooses; once used, focus goes back to the engine's row (the button turns
 * into the "Active" badge).
 *
 * Each row leads with the engine's picture (`OcrEngineIcon`). Engines and their copy come from
 * `OCR_MODES`; per-engine settings go in `EngineSettings`, and per-engine overflow actions in
 * `engineMenu` below. The decisions are `ui/engine-chooser.ts`.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Ellipsis, Trash2 } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
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
  engineListed,
  engineSelectable,
  type EngineHint
} from '@ui/ocr-engines'
import { listKeyTarget, ocrUseAction, activateLabel } from '@ui/engine-chooser'
import { OCR_MODES, type OcrMode } from '../../bridge/settings'
import { OcrEngineIcon, OcrRunsIcon } from '../../components/EngineIcon'
import { useCapabilities, type PlatformCapabilities } from '../../bridge/capabilities'
import { useModelControls, useModelStatus } from '../../bridge/models'
import { useEngineSelection } from '../../bridge/useEngineSelection'
import { DownloadConfirmDialog } from './DownloadConfirmDialog'
import { RemoveModelDialog } from './ModelDownload'
import { EngineSettings } from './EngineSettings'
import './engine-chooser.css'

type Engines = PlatformCapabilities['ocrEngines']

const MODES = Object.keys(OCR_MODES) as OcrMode[]


/** The active engine's mark at the end of its row: a green check, read out as "In use". */
export function InUseCheck(): ReactNode {
  return (
    <span className="engine-item-check">
      <Check aria-hidden />
      <span className="sr-only">In use</span>
    </span>
  )
}

function EngineItem({
  mode,
  id,
  engines,
  viewed,
  inUse,
  pending,
  onView
}: {
  mode: OcrMode
  id: string
  engines: Engines
  /** The panel shows this engine: the listbox's selected option. */
  viewed: boolean
  /** Scans use this engine (or the pick being saved): the check mark. */
  inUse: boolean
  /** Chosen, but its model download is being asked about. */
  pending: boolean
  onView: () => void
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
      aria-selected={viewed}
      aria-current={inUse ? 'true' : undefined}
      tabIndex={viewed ? 0 : -1}
      className="engine-item"
      data-viewed={viewed ? '' : undefined}
      data-in-use={inUse ? '' : undefined}
      data-unavailable={selectable ? undefined : ''}
      // Focus views (the arrow keys, a click); nothing here makes the engine active.
      onFocus={onView}
      onClick={(event) => event.currentTarget.focus()}
    >
      <OcrEngineIcon mode={mode} className="engine-item-icon" />
      <span className="engine-item-text">
        <span className="engine-item-name">
          {info.name}
          <OcrRunsIcon mode={mode} />
        </span>
        <span className="engine-item-tagline">{info.tagline}</span>
        {hint && (
          <Tooltip content={hint.reason}>
            <span className="engine-item-hint k-num" data-tone={hint.tone}>
              {hint.text}
            </span>
          </Tooltip>
        )}
      </span>
      {inUse && <InUseCheck />}
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
  const reasonId = `${id}-reason`
  const action = ocrUseAction({ inUse, pending, selectable })
  const runsOn = capability?.available ? acceleratorLabel(capability.accelerator) : null
  const capabilities = useCapabilities()
  const windows10 = capabilities.os === 'windows' &&
    Number(capabilities.osVersion.split('.')[2]) > 0 &&
    Number(capabilities.osVersion.split('.')[2]) < 22000

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
          <OcrRunsIcon mode={mode} />
        </h3>
        {action === 'active' ? (
          <Badge tone="accent">Active</Badge>
        ) : action === 'pending' ? (
          <Badge>Confirming…</Badge>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={action === 'unavailable'}
            aria-describedby={action === 'unavailable' ? reasonId : undefined}
            onClick={onUse}
          >
            {activateLabel(info.name)}
          </Button>
        )}
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
        <Callout tone="warn" id={reasonId}>
          {capability?.reason || 'Not available on this computer.'}
        </Callout>
      )}
      {mode === 'oneocr' && capabilities.os === 'windows' && (
        <>
          {windows10 && (
            <p className="k-description">
              Windows 10 needs three files from a recent Windows 11 Snipping Tool package:
              {' '}oneocr.dll, oneocr.onemodel and onnxruntime.dll. Put a matching x64 or ARM64
              set in your user folder under .config/oneocr.
            </p>
          )}
          {!capability?.available && (
            <Callout tone="warn">{capability?.reason || 'OneOCR runtime files need setup.'}</Callout>
          )}
          {(windows10 || !capability?.available) && (
            <Button size="sm" onClick={() => void openUrl('https://github.com/AuroraWright/oneocr#readme')}>
              OneOCR setup instructions
            </Button>
          )}
        </>
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
  const capabilities = useCapabilities()
  const engines = capabilities.ocrEngines
  // Kimochi cloud is listed only with an access key, or while it is still the selected engine.
  const modes = MODES.filter((mode) => engineListed(mode, capabilities, ocrMode))
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
  // Only a pick the download question is open for is pending; meanwhile the saved engine is still
  // the one in use. A pick still being decided, or written, already shows as in use: `shown`
  // leads `ocrMode` by a round trip, and the panel follows `shown` so it does not flash the
  // "Use" button back in between.
  const pendingMode = confirmation ? shown : null
  const inUseMode = pendingMode ? ocrMode : shown

  const focusMode = (mode: OcrMode): void => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(itemId(mode))}`)?.focus()
  }

  // "Use <name>": the only way an engine becomes active here.
  const use = (mode: OcrMode): void => {
    if (mode === shown || !engineSelectable(engines[mode])) return
    // The button gives way to "Active" (or the download question), so the keyboard goes back to
    // the engine's row rather than falling to the page.
    focusMode(mode)
    choose(mode)
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
    // Enter and Space only view the row, which is viewed already; Space must not scroll the page.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      return
    }
    const next = listKeyTarget(event.key, modes.indexOf(viewed), modes.length)
    if (next === null) return
    event.preventDefault()
    focusMode(modes[next])
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
          {modes.map((mode) => (
            <EngineItem
              key={mode}
              mode={mode}
              id={itemId(mode)}
              engines={engines}
              viewed={mode === viewed}
              inUse={mode === inUseMode}
              pending={mode === pendingMode}
              onView={() => setViewed(mode)}
            />
          ))}
        </div>
        <EngineDetail
          key={viewed}
          mode={viewed}
          id={detailId}
          engines={engines}
          inUse={viewed === inUseMode}
          pending={viewed === pendingMode}
          onUse={() => use(viewed)}
        />
      </div>
      <DownloadConfirmDialog confirmation={confirmation} />
    </div>
  )
}

