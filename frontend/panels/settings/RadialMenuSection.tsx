/**
 * Settings → Shortcuts & Controls → Radial menu, and the same in Settings → Overlay: which actions the radial menu holds and in what
 * order (`controllerMenuItems`, ui/radial-items.js), and a shortcut for each that runs it without
 * the menu (`hotkeys.menu…`: keys and a controller button or combination).
 *
 * The preview is the overlay's own ring (ui/radial-menu.js, in the Halo look) drawn in a well, as
 * it looks with an OCR source or while text hooking (the menu at its top left). Dragging an item
 * carries it round the ring, swapping places with each item it reaches, and it snaps into its
 * place when let go. Clicking one opens its panel beside the ring (the ring springs left to make
 * room): what it does, where it shows, its shortcut (keys and a controller button or combination)
 * and Remove from the menu. Add item, at the well's bottom right, puts back an action the menu
 * doesn't hold. For keyboards and screen readers, each item is also a hidden button that opens its
 * panel. The menu always keeps one item, and Reset to default puts the shipped menu back (the
 * shortcuts stay as they are).
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode
} from 'react'
import { Eye, Plus, Trash2, X } from 'lucide-react'
import { Badge, Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Select, SettingsSection } from '@kit'
import { ICONS, ORBIT, RadialMenu } from '@ui/radial-menu.js'
import {
  RADIAL_ITEMS,
  RADIAL_MENU_SETTING,
  addRadialItem,
  canRemoveRadialItem,
  effectiveRadialMenu,
  hotkeyConflicts,
  isDefaultRadialMenu,
  removeRadialItem,
  reorderShownItems
} from '@ui/radial-items.js'
import { hexToRgbTriplet, radialBaseVars, type RadialMenuBase } from '@ui/settings'
import { useRadialStyle } from './RadialStyle'
import { HotkeyRow } from './HotkeyRow'
import { shownRadialItems, useRadialShortcuts, type PreviewSource, type RadialItem } from './radialMenuPreview'
import { useSetting } from '../../bridge/useSetting'
import { useHotkeys } from '../../bridge/useHotkeys'
import { usePrefs } from '../../kit/appearance-state'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { gamepadChord } from '../../vendor/shared-defaults'
import { ShortcutRecorder } from './ShortcutRecorder'
import { GridField } from '../../components/GridField'
import '@ui/controller.css'
import '@ui/controller-variants.css'
import './radial-menu-section.css'

/** The stage the ring is drawn on, in the overlay's pixels; scaled down to fit the well. */
const STAGE = 620
/** How far the pointer must move before a press on an item becomes a drag. */
const DRAG_START_PX = 4
/** How long an item takes to settle into its place, as the CSS transition. */
const SNAP_MS = 180

const SOURCES: { value: PreviewSource; label: string }[] = [
  { value: 'ocr', label: 'OCR source' },
  { value: 'hooker', label: 'Text hooking' }
]

/** When an item shows only for one kind of source, said in its row. */
const ONLY_WHEN: Record<string, string> = {
  ocr: 'Shows only with an OCR source',
  hooker: 'Shows only while text hooking'
}

/** The overlay's icon for each item (ui/controller.js). */
const ITEM_ICONS: Record<string, string> = {
  scan: ICONS.scan,
  dictionary: ICONS.dictionary,
  auto: ICONS.auto,
  card: ICONS.card,
  history: ICONS.history,
  controls: ICONS.app,
  'ocr-settings': ICONS.settings,
  pause: ICONS.pause,
  'pause-scan': ICONS.pauseScan,
  'pause-read-along': ICONS.pauseReadAlong
}

