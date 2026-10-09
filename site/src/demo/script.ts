/**
 * The demo's scripted run, as a flat list of frames. Each frame is the complete visible state for
 * `ms` milliseconds; the player steps through them in a loop. Desktop and Steam Deck share the game
 * screen, so they share the frame shape.
 */
import { useEffect, useState } from 'react'
import { PLAY_LINES } from './content'

export type Button = 'L3' | 'R3' | 'up' | 'right' | 'A' | 'B'

export interface Frame {
  ms: number
  line: number
  /** Dialogue text: typing in, or fully shown. */
  text: 'typing' | 'shown'
  /** The scan sweep is running. */
  scan: boolean
  /** The overlay's word boxes are up. */
  boxes: boolean
  /** Highlighted token (overlay hover or controller cursor). */
  cursor: number | null
  popup: boolean
  /** The controller radial menu: closed, or open with a selected wedge (-1 none). */
  menu: { sel: number; chosen: boolean } | null
  /** Buttons held this frame (Steam Deck glyphs). */
  pressed: Button[]
  /** What the Deck's hint strip says. */
  hint: string
  /** Sent to the embedded Log when the frame starts. */
  emit?: 'scan' | 'line'
}

const TYPE_MS = 42

function base(line: number): Omit<Frame, 'ms'> {
  return { line, text: 'shown', scan: false, boxes: false, cursor: null, popup: false, menu: null, pressed: [], hint: '' }
}

function typing(line: number): number {
  return PLAY_LINES[line].text.length * TYPE_MS + 250
}

/** Desktop: line → scan → boxes snap on → Log receives the line → popup on a word → next. */
export function desktopFrames(): Frame[] {
  return PLAY_LINES.flatMap((line, i): Frame[] => {
    const b = base(i)
    return [
      { ...b, ms: typing(i), text: 'typing' },
      { ...b, ms: 650 },
      { ...b, ms: 950, scan: true, emit: 'scan' },
      { ...b, ms: 900, boxes: true, emit: 'line' },
      { ...b, ms: 3000, boxes: true, cursor: line.focus, popup: line.focus >= 0 },
      { ...b, ms: 450, boxes: true },
      { ...b, ms: 350 }
    ]
  })
}

/** Index of the Scan wedge in the radial menu (see RadialMenu.tsx). */
export const SCAN_WEDGE = 0

/**
 * Steam Deck: both sticks → radial menu → Scan → boxes → D-pad word to word → A opens the reading
 * → B back to the game.
 */
export function deckFrames(): Frame[] {
  return PLAY_LINES.flatMap((line, i): Frame[] => {
    const b = base(i)
    const words = line.tokens.flatMap((t, index) => (t.punct ? [] : [index]))
    const target = Math.max(0, words.indexOf(line.focus))
    // Walk from the first word to the focus word, at most four steps, so every line takes a beat.
    const start = Math.max(0, target - 3)
    const path = words.slice(start, target + 1)
    const frames: Frame[] = [
      { ...b, ms: typing(i), text: 'typing' },
      { ...b, ms: 700, hint: 'Press both sticks for Kimochi' },
      { ...b, ms: 380, pressed: ['L3', 'R3'], menu: { sel: -1, chosen: false }, hint: 'Press both sticks for Kimochi' },
      { ...b, ms: 650, menu: { sel: -1, chosen: false } },
      { ...b, ms: 650, menu: { sel: SCAN_WEDGE, chosen: false }, pressed: ['up'] },
      { ...b, ms: 260, menu: { sel: SCAN_WEDGE, chosen: true }, pressed: ['A'] },
      { ...b, ms: 950, scan: true, emit: 'scan' },
      { ...b, ms: 450, boxes: true, cursor: path[0], emit: 'line', hint: 'Choose a word' }
    ]
    for (let k = 1; k < path.length; k++)
      frames.push({ ...b, ms: 430, boxes: true, cursor: path[k], pressed: ['right'], hint: 'Choose a word' })
    frames.push(
      { ...b, ms: 380, boxes: true, cursor: target >= 0 ? path[path.length - 1] : null, hint: 'Choose a word' },
      { ...b, ms: 280, boxes: true, cursor: path[path.length - 1], popup: true, pressed: ['A'], hint: 'Reading' },
      { ...b, ms: 2400, boxes: true, cursor: path[path.length - 1], popup: true, hint: 'Reading' },
      { ...b, ms: 380, boxes: true, cursor: path[path.length - 1], pressed: ['B'], hint: 'Back to the game' },
      { ...b, ms: 450 }
    )
    return frames
  })
}

/**
 * Steps through `frames` while `running`. A paused run resumes the current frame from its start.
 * `onEnter` runs once per frame entry (not on resume).
 */
export function usePlayer(
  frames: Frame[],
  running: boolean,
  onEnter?: (frame: Frame) => void,
  /** Restart from the first frame when this changes (e.g. the platform). */
  resetKey?: unknown
): Frame {
  const [index, setIndex] = useState(0)
  const frame = frames[index % frames.length]

  useEffect(() => {
    setIndex(0)
  }, [frames, resetKey])

  useEffect(() => {
    if (!running) return
    const timer = setTimeout(() => setIndex((i) => (i + 1) % frames.length), frame.ms)
    return () => clearTimeout(timer)
  }, [frame, frames.length, running])

  useEffect(() => {
    if (running) onEnter?.(frame)
    // Only on frame entry: resuming the same frame must not re-send it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame])

  return frame
}
