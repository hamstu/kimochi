/**
 * DEV-ONLY: the UI studio's desktop. A window surface sits on it in a frame the reader drags by its
 * tab and resizes from any edge or corner, never below the window's minimum size; a frameless one
 * (the overlay, Gaming Mode) fills a screen of its own size. Either is scaled down to fit when the
 * desktop is smaller than it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { GripHorizontal } from 'lucide-react'
import type { Surface } from './types'

export interface Placement {
  x: number
  y: number
  width: number
  height: number
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const TAB_HEIGHT = 28
const MARGIN = 24

export function Stage({
  surface,
  url,
  frameKey,
  placement,
  onPlacement,
  zoom,
  frameRef,
  onFrameLoad,
  copyEditing
}: {
  surface: Surface
  url: string
  frameKey: number
  placement: Placement | undefined
  onPlacement: (placement: Placement) => void
  zoom: 'fit' | number
  frameRef: RefObject<HTMLIFrameElement | null>
  onFrameLoad: () => void
  copyEditing: boolean
}): ReactNode {
  const desk = useRef<HTMLDivElement>(null)
  const [deskSize, setDeskSize] = useState({ width: 0, height: 0 })
  const [gesture, setGesture] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = desk.current
    if (!el) return
    const observer = new ResizeObserver(() => setDeskSize({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    setDeskSize({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const size = surface.size
  const box = placement ?? { x: 0, y: 0, width: size.width, height: size.height }
  const fullHeight = box.height + (surface.frameless ? 0 : TAB_HEIGHT)
  const fit = deskSize.width
    ? Math.min(1, (deskSize.width - MARGIN * 2) / box.width, (deskSize.height - MARGIN * 2) / fullHeight)
    : 1
  const scale = zoom === 'fit' ? Math.max(0.2, fit) : zoom

  // A new surface: centred on the desk at its own size.
  useEffect(() => {
    if (placement || !deskSize.width) return
    onPlacement({
      x: Math.round((deskSize.width / scale - size.width) / 2),
      y: Math.round((deskSize.height / scale - size.height - (surface.frameless ? 0 : TAB_HEIGHT)) / 2),
      width: size.width,
      height: size.height
    })
  }, [placement, deskSize, size, scale, surface.frameless, onPlacement])

  const start = (event: React.PointerEvent, edge: Edge | 'move'): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const from = { x: event.clientX, y: event.clientY }
    const origin = { ...box }
    const minWidth = size.minWidth ?? 240
    const minHeight = size.minHeight ?? 160
    setGesture(edge === 'move' ? 'grabbing' : `${edge}-resize`)
    const move = (e: PointerEvent): void => {
      const dx = (e.clientX - from.x) / scale
      const dy = (e.clientY - from.y) / scale
      const next = { ...origin }
      if (edge === 'move') {
        next.x = Math.round(origin.x + dx)
        next.y = Math.round(origin.y + dy)
      } else {
        if (edge.includes('e')) next.width = Math.max(minWidth, Math.round(origin.width + dx))
        if (edge.includes('s')) next.height = Math.max(minHeight, Math.round(origin.height + dy))
        if (edge.includes('w')) {
          next.width = Math.max(minWidth, Math.round(origin.width - dx))
          next.x = origin.x + origin.width - next.width
        }
        if (edge.includes('n')) {
          next.height = Math.max(minHeight, Math.round(origin.height - dy))
          next.y = origin.y + origin.height - next.height
        }
      }
      onPlacement(next)
    }
    const end = (): void => {
      setGesture(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  const frame = (
    <iframe
      key={frameKey}
      ref={frameRef}
      className="studio-frame"
      src={url}
      title={surface.label}
      onLoad={onFrameLoad}
      style={{ width: box.width, height: box.height }}
    />
  )

  if (surface.frameless) {
    return (
      <div ref={desk} className="studio-desk studio-desk-screen" data-gesture={gesture ?? undefined}>
        <div
          className="studio-screen"
          style={{ width: box.width, height: box.height, transform: `translate(-50%, -50%) scale(${scale})` }}
          data-copy-editing={copyEditing || undefined}
        >
          {frame}
        </div>
      </div>
    )
  }

  return (
    <div ref={desk} className="studio-desk" data-gesture={gesture ?? undefined}>
      <div className="studio-desk-plane" style={{ transform: `scale(${scale})` }}>
        <div
          className="studio-window"
          style={{ left: box.x, top: box.y, width: box.width }}
          data-copy-editing={copyEditing || undefined}
        >
          <div className="studio-window-tab" onPointerDown={(e) => start(e, 'move')}>
            <GripHorizontal aria-hidden />
            <span className="studio-window-title">{surface.label}</span>
            <span className="studio-window-size">
              {box.width} × {box.height}
            </span>
          </div>
          <div className="studio-window-body">
            {frame}
            {gesture && <div className="studio-frame-shield" />}
          </div>
          {EDGES.map((edge) => (
            <div key={edge} className={`studio-edge studio-edge-${edge}`} onPointerDown={(e) => start(e, edge)} />
          ))}
        </div>
      </div>
      {gesture && <div className="studio-desk-shield" style={{ cursor: gesture }} />}
    </div>
  )
}
