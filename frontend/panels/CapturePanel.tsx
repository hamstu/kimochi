/** Live native capture preview. OCR publication has a separate lifetime. */
import { useEffect, useState, type JSX } from 'react'
import { invoke } from '@tauri-apps/api/core'
import CapturePreview from '../components/CapturePreview'
import { nativeError } from '../bridge/tauri'

interface Preview {
  id: number
  url: string
  info: { capturedAt: number; width: number; height: number }
}

export default function CapturePanel(): JSX.Element {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const next = await invoke<{ frame: Preview | null; error: string | null } | null>(
          'capture_preview'
        )
        if (active) {
          setPreview(next?.frame ?? null)
          setError(next?.error ?? null)
        }
      } catch (caught) {
        if (active) setError(nativeError(caught).message)
      } finally {
        if (active) {
          setNow(Date.now())
          timer = setTimeout(() => void poll(), 1000)
        }
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  const age = preview ? Math.max(0, (now - preview.info.capturedAt) / 1000) : 0
  return (
    <div>
      <p style={{ margin: '8px 12px', fontSize: 12 }}>
        {preview
          ? `Captured ${age.toFixed(1)}s ago · ${preview.info.width} × ${preview.info.height} · frame ${preview.id}`
          : 'Waiting for a capture. Enable Auto OCR or trigger a scan.'}
        {age > 3 && ' — No recent capture; this image is stale.'}
      </p>
      {error && <p role="alert">Capture preview unavailable: {error}</p>}
      <CapturePreview visible imageData={preview?.url ?? null} />
    </div>
  )
}
