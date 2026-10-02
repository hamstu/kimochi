/**
 * The popover shown when the tray icon is clicked: the Controller's `RemoteControl` rows, full
 * bleed under a 28px bar, so it reads as the same instrument as the Controller window.
 *
 * Delta from Electron: it relayed `tray-state-update` messages from the overlay to keep this mount
 * in sync. Both mounts now read the same shared session state, so there is nothing to relay.
 */
import type { JSX } from 'react'
import { Bar } from '@kit'
import RemoteControl from '../components/RemoteControl'
import { useController } from './useController'
import { useNativeHover } from '../shell/useNativeHover'
import './tray-popover.css'

export default function TrayPopover(): JSX.Element {
  const { props, error, dismissError } = useController()
  useNativeHover()
  return (
    <div className="native-panel native-panel-tray-popover">
      <Bar position="top" className="tray-popover-bar">
        <span className="k-medium">Kimochi</span>
      </Bar>
      {error && (
        <div className="native-panel-error" role="status" onClick={dismissError} title="Dismiss">
          {error}
        </div>
      )}
      <RemoteControl {...props} openMainLabel="Show Kimochi" />
    </div>
  )
}