/** The parts of a shown RadialMenu the drag moves (ui/radial-menu.js). */
interface RingParts {
  labels: HTMLElement[]
  wedges: Element[]
  pointAt: (degrees: number, smoothing?: number) => void
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

/** Where on the orbit an angle (degrees clockwise from the top) is, from the ring's centre. */
function onOrbit(degrees: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180
  return [ORBIT * Math.cos(radians), ORBIT * Math.sin(radians)]
}

function place(label: HTMLElement, degrees: number): void {
  const [x, y] = onOrbit(degrees)
  label.style.setProperty('--x', `${x}px`)
  label.style.setProperty('--y', `${y}px`)
}

/** A drag under way: the item's label, the slot it holds now, and every slot's item. */
interface Drag {
  pointerId: number
  startX: number
  startY: number
  moving: boolean
  label: HTMLElement
  slot: number
  ids: string[]
  labels: HTMLElement[]
}

/**
 * The overlay's radial menu, drawn with `items` and `selected` lit. Hovering points at items as
 * the mouse does over a game; clicking one calls `onPick`, and dragging one round the ring calls
 * `onReorder` with the ring's new order once it has snapped into place.
 */
function RadialPreview({
  items,
  selected,
  details,
  color,
  base,
  source = 'ocr',
  onSource,
  onPick,
  onSelect,
  onReorder,
  panel,
  add,
  reset
}: {
  items: { item: RadialItem; label: string; enabled: boolean }[]
  selected: string | null
  details: Record<string, string | undefined>
  /** The ring's colour, `#rrggbb` (`radialMenuColorOf`). */
  color: string
  /** The ring's base colour and opacity (`radialMenuBase`). */
  base: RadialMenuBase
  source?: PreviewSource
  onSource?: (source: PreviewSource) => void
  onPick?: (id: string) => void
  onSelect?: (id: string) => void
  onReorder?: (ids: string[]) => void
  /** The open item's panel, beside the ring; the ring moves over for it. */
  panel?: ReactNode
  /** Add item, at the bottom right. */
  add?: ReactNode
  /** Reset to default, at the top right. */
  reset?: ReactNode
}): ReactNode {
  const previewRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<RadialMenu | null>(null)
  const dragRef = useRef<Drag | null>(null)
  /** A drag ends in a click on the item; that click is not a pick. */
  const draggedAt = useRef(0)
  const pickRef = useRef(onPick)
  useEffect(() => {
    pickRef.current = onPick
  }, [onPick])
  const { resolved } = usePrefs()
  const ringRgb = hexToRgbTriplet(color) ?? undefined
  const baseVars = radialBaseVars(base)
  const selectedIndex = items.findIndex(({ item }) => item.id === selected)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const menu = new RadialMenu(host, {
      onChoose: (id: string) => {
        if (performance.now() - draggedAt.current > 300) pickRef.current?.(id)
      },
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
      items.map(({ item, label, enabled }) => ({
        id: item.id,
        label,
        icon: ITEM_ICONS[item.id] ?? '',
        enabled,
        shortcut: details[item.id],
        unavailable: ONLY_WHEN[item.when ?? '']
      })),
      'pad',
      selectedIndex
    )
  }, [items, selectedIndex, details])

