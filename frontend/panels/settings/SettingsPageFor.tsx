/** One settings page by name, for the Settings window and the main window's Settings view. */
import type { ReactNode } from 'react'
import type { SettingsTabName } from '../../bridge/tauri'
import { GeneralTab } from './GeneralTab'
import { SourcesTab } from './SourcesTab'
import { OcrTab } from './OcrTab'
import { LogTab } from './LogTab'
import { DictionaryTab } from './DictionaryTab'
import { AssistTab } from './AssistTab'
import { ControlsTab } from './ControlsTab'

const PAGES: Record<SettingsTabName, () => ReactNode> = {
  general: GeneralTab,
  sources: SourcesTab,
  ocr: OcrTab,
  log: LogTab,
  dictionary: DictionaryTab,
  assist: AssistTab,
  controls: ControlsTab
}

export function SettingsPageFor({ tab }: { tab: SettingsTabName }): ReactNode {
  const Page = PAGES[tab]
  return <Page />
}
