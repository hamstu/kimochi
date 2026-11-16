/**
 * Settings → Shortcuts & Controls → Radial menu: which actions the controller menu holds and in
 * what order (`controllerMenuItems`, ui/radial-items.js), and a shortcut for each that runs it
 * without the menu (`hotkeys.menu…`: keys and a controller button or combination).
 *
 * The preview is the overlay's own ring (ui/radial-menu.js, in the Halo look) drawn in a well;
 * clicking one of its items picks that item's row below, where its shortcut is set. Every action
 * has a row, in the menu or not, so an action can have a button without taking a place in the
 * menu. The menu always keeps one item, and Reset to default puts the shipped menu back (the
 * shortcuts stay as they are).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, RotateCw, X } from 'lucide-react'
import { Badge, Button, IconButton, SettingsRow, SettingsSection } from '@kit'
import { ICONS, RadialMenu } from '@ui/radial-menu.js'
import {
  RADIAL_ITEMS,
  RADIAL_MENU_SETTING,
  addRadialItem,
  canRemoveRadialItem,
  effectiveRadialMenu,
  hotkeyConflicts,
  isDefaultRadialMenu,
  moveRadialItem,
  removeRadialItem
} from '@ui/radial-items.js'
import { useSetting } from '../../bridge/useSetting'
import { useHotkeys } from '../../bridge/useHotkeys'
import { useCapabilities } from '../../bridge/capabilities'
import { getButtonName } from '../../bridge/useGamepad'
import { usePrefs } from '../../kit/appearance-state'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { gamepadChord } from '../../vendor/shared-defaults'
import { formatAccelerator, keyPlatformOf } from './accelerator'
import { ShortcutRecorder } from './ShortcutRecorder'
import '@ui/controller.css'
import '@ui/controller-variants.css'
import './radial-menu-section.css'

type RadialItem = (typeof RADIAL_ITEMS)[number]

/** The stage the ring is drawn on, in the overlay's pixels; scaled down to fit the well. */
const STAGE = 620

/** The overlay's icon for each item (ui/controller.js). */
const ITEM_ICONS: Record<string, string> = {
  scan: ICONS.scan,
  dictionary: ICONS.dictionary,
  auto: ICONS.auto,
  card: ICONS.card,
  history: ICONS.history,
  controls: ICONS.app,
  'ocr-settings': ICONS.settings
}

function ItemIcon({ id }: { id: string }): ReactNode {
  return (
    <svg
      className="radial-row-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: ITEM_ICONS[id] ?? '' }}
    />
  )
}

/**
 * The overlay's radial menu, drawn with `items` and `selected` lit. Hovering points at items as
 * the mouse does over a game; clicking one calls `onPick`, and leaving lights `selected` again.
 */
function RadialPreview({
  items,
  selected,
  details,
  onPick
}: {
  items: RadialItem[]
  selected: string | null
  details: Record<string, string | undefined>
  onPick: (id: string) => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<RadialMenu | null>(null)
  const pickRef = useRef(onPick)
  useEffect(() => {
    pickRef.current = onPick
  }, [onPick])
  const { resolved } = usePrefs()
  const selectedIndex = items.findIndex((item) => item.id === selected)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const menu = new RadialMenu(host, {
      onChoose: (id: string) => pickRef.current(id),
      onClose: () => undefined
    })
    menuRef.current = menu
    return () => {
      menu.remove()
      menuRef.current = null
    }
  }, [])

  useEffect(() => {
    menuRef.current?.show(
      { x: STAGE / 2, y: STAGE / 2 },
      items.map((item) => ({
        id: item.id,
        label: item.label,
        icon: ITEM_ICONS[item.id] ?? '',
        enabled: true,
        detail: details[item.id]
      })),
      'pad',
      selectedIndex
    )
  }, [items, selectedIndex, details])

  return (
    <div className="radial-preview" onMouseLeave={() => menuRef.current?.select(selectedIndex)}>
      <div
        ref={hostRef}
        className="radial-preview-stage"
        data-cm-variant="halo"
        data-cm-theme={resolved}
        style={{ width: STAGE, height: STAGE }}
        aria-hidden
      />
    </div>
  )
}

