import { useRef, type PointerEvent, type ReactNode } from 'react'

/**
 * A panel's draggable edge: drag to resize, double-click to reset. The panel shows `onLive`'s width
 * while dragging; `onCommit` is called once, on release, so a saved width isn't written per move.
 * `edge` is the side of the panel the handle sits on: a handle on the start (left) edge widens the
 * panel as it moves left.
 */
export function ResizeHandle({
  width,
  min,
  max,
  reset,
  edge = 'end',
  label,
  onLive,
  onCommit
}: {
  width: number
  min: number
  max: number
  /** The width a double-click restores. */
  reset: number
  edge?: 'start' | 'end'
  label: string
  onLive: (width: number | null) => void
  onCommit: (width: number) => void
}): ReactNode {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  const clamp = (value: number): number => Math.round(Math.min(max, Math.max(min, value)))
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current) return
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    onCommit(current.last)
    onLive(null)
  }
  return (
    <div
      className="k-resize"
      data-edge={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width, last: width }
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        const moved = event.clientX - current.x
        current.last = clamp(current.width + (edge === 'end' ? moved : -moved))
        onLive(current.last)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(reset)}
    />
  )
}
