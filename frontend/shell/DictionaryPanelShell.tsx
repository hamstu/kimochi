/** The `dictionary` window's panel chrome, titled after the active engine ("10ten settings"). */
import type { ReactNode } from 'react'
import PanelShell from './PanelShell'
import { dictionaryPanelTitle, useDictionaryEngine } from '../bridge/dictionaryEngine'

export default function DictionaryPanelShell({
  label,
  hideTitle,
  children
}: {
  label: string
  hideTitle: boolean
  children: ReactNode
}): ReactNode {
  const [engine] = useDictionaryEngine()
  return (
    <PanelShell label={label} title={dictionaryPanelTitle(engine)} hideTitle={hideTitle}>
      {children}
    </PanelShell>
  )
}
