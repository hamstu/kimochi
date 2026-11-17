/**
 * Sessions' summaries (reading time, lines, the newest few), for Log & Sessions' list and a game's
 * session in Settings → Text Hooker.
 */
import { useEffect, useMemo, useState } from 'react'
import { sessionSummaries, subscribeSessions } from '@texthooker/lib/sessions'
import { getSettings } from '@texthooker/lib/settings'
import { snapshotLines } from '@texthooker/lib/store'
import { summarizeLines, type SessionSummary } from '@texthooker/lib/sessionSummary'
import type { SessionMeta } from '@texthooker/lib/types'

/**
 * Each session's summary: asked of the Log for them all when the list opens or changes, and kept
 * live for the open session from the lines the Log sends with every update.
 */
export function useSummaries(
  sessions: SessionMeta[],
  activeId: string,
  version: number
): Record<string, SessionSummary> {
  const [stored, setStored] = useState<Record<string, SessionSummary>>({})
  const [live, setLive] = useState<SessionSummary | null>(null)
  const idsKey = sessions.map((session) => session.id).join('\u0001')

  useEffect(() => {
    let current = true
    sessionSummaries()
      .then((list) => {
        if (current) setStored(Object.fromEntries(list.map((s) => [s.id, s])))
      })
      .catch(() => {
        // The rows show no stats until the next change; the list still works.
      })
    return () => {
      current = false
    }
  }, [idsKey, activeId, version])

  useEffect(() => {
    const update = () => {
      try {
        const ceilingMs = Math.max(10, getSettings().afkThresholdSec) * 1000
        const next = summarizeLines(activeId, snapshotLines(), ceilingMs, getSettings().skipFastLines)
        setLive((previous) => (sameSummary(previous, next) ? previous : next))
      } catch {
        // The Log has not sent its first snapshot yet.
      }
    }
    update()
    return subscribeSessions(update)
  }, [activeId])

  return useMemo(
    () => (live && live.id === activeId ? { ...stored, [activeId]: live } : stored),
    [stored, live, activeId]
  )
}

function sameSummary(a: SessionSummary | null, b: SessionSummary): boolean {
  return (
    !!a &&
    a.id === b.id &&
    a.lines === b.lines &&
    a.readingMs === b.readingMs &&
    a.recent.join('\n') === b.recent.join('\n')
  )
}
