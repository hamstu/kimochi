/**
 * The controller window: the original `RemoteControl` with the shared wiring.
 * Electron mounted the same component from `OverlayApp.tsx`; nothing about its look changes.
 *
 * Addition: a failed action shows a dismissible line under the controls. In Electron these calls
 * were in-process and could not fail this way; here they cross to the native backend, and a control
 * that silently does nothing would be indistinguishable from a broken one.
 */
import type { JSX } from 'react'
import RemoteControl from '../components/RemoteControl'
import { useController } from './useController'

export default function ControllerPanel(): JSX.Element {
  const { props, error, dismissError } = useController()
  return (
    <>
      <RemoteControl {...props} />
      {error && (
        <div className="native-panel-error" role="status" onClick={dismissError} title="Dismiss">
          {error}
        </div>
      )}
    </>
  )
}
