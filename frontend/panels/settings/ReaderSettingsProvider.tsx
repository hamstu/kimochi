/**
 * Connects the Settings window to the Log once, for every page that edits the Log's settings. It
 * also hosts the notebook entry editor, which settings actions (such as a VNDB import) can open.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Callout } from '@kit'
import { initializeClient } from '@texthooker/bridge'
import { loadSettings, onSettingsChange } from '@texthooker/lib/settings'
import { EditEntryModal } from '@texthooker/components/EditEntryModal'
import { onEditModalRequest } from '@texthooker/lib/editModal'
import type { Settings } from '@texthooker/lib/types'
import { ReaderSettingsContext, useReaderSettings } from './readerSettings'
import '@texthooker/settings.css'

export function ReaderSettingsProvider({ children }: { children: ReactNode }): ReactNode {
  // Set only once the Log has answered: settings can arrive (through the change listener) first,
  // and pages that read the Log's data must not render before its snapshot is here.
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const fail = (event: PromiseRejectionEvent): void => setError(String(event.reason))
    window.addEventListener('unhandledrejection', fail)
    void Promise.all([initializeClient(), loadSettings()])
      .then(([, value]) => {
        if (!active) return
        setSettings(value)
        setReady(true)
      })
      .catch((caught) => {
        if (active) setError(String(caught))
      })
    const offSettings = onSettingsChange(setSettings)
    const offEdit = onEditModalRequest(setEdit)
    return () => {
      active = false
      window.removeEventListener('unhandledrejection', fail)
      offSettings()
      offEdit()
    }
  }, [])

  return (
    <ReaderSettingsContext.Provider value={{ settings: ready ? settings : null, error }}>
      {children}
      {/* The editor reads the notebook the moment it renders, so it waits for the Log's data. */}
      {ready && (
        <div className="texthooker" style={{ display: 'contents' }}>
          <EditEntryModal entryId={edit} onClose={() => setEdit(null)} />
        </div>
      )}
    </ReaderSettingsContext.Provider>
  )
}

/** Renders its children with the loaded settings, or the loading state or failure in their place. */
export function WithReaderSettings({
  children
}: {
  children: (settings: Settings) => ReactNode
}): ReactNode {
  const { settings, error } = useReaderSettings()
  if (settings) return children(settings)
  return (
    <div className="texthooker-settings-status">
      {error ? (
        <Callout tone="danger">{error}</Callout>
      ) : (
        <span role="status" className="k-description">
          Loading…
        </span>
      )}
    </div>
  )
}
