/**
 * The sidebar's Source: one card that says where the Log's text comes from, opening a popover of
 * source types, and under it the controls that apply to that source.
 *
 * Nothing chosen yet is a dashed card. Choosing "Window or screen" opens the source picker at once;
 * once a window or display is chosen the card shows it live (a fresh frame every few seconds,
 * crossfaded in) with its region marked, and the scan, Auto OCR, region and overlay controls sit
 * underneath. Quick Shot keeps a scan button and the overlay but has nothing to watch; Clipboard
 * and WebSocket need no controls at all.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Aperture,
  AppWindow,
  Check,
  ChevronsUpDown,
  Clipboard,
  Crop,
  Eye,
  Monitor,
  Plus,
  Radio,
  ScanSearch,
  ScanText,
  Settings
} from 'lucide-react'
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner, cn } from '@kit'
import { getSettings, onSettingsChange, updateSettings } from '@texthooker/lib/settings'
import type { InputSource } from '@texthooker/input-source'
import { SourceIcon } from '../components/RemoteControl'
import { isOverlayTextVisible } from '../../ui/settings'
import { useSetting } from '../bridge/useSetting'
import { useViewState } from '../bridge/state'
import { useHotkeys } from '../bridge/useHotkeys'
import { nativeError, sourceLiveThumbnail } from '../bridge/tauri'
import type { NativeCrop } from '../bridge/types'
import { detectKeyPlatform, formatAccelerator } from '../panels/settings/accelerator'
import type { ControllerWiring } from '../panels/useController'

type Controller = ControllerWiring['props']
/** The texthooker's inputs, with OCR split into a chosen window or screen and Quick Shot. */
type Mode = InputSource | 'quickshot'

/** How often the live preview asks for a new frame, and how soon it retries after `busy:`. */
const REFRESH_MS = 2500
const BUSY_RETRY_MS = 900
/** The crossfade; matches `.src-frame`'s opacity transition. */
const FADE_MS = 700

const KEY_PLATFORM = detectKeyPlatform()

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
  }}

function LivePreview({
  sourceId,
  crop,
  live,
  placeholder
}: {
  sourceId: string
  crop: NativeCrop | null
  live: boolean
  placeholder: ReactNode
}): ReactNode {
  const { frames, size, onLoad } = useLiveFrames(sourceId)
  const ratio = size ? size.width / size.height : 16 / 9
  // Wide frames set the card's shape; tall ones sit in a square, pillarboxed.
  const boxRatio = Math.min(Math.max(ratio, 1), 3)
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
      <span
        className={cn('src-stage', ratio < 1 && 'src-stage-tall')}
        style={{ aspectRatio: ratio }}
      >
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
  detail
}: {
  icon: ReactNode
  title: ReactNode
  detail?: ReactNode
}): ReactNode {
  return (
    <span className="src-head">
      <span className="src-head-icon">{icon}</span>
      <span className="src-head-text">
        <span className="src-head-title">{title}</span>
        {detail && <span className="src-head-detail">{detail}</span>}
      </span>
      <ChevronsUpDown className="src-head-chevron" />
    </span>
  )
}

function TypeList({
  mode,
  onChoose
}: {
  mode: Mode | null
  onChoose: (mode: Mode) => void
}): ReactNode {
  return (
    <div className="src-types" role="listbox" aria-label="Source type">
      {TYPES.map((type) => {
        const selected = type.mode === mode
        return (
          <button
            key={type.mode}
            type="button"
            role="option"
            aria-selected={selected}
            className="src-type"
            onClick={() => onChoose(type.mode)}
          >
            <span className="src-type-icon">{type.icon}</span>
            <span className="src-type-text">
              <span className="src-type-label">{type.label}</span>
              <span className="src-type-detail">{type.detail}</span>
            </span>
            {selected && <Check className="src-type-check" />}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------- panel

export function SourcePanel({
  controller,
  onOpenSettings
}: {
  controller: Controller
  onOpenSettings: () => void
}): ReactNode {
  const [mode, choose] = useInputSource()
  const [open, setOpen] = useState(false)
  const [hotkeys] = useHotkeys()
  const { state } = useViewState()
  const [websocketUrl, setWebsocketUrl] = useState(() => getSettings().websocketUrl)
  useEffect(() => onSettingsChange((next) => setWebsocketUrl(next.websocketUrl)), [])

  const source = controller.currentSource
  // A window or screen that has not been picked yet reads as no source at all.
  const empty = mode === 'ocr' && !source
  const scanKey = hotkeys.triggerScan?.enabled
    ? formatAccelerator(hotkeys.triggerScan.accelerator, KEY_PLATFORM)
    : null
  const overlayOn = isOverlayTextVisible(
    controller.isOverlayModeEnabled,
    controller.isTextOverlayVisible
  )
  const crop = state.crop ?? null

  const pick = (next: Mode): void => {
    setOpen(false)
    choose(next)
    // A window or screen is chosen straight away, in the picker.
    if (next === 'ocr') controller.onOpenSource()
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
    card = (
      <button
        type="button"
        className="src-card src-card-live"
        aria-label={`Source: ${title}. Change source`}
        onMouseEnter={() => {
          if (source.type === 'window') controller.onSourceHover(true)
        }}
        onMouseLeave={() => controller.onSourceHover(false)}
      >
        <LivePreview
          // A new source starts from a clean slate rather than fading from the old one.
          key={source.sourceId}
          sourceId={source.sourceId}
          crop={crop}
          live={controller.isAutoOCREnabled}
          placeholder={isScreen ? <Monitor /> : <SourceIcon source={source} />}
        />
        <CardHead
          icon={isScreen ? <Monitor /> : <SourceIcon source={source} />}
          title={title}
          detail={detail}
        />
      </button>
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

  const regionDisabled =
    !controller.hasSource ||
    (controller.isScreenSource && (controller.isAutoOCREnabled || controller.isScanning))
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{card}</PopoverTrigger>
        <PopoverContent align="start" className="src-popover">
          <TypeList mode={empty ? null : mode} onChoose={pick} />
          <div className="src-popover-foot">
            <button
              type="button"
              className="src-popover-link"
              onClick={() => {
                setOpen(false)
                onOpenSettings()
              }}
            >
              <Settings />
              Source settings
            </button>
          </div>
        </PopoverContent>
      </Popover>

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
            <button
              type="button"
              className="k-row src-row"
              disabled={regionDisabled}
              onClick={() => {
                if (controller.isScreenSource) controller.onSelectAndScan()
                else controller.onEditCropArea()
              }}
            >
              <Crop />
              <span className="k-row-label">Region</span>
              <span className="k-row-meta src-row-meta">
                {crop ? `${Math.round(crop.width)} × ${Math.round(crop.height)}` : 'Whole'}
              </span>
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
