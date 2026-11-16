/**
 * Settings → Shortcuts & Controls → Radial menu: which actions the radial menu holds and in what
 * order (`controllerMenuItems`, ui/radial-items.js), and a shortcut for each that runs it without
 * the menu (`hotkeys.menu…`: keys and a controller button or combination).
 *
 * The preview is the overlay's own ring (ui/radial-menu.js, in the Halo look) drawn in a well, as
 * it looks with an OCR source or while text hooking (the menu at its top left). Dragging an item
 * carries it round the ring, swapping places with each item it reaches, and it snaps into its
 * place when let go; clicking one picks its row below, where its shortcut is set. Every action has
 * a row, in the menu or not, so an action can have a button without taking a place in the menu.
 * The menu always keeps one item, and Reset to default puts the shipped menu back (the shortcuts
 * stay as they are).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Eye, Plus, X } from 'lucide-react'
import { Badge, Button, IconButton, Select, SettingsRow, SettingsSection, Tooltip } from '@kit'
import { ICONS, ORBIT, RadialMenu } from '@ui/radial-menu.js'
import {
  RADIAL_ITEMS,
  RADIAL_MENU_SETTING,
  addRadialItem,
  canRemoveRadialItem,
  effectiveRadialMenu,
  hotkeyConflicts,
  isDefaultRadialMenu,
  radialItemsFor,
  removeRadialItem,
  reorderShownItems
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
type PreviewSource = 'ocr' | 'hooker'

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
  'ocr-settings': ICONS.settings
}

/** The parts of a shown RadialMenu the drag moves (ui/radial-menu.js). */
interface RingParts {
  labels: HTMLElement[]
  wedges: Element[]
  spokes: Element[]
  current: HTMLElement
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
  source,
  onSource,
  onPick,
  onSelect,
  onReorder
}: {
  items: { item: RadialItem; label: string; enabled: boolean }[]
  selected: string | null
  details: Record<string, string | undefined>
  source: PreviewSource
  onSource: (source: PreviewSource) => void
  onPick: (id: string) => void
  onSelect: (id: string) => void
  onReorder: (ids: string[]) => void
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
  const selectedIndex = items.findIndex(({ item }) => item.id === selected)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const menu = new RadialMenu(host, {
      onChoose: (id: string) => {
        if (performance.now() - draggedAt.current > 300) pickRef.current(id)
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
        detail: details[item.id],
        unavailable: ONLY_WHEN[item.when ?? '']
      })),
      'pad',
      selectedIndex
    )
  }, [items, selectedIndex, details])

  /** Light the slot the dragged item is over, and name it in the hub. */
  const light = (ring: RingParts, drag: Drag): void => {
    ring.wedges.forEach((wedge, index) => wedge.classList.toggle('cm-selected', index === drag.slot))
    ring.spokes.forEach((spoke, index) => spoke.classList.toggle('cm-selected', index === drag.slot))
    ring.labels.forEach((label) => label.classList.toggle('cm-selected', label === drag.label))
    ring.current.textContent = drag.label.querySelector('.cm-label')?.textContent ?? ''
    ring.current.classList.remove('cm-muted')
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
    place(drag.label, degrees)
    const span = 360 / drag.ids.length
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
    place(drag.label, (drag.slot * 360) / drag.ids.length)
    const ids = drag.ids
    const id = ids[drag.slot]
    // Redrawn only now: picking its row while it moved would redraw the ring under the pointer.
    setTimeout(() => {
      previewRef.current?.removeAttribute('data-dragging')
      onReorder(ids)
      onSelect(id)
    }, SNAP_MS)
  }

  return (
    <div
      ref={previewRef}
      className="radial-preview"
      onMouseLeave={() => {
        if (!dragRef.current) menuRef.current?.select(selectedIndex)
      }}
    >
      <div
        ref={hostRef}
        className="radial-preview-stage"
        data-cm-variant="halo"
        data-cm-theme={resolved}
        style={{ width: STAGE, height: STAGE }}
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
          onValueChange={onSource}
          options={SOURCES}
        />
      </div>
      <p className="radial-preview-hint">Drag an item to change its place in the ring.</p>
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
  const [source, setSource] = useState<PreviewSource>('ocr')
  const rows = useRef(new Map<string, HTMLDivElement>())

  const inMenu = useMemo(
    () => menu.map((id) => RADIAL_ITEMS.find((item) => item.id === id)).filter((item) => item !== undefined),
    [menu]
  )
  const outside = RADIAL_ITEMS.filter((item) => !menu.includes(item.id))

  /** What the ring shows with the chosen source, labelled as the overlay labels it. */
  const shown = useMemo(
    () =>
      radialItemsFor(menu, source === 'hooker').flatMap(({ id, inapplicable }) => {
        const item = RADIAL_ITEMS.find((candidate) => candidate.id === id)
        if (!item) return []
        const label = id === 'ocr-settings' ? (source === 'hooker' ? 'App settings' : 'OCR settings') : item.label
        return [{ item, label, enabled: !inapplicable }]
      }),
    [menu, source]
  )

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
    const only = item.when ? ONLY_WHEN[item.when] : undefined
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
          badge={
            <>
              {only && (
                <Tooltip content={only}>
                  <span className="radial-row-only" tabIndex={0} aria-label={only}>
                    <Eye aria-hidden />
                  </span>
                </Tooltip>
              )}
              {clashes.length > 0 && <Badge tone="warn">Same as {clashes.join(', ')}</Badge>}
            </>
          }
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
            <IconButton
              label={canRemoveRadialItem(menu, item.id) ? 'Remove from the menu' : 'The menu needs at least one item'}
              size="sm"
              disabled={!canRemoveRadialItem(menu, item.id)}
              onClick={() => save(removeRadialItem(menu, item.id))}
            >
              <X />
            </IconButton>
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
        description="The actions in the radial menu, clockwise from the top. Click one to give it a shortcut that runs it without opening the menu."
        actions={
          <Button size="sm" disabled={isDefaultRadialMenu(stored)} onClick={() => void setStored(null)}>
            Reset to default
          </Button>
        }
      >
        <RadialPreview
          items={shown}
          selected={selected}
          details={details}
          source={source}
          onSource={setSource}
          onPick={pick}
          onSelect={setSelected}
          onReorder={(ids) => save(reorderShownItems(menu, ids))}
        />
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