  /** Light the slot the dragged item is over, its name under its icon. */
  const light = (ring: RingParts, drag: Drag): void => {
    ring.wedges.forEach((wedge, index) => wedge.classList.toggle('cm-selected', index === drag.slot))
    ring.labels.forEach((label) => label.classList.toggle('cm-selected', label === drag.label))
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const menu = menuRef.current as unknown as RingParts | null
    const wedge = (event.target as Element).closest?.('.cm-wedge') as SVGElement | null
    if (!menu || !wedge || event.button !== 0 || items.length < 2) return
    const slot = Number(wedge.dataset.index)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moving: false,
      label: menu.labels[slot],
      slot,
      ids: items.map(({ item }) => item.id),
      labels: [...menu.labels]
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const ring = menuRef.current as unknown as RingParts | null
    const host = hostRef.current
    if (!drag || !ring || !host || event.pointerId !== drag.pointerId) return
    if (!drag.moving) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_START_PX) return
      drag.moving = true
      try {
        host.setPointerCapture(event.pointerId)
      } catch {
        // A pointer that is already gone: the drag still follows the moves that come.
      }
      previewRef.current?.setAttribute('data-dragging', '')
      drag.label.setAttribute('data-dragging', '')
    }
    // The stage is scaled, but its centre is the ring's: the angle needs no scaling.
    const rect = host.getBoundingClientRect()
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height / 2)
    const degrees = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
    const span = 360 / drag.ids.length
    place(drag.label, degrees)
    // The marker on the hub's track follows the item round.
    ring.pointAt(degrees, 0)
    const nearest = Math.round(degrees / span) % drag.ids.length
    if (nearest !== drag.slot) {
      // The item it reached takes the place it left, and slides there.
      const displaced = drag.labels[nearest]
      ;[drag.labels[drag.slot], drag.labels[nearest]] = [displaced, drag.label]
      ;[drag.ids[drag.slot], drag.ids[nearest]] = [drag.ids[nearest], drag.ids[drag.slot]]
      place(displaced, drag.slot * span)

      drag.slot = nearest
    }
    light(ring, drag)
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (!drag.moving) return
    draggedAt.current = performance.now()
    // Snap into its place, then keep the new order.
    drag.label.removeAttribute('data-dragging')
    const span = 360 / drag.ids.length
    place(drag.label, drag.slot * span)
    // The marker glides into place with it.
    ;(menuRef.current as unknown as RingParts | null)?.pointAt(drag.slot * span)
    const ids = drag.ids
    const id = ids[drag.slot]
    // Redrawn only now: picking its row while it moved would redraw the ring under the pointer.
    setTimeout(() => {
      previewRef.current?.removeAttribute('data-dragging')
      onReorder?.(ids)
      onSelect?.(id)
    }, SNAP_MS)
  }

  return (
    <div className="radial-preview-well">
      <div
        ref={previewRef}
        className="radial-preview"
        data-open={panel ? '' : undefined}
        onMouseLeave={() => {
          if (!dragRef.current) menuRef.current?.select(selectedIndex)
        }}
      >
        <GridField />
        <div
          ref={hostRef}
          className="radial-preview-stage"
          data-cm-variant="halo"
          data-cm-theme={resolved}
          data-cm-ring-tone={baseVars.tone}
          style={
            {
              width: STAGE,
              height: STAGE,
              '--cm-ring-rgb': ringRgb,
              '--cm-base-rgb': baseVars.rgb,
              '--cm-base-alpha': baseVars.alpha
            } as CSSProperties
          }
          aria-hidden
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="radial-preview-source">
          <Select
            aria-label="Show the menu as it looks with"
            size="sm"
            variant="ghost"
            value={source}
            onValueChange={(value) => onSource?.(value)}
            options={SOURCES}
          />
        </div>
        <p className="radial-preview-hint">Drag an item to move it. Click one to edit it.</p>
        <div className="radial-preview-add">{add}</div>
        {reset}
        {panel}
      </div>
    </div>
  )
}

/**
 * `withShortcut`: under the look, the shortcut that opens the menu (as Shortcuts & Controls lists
 * it), for Settings → Overlay, where that list isn't.
 */