export function RadialMenuSection(): ReactNode {
  const [stored, setStored] = useSetting<string[] | null>(RADIAL_MENU_SETTING, null)
  const [hotkeys, setHotkeys] = useHotkeys()
  const capabilities = useCapabilities()
  const keyPlatform = keyPlatformOf(capabilities)
  const menu = useMemo(() => effectiveRadialMenu(stored), [stored])
  const [selected, setSelected] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())

  const inMenu = useMemo(
    () => menu.map((id) => RADIAL_ITEMS.find((item) => item.id === id)).filter((item) => item !== undefined),
    [menu]
  )
  const outside = RADIAL_ITEMS.filter((item) => !menu.includes(item.id))

  const save = (next: string[]): void => void setStored(next)

  const updateHotkey = useCallback(
    (name: string, patch: { accelerator?: string; gamepadButtons?: number[] }): void => {
      const current = hotkeys[name] ?? {
        name,
        accelerator: '',
        enabled: true,
        gamepadButtons: []
      }
      const binding = { ...current, ...patch, enabled: true }
      // A chord supersedes the legacy single button, so never store both.
      if (patch.gamepadButtons) delete binding.gamepadButton
      void setHotkeys({ ...hotkeys, [name]: binding })
    },
    [hotkeys, setHotkeys]
  )

  /** Each item's shortcut, for the ring: its controller buttons, or else its keys. */
  const details = useMemo(() => {
    const result: Record<string, string | undefined> = {}
    for (const item of RADIAL_ITEMS) {
      const binding = hotkeys[item.hotkey]
      if (!binding) continue
      const chord = gamepadChord(binding)
      result[item.id] =
        chord.length > 0
          ? chord.map(getButtonName).join(' + ')
          : binding.accelerator
            ? formatAccelerator(binding.accelerator, keyPlatform)
            : undefined
    }
    return result
  }, [hotkeys, keyPlatform])

  const pick = (id: string): void => {
    setSelected(id)
    const row = rows.current.get(id)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    row?.querySelector<HTMLButtonElement>('.radial-row-shortcut button')?.focus({ preventScroll: true })
  }

  const renderRow = (item: RadialItem, member: boolean): ReactNode => {
    const binding = hotkeys[item.hotkey]
    const conflicts = hotkeyConflicts(hotkeys, item.hotkey)
    const clashes = [...new Set([...conflicts.keys, ...conflicts.buttons])]
    return (
      <div
        key={item.id}
        ref={(node) => {
          if (node) rows.current.set(item.id, node)
          else rows.current.delete(item.id)
        }}
        className="radial-row"
        data-selected={selected === item.id ? '' : undefined}
        data-outside={member ? undefined : ''}
        onFocusCapture={() => setSelected(item.id)}
        onPointerDown={() => setSelected(item.id)}
      >
        <SettingsRow
          className="shortcut-row"
          leading={<ItemIcon id={item.id} />}
          label={item.label}
          description={item.description}
          badge={clashes.length > 0 ? <Badge tone="warn">Same as {clashes.join(', ')}</Badge> : undefined}
        >
          <span className="radial-row-shortcut">
            <ShortcutRecorder
              label={item.label}
              value={binding?.accelerator ?? ''}
              onChange={(accelerator) => updateHotkey(item.hotkey, { accelerator })}
            />
          </span>
          <GamepadButtonCapture
            chord
            value={binding ? gamepadChord(binding) : []}
            onChange={(buttons) => updateHotkey(item.hotkey, { gamepadButtons: buttons })}
            size="1"
          />
          {member ? (
            <span className="radial-row-actions">
              <IconButton
                label="Move anticlockwise"
                size="sm"
                disabled={menu.length < 2}
                onClick={() => save(moveRadialItem(menu, item.id, -1))}
              >
                <RotateCcw />
              </IconButton>
              <IconButton
                label="Move clockwise"
                size="sm"
                disabled={menu.length < 2}
                onClick={() => save(moveRadialItem(menu, item.id, 1))}
              >
                <RotateCw />
              </IconButton>
              <IconButton
                label={canRemoveRadialItem(menu, item.id) ? 'Remove from the menu' : 'The menu needs at least one item'}
                size="sm"
                disabled={!canRemoveRadialItem(menu, item.id)}
                onClick={() => save(removeRadialItem(menu, item.id))}
              >
                <X />
              </IconButton>
            </span>
          ) : (
            <Button size="sm" onClick={() => save(addRadialItem(menu, item.id))}>
              <Plus />
              Add
            </Button>
          )}
        </SettingsRow>
      </div>
    )
  }

  return (
    <>
      <SettingsSection
        title="Radial menu"
        description="The actions in the controller menu, clockwise from the top. Click one to give it a shortcut that runs it without opening the menu."
        actions={
          <Button size="sm" disabled={isDefaultRadialMenu(stored)} onClick={() => void setStored(null)}>
            Reset to default
          </Button>
        }
      >
        <RadialPreview items={inMenu} selected={selected} details={details} onPick={pick} />
        <p className="radial-preview-note k-description">
          Scan and Auto OCR show only with an OCR source, and Text Hooker only with the Text Hooker.
        </p>
        {inMenu.map((item) => renderRow(item, true))}
      </SettingsSection>
      {outside.length > 0 && (
        <SettingsSection
          title="Not in the menu"
          description="Add an action back to the menu, or give it a shortcut on its own."
        >
          {outside.map((item) => renderRow(item, false))}
        </SettingsSection>
      )}
    </>
  )
}
