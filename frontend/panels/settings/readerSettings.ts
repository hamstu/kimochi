import { createContext, useContext } from 'react'
import type { Settings } from '@texthooker/lib/types'

export interface ReaderSettingsState {
  /** Null until the Log's settings have loaded. */
  settings: Settings | null
  error: string
}

export const ReaderSettingsContext = createContext<ReaderSettingsState>({
  settings: null,
  error: ''
})

/** The Log's (Super Texthooker's) settings, shared by the Sources, Log, Dictionary and AI pages. */
export const useReaderSettings = (): ReaderSettingsState => useContext(ReaderSettingsContext)
