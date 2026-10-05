/**
 * The sidebar's Source: one card that says where the Log's text comes from, a menu of source types
 * to change it, and under it the controls that apply to that source.
 *
 * Nothing chosen yet is a dashed card. The menu's "Window or screen" opens a submenu of every
 * window and display, as thumbnails, to choose from. Once one is chosen the card shows it live (a
 * fresh frame every few seconds, crossfaded in) with its region marked; clicking the picture brings
 * a window to the front, and the card's foot holds Crop area and Change source. The scan, Auto OCR
 * and overlay controls sit underneath. Quick Shot keeps a scan button and the overlay but has
 * nothing to watch; Clipboard and WebSocket need no controls at all.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Aperture,
  AppWindow,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Clipboard,
  Crop,
  Eye,
  Monitor,
  Plus,
  Radio,
  ScanSearch,
  ScanText,
  Settings,
  SquareDashed,
  X
} from 'lucide-react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuTrigger,
  Spinner
} from '@kit'
import { SourceGrid } from './SourceGrid'
import { getSettings, onSettingsChange, updateSettings } from '@texthooker/lib/settings'
import type { InputSource } from '@texthooker/input-source'
import { SourceIcon } from '../components/RemoteControl'
import { isOverlayTextVisible } from '../../ui/settings'
import { useSetting } from '../bridge/useSetting'
import { useViewState } from '../bridge/state'
import { useHotkeys } from '../bridge/useHotkeys'
import { nativeError, sourceLiveThumbnail } from '../bridge/tauri'
import type { NativeCrop } from '../bridge/types'
import { formatAccelerator, keyPlatformOf } from '../panels/settings/accelerator'
import { useCapabilities } from '../bridge/capabilities'
import type { ControllerWiring } from '../panels/useController'

type Controller = ControllerWiring['props']
/** The texthooker's inputs, with OCR split into a chosen window or screen and Quick Shot. */
type Mode = InputSource | 'quickshot'

/** How often the live preview asks for a new frame, and how soon it retries after `busy:`. */
const REFRESH_MS = 2500
const BUSY_RETRY_MS = 900
/** The crossfade; matches `.src-frame`'s opacity transition. */
const FADE_MS = 700

const TYPES = [
  {
    mode: 'ocr',
    label: 'Window or screen',
    icon: <AppWindow />,
    detail: 'Read a game window or a whole display with OCR.'
  },
  {
    mode: 'quickshot',
    label: 'Quick Shot',
    icon: <Aperture />,
    detail: 'Draw an area with the scan shortcut, anywhere.'
  },
  {
    mode: 'clipboard',
    label: 'Clipboard',
    icon: <Clipboard />,
    detail: 'Pick up text copied by a text hooker.'
  },
  {
    mode: 'websocket',
    label: 'WebSocket',
    icon: <Radio />,
    detail: 'Receive lines from a text source on your network.'
  }
] as const satisfies readonly { mode: Mode; label: string; icon: ReactNode; detail: string }[]

function useInputSource(): [Mode, (next: Mode) => void] {
  const [input, setInput] = useState<InputSource>(() => getSettings().inputSource)
  useEffect(() => onSettingsChange((next) => setInput(next.inputSource)), [])
  const [quickShot, setQuickShot] = useSetting<boolean>('quickShotEnabled', false)
  const mode: Mode = input === 'ocr' && quickShot ? 'quickshot' : input
  // Quick Shot is OCR input as far as the Log is concerned; only the overlay tells them apart.
  const choose = (next: Mode): void => {
    const nextInput: InputSource = next === 'quickshot' ? 'ocr' : next
    if (nextInput !== input) void updateSettings({ inputSource: nextInput })
    if ((next === 'quickshot') !== quickShot) void setQuickShot(next === 'quickshot')
  }
  return [mode, choose]
}

/** A switch drawn inside a row; the row itself is the control. */
function SwitchMark({ on }: { on: boolean }): ReactNode {
  const state = on ? 'checked' : 'unchecked'
  return (
    <span className="k-switch k-switch-sm src-switch" data-state={state} aria-hidden>
      <span className="k-switch-thumb" data-state={state} />
    </span>
  )
}

// ---------------------------------------------------------------------------- live preview

interface Frame {
  id: number
  url: string
  ready: boolean
}

/**
 * The chosen source, refreshed every few seconds while the window is visible. Each new frame is
 * stacked over the last and faded in; the old one goes once the fade ends. A failed or busy capture
 * keeps the last frame, so the card never flashes empty.
 */
