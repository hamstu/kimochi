/**
 * The OCR engine pickers (the sidebar's "OCR model" and the engine list in Settings → OCR & Overlay) share this,
 * so both behave the same: picking a local engine whose models were never downloaded does not
 * change `ocrMode` yet. The picker shows the pick while a confirmation asks to download the model
 * (`DownloadConfirmDialog`); Download saves `ocrMode` (and native `settings_set` starts the
 * download), Cancel drops the pick so the picker shows the saved engine again and nothing is
 * written. Any other pick is saved at once. The decision itself is `engineChoice`.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { engineChoice, isModelEngine, type ModelStatus } from '@ui/model-download'
import { modelStatus } from './models'
import type { OcrMode } from './settings'
import { useSetting } from './useSetting'

/** A pick waiting on the user: its model's status (for the name and size) and the answers. */
export interface DownloadConfirmation {
  status: ModelStatus
  confirm: () => void
  cancel: () => void
}

export interface EngineSelection {
  /** The saved engine. */
  ocrMode: OcrMode
  /** What the picker shows: the pick while it is being decided or confirmed, else the saved one. */
  shown: OcrMode
  choose: (mode: OcrMode) => void
  /** Set while the download confirmation should be open. */
  confirmation: DownloadConfirmation | null
}

export function useEngineSelection(): EngineSelection {
  const [ocrMode, setOcrMode] = useSetting<OcrMode>('ocrMode', 'cloud')
  const [pick, setPick] = useState<{ mode: OcrMode; status: ModelStatus | null } | null>(null)
  // A later pick supersedes a status request still in flight for an earlier one.
  const ticket = useRef(0)

  const commit = useCallback(
    (mode: OcrMode): void => {
      ticket.current += 1
      setPick(null)
      void setOcrMode(mode)
    },
    [setOcrMode]
  )

  const choose = useCallback(
    (mode: OcrMode): void => {
      if (!isModelEngine(mode)) return commit(mode)
      const mine = ++ticket.current
      setPick({ mode, status: null })
      modelStatus(mode)
        .then((status) => {
          if (ticket.current !== mine) return
          if (engineChoice(mode, status) === 'confirm' && status) setPick({ mode, status })
          else commit(mode)
        })
        // No answer (a backend without model downloads): nothing to confirm.
        .catch(() => {
          if (ticket.current === mine) commit(mode)
        })
    },
    [commit]
  )

  const cancel = useCallback((): void => {
    ticket.current += 1
    setPick(null)
  }, [])

  // Stable while the pick stands, so the dialog can tell a new question from a re-render.
  const confirmation = useMemo<DownloadConfirmation | null>(
    () =>
      pick?.status != null
        ? { status: pick.status, confirm: () => commit(pick.mode), cancel }
        : null,
    [pick, commit, cancel]
  )

  return { ocrMode, shown: pick?.mode ?? ocrMode, choose, confirmation }
}
