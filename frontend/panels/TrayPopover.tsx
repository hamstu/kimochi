/**
 * COPY of `src/renderer/src/windows/tray-popover/TrayPopoverApp.tsx`'s layout: the same
 * `RemoteControl`, the same centred 16 px padding.
 *
 * Delta: Electron relayed `tray-state-update` messages from the overlay to keep this mount in sync.
 * Both mounts now read the same shared session state, so there is nothing to relay.
 */
import type { JSX } from 'react'
import RemoteControl from '../components/RemoteControl'
import { useController } from './useController'
import { useNativeHover } from '../shell/useNativeHover'

export default function TrayPopover(): JSX.Element {
  const { props, error, dismissError } = useController()
  useNativeHover()
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        alignItems: 'stretch',
        padding: '16px'
      }}
    >
      <RemoteControl {...props} />
      {error && (
        <div className="native-panel-error" role="status" onClick={dismissError} title="Dismiss">
          {error}
        </div>
      )}
    </div>
  )
}
