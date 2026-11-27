/**
 * Export the reading history (src-tauri/src/reading_history.rs): every line read, with when and
 * what it was read from, as a file the person chooses.
 */
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { postActivity } from '../../bridge/activity'
import { defaultSavePath } from '../../bridge/saveLocation'
import { getSettings } from './settings'

export type HistoryFormat = 'exstatic-lines' | 'exstatic-stats' | 'csv' | 'json'

/** The formats the Log's ⋯ menu offers, and the file each suggests. */
export const HISTORY_FORMATS: readonly {
  format: HistoryFormat
  label: string
  file: string
  filter: { name: string; extensions: string[] }
}[] = [
  {
    format: 'exstatic-lines',
    label: 'Lines for exSTATic or GSM (CSV)',
    file: 'exSTATic_lines.csv',
    filter: { name: 'CSV', extensions: ['csv'] }
  },
  {
    format: 'exstatic-stats',
    label: 'Daily stats for exSTATic (CSV)',
    file: 'exSTATic_stats.csv',
    filter: { name: 'CSV', extensions: ['csv'] }
  },
  {
    format: 'csv',
    label: 'Every detail (CSV)',
    file: 'kimochi-reading-history.csv',
    filter: { name: 'CSV', extensions: ['csv'] }
  },
  {
    format: 'json',
    label: 'Every detail (JSON)',
    file: 'kimochi-reading-history.json',
    filter: { name: 'JSON', extensions: ['json'] }
  }
]

/** Ask where, then write the history there. Says how it went in the activity feed. */
export async function exportReadingHistory(format: HistoryFormat): Promise<void> {
  const choice = HISTORY_FORMATS.find((f) => f.format === format)
  if (!choice) return
  const path = await save({
    title: 'Export reading history',
    defaultPath: await defaultSavePath(choice.file),
    filters: [choice.filter]
  })
  if (!path) return
  try {
    const lines = await invoke<number>('reading_history_export', {
      path,
      format,
      idleSec: getSettings().afkThresholdSec,
      skipFastLines: getSettings().skipFastLines,
      dayStartHour: getSettings().dayStartHour
    })
    postActivity({ text: `Exported ${lines.toLocaleString()} lines read`, tone: 'ok', key: 'reading-history' })
  } catch (error) {
    postActivity({
      text: `Could not export the reading history: ${String(error)}`,
      tone: 'error',
      key: 'reading-history'
    })
  }
}
