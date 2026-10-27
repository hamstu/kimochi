/** Linux Wayland source-image editor; never maps a transparent desktop window. */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { Button, Dialog, DialogContent } from '@kit'
import { nativeError } from '../bridge/tauri'
import type { NativeCrop } from '../bridge/types'
import { cropForFrame, cropFromPoints } from '../../ui/linux-crop-geometry.js'

interface Request {
  requestId: string
  sourceId: string
  frame: { url: string; width: number; height: number }
  crop: NativeCrop | null
  /** Which of the source's regions: the area read (`ocr`, the default) or the Anki screenshot. */
  kind?: 'ocr' | 'anki'
}

export function LinuxSourceCrop({ enabled }: { enabled: boolean }): ReactNode {
  const [request, setRequest] = useState<Request | null>(null)
  const [crop, setCrop] = useState<NativeCrop | null>(null)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drag = useRef<{ x: number; y: number; pointer: number; rect: DOMRect } | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const active = useRef<Request | null>(null)
  useEffect(() => {
    if (!enabled || window.__KIMOCHI_PLATFORM__?.os !== 'linux') return
    let disposed = false
    const stops: Array<() => void> = []
    const add = async (): Promise<void> => {
      const open = await listen<Request>('linux:edit-source-crop', ({ payload }) => {
        active.current = payload
        setRequest(payload)
        setCrop(cropForFrame(payload.crop, payload.frame))
        setReady(false)
        setError(null)
        setSaving(false)
        drag.current = null
      })
      if (disposed) open(); else stops.push(open)
      const close = await listen<{ requestId: string }>('linux:close-source-crop', ({ payload }) => {
        if (active.current?.requestId === payload.requestId) {
          active.current = null
          setRequest(null)
        }
      })
      if (disposed) close(); else stops.push(close)
    }
    void add()
    return () => {
      disposed = true
      stops.forEach(stop => stop())
      if (active.current) void emit('linux:source-crop-result', { requestId: active.current.requestId, saved: false })
      active.current = null
    }
  }, [enabled])

  const finish = async (saved: boolean): Promise<void> => {
    if (!request) return
    await emit('linux:source-crop-result', { requestId: request.requestId, saved })
    active.current = null
    setRequest(null)
    drag.current = null
  }
  const save = async (): Promise<void> => {
    if (!request || !crop || saving) return
    setSaving(true)
    try {
      if (await invoke('selected_source') !== request.sourceId) throw new Error('The shared source changed. Cancel and open the crop editor again.')
      // The Anki crop is saved on its own: the selection, the OCR crop and the scan stay.
      if (request.kind === 'anki') await invoke('commit_anki_crop', { sourceId: request.sourceId, crop })
      else await invoke('commit_source', { sourceId: request.sourceId, crop, keepCrop: false })
      await finish(true)
    } catch (caught) {
      setError(nativeError(caught).message)
    } finally { setSaving(false) }
  }
  const point = (event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const rect = drag.current?.rect ?? image.current?.getBoundingClientRect()
    if (!rect?.width || !rect.height || !request) return null
    return { x: (event.clientX - rect.left) * request.frame.width / rect.width,
      y: (event.clientY - rect.top) * request.frame.height / rect.height }
  }
  if (!enabled || !request) return null
  const anki = request.kind === 'anki'
  const outline = crop ? { left: `${crop.x / request.frame.width * 100}%`, top: `${crop.y / request.frame.height * 100}%`,
    width: `${crop.width / request.frame.width * 100}%`, height: `${crop.height / request.frame.height * 100}%` } : null
  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) void finish(false) }}>
      <DialogContent title={anki ? 'Anki crop area' : 'OCR crop area'} size="lg"
        description={anki
          ? 'Drag on the image to choose the part that goes on Anki cards as the screenshot.'
          : 'Drag on the image to choose the area to read. Save applies this crop to your shared source.'}
        style={{ width: 'min(96vw, 1100px)', maxWidth: '96vw' }}
        onEscapeKeyDown={event => { if (saving) event.preventDefault() }}
        footer={<><Button disabled={saving} onClick={() => void finish(false)}>Cancel</Button>
          <Button variant="primary" disabled={!ready || !crop || saving} onClick={() => void save()}>{saving ? 'Saving…' : anki ? 'Save' : 'Save crop'}</Button></>}>
        {error && <p role="alert">{error}</p>}
        {!ready && !error && <p>Loading shared source…</p>}
        <div data-linux-source-crop style={{ position: 'relative', overflow: 'hidden', cursor: ready ? 'crosshair' : 'wait', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={event => {
            if (!ready || saving || event.button !== 0) return
            const start = point(event)
            if (!start) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { ...start, pointer: event.pointerId, rect: image.current!.getBoundingClientRect() }
            setCrop(null)
          }}
          onPointerMove={event => {
            const end = point(event)
            if (drag.current?.pointer === event.pointerId && end) setCrop(cropFromPoints(drag.current, end, request.frame))
          }}
          onPointerUp={event => {
            const end = point(event)
            if (drag.current?.pointer !== event.pointerId) return
            if (end) setCrop(cropFromPoints(drag.current, end, request.frame))
            drag.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { drag.current = null }}>
          <img ref={image} src={request.frame.url} alt="Shared source to crop" draggable={false}
            style={{ display: 'block', width: '100%', height: 'auto' }}
            onLoad={() => setReady(true)} onError={() => setError('Could not load this source image. Cancel and choose the source again.')} />
          {outline && <div data-linux-crop-outline style={{ ...outline, position: 'absolute', pointerEvents: 'none', border: `2px solid ${anki ? 'var(--k-ok)' : 'var(--k-accent)'}`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }} />}
        </div>
        <p>{crop ? `${crop.width} × ${crop.height} pixels` : 'Drag to select an area.'}</p>
      </DialogContent>
    </Dialog>
  )
}