export function RadialMenuSection({ withShortcut = false }: { withShortcut?: boolean }): ReactNode {
  const [stored, setStored] = useSetting<string[] | null>(RADIAL_MENU_SETTING, null)
  const [hotkeys, setHotkeys] = useHotkeys()
  const menu = useMemo(() => effectiveRadialMenu(stored), [stored])
  const [selected, setSelected] = useState<string | null>(null)
  const [source, setSource] = useState<PreviewSource>('ocr')
  const { accent: color, base, controls } = useRadialStyle()

  const inMenu = useMemo(
    () => menu.map((id) => RADIAL_ITEMS.find((item) => item.id === id)).filter((item) => item !== undefined),
    [menu]
  )
  const outside = RADIAL_ITEMS.filter((item) => !menu.includes(item.id))

  /** What the ring shows with the chosen source, labelled as the overlay labels it. */
  const shown = useMemo(() => shownRadialItems(menu, source), [menu, source])

  const save = (next: string[]): void => void setStored(next)

  const updateHotkey = useCallback(
    (name: string, patch: { accelerator?: string; gamepadButtons?: number[] }): void => {
      const current = hotkeys[name] ?? { name, accelerator: '', enabled: true, gamepadButtons: [] }
      const binding = { ...current, ...patch, enabled: true }
      // A chord supersedes the legacy single button, so never store both.
      if (patch.gamepadButtons) delete binding.gamepadButton
      void setHotkeys({ ...hotkeys, [name]: binding })
    },
    [hotkeys, setHotkeys]
  )

  const details = useRadialShortcuts()

  const open = selected ? RADIAL_ITEMS.find((item) => item.id === selected) : undefined

  // Escape closes the open panel.
  useEffect(() => {
    if (!selected) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const conflicts = open ? hotkeyConflicts(hotkeys, open.hotkey) : null
  const panel = open ? (
    <ItemPanel
      key={open.id}
      item={open}
      label={shown.find(({ item }) => item.id === open.id)?.label ?? open.label}
      binding={hotkeys[open.hotkey]}
      clashes={conflicts ? [...new Set([...conflicts.keys, ...conflicts.buttons])] : []}
      removable={canRemoveRadialItem(menu, open.id)}
      onHotkey={(patch) => updateHotkey(open.hotkey, patch)}
      onRemove={() => {
        save(removeRadialItem(menu, open.id))
        setSelected(null)
      }}
      onClose={() => setSelected(null)}
    />
  ) : null

  const add =
    outside.length > 0 ? (
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Plus />
            Add item
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          {outside.map((item) => (
            <MenuItem
              key={item.id}
              icon={<ItemIcon id={item.id} />}
              onSelect={() => {
                save(addRadialItem(menu, item.id))
                setSelected(item.id)
              }}
            >
              {item.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    ) : null

  return (
    <SettingsSection
      title="Radial menu"
      description="The actions in the radial menu, clockwise from the top. Click one to give it a shortcut that runs it without opening the menu."
    >
      <RadialPreview
        items={shown}
        selected={selected}
        details={details}
        color={color}
        base={base}
        source={source}
        onSource={setSource}
        onPick={setSelected}
        // After a drag, an open panel follows the item that moved; a closed one stays closed.
        onSelect={(id) => setSelected((current) => (current ? id : null))}
        onReorder={(ids) => save(reorderShownItems(menu, ids))}
        panel={panel}
        add={add}
        reset={
          // Only once the menu differs from the one Kimochi ships.
          isDefaultRadialMenu(stored) ? null : (
            <button type="button" className="radial-preview-reset" onClick={() => void setStored(null)}>
              Reset to default
            </button>
          )
        }
      />
      {/* Its look, as in Settings → Overlay → Radial menu. */}
      {controls}
      {withShortcut && <HotkeyRow name="openControllerMenu" />}
      {/* The ring is drawn for the pointer; these open the same panels from the keyboard. */}
      <ul className="sr-only">
        {inMenu.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => setSelected(item.id)}>
              {item.label}: shortcut and options
            </button>
          </li>
        ))}
      </ul>
    </SettingsSection>
  )
}

/**
 * An item's panel, floating beside the ring: its name and what it does, where it shows, its
 * shortcut (keys, and a controller button or combination), and Remove from the menu.
 */
function ItemPanel({
  item,
  label,
  binding,
  clashes,
  removable,
  onHotkey,
  onRemove,
  onClose
}: {
  item: RadialItem
  label: string
  binding: (Parameters<typeof gamepadChord>[0] & { accelerator?: string }) | undefined
  clashes: string[]
  removable: boolean
  onHotkey: (patch: { accelerator?: string; gamepadButtons?: number[] }) => void
  onRemove: () => void
  onClose: () => void
}): ReactNode {
  const only = item.when ? ONLY_WHEN[item.when] : undefined
  const id = useId()
  return (
    <section className="radial-panel" aria-labelledby={`${id}-title`}>
      <header className="radial-panel-head">
        <ItemIcon id={item.id} />
        <h3 className="radial-panel-title" id={`${id}-title`}>
          {label}
        </h3>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <p className="radial-panel-description">{item.description}</p>
      {only && (
        <p className="radial-panel-note">
          <Eye aria-hidden />
          {only}
        </p>
      )}
      <div className="radial-panel-field">
        <span className="radial-panel-label">Shortcut</span>
        <div className="radial-panel-shortcut">
          <ShortcutRecorder
            label={label}
            value={binding?.accelerator ?? ''}
            onChange={(accelerator) => onHotkey({ accelerator })}
          />
          <GamepadButtonCapture
            chord
            value={binding ? gamepadChord(binding) : []}
            onChange={(buttons) => onHotkey({ gamepadButtons: buttons })}
            size="1"
          />
        </div>
        {clashes.length > 0 && <Badge tone="warn">Same as {clashes.join(', ')}</Badge>}
      </div>
      <div className="radial-panel-foot">
        <Button
          size="sm"
          variant="ghost"
          className="radial-panel-remove"
          disabled={!removable}
          title={removable ? undefined : 'The menu needs at least one item'}
          onClick={onRemove}
        >
          <Trash2 />
          Remove from menu
        </Button>
      </div>
    </section>
  )
}
