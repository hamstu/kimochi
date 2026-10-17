/**
 * The Sync log window (`sync-log`, opened from Settings → Account → Sync): what Sync did, newest
 * last, as timestamped monospaced lines that can be selected and copied (or all copied at once).
 * Native keeps the last 2000 entries across restarts (`sync_log.rs`); new ones arrive live as
 * `sync-log` events, and the view stays at the bottom while it is scrolled there.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy, RefreshCw, Trash2 } from 'lucide-react'
import { Bar, BarSpacer, Button, EmptyState } from '@kit'
import { appendLog, logLine, logText, syncStateLine, type SyncLogEntry } from '@ui/sync'
import { clearSyncLog, readSyncLog, syncNow, useSync } from '../bridge/sync'
import { onEvent } from '../bridge/tauri'
import './sync-log.css'

export default function SyncLogPanel(): JSX.Element {
  const [entries, setEntries] = useState<SyncLogEntry[]>([])
  const [copied, setCopied] = useState(false)
  const sync = useSync()
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let live = true
    void readSyncLog()
      .then((list) => live && setEntries(list))
      .catch(() => undefined)
    const offs = [
      onEvent<SyncLogEntry>('sync-log', (entry) => setEntries((list) => appendLog(list, entry))),
      onEvent<unknown>('sync-log-cleared', () => setEntries([]))
    ]
    return () => {
      live = false
      for (const off of offs) void off.then((fn) => fn()).catch(() => undefined)
    }
  }, [])

  // Follow new entries while scrolled to the bottom; leave the reader where they are otherwise.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])

  const copyAll = (): void => {
    void navigator.clipboard.writeText(logText(entries)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="sync-log">
      <Bar>
        <span className="sync-log-status k-num">{syncStateLine(sync, now)}</span>
        <BarSpacer />
        <span className="sync-log-count k-num">{entries.length.toLocaleString('en-US')} entries</span>
        <Button size="sm" variant="ghost" disabled={sync.state === 'syncing' || sync.state === 'off'} onClick={() => void syncNow()}>
          <RefreshCw />
          Sync now
        </Button>
        <Button size="sm" variant="ghost" disabled={entries.length === 0} onClick={() => void clearSyncLog()}>
          <Trash2 />
          Clear
        </Button>
        <Button size="sm" disabled={entries.length === 0} onClick={copyAll}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy all'}
        </Button>
      </Bar>
      <div
        ref={scroller}
        className="sync-log-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {entries.length === 0 ? (
          <EmptyState title="Nothing logged yet">Sync&apos;s activity appears here as it happens.</EmptyState>
        ) : (
          <pre className="sync-log-text" aria-label="Sync log">
            {entries.map((entry, index) => (
              <span key={`${entry.t}-${index}`} className="sync-log-line" data-kind={entry.kind}>
                {logLine(entry)}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}
