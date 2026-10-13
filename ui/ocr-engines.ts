/**
 * The engine chooser in Settings → OCR & Overlay, as pure decisions: the short status hint beside
 * each engine in the list, and how its accelerator reads. The engines themselves (names, copy)
 * are `OCR_MODES` in `ui/settings.ts`.
 */
import type { OcrEngineCapability, PlatformOs } from './capabilities.js'
import { percent, type ModelState, type ModelStatus } from './model-download.js'

export type EngineHintTone = 'neutral' | 'progress' | 'warn' | 'muted'

export interface EngineHint {
  /** A few words: "Not downloaded", "Downloading 32%", "Unavailable". */
  text: string
  tone: EngineHintTone
  /** The longer explanation, for a tooltip. */
  reason?: string
}

/** The hint for a model state; `pct` when there is a measured download to report. */
function modelHint(state: ModelState, pct: number | null, message: string | null): EngineHint | null {
  switch (state) {
    case 'absent':
      return { text: 'Not downloaded', tone: 'neutral' }
    case 'downloading':
      return { text: pct === null ? 'Downloading' : `Downloading ${pct}%`, tone: 'progress' }
    case 'verifying':
      return { text: 'Verifying…', tone: 'progress' }
    case 'paused':
      return { text: pct ? `Paused at ${pct}%` : 'Paused', tone: 'warn' }
    case 'failed':
      return { text: 'Download failed', tone: 'warn', reason: message ?? undefined }
    case 'ready':
      return null
  }
}

/**
 * What the list says beside an engine, or nothing when it is simply ready to use. An engine this
 * computer cannot run is "Unavailable" (its reason for the tooltip); one held back only by its
 * model says where the download stands, from the live model status when there is one and from
 * the capability's model gate until then.
 */
export function engineHint(
  capability: OcrEngineCapability | undefined,
  status: ModelStatus | null
): EngineHint | null {
  if (capability && !capability.available && !capability.model) {
    return {
      text: capability.selectable ? 'Setup needed' : 'Unavailable',
      tone: capability.selectable ? 'warn' : 'muted',
      reason: capability.reason || 'Not available on this computer'
    }
  }
  if (status) {
    const pct = status.overallTotal > 0 ? percent(status.overallReceived, status.overallTotal) : null
    return modelHint(status.state, pct, status.message)
  }
  if (capability?.model) {
    const hint = modelHint(capability.model, null, null)
    return hint && { ...hint, reason: hint.reason ?? capability.reason ?? undefined }
  }
  return null
}

/**
 * Whether an engine belongs in this OS's pickers at all. An OS-specific engine is left out of
 * the others' lists rather than shown as unavailable: there is nothing to do about it there.
 */
export function engineOffered(mode: string, os: PlatformOs): boolean {
  switch (mode) {
    case 'oneocr':
      return os === 'windows'
    case 'livetext':
      return os === 'macos'
    default:
      return true
  }
}

/**
 * Whether an engine appears in the pickers: offered on this OS, and Kimochi cloud only with an
 * access key (`cloudAccess`). An engine that is still the selected one stays listed even without
 * the key, so the picker shows what is chosen (as unavailable, with its reason); the setting is
 * never changed behind the user's back.
 */
export function engineListed(
  mode: string,
  capabilities: { os: PlatformOs; cloudAccess: boolean },
  selected: string
): boolean {
  if (!engineOffered(mode, capabilities.os)) return false
  if (mode === 'cloud' && !capabilities.cloudAccess) return mode === selected
  return true
}

/** Whether an engine can be chosen here: anything but one this computer cannot run at all. */
export const engineSelectable = (capability: OcrEngineCapability | undefined): boolean =>
  !capability || capability.available || !!capability.model || capability.selectable === true

/** Where a local engine runs, as the detail panel says it: "the GPU, through Core ML". */
export function acceleratorLabel(accelerator: OcrEngineCapability['accelerator']): string | null {
  switch (accelerator) {
    case 'coreml':
      return 'the GPU and Neural Engine, through Core ML'
    case 'directml':
      return 'the GPU, through DirectML'
    case 'metal':
      return 'the GPU, through Metal'
    case 'cuda':
      return 'the NVIDIA GPU, through CUDA'
    case 'cpu':
      return 'the CPU'
    default:
      return null
  }
}
