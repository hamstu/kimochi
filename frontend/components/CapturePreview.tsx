/**
 * COPY of `src/renderer/src/components/CapturePreview.tsx`.
 * Delta: accepts a `capture://` URL as well as base64, because the native backend serves the last
 * capture through its own protocol instead of pushing base64 over IPC.
 */
import { useState, type JSX } from 'react'

interface CapturePreviewProps {
  visible: boolean
  /** Base64 PNG (Electron parity) or a `capture://` URL from the native backend. */
  imageData: string | null
}

const sourceUrl = (imageData: string): string =>
  imageData.startsWith('capture:') || imageData.startsWith('data:')
    ? imageData
    : `data:image/png;base64,${imageData}`

export default function CapturePreview({
  visible,
  imageData
}: CapturePreviewProps): JSX.Element | null {
  const [failed, setFailed] = useState<string | null>(null)
  if (!visible) return null
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: 12 }}>
      {failed === imageData && imageData && <p role="alert">Could not load this capture image.</p>}
      {imageData ? (
        <img
          src={sourceUrl(imageData)}
          alt="Capture preview"
          onError={() => setFailed(imageData)}
          onLoad={() => setFailed(null)}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      ) : (
        <p>No capture yet. Trigger a scan to see a preview.</p>
      )}
    </div>
  )
}
