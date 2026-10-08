/**
 * "Download Manga OCR?": asked when an engine picker (sidebar or Settings → OCR) picks a local
 * engine whose models were never downloaded. Download saves the pick; Cancel, Escape or a click
 * outside drops it. Driven by `useEngineSelection`.
 */
import { useState, type ReactNode } from 'react'
import { ConfirmDialog } from '@kit'
import { downloadPrompt } from '@ui/model-download'
import type { DownloadConfirmation } from '../../bridge/useEngineSelection'

export function DownloadConfirmDialog({
  confirmation
}: {
  confirmation: DownloadConfirmation | null
}): ReactNode {
  // The last question asked, so its words stay put while the dialog fades out.
  const [last, setLast] = useState(confirmation)
  if (confirmation && confirmation !== last) setLast(confirmation)
  const shown = confirmation ?? last
  const prompt = shown ? downloadPrompt(shown.status) : null
  return (
    <ConfirmDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) confirmation?.cancel()
      }}
      title={prompt?.title ?? ''}
      description={prompt?.description}
      confirmLabel="Download"
      onConfirm={() => confirmation?.confirm()}
      dismissOnOutsideClick
    />
  )
}
