/**
 * A panel window's launch: the frame `panel.html` paints before any script (`#kimochi-boot`), its
 * hand-over to React, and the main window's half of the startup timing (src-tauri/src/boot.rs).
 *
 * Timing: when this page started navigating, parsed its HTML, painted first, rendered React and was
 * ready, in milliseconds since the process started (`__KIMOCHI_PLATFORM__.bootAt`). Reported once
 * per launch as `{check: "startup"}`; native adds its own marks. Read by `scripts/startup-bench.mjs`.
 */
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useLayoutEffect } from 'react'

interface BootWindow {
  __KIMOCHI_PLATFORM__?: { bootAt?: number }
  __kimochiBoot?: Record<string, number>
}

/** The main window's shape for `panel.html`'s first frame, written as it changes. */
export interface BootShape {
  sidebar?: boolean
  sidebarWidth?: number
}

const SHAPE_KEY = 'kimochi.boot.v1'
const boot = window as unknown as BootWindow
const marks: Record<string, number> = boot.__kimochiBoot ?? {}
boot.__kimochiBoot = marks
let ready = false

/** Notes `name` at the current time, once. */
export function bootMark(name: string): void {
  if (!(name in marks)) marks[name] = performance.now()
}

/** Remembers `shape` so the next launch's first frame has the window's sidebar where it will be. */
export function rememberBootShape(shape: BootShape): void {
  try {
    const current = JSON.parse(localStorage.getItem(SHAPE_KEY) ?? '{}') as BootShape
    const next = { ...current, ...shape }
    if (JSON.stringify(next) !== JSON.stringify(current)) localStorage.setItem(SHAPE_KEY, JSON.stringify(next))
  } catch {
    /* Storage unavailable: the next first frame is the default shape. */
  }
}

/** Fades the first frame out over the rendered window, then removes it. */
function hideBootFrame(): void {
  const frame = document.getElementById('kimochi-boot')
  if (!frame) return
  frame.classList.add('done')
  const remove = (): void => frame.remove()
  frame.addEventListener('transitionend', remove, { once: true })
  // No transition (reduced motion, a hidden window): removed regardless.
  setTimeout(remove, 400)
}

/**
 * The window shows its real content: the first frame fades out, and once that frame is painted the
 * main window reports its launch timing. A reload (an engine switch) is not a launch.
 */
export function bootReady(label: string): void {
  if (ready) return
  ready = true
  bootMark('ready')
  // After React's commit, in the next frame: the content is laid out under the first frame.
  requestAnimationFrame(() => {
    hideBootFrame()
    if (label !== 'log') return
    setTimeout(() => report(label), 0)
  })
}

/**
 * Rendered where a window's real content is: its commit is the end of the launch. Inside the
 * Suspense boundary of a lazy panel, and inside the Log's `ReaderHost` (after the log has loaded),
 * so the first frame stays up until there is something to show rather than a loading state.
 */
export function BootReady({ label }: { label: string }): null {
  bootMark('rendered')
  useLayoutEffect(() => bootMark('committed'), [])
  useEffect(() => bootReady(label), [label])
  return null
}

function report(label: string): void {
  bootMark('ready-painted')
  const bootAt = boot.__KIMOCHI_PLATFORM__?.bootAt ?? performance.timeOrigin
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  // Sent either way, because native starts the rest of the app on it (boot.rs), but only a launch
  // is timed: not a reload (an engine switch), nor a window opened long after the app started.
  const launch = navigation?.type !== 'reload' && performance.timeOrigin - bootAt < 60_000
  const since = (at: number): number => Math.round(performance.timeOrigin + at - bootAt)
  const web: Record<string, number> = { navigation: since(0) }
  for (const entry of performance.getEntriesByType('paint')) web[entry.name] = since(entry.startTime)
  for (const [name, at] of Object.entries(marks)) web[name] = since(at)
  void invoke('report', { value: { check: 'startup', window: label, launch, web } }).catch(() => undefined)
}
