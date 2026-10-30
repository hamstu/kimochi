/**
 * The engine-specific part of the engine chooser's detail panel (`EngineChooser`): whatever one
 * engine needs set up beyond being chosen. This is the extension point for per-engine settings:
 * give a new engine a case in `EngineSettings` and lay its settings out with `EngineSetting`.
 */
import type { ReactNode } from 'react'
import type { OcrMode } from '../../bridge/settings'
import type { ModelControls } from '../../bridge/models'
import { DEV_BUILD } from '../../bridge/devBuild'
import { ModelDownload } from './ModelDownload'

/** One setting inside the detail panel: label and description, the control beside them. */
export function EngineSetting({
  label,
  description,
  children
}: {
  label: string
  description?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <div className="engine-setting">
      <div className="engine-setting-text">
        <span className="engine-setting-label">{label}</span>
        {description && <span className="k-description">{description}</span>}
      </div>
      <div className="engine-setting-control">{children}</div>
    </div>
  )
}

/** Development builds: where Kimochi's server (production or local) is switched. */
function CloudServerNote(): ReactNode {
  return (
    <p className="k-description">
      Development build: switch between the production and local server in Settings → Account.
    </p>
  )
}

/**
 * The settings `mode` needs, or null when it has none. `model` is the engine's model controls
 * (status null for an engine without one); `emphasis` is whether the engine is the one in use.
 */
export function EngineSettings({
  mode,
  model,
  emphasis
}: {
  mode: OcrMode
  model: ModelControls
  emphasis: boolean
}): ReactNode {
  switch (mode) {
    case 'cloud':
      return DEV_BUILD ? <CloudServerNote /> : null
    case 'meikiocr':
    case 'mangaocr':
    case 'ppocr':
      return <ModelDownload controls={model} emphasis={emphasis} />
    case 'googlelens':
    case 'oneocr':
    case 'livetext':
      return null
  }
}