function useLiveFrames(sourceId: string): {
  frames: Frame[]
  size: { width: number; height: number } | null
  onLoad: (id: number) => void
} {
  const [frames, setFrames] = useState<Frame[]>([])
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const next = useRef(0)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void tick(), ms)
    }
    const tick = async (): Promise<void> => {
      if (!alive) return
      // A hidden window shows nothing; resumed by the visibility listener below.
      if (document.visibilityState !== 'visible') return
      try {
        const frame = await sourceLiveThumbnail(sourceId)
        if (!alive) return
        if (frame.url) {
          setSize({ width: frame.width, height: frame.height })
          setFrames((current) => [
            ...current.slice(-1),
            { id: next.current++, url: frame.url, ready: false }
          ])
        }
        schedule(REFRESH_MS)
      } catch (error) {
        if (!alive) return
        const { message } = nativeError(error)
        schedule(message.startsWith('busy:') ? BUSY_RETRY_MS : REFRESH_MS * 2)
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') schedule(0)
      else clearTimeout(timer)
    }
    document.addEventListener('visibilitychange', onVisibility)
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sourceId])

  const drop = (id: number): void =>
    setFrames((current) => {
      const index = current.findIndex((frame) => frame.id === id)
      return index > 0 ? current.slice(index) : current
    })

  return {
    frames,
    size,
    // A data URL can finish loading before the frame is first painted, which would skip the
    // fade; wait for two paints at opacity 0 first. Once it is fully in, drop what is under it.
    onLoad: (id) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setFrames((current) =>
            current.map((frame) => (frame.id === id ? { ...frame, ready: true } : frame))
          )
          setTimeout(() => drop(id), FADE_MS + 50)
        })
      )
  }
}

