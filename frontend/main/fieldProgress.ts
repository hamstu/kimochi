/** A sidebar select's setup under way, drawn as a fill behind its text (EngineValue.tsx). */
import { useState, type CSSProperties } from 'react'

export interface FieldProgress {
  /** 0–100: the whole setup, every step and file of it (one bar). */
  value: number
  /** False within a step that reports no progress: the fill pulses. */
  exact: boolean
  /** What the select says in place of where it runs: "42%", "Starting…". */
  short: string
  /** The whole sentence, for the tooltip. */
  title: string
}

/** Props for the select trigger that draw the fill (main.css `.sb-select[data-progress]`). */
export function progressProps(busy: FieldProgress | null): {
  'data-progress'?: string
  style?: CSSProperties
  title?: string
} {
  if (!busy) return {}
  return {
    'data-progress': busy.exact ? 'exact' : 'step',
    style: { '--sb-progress': `${Math.min(Math.max(busy.value, 0), 100)}%` } as CSSProperties,
    title: busy.title
  }
}

/**
 * The fill never runs backwards while one setup lasts (a step reported late, a status read
 * crossing an event): it holds the furthest point reached until the setup ends or `key` changes.
 */
export function useSteadyProgress(busy: FieldProgress | null, key: string): FieldProgress | null {
  const [furthest, setFurthest] = useState<{ key: string; value: number } | null>(null)
  const held = busy && furthest?.key === key ? Math.max(furthest.value, busy.value) : (busy?.value ?? null)
  // Adjusted while rendering (React's "storing information from previous renders").
  if (held === null ? furthest !== null : furthest?.key !== key || furthest.value !== held) {
    setFurthest(held === null ? null : { key, value: held })
  }
  if (!busy || held === null || held === busy.value) return busy
  return { ...busy, value: held, exact: false, short: busy.exact ? `${Math.floor(held)}%` : busy.short }
}
