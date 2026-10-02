/**
 * The Log and Notebook as tabs across the top of the content, each as wide as it can be. The
 * active one takes the content's ground and an accent underline, so it reads as the page below it.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { BookOpen, ScrollText } from 'lucide-react'
import { getSnapshot, subscribe } from '@texthooker/bridge'

export type TabView = 'log' | 'notebook'

function useCounts(): { lines: number; entries: number } {
  const count = (): { lines: number; entries: number } => {
    const snap = getSnapshot()
    return { lines: snap.lines.length, entries: snap.notebook.entries.length }
  }
  const [counts, setCounts] = useState(count)
  useEffect(() => subscribe(() => setCounts(count())), [])
  return counts
}

export function ViewTabs({
  view,
  onView
}: {
  view: TabView
  onView: (view: TabView) => void
}): JSX.Element {
  const counts = useCounts()
  const tab = (value: TabView, icon: ReactNode, label: string, count: number): JSX.Element => (
    <button
      type="button"
      role="tab"
      className="main-tab"
      aria-selected={view === value}
      onClick={() => onView(value)}
    >
      {icon}
      <span>{label}</span>
      <span className="main-tab-count">{count.toLocaleString()}</span>
    </button>
  )
  return (
    <div className="main-tabs" role="tablist" aria-label="Views">
      {tab('log', <ScrollText />, 'Log', counts.lines)}
      {tab('notebook', <BookOpen />, 'Notebook', counts.entries)}
    </div>
  )
}