function LivePreview({
  sourceId,
  crop,
  live,
  placeholder,
  hint
}: {
  sourceId: string
  crop: NativeCrop | null
  live: boolean
  placeholder: ReactNode
  /** Shown over the picture while the card is hovered. */
  hint?: ReactNode
}): ReactNode {
  const { frames, size, onLoad } = useLiveFrames(sourceId)
  const ratio = size ? size.width / size.height : 16 / 9
  // The well follows the frame's shape within limits; the frame sits inside it, fitted, with
  // room around it — a tall window stands in the middle of a wide well.
  const boxRatio = Math.min(Math.max(ratio, 1.3), 2.4)
  const region =
    crop && crop.reference_width > 0 && crop.reference_height > 0
      ? {
          left: `${(crop.x / crop.reference_width) * 100}%`,
          top: `${(crop.y / crop.reference_height) * 100}%`,
          width: `${(crop.width / crop.reference_width) * 100}%`,
          height: `${(crop.height / crop.reference_height) * 100}%`
        }
      : null

  return (
    <span className="src-shot" style={{ aspectRatio: boxRatio }}>
      <span className="src-stage" style={{ '--src-ratio': ratio } as CSSProperties}>
        {frames.map((frame) => (
          <img
            key={frame.id}
            className="src-frame"
            src={frame.url}
            alt=""
            draggable={false}
            data-ready={frame.ready || undefined}
            onLoad={() => onLoad(frame.id)}
          />
        ))}
        {region && <span className="src-region" style={region} />}
      </span>
      {frames.length === 0 && <span className="src-shot-wait">{placeholder}</span>}
      {hint}
      {live && (
        <span className="src-live">
          <span className="src-live-dot" />
          Auto
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------- cards

function CardHead({
  icon,
  title,
  detail,
  chevron = true
}: {
  icon: ReactNode
  title: ReactNode
  detail?: ReactNode
  chevron?: boolean
}): ReactNode {
  return (
    <span className="src-head">
      <span className="src-head-icon">{icon}</span>
      <span className="src-head-text">
        <span className="src-head-title">{title}</span>
        {detail && <span className="src-head-detail">{detail}</span>}
      </span>
      {chevron && <ChevronsUpDown className="src-head-chevron" />}
    </span>
  )
}

/** One source type in the Change source menu: an icon tile, its name and what it does. */
function TypeBody({
  type,
  selected,
  sub
}: {
  type: (typeof TYPES)[number]
  selected: boolean
  sub?: boolean
}): ReactNode {
  return (
    <>
      <span className="src-type-icon">{type.icon}</span>
      <span className="src-type-text">
        <span className="src-type-label">{type.label}</span>
        <span className="src-type-detail">{type.detail}</span>
      </span>
      {selected && <Check className="src-type-check" />}
      {sub && <ChevronRight className="src-type-chevron" />}
    </>
  )
}

/**
 * The Change source menu. "Window or screen" opens the grid of windows and displays; the other
 * types are chosen directly.
 */
function SourceMenuContent({
  mode,
  currentId,
  gridOpen,
  onGridOpen,
  onChooseType,
  onChooseSource,
  onOpenSettings
}: {
  mode: Mode | null
  currentId: string | null
  gridOpen: boolean
  onGridOpen: (open: boolean) => void
  onChooseType: (mode: Mode) => void
  onChooseSource: (sourceId: string) => void
  onOpenSettings: () => void
}): ReactNode {
  const [windowType, ...others] = TYPES
  return (
    <MenuContent align="start" className="src-menu">
      <MenuSub open={gridOpen} onOpenChange={onGridOpen}>
        <MenuPrimitive.SubTrigger className="src-type">
          <TypeBody type={windowType} selected={mode === 'ocr'} sub />
        </MenuPrimitive.SubTrigger>
        <MenuSubContent className="src-grid-menu">
          <SourceGrid currentId={currentId} onChoose={(source) => onChooseSource(source.id)} />
        </MenuSubContent>
      </MenuSub>
      {others.map((type) => (
        <MenuPrimitive.Item
          key={type.mode}
          className="src-type"
          onSelect={() => onChooseType(type.mode)}
        >
          <TypeBody type={type} selected={type.mode === mode} />
        </MenuPrimitive.Item>
      ))}
      <MenuSeparator />
      <MenuItem icon={<Settings />} onSelect={onOpenSettings}>
        Source settings
      </MenuItem>
    </MenuContent>
  )
}

/** Requests from elsewhere (the tray, a shortcut) to open the menu on the window grid. */
let handledChooseRequest = 0

// ---------------------------------------------------------------------------- panel

export function SourcePanel({
  controller,
  onOpenSettings,
  chooseRequest = 0
}: {
  controller: Controller
  onOpenSettings: () => void
  /** Bumped to open the menu on the window grid. */
  chooseRequest?: number
}): ReactNode {
  const [mode, choose] = useInputSource()
  const [open, setOpen] = useState(false)
  const [gridOpen, setGridOpen] = useState(false)
  // A request is handled once, even if the sidebar is remounted after it.
  const [seenRequest, setSeenRequest] = useState(() => handledChooseRequest)
  if (chooseRequest > seenRequest) {
    setSeenRequest(chooseRequest)
    setOpen(true)
    setGridOpen(true)
  }
  useEffect(() => {
    handledChooseRequest = Math.max(handledChooseRequest, seenRequest)
  }, [seenRequest])
  const [hotkeys] = useHotkeys()
  const keyPlatform = keyPlatformOf(useCapabilities())
  const { state } = useViewState()
  const [websocketUrl, setWebsocketUrl] = useState(() => getSettings().websocketUrl)
  useEffect(() => onSettingsChange((next) => setWebsocketUrl(next.websocketUrl)), [])

  const source = controller.currentSource
  // A window or screen that has not been picked yet reads as no source at all.
  const empty = mode === 'ocr' && !source
  const scanKey = hotkeys.triggerScan?.enabled
    ? formatAccelerator(hotkeys.triggerScan.accelerator, keyPlatform)
    : null
  const overlayOn = isOverlayTextVisible(
    controller.isOverlayModeEnabled,
    controller.isTextOverlayVisible
  )
  const crop = state.crop ?? null

  const closeMenu = (): void => {
    setOpen(false)
    setGridOpen(false)
  }
  const menu = (
    <SourceMenuContent
      mode={empty ? null : mode}
      currentId={source?.sourceId ?? null}
      gridOpen={gridOpen}
      onGridOpen={setGridOpen}
      onChooseType={(next) => {
        closeMenu()
        choose(next)
      }}
      onChooseSource={(sourceId) => {
        closeMenu()
        choose('ocr')
        controller.onSelectSource(sourceId)
      }}
      onOpenSettings={() => {
        closeMenu()
        onOpenSettings()
      }}
    />
  )
  const onMenuOpen = (next: boolean): void => {
    setOpen(next)
    if (!next) setGridOpen(false)
  }

  let card: ReactNode
  if (empty) {
    card = (
      <button type="button" className="src-card src-empty" aria-label="Choose a source">
        <span className="src-empty-plus">
          <Plus />
        </span>
        <span className="src-empty-title">Choose a source</span>
        <span className="src-empty-detail">Window, screen, clipboard…</span>
      </button>
    )
  } else if (mode === 'ocr' && source) {
    const isScreen = source.type === 'screen'
    const title = isScreen ? source.name || 'Screen' : source.appName || source.name || 'Window'
    const detail = isScreen
      ? 'Whole screen'
      : source.name && source.name !== title
        ? source.name
        : 'Window'
    const preview = (
      <>
        <LivePreview
          // A new source starts from a clean slate rather than fading from the old one.
          key={source.sourceId}
          sourceId={source.sourceId}
          crop={crop}
          live={controller.isAutoOCREnabled}
          placeholder={isScreen ? <Monitor /> : <SourceIcon source={source} />}
          hint={
            isScreen ? undefined : (
              <span className="src-front" aria-hidden>
                <ArrowUpRight />
                Bring to front
              </span>
            )
          }
        />
        <CardHead
          icon={isScreen ? <Monitor /> : <SourceIcon source={source} />}
          title={title}
          detail={detail}
          chevron={false}
        />
      </>
    )
    // The card is the source: clicking a window brings it forward (it may be behind others).
    // Its foot holds what changes it: the region, and the source itself.
    card = (
      <div className="src-card src-card-live">
        {isScreen ? (
          <div className="src-card-body">{preview}</div>
        ) : (
          <button
            type="button"
            className="src-card-body"
            aria-label={`Bring ${title} to the front`}
            onClick={() => controller.onActivateSource()}
            onMouseEnter={() => controller.onSourceHover(true)}
            onMouseLeave={() => controller.onSourceHover(false)}
          >
            {preview}
          </button>
        )}
        <div className="src-actions">
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="src-action" data-on={crop ? '' : undefined}>
                <Crop />
                <span className="src-action-label">Crop area</span>
              </button>
            </MenuTrigger>
            <MenuContent align="start" className="src-crop-menu">
              <MenuItem
                icon={<SquareDashed />}
                disabled={!controller.hasSource}
                onSelect={() => controller.onEditCropArea()}
              >
                {crop ? 'Change crop area…' : 'Set crop area…'}
              </MenuItem>
              <MenuItem icon={<X />} disabled={!crop} onSelect={() => controller.onClearCrop()}>
                Clear crop area
              </MenuItem>
            </MenuContent>
          </Menu>
          <Menu open={open} onOpenChange={onMenuOpen}>
            <MenuTrigger asChild>
              <button type="button" className="src-action">
                <ArrowLeftRight />
                <span className="src-action-label">Change source</span>
              </button>
            </MenuTrigger>
            {menu}
          </Menu>
        </div>
      </div>
    )
  } else {
    const type = TYPES.find((entry) => entry.mode === mode) ?? TYPES[0]
    const detail =
      mode === 'quickshot'
        ? scanKey
          ? `Press ${scanKey} to draw an area`
          : 'Draw an area to read it'
        : mode === 'clipboard'
          ? 'Watching for copied text'
          : websocketUrl
    card = (
      <button
        type="button"
        className="src-card src-card-plain"
        aria-label={`Source: ${type.label}. Change source`}
      >
        <CardHead icon={type.icon} title={type.label} detail={detail} />
      </button>
    )
  }

  const scanDisabled =
    mode === 'quickshot'
      ? controller.isScanning
      : !controller.hasSource || controller.isAutoOCREnabled || controller.isScanning

  const scanButton = (
    <Button
      // While Auto OCR reads on its own the button steps back; it is not the thing to press.
      variant={mode === 'ocr' && controller.isAutoOCREnabled ? 'secondary' : 'primary'}
      className="src-scan"
      disabled={scanDisabled}
      onClick={() => controller.onTriggerScan()}
    >
      {controller.isScanning ? <Spinner /> : <ScanText />}
      <span className="src-scan-label">
        {controller.isScanning
          ? 'Scanning…'
          : mode === 'quickshot'
            ? 'Draw and scan'
            : controller.isAutoOCREnabled
              ? 'Auto OCR is on'
              : 'Scan now'}
      </span>
      {scanKey && !controller.isScanning && <kbd className="src-scan-key">{scanKey}</kbd>}
    </Button>
  )

  const overlayRow = (
    <button
      type="button"
      role="switch"
      aria-checked={overlayOn}
      className="k-row src-row"
      onClick={() => controller.onToggleTextOverlayVisibility()}
    >
      <Eye />
      <span className="k-row-label">Show overlay</span>
      <SwitchMark on={overlayOn} />
    </button>
  )

  return (
    <div className="src-panel">
      {mode === 'ocr' && source ? (
        card
      ) : (
        <Menu open={open} onOpenChange={onMenuOpen}>
          <MenuTrigger asChild>{card}</MenuTrigger>
          {menu}
        </Menu>
      )}

      {mode === 'ocr' && source && (
        <div className="src-controls">
          {scanButton}
          <div className="src-rows">
            <button
              type="button"
              role="switch"
              aria-checked={controller.isAutoOCREnabled}
              className="k-row src-row"
              onClick={() => controller.onToggleAutoOCR()}
            >
              <ScanSearch />
              <span className="k-row-label">Auto OCR</span>
              <SwitchMark on={controller.isAutoOCREnabled} />
            </button>
            {overlayRow}
          </div>
        </div>
      )}

      {mode === 'quickshot' && (
        <div className="src-controls">
          {scanButton}
          <div className="src-rows">{overlayRow}</div>
        </div>
      )}
    </div>
  )
}
