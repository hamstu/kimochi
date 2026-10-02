/**
 * The Source picker: where the Log's text comes from. Screen is both a choice and a group: its
 * submenu holds the chosen window, its region, and the controls that only apply to screen reading
 * (Auto OCR, a single scan, the overlay). Quick Shot is OCR without a chosen source: the scan
 * shortcut asks for a region on the screen and reads that.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  AppWindow,
  Aperture,
  Camera,
  ChevronsUpDown,
  Clipboard,
  Crop,
  Eye,
  Monitor,
  Radio,
  ScanSearch,
  Search,
  Settings,
  SquareDashedMousePointer
} from 'lucide-react'
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger
} from '@kit'
import { SourceIcon } from '../components/RemoteControl'
import { getSettings, onSettingsChange, updateSettings } from '@texthooker/lib/settings'
import type { InputSource } from '@texthooker/input-source'
import type { ControllerWiring } from '../panels/useController'
import { isOverlayTextVisible } from '../../ui/settings'
import { useSetting } from '../bridge/useSetting'

type Controller = ControllerWiring['props']
/** The menu's choices: the texthooker's inputs, with OCR split into Screen and Quick Shot. */
type Mode = InputSource | 'quickshot'

/** Keeps a radio row's check in line with Screen's, which sits before its submenu chevron. */
const pad = <span className="main-source-pad" aria-hidden />

function WindowIcon({ controller }: { controller: Controller }): ReactNode {
  const source = controller.currentSource
  if (!source) return <AppWindow />
  return source.type === 'screen' ? <Monitor /> : <SourceIcon source={source} />
}

export function SourceMenu({
  controller,
  onOpenSettings
}: {
  controller: Controller
  onOpenSettings: () => void
}): ReactNode {
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

  const source = controller.currentSource
  const windowName = source ? source.appName || source.name || source.sourceId : 'No window chosen'
  const overlayOn = isOverlayTextVisible(
    controller.isOverlayModeEnabled,
    controller.isTextOverlayVisible
  )

  const current =
    mode === 'quickshot'
      ? { icon: <Aperture />, name: 'Quick Shot' }
      : input === 'ocr'
        ? {
            icon: <WindowIcon controller={controller} />,
            name: source ? windowName : 'Choose a window'
          }
        : input === 'clipboard'
          ? { icon: <Clipboard />, name: 'Clipboard' }
          : { icon: <Radio />, name: 'WebSocket' }

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="main-picker"
          aria-label={`Source: ${current.name}`}
          onMouseEnter={() => {
            if (mode === 'ocr' && source?.type === 'window') controller.onSourceHover(true)
          }}
          onMouseLeave={() => controller.onSourceHover(false)}
        >
          <span className="main-picker-icon">{current.icon}</span>
          <span className="main-picker-label">{current.name}</span>
          <ChevronsUpDown className="main-picker-chevron" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="main-source-menu">
        <MenuSub>
          <MenuSubTrigger icon={<Camera />} checked={mode === 'ocr'} onClick={() => choose('ocr')}>
            Screen
          </MenuSubTrigger>
          <MenuSubContent className="main-source-sub">
            <div className="main-source-current">
              <span className="main-picker-icon">
                <WindowIcon controller={controller} />
              </span>
              <span className="main-source-current-name">{windowName}</span>
            </div>
            <MenuItem
              icon={<Crop />}
              disabled={
                !controller.hasSource ||
                (controller.isScreenSource &&
                  (controller.isAutoOCREnabled || controller.isScanning))
              }
              onSelect={() => {
                choose('ocr')
                if (controller.isScreenSource) controller.onSelectAndScan()
                else controller.onEditCropArea()
              }}
            >
              Select region…
            </MenuItem>
            <MenuItem
              icon={<SquareDashedMousePointer />}
              onSelect={() => {
                choose('ocr')
                controller.onOpenSource()
              }}
            >
              Choose window or screen…
            </MenuItem>
            <MenuSeparator />
            <MenuCheckboxItem
              icon={<ScanSearch />}
              checked={controller.isAutoOCREnabled}
              disabled={!controller.hasSource}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => controller.onToggleAutoOCR()}
            >
              Auto OCR
            </MenuCheckboxItem>
            <MenuItem
              icon={<Search />}
              disabled={
                !controller.hasSource || controller.isAutoOCREnabled || controller.isScanning
              }
              onSelect={() => controller.onTriggerScan()}
            >
              Scan now
            </MenuItem>
            <MenuCheckboxItem
              icon={<Eye />}
              checked={overlayOn}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => controller.onToggleTextOverlayVisibility()}
            >
              Show overlay
            </MenuCheckboxItem>
          </MenuSubContent>
        </MenuSub>
        <MenuRadioGroup value={mode} onValueChange={(value) => choose(value as Mode)}>
          <MenuRadioItem value="quickshot" icon={<Aperture />} detail={pad}>
            Quick Shot
          </MenuRadioItem>
          <MenuRadioItem value="clipboard" icon={<Clipboard />} detail={pad}>
            Clipboard
          </MenuRadioItem>
          <MenuRadioItem value="websocket" icon={<Radio />} detail={pad}>
            WebSocket
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<Settings />} onSelect={onOpenSettings}>
          Source settings
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
