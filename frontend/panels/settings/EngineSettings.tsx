/**
 * The engine-specific part of the engine chooser's detail panel (`EngineChooser`): whatever one
 * engine needs set up beyond being chosen. This is the extension point for per-engine settings:
 * give a new engine a case in `EngineSettings` and lay its settings out with `EngineSetting`.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { ConfirmDialog, Select } from '@kit'
import type { ServerSettings } from '../../vendor/shared-types'
import { DEFAULT_SERVER_MODE, SERVER_URLS, type ServerMode } from '../../vendor/shared-constants'
import type { OcrMode } from '../../bridge/settings'
import { useSetting } from '../../bridge/useSetting'
import { nativeError, quitApp } from '../../bridge/tauri'
import type { ModelControls } from '../../bridge/models'
import { ModelDownload } from './ModelDownload'

/**
 * Whether this is a local development build. The frontend is always `vite build`-ed (even for
 * `tauri dev`), so `import.meta.env.DEV` only covers the Vite dev server; a debug native build
 * says so through `__KIMOCHI_PLATFORM__.debug` (`platform_prelude` in `src-tauri/src/platform`).
 */
const DEV_BUILD =
  import.meta.env.DEV ||
  (window as { __KIMOCHI_PLATFORM__?: { debug?: boolean } }).__KIMOCHI_PLATFORM__?.debug === true

const SERVER_OPTIONS = [
  { value: 'cloud', label: 'Cloud (recommended)' },
  { value: 'local', label: 'Local (localhost:3000)' }
] as const

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

/** Cloud OCR's server: a developer's switch, so only in a local development build. */
function CloudServerSetting(): ReactNode {
  const [serverSettings, setServerSettings] = useSetting<ServerSettings>('serverSettings', {
    mode: DEFAULT_SERVER_MODE
  })
  // Changing the server needs a restart, so it is confirmed first (local UI state, not persisted).
  const [pendingServerMode, setPendingServerMode] = useState<ServerMode | null>(null)

  const confirmServerModeChange = useCallback(async (): Promise<void> => {
    if (!pendingServerMode) return
    await setServerSettings({ mode: pendingServerMode })
    setPendingServerMode(null)
    quitApp().catch((error) => console.error('Quit failed:', nativeError(error).message))
  }, [pendingServerMode, setServerSettings])

  return (
    <>
      <EngineSetting
        label="OCR server"
        description={
          <>
            Using{' '}
            <span className="k-mono">
              {serverSettings.mode === 'cloud' ? SERVER_URLS.cloud : SERVER_URLS.local}
            </span>
            . Changing it restarts Kimochi.
          </>
        }
      >
        <Select
          aria-label="OCR server"
          value={serverSettings.mode}
          onValueChange={(value) => {
            if (value !== serverSettings.mode) setPendingServerMode(value as ServerMode)
          }}
          options={SERVER_OPTIONS}
        />
      </EngineSetting>
      <ConfirmDialog
        open={pendingServerMode !== null}
        onOpenChange={(open) => {
          if (!open) setPendingServerMode(null)
        }}
        title="Restart required"
        description="Changing the OCR server requires restarting Kimochi. The app will quit and you'll need to reopen it manually."
        confirmLabel="Quit & apply"
        onConfirm={() => void confirmServerModeChange()}
      />
    </>
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
      return DEV_BUILD ? <CloudServerSetting /> : null
    case 'meikiocr':
    case 'mangaocr':
      return <ModelDownload controls={model} emphasis={emphasis} />
    case 'websocket':
      return null
  }
}
