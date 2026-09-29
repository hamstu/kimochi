/**
 * Yomitan's own settings page (dictionaries, import, scanning options) inside Kimochi's panel
 * chrome. The distributed `/settings.html` is loaded unmodified in a frame; the window's init
 * script gives that frame the panel shim, which relays backend calls to the overlay's single
 * Yomitan backend.
 */
import { useState, type JSX } from 'react'
import { Spinner } from '@kit'
import './yomitan-settings.css'

export default function YomitanSettingsPanel(): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="yomitan-settings">
      {!loaded && (
        <div className="yomitan-settings-loading">
          <Spinner label="Loading Yomitan settings" />
          <span>Loading Yomitan settings…</span>
        </div>
      )}
      <iframe
        title="Yomitan settings"
        src="/settings.html"
        className="yomitan-settings-frame"
        data-loaded={loaded || undefined}
        onLoad={() => setLoaded(true)}
      />
    </div>
  )
}
